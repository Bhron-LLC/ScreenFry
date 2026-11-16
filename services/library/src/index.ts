/**
 * ScreenFry's setup library (docs/SETUP_LIBRARY.md): publish, search, get, vote on and
 * report setups, which are SF2- share codes with a title, description and tags. Codes are
 * checked and rebuilt with packages/core, the same code the extension uses. Nothing about
 * the people using it is stored besides an anonymous key per install and daily counts.
 */
import { LIBRARY_LIMITS, REPORT_REASONS, checkPublishable, cleanText, sha256Hex } from "@core/library";
import { sameSecret, verifyRequest, type Signer } from "./auth";

export interface Env {
  DB: D1Database;
  READS?: RateLimit;
  WRITES?: RateLimit;
  /** Set with `wrangler secret put ADMIN_TOKEN`; without it the admin routes are closed. */
  ADMIN_TOKEN?: string;
  PUBLISH_DAILY_CAP?: string;
  SEARCH_CACHE_SECONDS?: string;
}

const PAGE = 20;
const MAX_BODY = 16_000;
const DAILY = { publish: 10, vote: 50, report: 20 } as const;
const HIDE_AFTER_REPORTS = 3;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, ScreenFry-Key, ScreenFry-Time, ScreenFry-Signature",
  "Access-Control-Max-Age": "86400",
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS, ...headers },
  });

interface SetupRow {
  id: string;
  code: string;
  title: string;
  description: string;
  websites: string;
  tags: string;
  summary: string;
  publisher: string;
  created_at: number;
  upvotes: number;
  status: string;
}
/** What everyone sees. Never the publisher, its key or report counts. */
const card = (row: SetupRow) => ({
  id: row.id,
  title: row.title,
  description: row.description,
  websites: row.websites.split(" ").filter(Boolean),
  tags: row.tags.split(" ").filter(Boolean),
  summary: JSON.parse(row.summary) as unknown,
  upvotes: row.upvotes,
  createdAt: row.created_at,
});

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return [...bytes].map((b) => BASE58[b % 58]).join("");
}
const today = (now: number) => new Date(now).toISOString().slice(0, 10);

/** Adds one to a daily count and refuses past the limit. */
async function countToday(env: Env, now: number, publisher: string, kind: keyof typeof DAILY, limit: number) {
  const row = await env.DB.prepare(
    `INSERT INTO activity (publisher, day, kind, count) VALUES (?, ?, ?, 1)
     ON CONFLICT (publisher, day, kind) DO UPDATE SET count = count + 1 RETURNING count`,
  )
    .bind(publisher, today(now), kind)
    .first<{ count: number }>();
  return (row?.count ?? 0) <= limit;
}

async function rateLimit(env: Env, request: Request) {
  const limiter = request.method === "GET" ? env.READS : env.WRITES;
  if (!limiter) return;
  // The IP address is only the rate limiter's key, kept in memory by Cloudflare; never stored.
  const ip = request.headers.get("CF-Connecting-IP") ?? "local";
  const { success } = await limiter.limit({ key: ip });
  if (!success) throw new HttpError(429, "Too many requests. Wait a minute, then try again.");
}

/** The signer, recorded the first time it's seen; refused if blocked. */
async function signerOf(env: Env, request: Request, body: string, now: number): Promise<Signer> {
  const { signer, error } = await verifyRequest(request, body, now);
  if (!signer) throw new HttpError(401, error!);
  await env.DB.prepare("INSERT INTO publishers (id, public_key, created_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING")
    .bind(signer.id, signer.publicKey, now)
    .run();
  const row = await env.DB.prepare("SELECT blocked FROM publishers WHERE id = ?").bind(signer.id).first<{ blocked: number }>();
  if (row?.blocked) throw new HttpError(403, "This library key can’t publish, vote or report.");
  return signer;
}

async function readBody(request: Request): Promise<string> {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, "That request is too big.");
  return text;
}
function parse(body: string): Record<string, unknown> {
  try {
    const data = JSON.parse(body) as unknown;
    if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new HttpError(400, "That request isn’t valid JSON.");
}

/** Words for FTS5: letters and digits only, each a prefix match, all required. */
function ftsQuery(q: string): string | undefined {
  const words = q
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 8);
  return words.length ? words.map((w) => `"${w}"*`).join(" ") : undefined;
}

async function search(env: Env, url: URL) {
  const where = ["s.status = 'live'"];
  const binds: unknown[] = [];
  const q = ftsQuery(url.searchParams.get("q") ?? "");
  if (q) {
    where.push("s.id IN (SELECT setup_id FROM setups_fts WHERE setups_fts MATCH ?)");
    binds.push(q);
  }
  for (const website of url.searchParams.getAll("website").slice(0, 5)) {
    where.push("EXISTS (SELECT 1 FROM setup_websites w WHERE w.setup_id = s.id AND w.website = ?)");
    binds.push(website.toLowerCase());
  }
  for (const tag of url.searchParams.getAll("tag").slice(0, 4)) {
    where.push("EXISTS (SELECT 1 FROM setup_tags t WHERE t.setup_id = s.id AND t.tag = ?)");
    binds.push(tag);
  }
  const order = url.searchParams.get("sort") === "new" ? "s.created_at DESC, s.id" : "s.upvotes DESC, s.created_at DESC, s.id";
  const offset = Math.min(Math.max(0, Number.parseInt(url.searchParams.get("cursor") ?? "0", 10) || 0), 1000);
  const { results } = await env.DB.prepare(
    `SELECT s.* FROM setups s WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`,
  )
    .bind(...binds, PAGE + 1, offset)
    .all<SetupRow>();
  return {
    setups: results.slice(0, PAGE).map(card),
    next: results.length > PAGE ? String(offset + PAGE) : null,
  };
}

async function liveSetup(env: Env, id: string): Promise<SetupRow> {
  const row = await env.DB.prepare("SELECT * FROM setups WHERE id = ? AND status = 'live'").bind(id).first<SetupRow>();
  if (!row) throw new HttpError(404, "That setup isn’t in the library anymore.");
  return row;
}

async function publish(env: Env, signer: Signer, body: string, now: number) {
  const { setup, error } = await checkPublishable(parse(body));
  if (!setup) throw new HttpError(400, error!);
  const codeHash = await sha256Hex(setup.code);
  const existing = await env.DB.prepare("SELECT id, status FROM setups WHERE code_hash = ?")
    .bind(codeHash)
    .first<{ id: string; status: string }>();
  if (existing)
    throw Object.assign(new HttpError(409, "This setup is already in the library."), {
      id: existing.status === "live" ? existing.id : undefined,
    });
  if (!(await countToday(env, now, signer.id, "publish", DAILY.publish)))
    throw new HttpError(429, `You can publish up to ${DAILY.publish} setups a day. Try again tomorrow.`);
  const cap = Number(env.PUBLISH_DAILY_CAP ?? 1000);
  if (!(await countToday(env, now, "*", "publish", cap))) {
    console.error(`Publishing paused: over ${cap} setups today.`);
    throw new HttpError(503, "Publishing is paused for today. Try again tomorrow.");
  }
  const id = newId();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO setups (id, code, code_hash, title, description, websites, tags, summary, publisher, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, setup.code, codeHash, setup.title, setup.description, setup.websites.join(" "), setup.tags.join(" "), JSON.stringify(setup.summary), signer.id, now, now),
    env.DB.prepare("INSERT INTO setups_fts (setup_id, title, description) VALUES (?, ?, ?)").bind(id, setup.title, setup.description),
    ...setup.websites.map((w) => env.DB.prepare("INSERT INTO setup_websites (setup_id, website) VALUES (?, ?)").bind(id, w)),
    ...setup.tags.map((t) => env.DB.prepare("INSERT INTO setup_tags (setup_id, tag) VALUES (?, ?)").bind(id, t)),
  ]);
  return { id };
}

async function deleteSetups(env: Env, ids: string[]) {
  if (!ids.length) return;
  await env.DB.batch(
    ids.flatMap((id) => [
      env.DB.prepare("DELETE FROM setups_fts WHERE setup_id = ?").bind(id),
      env.DB.prepare("DELETE FROM setups WHERE id = ?").bind(id),
    ]),
  );
}

async function vote(env: Env, signer: Signer, id: string, on: boolean, now: number) {
  await liveSetup(env, id);
  if (on) {
    if (!(await countToday(env, now, signer.id, "vote", DAILY.vote)))
      throw new HttpError(429, "That’s a lot of upvotes for one day. Try again tomorrow.");
    const r = await env.DB.prepare("INSERT INTO votes (setup_id, publisher, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
      .bind(id, signer.id, now)
      .run();
    if (r.meta.changes) await env.DB.prepare("UPDATE setups SET upvotes = upvotes + 1 WHERE id = ?").bind(id).run();
  } else {
    const r = await env.DB.prepare("DELETE FROM votes WHERE setup_id = ? AND publisher = ?").bind(id, signer.id).run();
    if (r.meta.changes) await env.DB.prepare("UPDATE setups SET upvotes = MAX(0, upvotes - 1) WHERE id = ?").bind(id).run();
  }
  const row = await env.DB.prepare("SELECT upvotes FROM setups WHERE id = ?").bind(id).first<{ upvotes: number }>();
  return { upvotes: row?.upvotes ?? 0, voted: on };
}

async function report(env: Env, signer: Signer, id: string, body: string, now: number) {
  const setup = await liveSetup(env, id);
  const data = parse(body);
  const reason = String(data.reason ?? "");
  if (!(REPORT_REASONS as readonly string[]).includes(reason))
    throw new HttpError(400, "Choose why you’re reporting this setup.");
  const note = cleanText(data.note).slice(0, LIBRARY_LIMITS.reportNote);
  if (setup.publisher === signer.id) throw new HttpError(400, "You can delete your own setup instead of reporting it.");
  if (!(await countToday(env, now, signer.id, "report", DAILY.report)))
    throw new HttpError(429, "That’s a lot of reports for one day. Try again tomorrow.");
  const r = await env.DB.prepare(
    "INSERT INTO reports (setup_id, publisher, reason, note, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
  )
    .bind(id, signer.id, reason, note, now)
    .run();
  if (r.meta.changes)
    // Hidden once enough different installs report it, unless an admin already reviewed it.
    await env.DB.prepare(
      `UPDATE setups SET reports = reports + 1,
         status = CASE WHEN reviewed = 0 AND reports + 1 >= ? THEN 'hidden' ELSE status END
       WHERE id = ?`,
    )
      .bind(HIDE_AFTER_REPORTS, id)
      .run();
  return { reported: true };
}

async function admin(env: Env, request: Request, parts: string[], now: number) {
  const token = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!env.ADMIN_TOKEN || !token || !sameSecret(token, env.ADMIN_TOKEN)) throw new HttpError(404, "Not found.");
  const [what, id, action] = parts;
  if (request.method === "GET" && what === "hidden" && !id) {
    const { results } = await env.DB.prepare(
      `SELECT s.*, (SELECT json_group_array(json_object('reason', r.reason, 'note', r.note, 'at', r.created_at))
                    FROM reports r WHERE r.setup_id = s.id AND r.resolved = 0) AS open_reports
       FROM setups s WHERE s.status = 'hidden' OR s.reports > 0 ORDER BY s.reports DESC, s.updated_at DESC LIMIT 100`,
    ).all<SetupRow & { open_reports: string; reports: number }>();
    return {
      setups: results.map((r) => ({ ...card(r), code: r.code, status: r.status, publisher: r.publisher, reports: JSON.parse(r.open_reports) })),
    };
  }
  if (request.method === "POST" && what === "setups" && id && (action === "restore" || action === "remove")) {
    const status = action === "restore" ? "live" : "removed";
    const r = await env.DB.batch([
      env.DB.prepare("UPDATE setups SET status = ?, reports = 0, reviewed = ?, updated_at = ? WHERE id = ?").bind(status, action === "restore" ? 1 : 0, now, id),
      env.DB.prepare("UPDATE reports SET resolved = 1 WHERE setup_id = ?").bind(id),
    ]);
    if (!r[0].meta.changes) throw new HttpError(404, "No setup with that id.");
    if (action === "remove") await env.DB.prepare("DELETE FROM setups_fts WHERE setup_id = ?").bind(id).run();
    return { id, status };
  }
  if (request.method === "POST" && what === "publishers" && id && (action === "block" || action === "unblock")) {
    const blocked = action === "block" ? 1 : 0;
    const r = await env.DB.prepare("UPDATE publishers SET blocked = ? WHERE id = ?").bind(blocked, id).run();
    if (!r.meta.changes) throw new HttpError(404, "No publisher with that id.");
    // Blocking hides their live setups; unblocking leaves them for an admin to restore.
    if (blocked)
      await env.DB.prepare("UPDATE setups SET status = 'hidden', updated_at = ? WHERE publisher = ? AND status = 'live'").bind(now, id).run();
    return { id, blocked: Boolean(blocked) };
  }
  throw new HttpError(404, "Not found.");
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const now = Date.now();
  const { method } = request;
  if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (parts[0] === "admin") return json(await admin(env, request, parts.slice(1), now));
  if (parts[0] !== "v1") throw new HttpError(404, "Not found.");
  await rateLimit(env, request);
  const [, resource, id, sub] = parts;

  if (method === "GET" && resource === "health" && !id) return json({ ok: true });

  if (resource === "setups" && !id) {
    if (method === "GET") {
      const seconds = Number(env.SEARCH_CACHE_SECONDS ?? 0);
      const cacheKey = new Request(url.toString(), { method: "GET" });
      if (seconds > 0) {
        const hit = await caches.default.match(cacheKey);
        if (hit) return hit;
      }
      const response = json(await search(env, url), 200, seconds > 0 ? { "Cache-Control": `public, max-age=${seconds}` } : {});
      if (seconds > 0) ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
      return response;
    }
    if (method === "POST") {
      const body = await readBody(request);
      const signer = await signerOf(env, request, body, now);
      return json(await publish(env, signer, body, now), 201);
    }
  }

  if (resource === "setups" && id && !sub) {
    if (method === "GET") {
      const row = await liveSetup(env, id);
      return json({ ...card(row), code: row.code });
    }
    if (method === "DELETE") {
      const signer = await signerOf(env, request, await readBody(request), now);
      const row = await env.DB.prepare("SELECT publisher FROM setups WHERE id = ?").bind(id).first<{ publisher: string }>();
      if (!row) throw new HttpError(404, "That setup isn’t in the library anymore.");
      if (row.publisher !== signer.id) throw new HttpError(403, "Only the person who published a setup can delete it.");
      await deleteSetups(env, [id]);
      return json({ deleted: [id] });
    }
  }

  if (resource === "setups" && id && sub === "vote" && (method === "PUT" || method === "DELETE")) {
    const signer = await signerOf(env, request, await readBody(request), now);
    return json(await vote(env, signer, id, method === "PUT", now));
  }

  if (resource === "setups" && id && sub === "report" && method === "POST") {
    const body = await readBody(request);
    const signer = await signerOf(env, request, body, now);
    return json(await report(env, signer, id, body, now));
  }

  if (resource === "me" && id === "setups" && !sub) {
    const signer = await signerOf(env, request, await readBody(request), now);
    const { results } = await env.DB.prepare("SELECT * FROM setups WHERE publisher = ? ORDER BY created_at DESC")
      .bind(signer.id)
      .all<SetupRow>();
    if (method === "GET") return json({ setups: results.map((r) => ({ ...card(r), code: r.code, status: r.status })) });
    if (method === "DELETE") {
      await deleteSetups(env, results.map((r) => r.id));
      return json({ deleted: results.map((r) => r.id) });
    }
  }

  throw new HttpError(404, "Not found.");
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    try {
      return await route(request, env, ctx);
    } catch (error) {
      if (error instanceof HttpError)
        return json({ error: error.message, ...("id" in error && error.id ? { id: error.id } : {}) }, error.status);
      console.error(error);
      return json({ error: "Something went wrong in the library. Try again in a minute." }, 500);
    }
  },
  async scheduled(_controller, env): Promise<void> {
    const cutoff = today(Date.now() - 2 * 86_400_000);
    await env.DB.prepare("DELETE FROM activity WHERE day < ?").bind(cutoff).run();
  },
} satisfies ExportedHandler<Env>;
