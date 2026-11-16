/** A test install: a P-256 key pair that signs requests the way the extension will. */
import { exports } from "cloudflare:workers";
import { librarySigningText, sha256Hex } from "@core/library";
import { toBase64Url } from "../src/auth";

const BASE = "https://library.test";

export interface Install {
  keys: CryptoKeyPair;
  publicKey: string;
  /** Signed request. `skewMs` moves the signed time; `tamper` changes the body after signing. */
  call(method: string, path: string, body?: unknown, opts?: { skewMs?: number; tamper?: string; ip?: string }): Promise<Response>;
}

export async function newInstall(): Promise<Install> {
  const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer);
  const publicKey = toBase64Url(raw);
  return {
    keys,
    publicKey,
    async call(method, path, body, opts = {}) {
      const text = body === undefined ? "" : JSON.stringify(body);
      const time = String(Date.now() + (opts.skewMs ?? 0));
      const signed = librarySigningText(method, path, time, await sha256Hex(text));
      const signature = new Uint8Array(
        await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, new TextEncoder().encode(signed)),
      );
      return exports.default.fetch(
        new Request(BASE + path, {
          method,
          body: method === "GET" ? undefined : (opts.tamper ?? text),
          headers: {
            "Content-Type": "application/json",
            "ScreenFry-Key": publicKey,
            "ScreenFry-Time": time,
            "ScreenFry-Signature": toBase64Url(signature),
            "CF-Connecting-IP": opts.ip ?? randomIp(),
          },
        }),
      );
    },
  };
}

/** Each request gets its own address unless a test picks one, so rate limits don't pile up. */
const randomIp = () => `10.${[...crypto.getRandomValues(new Uint8Array(3))].join(".")}`;
/** An unsigned request (browsing). */
export const get = (path: string, ip = randomIp()) =>
  exports.default.fetch(new Request(BASE + path, { headers: { "CF-Connecting-IP": ip } }));
export const admin = (method: string, path: string) =>
  exports.default.fetch(new Request(BASE + path, { method, headers: { Authorization: "Bearer test-admin-token" } }));
