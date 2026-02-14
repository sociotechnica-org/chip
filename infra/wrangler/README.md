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
- `CODERUNNER_MODE` (`mock` or `modal`; mock is default)
- `MODAL_TOKEN_ID`
- `MODAL_TOKEN_SECRET`
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
