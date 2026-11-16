import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as actions from "@core/actions";
import { MemoryStateStore } from "@core/store";
import { librarySigningText, sha256Hex } from "@core/library";
import type { InstallKey } from "../apps/extension/src/library/key";

// IndexedDB isn't here; the key module is replaced by one in-memory key.
let key: InstallKey | undefined;
let made = 0;
vi.mock("../apps/extension/src/library/key", () => ({
  getInstallKey: async (create: boolean) => {
    if (!key && create) {
      made++;
      const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as CryptoKeyPair;
      const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
      key = { privateKey: pair.privateKey, publicKey: Buffer.from(raw).toString("base64url") };
      publicKey = pair.publicKey;
    }
    return key;
  },
  deleteInstallKey: () => (key = undefined),
}));
let publicKey: CryptoKey;
const api = await import("../apps/extension/src/library/api");

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}
let sent: Sent[] = [];
function serve(status: number, body: unknown) {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    sent.push({ url, method: init.method!, headers: init.headers as Record<string, string>, body: init.body as string | undefined });
    return new Response(JSON.stringify(body), { status });
  });
}
afterEach(() => {
  vi.unstubAllGlobals();
  sent = [];
});
beforeAll(() => {
  key = undefined;
});

describe("library client", () => {
  it("searches the test server with only the words and filters", async () => {
    serve(200, { setups: [], next: null });
    await api.searchSetups({ q: " study ", websites: ["youtube", "reddit"], tags: ["studying"], sort: "new", cursor: "20" });
    expect(sent[0].url).toBe(
      "https://screenfry-library-test.bhron-site.workers.dev/v1/setups?q=study&website=youtube&website=reddit&tag=studying&sort=new&cursor=20",
    );
    expect(sent[0].method).toBe("GET");
    expect(sent[0].body).toBeUndefined();
    expect(Object.keys(sent[0].headers)).toEqual([]);
    expect(made).toBe(0); // browsing never makes a key
  });

  it("signs a publish with the install key, made on first use", async () => {
    serve(201, { id: "abc" });
    const setup = { code: "SF2-jxyz", title: "YouTube for studying", description: "", tags: ["studying" as const] };
    expect(await api.publishSetup(setup)).toEqual({ id: "abc" });
    expect(made).toBe(1);
    const { headers, body, url } = sent[0];
    expect(JSON.parse(body!)).toEqual(setup);
    expect(headers["ScreenFry-Key"]).toBe(key!.publicKey);
    const text = librarySigningText("POST", new URL(url).pathname, headers["ScreenFry-Time"], await sha256Hex(body!));
    const signature = Buffer.from(headers["ScreenFry-Signature"], "base64url");
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, signature, new TextEncoder().encode(text))).toBe(true);
  });

  it("reuses the key, and asks for no key before there is one", async () => {
    serve(200, { upvotes: 1, voted: true });
    await api.voteSetup("abc", true);
    expect(made).toBe(1);
    expect(sent[0].method).toBe("PUT");
    key = undefined;
    await expect(api.mySetups()).rejects.toThrow(/haven’t published/);
  });

  it("passes the server's sentence through, and says when it can't reach it", async () => {
    serve(429, { error: "Too many requests. Wait a minute, then try again." });
    await expect(api.searchSetups({})).rejects.toThrow("Too many requests");
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(api.getSetup("x")).rejects.toThrow(api.OFFLINE);
  });

  it("keeps the existing id on a duplicate publish", async () => {
    serve(409, { error: "This setup is already in the library.", id: "old" });
    const error = await api.publishSetup({ code: "SF2-j", title: "Again", description: "", tags: [] }).catch((e) => e);
    expect(error).toBeInstanceOf(api.LibraryError);
    expect(error.status).toBe(409);
    expect(error.id).toBe("old");
  });
});

describe("turning the library on", () => {
  it("is off by default and needs no password", async () => {
    const ctx = { store: new MemoryStateStore(), now: () => 0 };
    expect((await ctx.store.get()).libraryEnabled).toBeFalsy();
    await actions.setSettingsPassword(ctx, "a long settings password");
    const r = await actions.setLibraryEnabled(ctx, true);
    expect(r.ok && r.data.libraryEnabled).toBe(true);
    await actions.setLibraryEnabled(ctx, false);
    expect((await ctx.store.get()).libraryEnabled).toBeFalsy();
  });

  it("is turned off again by Reset", async () => {
    const ctx = { store: new MemoryStateStore(), now: () => 0 };
    await actions.setLibraryEnabled(ctx, true);
    await actions.resetAll(ctx);
    expect((await ctx.store.get()).libraryEnabled).toBeFalsy();
  });
});
