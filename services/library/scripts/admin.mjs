#!/usr/bin/env node
// Moderates the setup library. Run it in a terminal from any folder:
//
//   node services/library/scripts/admin.mjs hidden            list hidden and reported setups
//   … restore <setup id>     put a hidden setup back (reports no longer hide it)
//   … remove <setup id>      take a setup out for good
//   … block <publisher id>   stop a key publishing, voting or reporting; hides its setups
//   … unblock <publisher id>
//
// It uses the test server unless you add --production. It asks for the admin password (the
// one set with `wrangler secret put ADMIN_TOKEN`) without showing it, so the password stays
// out of your shell history. LIBRARY_URL and LIBRARY_ADMIN_TOKEN in the environment override
// both, for scripts.
const URLS = {
  // Same as LIBRARY_URLS in packages/core/src/library.ts.
  production: "https://screenfry-library.bhron-site.workers.dev",
  test: "https://screenfry-library-test.bhron-site.workers.dev",
};
const args = process.argv.slice(2);
const production = args.includes("--production");
const [command, id] = args.filter((a) => a !== "--production");
const base = (process.env.LIBRARY_URL ?? (production ? URLS.production : URLS.test)).replace(/\/+$/, "");
const routes = {
  hidden: ["GET", "/admin/hidden"],
  restore: ["POST", `/admin/setups/${id}/restore`],
  remove: ["POST", `/admin/setups/${id}/remove`],
  block: ["POST", `/admin/publishers/${id}/block`],
  unblock: ["POST", `/admin/publishers/${id}/unblock`],
};
if (!routes[command] || (command !== "hidden" && !id)) {
  console.error("Usage: node services/library/scripts/admin.mjs [--production] hidden | restore <id> | remove <id> | block <publisher> | unblock <publisher>");
  process.exit(2);
}

/** Reads a line without echoing it. */
function askHidden(prompt) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      console.error("Run this in a terminal so it can ask for the admin password (or set LIBRARY_ADMIN_TOKEN).");
      process.exit(2);
    }
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    let value = "";
    const finish = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off("data", onData);
      process.stdout.write("\n");
    };
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === "\r" || c === "\n") {
          finish();
          return resolve(value);
        }
        if (c === "\u0003") {
          finish();
          process.exit(130);
        }
        if (c === "\u007f" || c === "\b") value = value.slice(0, -1);
        else value += c;
      }
    };
    process.stdin.on("data", onData);
  });
}

const token = process.env.LIBRARY_ADMIN_TOKEN || (await askHidden(`Admin password for ${new URL(base).host}: `));
const [method, path] = routes[command];
const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}` } });
const body = await response.json().catch(() => ({}));
if (response.status === 404 && command === "hidden") {
  console.error("The library didn’t accept that admin password.");
  process.exit(1);
}
if (!response.ok) {
  console.error(`${response.status}: ${body.error ?? "failed"}${response.status === 404 ? " (or the admin password is wrong)" : ""}`);
  process.exit(1);
}
if (command !== "hidden") console.log(JSON.stringify(body));
else if (!body.setups.length) console.log("Nothing is hidden or reported.");
else
  for (const s of body.setups) {
    console.log(`${s.id}  ${s.status.padEnd(7)}  "${s.title}"  publisher ${s.publisher}`);
    if (s.description) console.log(`    ${s.description}`);
    for (const r of s.reports) console.log(`    report: ${r.reason}${r.note ? ` — ${r.note}` : ""}`);
  }
