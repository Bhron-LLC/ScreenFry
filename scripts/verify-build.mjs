// Guards build invariants that break the extension silently if violated.
import { readFileSync, existsSync } from "node:fs";

const dist = new URL("../dist/chrome/", import.meta.url);
const read = (path) => readFileSync(new URL(path, dist), "utf8");
const errors = [];

if (!/^\{"build":"[0-9a-f]{16}"\}\n$/.test(read("build.json")))
  errors.push("build.json must hold the build fingerprint (scripts/stamp-build.mjs)");

const manifest = JSON.parse(read("manifest.json"));
if (
  /declarativeNetRequest\.(?:RuleActionType|ResourceType)\./.test(
    read(manifest.background.service_worker),
  )
)
  errors.push("network rules must use portable schema strings, not Chrome runtime enums");
if (!manifest.permissions.includes("declarativeNetRequestWithHostAccess"))
  errors.push("redirect rules require declarativeNetRequestWithHostAccess in Safari");
for (const [purpose, icons] of Object.entries({
  extension: manifest.icons,
  toolbar: manifest.action.default_icon,
})) {
  if (!icons?.["16"] || !icons?.["32"])
    errors.push(`missing ${purpose} icon declarations`);
  for (const [size, path] of Object.entries(icons ?? {})) {
    const file = new URL(path, dist);
    if (!existsSync(file)) {
      errors.push(`missing ${purpose} icon ${path}`);
      continue;
    }
    const png = readFileSync(file);
    if (
      png.length < 24 ||
      png.subarray(1, 4).toString() !== "PNG" ||
      png.readUInt32BE(16) !== Number(size) ||
      png.readUInt32BE(20) !== Number(size)
    )
      errors.push(`incorrect PNG dimensions for ${path}`);
  }
}
for (const file of [
  manifest.background.service_worker,
  ...manifest.content_scripts.flatMap((entry) => entry.js),
  manifest.action.default_popup,
  "blocked.html",
  "onboarding.html",
  "dashboard.html",
  "THIRD_PARTY_NOTICES.txt",
]) {
  if (!existsSync(new URL(file, dist))) errors.push(`missing ${file}`);
}
const content = read("assets/content.js");
if (
  /^\s*import[\s{*]|\bimport\s*\(/m.test(content) ||
  /^export\s/m.test(content)
)
  errors.push("content.js must be a classic script without import/export");
// The only allowed fetches read ScreenFry's own packaged manifest.json and build.json (local
// extension files) to notice a newer build on disk; anything else would be a network request.
const ownManifestRead = /\bfetch\(\s*chrome\.runtime\.getURL\(\s*["'`](?:manifest|build)\.json["'`]\s*\)/g;
if (
  /\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket/.test(
    (read(manifest.background.service_worker) + content).replace(ownManifestRead, ""),
  )
)
  errors.push("background/content must not make network requests");

// The setup library is reached only from the settings page (docs/SETUP_LIBRARY.md): its
// address may appear only in code the dashboard alone loads, never in the background,
// content scripts, popup, welcome or blocked pages.
const libraryHosts = [
  ...readFileSync(new URL("../packages/core/src/library.ts", import.meta.url), "utf8").matchAll(/https:\/\/([a-z0-9.-]+\.workers\.dev)/g),
].map((m) => m[1]);
if (!libraryHosts.length) errors.push("couldn't find the library's addresses in packages/core/src/library.ts");
const loads = (entry) => {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file) || !existsSync(new URL(file, dist))) return;
    seen.add(file);
    const text = read(file);
    const refs = file.endsWith(".html")
      ? [...text.matchAll(/(?:src|href)="\/?([^"]+\.js)"/g)].map((m) => m[1])
      : [...text.matchAll(/(?:from|import)\s*["']\.\/([^"']+\.js)["']/g)].map((m) => `assets/${m[1]}`);
    refs.forEach(visit);
  };
  visit(entry);
  return seen;
};
const outsideDashboard = new Set(
  [manifest.background.service_worker, ...manifest.content_scripts.flatMap((e) => e.js), manifest.action.default_popup, "onboarding.html", "blocked.html"].flatMap((e) => [...loads(e)]),
);
for (const file of outsideDashboard)
  if (libraryHosts.some((host) => read(file).includes(host)))
    errors.push(`${file} holds the setup library's address; only the settings page may contact the library`);

if (errors.length) {
  console.error(`Build verification failed:\n- ${errors.join("\n- ")}`);
  process.exit(1);
}
console.log("Build verification passed.");
