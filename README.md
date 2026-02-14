# chip

<p align="center">
  <img src="assets/chip-wooden-blank.png" alt="Chip" width="400"/>
</p>

`chip` is a Cloudflare-first software factory that turns GitHub issues into pull requests.

## Intent

This repository is the standalone platform infrastructure for automated engineering execution across `sociotechnica-org` repos.

v0 is intentionally narrow:

- Auth to GitHub uses a PAT (`GITHUB_TOKEN`)
- Target repo is `sociotechnica-org/lifebuild` only
- Orchestration uses Cloudflare Agents + Workflows + Queues
- Implementation and verification run in Modal VMs
- Storage is SQLite-based (Cloudflare D1 and/or Durable Object SQLite)
- Web UI is Vite + React

## MVP Outcome

The first working version should:

1. Accept a GitHub issue reference.
2. Queue and orchestrate a run.
3. Execute implementation in a Modal VM using Claude Code.
4. Run repository verification commands.
5. Push a branch and open a draft or ready PR.
6. Expose run status, station progress, and logs.

## Planned Structure

```text
bob-the-builder/
  apps/
    control-worker/
    queue-consumer-worker/
    web/
  packages/
    core/
    config/
    adapters-github/
    adapters-modal/
    adapters-coderunner/
    observability/
    security/
  infra/
    wrangler/
  docs/
    plans/
```

## Docs

- Bootstrap plan: `docs/plans/001-bootstrap-v0/001-bootstrap-v0.md`
- PR1 implementation plan: `docs/plans/001-bootstrap-v0/pr1-implementation-plan.md`
- Architecture: `docs/architecture.md`

## PR1 Bootstrap Status

PR1 establishes the base monorepo scaffolding and a minimal Cloudflare worker slice:

- Workspace/tooling baseline (TypeScript, ESLint, Prettier, Vitest, Playwright, PNPM)
- `packages/core` run/station domain contracts
- `packages/security` shared password gate helpers
- `apps/control-worker` with `/healthz` and protected `/v1/ping`
- `apps/queue-consumer-worker` scaffold for future queue orchestration
- `apps/web` Vite + React placeholder app

## PR2 Control Plane Status

PR2 adds the first D1-backed control-plane APIs:

- D1 schema/migrations for `repos`, `runs`, `station_executions`, `artifacts`
- Queue producer wiring from `POST /v1/runs`
- Idempotent run creation with `Idempotency-Key`
- New authenticated endpoints:
  - `POST /v1/repos`
  - `GET /v1/repos`
  - `POST /v1/runs`
  - `GET /v1/runs`
  - `GET /v1/runs/:id`

## PR3 Execution Orchestration Status

PR3 adds the first asynchronous execution loop:

- `apps/queue-consumer-worker` now consumes run queue messages
- queue messages are validated and runs are claimed atomically (`queued -> running`)
- workflow skeleton executes stations in order:
  - `intake`
  - `plan`
  - `implement`
  - `verify`
  - `create_pr`
- run and station execution state are persisted to D1
- `GET /v1/runs/:id` now returns `run`, `stations`, and artifact summaries

## PR4 Adapter Execution Status

PR4 replaces placeholder station bodies with adapter-driven execution:

- `@bob/adapters-modal` provides typed submit/status/result transport primitives
- `@bob/adapters-coderunner` provides mock + modal Claude runner modes
- queue-consumer `implement` and `verify` stations now persist:
  - `external_ref` + `metadata_json` in `station_executions`
  - `implement_summary` / `verify_summary` artifacts
  - bounded `*_runner_logs_excerpt` artifacts
- stale running runs resume externalized station work by polling existing `external_ref`

## Getting Started

Brand new local instance:

```bash
pnpm setup
```

Start the full local stack (control worker, queue-consumer worker, and web app):

```bash
pnpm dev
```

Default local ports:

- Control worker: `http://127.0.0.1:20287`
- Queue-consumer worker: `http://127.0.0.1:20288`
- Web app: `http://127.0.0.1:6673`

For reliable local end-to-end queue execution during `pnpm dev`, configure:

- `apps/control-worker/.dev.vars`:
  - `BOB_PASSWORD=...`
  - `LOCAL_QUEUE_CONSUMER_URL=http://127.0.0.1:20288`
  - `LOCAL_QUEUE_SHARED_SECRET=...`
- `apps/queue-consumer-worker/.dev.vars`:
  - `LOCAL_QUEUE_SHARED_SECRET=...` (must match control worker)
  - `CODERUNNER_MODE=mock` (default; CI-safe)
  - `CLAUDE_CODE_API_KEY=...` (required when `CODERUNNER_MODE=modal`)
  - `MODAL_TOKEN_ID=...` (required when `CODERUNNER_MODE=modal`)
  - `MODAL_TOKEN_SECRET=...` (required when `CODERUNNER_MODE=modal`)

For real adapter QA, switch queue-consumer to modal mode:

```bash
export CODERUNNER_MODE=modal
```

Reset local runtime state and rebuild a fresh local instance:

```bash
pnpm reset
```

Common quality commands:

```bash
pnpm lint-all         # lint:fix + format:fix
pnpm lint:check       # typecheck + lint + format:check (CI-safe)
pnpm test             # unit + integration
pnpm test:unit        # unit tests only
pnpm test:integration # smoke/integration tests only
pnpm smoke            # all smoke suites
```

Run the control worker locally:

```bash
pnpm migrate
pnpm --filter @bob/control-worker dev
```

In another shell, probe endpoints:

```bash
curl -i http://127.0.0.1:20287/healthz
curl -i http://127.0.0.1:20287/v1/ping
curl -i -H \"Authorization: Bearer $BOB_PASSWORD\" http://127.0.0.1:20287/v1/ping
curl -i -H \"Authorization: Bearer $BOB_PASSWORD\" -H \"Content-Type: application/json\" \
  -d '{"owner":"sociotechnica-org","name":"lifebuild"}' \
  http://127.0.0.1:20287/v1/repos
curl -i -H \"Authorization: Bearer $BOB_PASSWORD\" -H \"Content-Type: application/json\" \
  -H \"Idempotency-Key: run-123\" \
  -d '{"repo":{"owner":"sociotechnica-org","name":"lifebuild"},"issue":{"number":123},"requestor":"jess","prMode":"draft"}' \
  http://127.0.0.1:20287/v1/runs
```

Run an automated local Vitest integration smoke test for the control worker:

```bash
pnpm smoke:control-worker
```

Run queue-consumer smoke coverage:

```bash
pnpm smoke:queue-consumer-worker
```
