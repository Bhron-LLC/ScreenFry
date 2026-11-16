import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { alias } from "../../vite.shared.ts";

// Tests run inside the Workers runtime against a local D1, with the migrations applied
// before each file. No Cloudflare account or network is needed.
export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    resolve: { alias },
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations, ADMIN_TOKEN: "test-admin-token", SEARCH_CACHE_SECONDS: "0" },
        },
      }),
    ],
    test: { setupFiles: ["./test/apply-migrations.ts"] },
  };
});
