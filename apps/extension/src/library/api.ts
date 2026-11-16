/**
 * The setup library's client (docs/SETUP_LIBRARY.md). Only the Share page uses it, and only
 * once the library is turned on: the background, popup and content scripts never contact the
 * library (scripts/verify-build.mjs checks). Searches send the words and filters chosen;
 * publishing sends one setup; nothing else about you or your settings is ever sent.
 */
import { LIBRARY_URLS, librarySigningText, sha256Hex, type LibraryTag, type ReportReason } from "@core/library";
import type { SharedSummary } from "@core/share";
import { getInstallKey, type InstallKey } from "./key";

/** The test server until the library ships (then LIBRARY_URLS.production). */
export const LIBRARY_URL: string = LIBRARY_URLS.test;
const TIMEOUT_MS = 10_000;
export const OFFLINE = "Can’t reach the library right now. Your loadouts and settings work as usual.";

export interface LibraryCard {
  id: string;
  title: string;
  description: string;
  websites: string[];
  tags: string[];
  summary: SharedSummary;
  upvotes: number;
  createdAt: number;
}
export interface LibrarySetup extends LibraryCard {
  code: string;
}
export interface MySetup extends LibrarySetup {
  status: "live" | "hidden" | "removed";
}
export interface SearchQuery {
  q?: string;
  websites?: string[];
  tags?: string[];
  sort?: "top" | "new";
  cursor?: string | null;
}

export class LibraryError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    readonly id?: string,
  ) {
    super(message);
  }
}

const toBase64Url = (bytes: Uint8Array) => {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** The headers that sign a request with the install key. */
export async function signedHeaders(key: InstallKey, method: string, path: string, body: string, now = Date.now()) {
  const time = String(now);
  const text = librarySigningText(method, path, time, await sha256Hex(body));
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, new TextEncoder().encode(text)),
  );
  return { "ScreenFry-Key": key.publicKey, "ScreenFry-Time": time, "ScreenFry-Signature": toBase64Url(signature) };
}

async function request<T>(method: string, path: string, opts: { body?: unknown; signed?: "create" | "existing" } = {}): Promise<T> {
  const body = opts.body === undefined ? "" : JSON.stringify(opts.body);
  const headers: Record<string, string> = body ? { "Content-Type": "application/json" } : {};
  if (opts.signed) {
    const key = await getInstallKey(opts.signed === "create");
    if (!key) throw new LibraryError("You haven’t published anything from this browser.", 404);
    Object.assign(headers, await signedHeaders(key, method, path.split("?")[0], body));
  }
  let response: Response;
  try {
    response = await fetch(LIBRARY_URL + path, {
      method,
      headers,
      body: body || undefined,
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new LibraryError(OFFLINE);
  }
  const data = (await response.json().catch(() => ({}))) as T & { error?: string; id?: string };
  if (!response.ok) throw new LibraryError(data.error ?? OFFLINE, response.status, data.id);
  return data;
}

export function searchSetups(query: SearchQuery): Promise<{ setups: LibraryCard[]; next: string | null }> {
  const params = new URLSearchParams();
  if (query.q?.trim()) params.set("q", query.q.trim());
  for (const w of query.websites ?? []) params.append("website", w);
  for (const t of query.tags ?? []) params.append("tag", t);
  if (query.sort === "new") params.set("sort", "new");
  if (query.cursor) params.set("cursor", query.cursor);
  const qs = params.toString();
  return request("GET", `/v1/setups${qs ? `?${qs}` : ""}`);
}
export const getSetup = (id: string) => request<LibrarySetup>("GET", `/v1/setups/${encodeURIComponent(id)}`);
export const publishSetup = (setup: { code: string; title: string; description: string; tags: LibraryTag[] }) =>
  request<{ id: string }>("POST", "/v1/setups", { body: setup, signed: "create" });
export const voteSetup = (id: string, on: boolean) =>
  request<{ upvotes: number; voted: boolean }>(on ? "PUT" : "DELETE", `/v1/setups/${encodeURIComponent(id)}/vote`, { signed: "create" });
export const reportSetup = (id: string, reason: ReportReason, note: string) =>
  request<{ reported: true }>("POST", `/v1/setups/${encodeURIComponent(id)}/report`, { body: { reason, note }, signed: "create" });
export const mySetups = () => request<{ setups: MySetup[] }>("GET", "/v1/me/setups", { signed: "existing" });
export const deleteSetup = (id: string) =>
  request<{ deleted: string[] }>("DELETE", `/v1/setups/${encodeURIComponent(id)}`, { signed: "existing" });
export const deleteAllMySetups = () => request<{ deleted: string[] }>("DELETE", "/v1/me/setups", { signed: "existing" });
