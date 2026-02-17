# 001 - Bootstrap v0 Plan

Status: Draft  
Date: 2026-02-10  
Scope: Initial platform bootstrap for `bob-the-builder`

## 1. Objective

Deliver the smallest usable "issue to PR" software factory path for one target repo:

- Input: GitHub issue number
- Process: orchestrated pipeline with queue + workflow + VM execution
- Output: draft/ready PR and visible run status/logs

## 2. Confirmed v0 Decisions

1. GitHub auth uses PAT via `GITHUB_TOKEN`.
2. Initial target repo is only `sociotechnica-org/lifebuild`.
3. Verification commands are sourced from target repo instructions (`AGENTS.md` plus project OpenCode instructions/config).
4. PR mode can be `draft` or `ready` from run instructions.
5. Shared password gate is acceptable for v0.

## 3. Constraints

1. Cloudflare-first runtime using Agents + Workflows.
2. Sprites is required for implementation/verification VM execution.
3. Storage must be SQLite-based (D1 and/or Durable Object SQLite).
4. Frontend uses Vite + React (not Next.js App Router).
5. Queueing uses Cloudflare Queues.
6. Tooling baseline: TypeScript, PNPM, Vitest, Playwright, ESLint, Prettier.
7. Coderunner standardizes on OpenCode, with adapter boundaries preserved for future runner swaps.

## 4. Proposed Monorepo Layout

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
    adapters-sprites/
    adapters-coderunner/
    observability/
    security/
  infra/
    wrangler/
  docs/
    plans/
```

## 5. End-to-End Run Flow (MVP)

1. `POST /v1/runs` accepts `{ repo, issue, requestor, prMode }`.
2. Control worker validates input, writes queued run to D1, publishes queue message.
3. Queue consumer starts Workflow instance.
4. Workflow runs stations in order:
   - `intake`: fetch issue context
   - `plan`: generate short implementation plan
   - `implement`: Sprites VM + coderunner execution
   - `verify`: run repo checks
   - `create_pr`: push branch + open PR
5. Agent state mirrors run progress for live status streaming.

## 6. Initial Data Model (D1)

1. `repos`: target repo metadata and enablement.
2. `runs`: run lifecycle, branch metadata, PR state.
3. `station_executions`: per-station timing and status.
4. `artifacts`: snapshots/logs/plans/reports with `inline` or `r2` storage.

## 7. API Surface (MVP)

1. `POST /v1/repos`
2. `GET /v1/repos`
3. `POST /v1/runs`
4. `GET /v1/runs`
5. `GET /v1/runs/:id`
6. `POST /v1/runs/:id/cancel`
7. `GET /healthz`

All non-health routes are password-protected for v0.

## 8. Delivery Plan (PR Sequence)

1. PR1: Monorepo scaffold, tooling, core types, password middleware.
2. PR2: D1 schema + repo/run API + queue producer.
3. PR3: Queue consumer + Workflow skeleton + station persistence.
4. PR4: Sprites adapter + OpenCode runner adapter.
5. PR5: GitHub adapter + PR creation station.
6. PR6: Vite web dashboard (runs list/detail/artifacts).
7. PR7: Hardening (retries, cancel, R2 artifacts, test coverage uplift).

## 9. Environment Variables (v0)

1. `GITHUB_TOKEN`
2. `BOB_PASSWORD`
3. `SPRITE_TOKEN`
4. `SPRITE_NAME`
5. `SPRITES_API_BASE_URL` (optional, defaults to `https://api.sprites.dev`)
6. `SPRITES_TIMEOUT_MS` (optional)
7. `OPENCODE_MODEL` (for example `anthropic/claude-sonnet-4-20250514`)
8. Provider credential env var(s) used by OpenCode config (for example `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.)

## 9.1 Ramp-Inspired Implementation Notes

The Ramp background-agent architecture suggests a few implementation patterns we should carry into v0:

1. Treat each run as a durable agent session with explicit resume points, not a single fire-and-forget command.
2. Keep two artifact channels:
   - primary execution stream (full tool logs/checkpoints)
   - compact operator summary stream (small, always-readable run/station status)
3. Prefer framework-native extension points over prompt hacks:
   - OpenCode plugins/hooks for guardrails, retries, and tool policy
   - explicit lifecycle events for observability and control
4. Persist more than text output:
   - session id/external ref
   - model/provider/mode metadata
   - tool invocations and terminal reason
5. Design for human-in-the-loop transitions (pause/resume/escalate) without discarding agent context.

## 10. Definition of Done for Bootstrap Phase

1. Typecheck, lint, and tests pass.
2. One local E2E path works: run submission -> queue -> workflow -> implement -> verify -> PR.
3. Dashboard reflects live run progression and station outcomes.
4. Draft-vs-ready PR behavior is enforced by run instructions.

## 11. Immediate Next Action

Start PR1 with a vertical slice that includes:

- Monorepo scaffolding and workspace wiring
- Shared domain contracts in `packages/core`
- Security middleware in `packages/security`
- Minimal control worker health and protected route skeleton
