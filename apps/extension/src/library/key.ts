/**
 * The setup library's install key: a P-256 key pair made in this browser the first time you
 * publish, upvote or report (docs/SETUP_LIBRARY.md). The private key can't be exported and
 * stays in this extension's IndexedDB; the server only ever sees the public key. No account.
 *
 * This file has no network code, so the background can import it to delete the key on Reset.
 */
export const LIBRARY_KEY_DB = "screenfry-library";
const STORE = "keys";
const RECORD = "install";

export interface InstallKey {
  privateKey: CryptoKey;
  /** Raw uncompressed public key, base64url. */
  publicKey: string;
}

const toBase64Url = (bytes: Uint8Array) => {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LIBRARY_KEY_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = work(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/** This browser's install key; made and saved when `create` is set and there's none yet. */
export async function getInstallKey(create: boolean): Promise<InstallKey | undefined> {
  const saved = await run<InstallKey | undefined>("readonly", (s) => s.get(RECORD));
  if (saved || !create) return saved;
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const key: InstallKey = { privateKey: pair.privateKey, publicKey: toBase64Url(raw) };
  await run("readwrite", (s) => s.put(key, RECORD));
  return key;
}

/** Forgets the install key (Reset, or turning the library off and choosing to forget it). */
export function deleteInstallKey(): void {
  try {
    indexedDB.deleteDatabase(LIBRARY_KEY_DB);
  } catch {
    // No IndexedDB here: there's no key either.
  }
}
