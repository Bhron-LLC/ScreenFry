import { beforeEach } from "vitest";
import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Every test starts with an empty library.
beforeEach(async () => {
  await env.DB.batch(
    ["setups_fts", "reports", "votes", "setup_tags", "setup_websites", "setups", "publishers", "activity"].map((t) =>
      env.DB.prepare(`DELETE FROM ${t}`),
    ),
  );
});
