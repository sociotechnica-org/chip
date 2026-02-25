# Architecture

## Overview

`bob-the-builder` is a Cloudflare-first software factory platform that takes an engineering work item (starting with a GitHub issue) and drives an automated pipeline to produce a pull request.

For v0, the platform is scoped to one target repository: `sociotechnica-org/lifebuild`.

## Architecture Goals

1. Ship a working issue-to-PR path quickly.
2. Keep long-running orchestration durable and observable.
3. Separate platform logic from provider integrations through adapters.
4. Keep security simple in v0 but easy to replace later.
5. Use SQLite-backed state and Cloudflare-native primitives.

## System Components

### `apps/control-worker`

- Public API surface for repos and runs.
- Validates requests and applies password gate.
- Writes run records to D1.
- Produces queue messages for asynchronous processing.
- Exposes health endpoint.

### `apps/queue-consumer-worker`

- Consumes run messages from Cloudflare Queues.
- Starts/coordinates Workflow instances for each run.
- Handles retries and failed message behavior.

### Cloudflare Workflows

- Durable run orchestrator with station-based execution.
- Persists station transitions and outcomes.
- Supports cancellation and retry policies.

### Cloudflare Agents

- Per-run realtime state mirror.
- Provides websocket-friendly run status/event stream to the web UI.

### Sprites Execution Layer

- Runs repository implementation and verification inside VM sandboxes.
- Hosts coderunner invocation (`claude-code` first in v0).
- Produces logs and execution artifacts.

### Web App (`apps/web`)

- Vite + React dashboard.
- Run list, run detail timeline, artifact/log viewer.
- Trigger run by repo and issue number.

### Shared Packages

- `packages/core`: domain types, enums, state machine contracts.
- `packages/config`: `.bob/factory.yaml` schema and loader.
- `packages/adapters-github`: issue, branch, and PR API operations.
- `packages/adapters-sprites`: Sprites API client and job orchestration.
- `packages/adapters-coderunner`: pluggable runner interface and implementations.
- `packages/observability`: structured logging and trace/event contracts.
- `packages/security`: shared password middleware + cookie/session helpers.

## Data Architecture

Primary persistent data lives in Cloudflare D1.

### `repos`

- target repository metadata and enablement
- default branch and config path metadata

### `runs`

- run identity, requested issue, and requestor
- lifecycle status: `queued | running | succeeded | failed | canceled`
- branch metadata and PR mode (`draft | ready`)
- PR URL and timestamps

### `station_executions`

- per-station execution records
- station status: `pending | running | succeeded | failed | skipped`
- timing and summary data

### `artifacts`

- run artifacts such as issue snapshot, plan, patch summary, verify report, logs
- payload storage strategy: `inline` or `r2`

## Run Orchestration

1. `POST /v1/runs` receives repo + issue + request metadata.
   - Requires `Idempotency-Key` for safe retries.
2. Control worker stores run as `queued` in D1 and enqueues message.
3. Queue consumer starts a workflow instance.
4. Workflow executes ordered stations:
   - `intake`: read issue context and snapshot artifacts
   - `plan`: generate implementation plan artifact
   - `implement`: Sprites VM + coderunner execution on work branch
   - `verify`: run repo checks from target repo instructions
   - `create_pr`: push branch and open draft/ready PR
5. Workflow updates D1 and Agent state throughout execution.
6. Web clients consume run status, station timeline, and artifacts.

## Security Model (v0)

v0 uses a shared password gate:

- API access via `Authorization: Bearer <password>`
- Web login via lightweight signed cookie
- Secret source: `BOB_PASSWORD`

This is isolated in `packages/security` so it can be replaced with stronger auth later.

## External Integrations

### GitHub

- Read issue title/body/comments.
- Create branch, commit/push changes, and open PR.
- Auth uses `GITHUB_TOKEN` (PAT) in v0.

### Sprites

- Provision execution VM.
- Run coderunner and verify commands.
- Return logs and execution metadata to platform.

### Coderunner Adapter

Canonical interface:

- `runIssueTask(input) -> { success, branch, summary, logsRef }`

Implementations:

1. `ClaudeCodeRunner` (v0 primary)
2. `OpenCodeRunner` (stub/evaluation path)

## Environment Variables (v0)

1. `GITHUB_TOKEN`
2. `BOB_PASSWORD`
3. `SPRITE_TOKEN`
4. `SPRITE_NAME`
5. `SPRITES_API_BASE_URL` (optional)
6. `SPRITES_TIMEOUT_MS` (optional)
7. `CLAUDE_CODE_API_KEY`

## Planned Delivery Slices

1. PR1: scaffold + tooling + core + security
2. PR2: D1 schema + repo/run API + queue producer
3. PR3: queue consumer + workflow skeleton + station persistence
4. PR4: Sprites adapter + Claude Code integration
5. PR5: GitHub adapter + PR station
6. PR6: web dashboard
7. PR7: hardening (retry/cancel/artifacts/tests)
8. PR8: launch readiness (promotion/rollback runbooks, observability baseline, launch gates)
