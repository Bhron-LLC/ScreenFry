# Setup library server

The Cloudflare Worker behind ScreenFry's setup library: publish, search, get, vote on and report setups (share codes with a title, description and tags). The plan, decisions and privacy rules are in [docs/SETUP_LIBRARY.md](../../docs/SETUP_LIBRARY.md).

- `src/index.ts`: the routes, rate limits and moderation. `src/auth.ts`: signed requests (each install's anonymous P-256 key).
- `migrations/`: the D1 schema. Add a new numbered file for every change; never edit one that's been applied.
- Codes are checked and rebuilt with `packages/core/src/library.ts`, the same code the extension uses. The Worker imports it through `tsconfig.json`'s `paths`.
- `scripts/admin.mjs`: list hidden or reported setups, restore, remove, block or unblock a publisher.

## Working on it

Uses the repository's Node (`.nvmrc`). Run these in `services/library`:

```bash
npm ci
```

```bash
npm run check
```

`npm run check` typechecks and runs the tests inside the Workers runtime against a local D1 (no Cloudflare account or network). `npm run dev` serves it at `http://localhost:8787` with a local database. Apply the migrations to that database first with `npx wrangler d1 migrations apply DB --local`.

## Deploying

| | Address | Wrangler environment |
| --- | --- | --- |
| Test | `https://screenfry-library-test.bhron-site.workers.dev` | `--env test` |
| Production | `https://screenfry-library.bhron-site.workers.dev` | `--env production` |

Both are on the Cloudflare account's free workers.dev subdomain, so they need no domain or DNS changes. Deploying needs `npx wrangler login` with that account.

The first time for each environment, create its database with `npx wrangler d1 create screenfry-library-test` (or `screenfry-library`), and put the `database_id` it prints into that environment's `d1_databases` entry in `wrangler.jsonc`. Then set the admin token, typing it yourself so it stays out of the repository:

```bash
npx wrangler secret put ADMIN_TOKEN --env test
```

After that, every deploy applies new migrations and uploads the Worker:

```bash
npm run deploy:test
```

`npm run deploy:production` does the same for the real library, from `main` only. Still to add: a GitHub Actions deploy job with a Cloudflare API token stored as a repository secret.
