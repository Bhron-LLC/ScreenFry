/**
 * Signed requests. Each install has a P-256 key pair made on the device; a request that
 * publishes, votes, reports or reads "my setups" carries the public key, the time and a
 * signature over librarySigningText (packages/core/src/library.ts). No accounts.
 */
import { LIBRARY_MAX_CLOCK_SKEW_MS, librarySigningText, sha256Hex } from "@core/library";

export interface Signer {
  /** First 16 bytes of the public key's SHA-256, base64url. */
  id: string;
  publicKey: string;
}

export const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return undefined;
  try {
    return Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
}

export async function publisherId(rawKey: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", rawKey));
  return toBase64Url(digest.subarray(0, 16));
}

/** The signer of a request, or an error sentence. `body` is the request's text. */
export async function verifyRequest(
  request: Request,
  body: string,
  now: number,
): Promise<{ signer?: Signer; error?: string }> {
  const key = request.headers.get("ScreenFry-Key") ?? "";
  const time = request.headers.get("ScreenFry-Time") ?? "";
  const signature = request.headers.get("ScreenFry-Signature") ?? "";
  if (!key || !time || !signature) return { error: "This needs your ScreenFry library key." };
  const when = Number(time);
  if (!Number.isFinite(when) || Math.abs(now - when) > LIBRARY_MAX_CLOCK_SKEW_MS)
    return { error: "Your Mac’s clock is off by more than five minutes. Fix the time, then try again." };
  const raw = fromBase64Url(key);
  const sig = fromBase64Url(signature);
  // Uncompressed P-256 public key (65 bytes) and a P1363 signature (64 bytes).
  if (!raw || raw.length !== 65 || raw[0] !== 4 || !sig || sig.length !== 64)
    return { error: "That library key isn’t valid." };
  let ok = false;
  try {
    const publicKey = await crypto.subtle.importKey("raw", raw, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const path = new URL(request.url).pathname;
    const text = librarySigningText(request.method, path, time, await sha256Hex(body));
    ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, sig, new TextEncoder().encode(text));
  } catch {
    ok = false;
  }
  if (!ok) return { error: "That library key isn’t valid." };
  return { signer: { id: await publisherId(raw), publicKey: key } };
}

/** Constant-time comparison for the admin token. */
export function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
