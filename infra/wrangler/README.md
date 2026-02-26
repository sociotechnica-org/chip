# Wrangler Notes

This folder documents shared Wrangler conventions for `bob-the-builder` worker apps.

## PR1 Baseline

All worker configs should use `wrangler.jsonc` with:

- `compatibility_date`: `2025-03-07`
- `compatibility_flags`: `["nodejs_compat"]`
- `observability.enabled`: `true`
- `observability.head_sampling_rate`: `1`

## Local Development

Each worker app can use `.dev.vars` locally. Do not commit secrets.

Expected v0 secret variables:

- `BOB_PASSWORD`
- `GITHUB_TOKEN`
- `CODERUNNER_MODE` (`mock` or `sprites`; mock is default)
- `SPRITE_TOKEN`
- `SPRITE_NAME`
- `SPRITES_API_BASE_URL`
- `SPRITES_TIMEOUT_MS`
- `CLAUDE_CODE_API_KEY`

## Control Worker D1 + Queue (PR2)

`apps/control-worker/wrangler.jsonc` now binds:

- `DB` (D1)
- `RUN_QUEUE` (Queue producer)

Apply migrations locally before hitting repo/run endpoints:

```bash
pnpm --filter @bob/control-worker exec wrangler d1 migrations apply DB --local --config wrangler.jsonc
```

Run the worker locally:

```bash
pnpm --filter @bob/control-worker dev --local
```

## Environment Promotion Plumbing (PR8)

Both worker configs now define explicit Wrangler environments:

1. `staging`
2. `production`

Environment-specific deploy scripts:

```bash
pnpm deploy:staging
pnpm deploy:production
```

Control-worker migration scripts:

```bash
pnpm migrate:staging
pnpm migrate:production
```

Promotion sequence:

1. run `pnpm migrate:staging`
2. run `pnpm deploy:staging`
3. verify staging canary + smoke coverage
4. run `pnpm migrate:production`
5. run `pnpm deploy:production`
6. monitor baseline alerts during post-deploy window

See detailed procedures in:

- `docs/operations/environment-promotion.md`
- `docs/operations/migration-discipline.md`
