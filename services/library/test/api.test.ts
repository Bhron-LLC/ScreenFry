import { describe, expect, it } from "vitest";
import { env, exports } from "cloudflare:workers";
import { createDefaultState } from "@core/defaults";
import { encodeShareCode } from "@core/share";
import worker from "../src/index";
import { admin, get, newInstall, type Install } from "./client";

/** A real share code: a fresh install with some changes. */
async function codeWith(change: (s: ReturnType<typeof createDefaultState>) => void) {
  const s = createDefaultState();
  change(s);
  return encodeShareCode({ rules: s.rules, windows: s.windows, earnGoals: s.earnGoals ?? [], feedSettings: s.feedSettings, warningsEnabled: s.warningsEnabled });
}
const youtubeStudying = () =>
  codeWith((s) => {
    s.rules.find((r) => r.domains.includes("youtube.com"))!.dailyAllowance = { defaultMinutes: 30 };
    s.feedSettings.sites.youtube.shorts = true;
  });
const redditLimit = (minutes = 30) =>
  codeWith((s) => {
    s.rules.find((r) => r.domains.includes("reddit.com"))!.dailyAllowance = { defaultMinutes: minutes };
  });

async function publish(who: Install, code: string, extra: object = {}) {
  const r = await who.call("POST", "/v1/setups", { code, title: "YouTube for studying", description: "No Shorts.", tags: ["studying"], ...extra });
  return { status: r.status, body: (await r.json()) as { id?: string; error?: string } };
}
const ids = async (path: string) => ((await (await get(path)).json()) as { setups: { id: string }[] }).setups.map((s) => s.id);

describe("publishing", () => {
  it("publishes a real code and anyone can get it", async () => {
    const me = await newInstall();
    const code = await youtubeStudying();
    const { status, body } = await publish(me, code);
    expect(status).toBe(201);
    const r = await get(`/v1/setups/${body.id}`);
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const setup = (await r.json()) as Record<string, unknown>;
    expect(setup).toMatchObject({ id: body.id, code, title: "YouTube for studying", websites: ["youtube"], tags: ["studying"], upvotes: 0 });
    expect((setup.summary as { limits: string[] }).limits).toEqual(["YouTube: 30 min a day"]);
    // Never the publisher or its key.
    expect(JSON.stringify(setup)).not.toContain(me.publicKey);
    expect(setup).not.toHaveProperty("publisher");
  });

  it("refuses codes the core checks refuse", async () => {
    const me = await newInstall();
    expect((await publish(me, "SCREENFRY-1-abc")).status).toBe(400);
    expect((await publish(me, await codeWith(() => {}))).body.error).toMatch(/doesn’t change anything/);
    expect((await publish(me, await youtubeStudying(), { title: "x" })).body.error).toMatch(/title/);
    const bad = await me.call("POST", "/v1/setups", undefined, { tamper: "not json" });
    expect(bad.status).toBe(401); // the body no longer matches its signature
  });

  it("stores each setup once", async () => {
    const code = await youtubeStudying();
    const first = await publish(await newInstall(), code);
    const again = await publish(await newInstall(), code);
    expect(again.status).toBe(409);
    expect(again.body.id).toBe(first.body.id);
  });

  it("limits publishing to 10 a day per key", async () => {
    const me = await newInstall();
    for (let i = 1; i <= 10; i++) expect((await publish(me, await redditLimit(i))).status).toBe(201);
    const eleventh = await publish(me, await redditLimit(11));
    expect(eleventh.status).toBe(429);
  });

  it("pauses all publishing past the daily cap", async () => {
    await env.DB.prepare("INSERT INTO activity (publisher, day, kind, count) VALUES ('*', ?, 'publish', 1000)")
      .bind(new Date().toISOString().slice(0, 10))
      .run();
    expect((await publish(await newInstall(), await youtubeStudying())).status).toBe(503);
    expect((await get("/v1/setups")).status).toBe(200);
  });
});

describe("signed requests", () => {
  it("refuses missing, wrong, stale and tampered signatures", async () => {
    const me = await newInstall();
    const code = await youtubeStudying();
    const unsigned = await get("/v1/me/setups");
    expect(unsigned.status).toBe(401);
    expect((await me.call("POST", "/v1/setups", { code, title: "Fine title" }, { skewMs: 6 * 60_000 })).status).toBe(401);
    expect(
      (await me.call("POST", "/v1/setups", { code, title: "Fine title" }, { tamper: JSON.stringify({ code, title: "Changed" }) })).status,
    ).toBe(401);
    expect((await me.call("GET", "/v1/me/setups")).status).toBe(200);
    // A made-up signature for someone's key.
    const headers = { "ScreenFry-Key": me.publicKey, "ScreenFry-Time": String(Date.now()), "ScreenFry-Signature": "A".repeat(86) };
    const forged = await exports.default.fetch(new Request("https://library.test/v1/me/setups", { headers }));
    expect(forged.status).toBe(401);
  });

  it("refuses a blocked key", async () => {
    const me = await newInstall();
    const { body } = await publish(me, await youtubeStudying());
    const row = await env.DB.prepare("SELECT publisher FROM setups WHERE id = ?").bind(body.id).first<{ publisher: string }>();
    expect((await admin("POST", `/admin/publishers/${row!.publisher}/block`)).status).toBe(200);
    expect((await publish(me, await redditLimit())).status).toBe(403);
    // Their setups are hidden.
    expect((await get(`/v1/setups/${body.id}`)).status).toBe(404);
  });
});

describe("search", () => {
  it("finds setups by words, website and tag, newest or top first", async () => {
    const a = await publish(await newInstall(), await youtubeStudying(), { title: "YouTube for studying", tags: ["studying", "no-shorts"] });
    const b = await publish(await newInstall(), await redditLimit(), { title: "Thirty minutes of Reddit", description: "Evenings only", tags: ["evenings"] });
    expect(await ids("/v1/setups?q=study")).toEqual([a.body.id]);
    expect(await ids("/v1/setups?q=EVENINGS")).toEqual([b.body.id]);
    expect(await ids('/v1/setups?q=" OR 1=1 --')).toEqual([]);
    expect(await ids("/v1/setups?website=reddit")).toEqual([b.body.id]);
    expect(await ids("/v1/setups?tag=no-shorts")).toEqual([a.body.id]);
    expect(await ids("/v1/setups?website=reddit&tag=studying")).toEqual([]);
    expect(await ids("/v1/setups?sort=new")).toEqual([b.body.id, a.body.id]);
    await (await newInstall()).call("PUT", `/v1/setups/${a.body.id}/vote`);
    expect(await ids("/v1/setups")).toEqual([a.body.id, b.body.id]);
  });

  it("pages 20 at a time", async () => {
    const installs = [await newInstall(), await newInstall(), await newInstall()];
    for (let i = 1; i <= 21; i++) expect((await publish(installs[i % 3], await redditLimit(i))).status).toBe(201);
    const first = (await (await get("/v1/setups")).json()) as { setups: unknown[]; next: string | null };
    expect(first.setups).toHaveLength(20);
    expect(first.next).toBe("20");
    const second = (await (await get(`/v1/setups?cursor=${first.next}`)).json()) as { setups: unknown[]; next: string | null };
    expect(second.setups).toHaveLength(1);
    expect(second.next).toBeNull();
  });
});

describe("votes, reports and moderation", () => {
  it("counts one upvote per key and lets it be taken back", async () => {
    const { body } = await publish(await newInstall(), await youtubeStudying());
    const fan = await newInstall();
    await fan.call("PUT", `/v1/setups/${body.id}/vote`);
    const twice = (await (await fan.call("PUT", `/v1/setups/${body.id}/vote`)).json()) as { upvotes: number };
    expect(twice.upvotes).toBe(1);
    const back = (await (await fan.call("DELETE", `/v1/setups/${body.id}/vote`)).json()) as { upvotes: number };
    expect(back.upvotes).toBe(0);
  });

  it("hides a setup after 3 reports from different keys, not from one", async () => {
    const { body } = await publish(await newInstall(), await youtubeStudying());
    const path = `/v1/setups/${body.id}/report`;
    const one = await newInstall();
    for (let i = 0; i < 3; i++) expect((await one.call("POST", path, { reason: "spam" })).status).toBe(200);
    expect((await get(`/v1/setups/${body.id}`)).status).toBe(200);
    expect((await one.call("POST", path, { reason: "nonsense" })).status).toBe(400);
    await (await newInstall()).call("POST", path, { reason: "offensive", note: "rude title" });
    await (await newInstall()).call("POST", path, { reason: "misleading" });
    expect((await get(`/v1/setups/${body.id}`)).status).toBe(404);
    expect(await ids("/v1/setups")).toEqual([]);

    // An admin sees it with its reports, restores it, and it stays up after more reports.
    const hidden = (await (await admin("GET", "/admin/hidden")).json()) as { setups: { id: string; reports: { note: string }[] }[] };
    expect(hidden.setups[0].id).toBe(body.id);
    expect(hidden.setups[0].reports.map((r) => r.note)).toContain("rude title");
    expect((await admin("POST", `/admin/setups/${body.id}/restore`)).status).toBe(200);
    for (let i = 0; i < 3; i++) await (await newInstall()).call("POST", path, { reason: "spam" });
    expect((await get(`/v1/setups/${body.id}`)).status).toBe(200);

    // Removing takes it out for good.
    await admin("POST", `/admin/setups/${body.id}/remove`);
    expect((await get(`/v1/setups/${body.id}`)).status).toBe(404);
  });

  it("doesn't let you report your own setup", async () => {
    const me = await newInstall();
    const { body } = await publish(me, await youtubeStudying());
    expect((await me.call("POST", `/v1/setups/${body.id}/report`, { reason: "spam" })).status).toBe(400);
  });

  it("keeps the admin routes closed without the token", async () => {
    const r = await get("/admin/hidden");
    expect(r.status).toBe(404);
  });
});

describe("your own setups", () => {
  it("lists, deletes one and deletes all, only for the owner", async () => {
    const me = await newInstall();
    const a = await publish(me, await youtubeStudying());
    const b = await publish(me, await redditLimit());
    const mine = (await (await me.call("GET", "/v1/me/setups")).json()) as { setups: { id: string; status: string }[] };
    expect(mine.setups.map((s) => s.status)).toEqual(["live", "live"]);
    expect((await (await newInstall()).call("DELETE", `/v1/setups/${a.body.id}`)).status).toBe(403);
    expect((await me.call("DELETE", `/v1/setups/${a.body.id}`)).status).toBe(200);
    expect((await get(`/v1/setups/${a.body.id}`)).status).toBe(404);
    const all = (await (await me.call("DELETE", "/v1/me/setups")).json()) as { deleted: string[] };
    expect(all.deleted).toEqual([b.body.id]);
    expect(await ids("/v1/setups")).toEqual([]);
  });
});

describe("limits and housekeeping", () => {
  it("rate-limits writes from one address", async () => {
    const me = await newInstall();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await me.call("PUT", "/v1/setups/nope/vote", undefined, { ip: "192.0.2.1" })).status);
    expect(statuses).toContain(429);
  });

  it("answers preflight requests and unknown paths", async () => {
    const pre = await exports.default.fetch(new Request("https://library.test/v1/setups", { method: "OPTIONS" }));
    expect(pre.status).toBe(204);
    expect(pre.headers.get("Access-Control-Allow-Headers")).toContain("ScreenFry-Signature");
    expect((await get("/v1/nothing")).status).toBe(404);
    expect((await (await get("/v1/health")).json())).toEqual({ ok: true });
  });

  it("deletes old daily counts", async () => {
    await env.DB.prepare("INSERT INTO activity (publisher, day, kind, count) VALUES ('x', '2020-01-01', 'vote', 3)").run();
    await worker.scheduled({} as ScheduledController, env);
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM activity").first<{ n: number }>();
    expect(left!.n).toBe(0);
  });
});
