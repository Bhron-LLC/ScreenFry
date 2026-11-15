#!/usr/bin/env node
// Moderates the setup library. Needs the library's address and the admin token (the one set
// with `wrangler secret put ADMIN_TOKEN`), from the environment so they stay out of the shell
// history:
//
//   LIBRARY_URL=https://… LIBRARY_ADMIN_TOKEN=… node scripts/admin.mjs hidden
//   … restore <setup id>     put a hidden setup back (reports no longer hide it)
//   … remove <setup id>      take a setup out for good
//   … block <publisher id>   stop a key publishing, voting or reporting; hides its setups
//   … unblock <publisher id>
const [command, id] = process.argv.slice(2);
const base = process.env.LIBRARY_URL?.replace(/\/+$/, "");
const token = process.env.LIBRARY_ADMIN_TOKEN;
const routes = {
  hidden: ["GET", "/admin/hidden"],
  restore: ["POST", `/admin/setups/${id}/restore`],
  remove: ["POST", `/admin/setups/${id}/remove`],
  block: ["POST", `/admin/publishers/${id}/block`],
  unblock: ["POST", `/admin/publishers/${id}/unblock`],
};
if (!base || !token || !routes[command] || (command !== "hidden" && !id)) {
  console.error("Usage: LIBRARY_URL=… LIBRARY_ADMIN_TOKEN=… node scripts/admin.mjs hidden | restore <id> | remove <id> | block <publisher> | unblock <publisher>");
  process.exit(2);
}
const [method, path] = routes[command];
const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}` } });
const body = await response.json().catch(() => ({}));
if (!response.ok) {
  console.error(`${response.status}: ${body.error ?? "failed"}`);
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
