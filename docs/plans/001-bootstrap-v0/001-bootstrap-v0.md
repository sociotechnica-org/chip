# 001 - Bootstrap v0 Plan

Status: Active  
Date: 2026-02-17  
Scope: Bootstrap and production-readiness path for `bob-the-builder` v0

## 1. Objective

Ship a reliable, observable, and secure-enough v0 pipeline that turns a GitHub issue into a draft or ready PR for one target repo.

Target outcome for v0:

1. Input: GitHub issue number for `sociotechnica-org/lifebuild`.
2. Process: queue + workflow orchestration + Modal execution + GitHub integration.
3. Output: created PR, full run timeline, and actionable artifacts/logs for operators.

## 2. Confirmed v0 Decisions

1. GitHub auth uses PAT via `GITHUB_TOKEN`.
2. Initial target repo is only `sociotechnica-org/lifebuild`.
3. Verification commands are sourced from target repo instructions (`AGENTS.md` plus project OpenCode instructions/config).
4. PR mode can be `draft` or `ready` from run instructions.
5. Shared password gate is acceptable for v0 but not final production auth.

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

## 5. End-to-End Run Flow (Target v0)

1. `POST /v1/runs` accepts `{ repo, issue, requestor, prMode }`.
2. Control worker validates input, writes queued run to D1, publishes queue message.
3. Queue consumer claims run and executes workflow stations in order.
4. Stations:
   - `intake`: fetch issue context
   - `plan`: generate short implementation plan
   - `implement`: Sprites VM + coderunner execution
   - `verify`: run repo checks
   - `create_pr`: push branch + open PR
5. Run, station, and artifact state persist in D1; large logs/artifacts move to R2.
6. Dashboard exposes run list, run detail, station timeline, and artifact/log access.

## 6. Data Model (D1 Baseline)

1. `repos`: target repo metadata and enablement.
2. `runs`: run lifecycle, branch metadata, PR state, failure and heartbeat fields.
3. `station_executions`: per-station timing, status, and external execution refs.
4. `artifacts`: snapshots/logs/plans/reports with `inline` or `r2` storage.
5. `run_idempotency_keys`: safe `POST /v1/runs` retries.

## 7. API Surface

Bootstrap API:

1. `POST /v1/repos`
2. `GET /v1/repos`
3. `POST /v1/runs`
4. `GET /v1/runs`
5. `GET /v1/runs/:id`
6. `GET /healthz`

Production-complete additions:

1. `POST /v1/runs/:id/cancel`
2. `POST /v1/runs/:id/retry` (or equivalent operator replay endpoint)
3. artifact/log retrieval endpoints if run detail payload becomes too large

All non-health routes are password-protected in v0, with production auth upgrade planned.

## 8. Current Implementation Status (as of 2026-02-17, assuming GitHub PR #5 merges soon)

Completed slices:

1. Foundation Scaffold (monorepo + tooling + security baseline).
2. Control Plane Data + Queue Producer (D1 schema + repo/run API + queue publish).
3. Execution Orchestration Skeleton (queue consumer + workflow station persistence).

In-flight:

1. Adapter-Driven Execution (`implement`/`verify` via Modal + coderunner) is in GitHub PR #5 (`Implement PR4 adapter-driven execution pipeline`) and expected to merge imminently.

Next slice:

1. GitHub PR Creation (`create_pr` real behavior) is next after GitHub PR #5 merges.

Historical mapping (legacy numeric labels):

1. Legacy PR1 -> Foundation Scaffold.
2. Legacy PR2 -> Control Plane Data + Queue Producer.
3. Legacy PR3 -> Execution Orchestration Skeleton.
4. Legacy PR4 -> Adapter-Driven Execution.
5. Legacy PR5 -> GitHub PR Creation.
6. Legacy PR6 -> Web Dashboard v0.
7. Legacy PR7 -> Reliability Hardening.

## 9. Delivery Plan (Expanded Slice Sequence)

### Phase A: Close the Real Issue-to-PR Loop

1. Adapter-Driven Execution: complete via GitHub PR #5 (pending merge).
2. GitHub PR Creation: GitHub adapter + real `create_pr` station (branch push + PR open).
3. Web Dashboard v0: run list, run detail timeline, artifact/log viewer.

### Phase B: Production Hardening

1. Reliability Hardening.
   - cancel semantics
   - retry/requeue policy
   - stronger idempotency and resume guarantees under redelivery/restarts
2. Artifact/Log Storage Hardening.
   - R2 offload for large payloads
   - bounded inline excerpts
   - retention policy and artifact metadata normalization
3. Security Hardening.
   - replace shared password with real operator auth
   - tighten secret handling and environment separation
   - audit logging for privileged actions

### Phase C: Launch Readiness

1. Observability + SLOs.
   - structured events, trace correlation, failure taxonomy
   - dashboards and alerts for run latency/failure/retry
2. Staging and Production Rollout Plumbing.
   - environment-specific Wrangler config and promotion flow
   - migration/runbook discipline and rollback procedure
3. Production-Readiness Validation.
   - soak/load tests for queue and workflow throughput
   - fault-injection checks for provider/API failures
   - final launch checklist and go-live decision doc

## 10. Slice Gate Criteria

Each delivery slice should satisfy:

1. Clear user-visible capability gain.
2. Failure-path behavior defined and tested.
3. Idempotency and resume behavior preserved.
4. `pnpm lint:check`, `pnpm test`, and relevant smoke coverage pass.
5. Docs updated for setup, env vars, and operator QA.

## 11. Environment Variables (v0+)

Current required:

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

Expected additions during production hardening:

1. auth/session secrets for non-password operator auth
2. R2 bucket bindings for artifact storage
3. observability/alert routing secrets where needed

## 12. Definition of Done for Production v0

1. A real issue can be submitted and reliably reaches a draft/ready PR without manual DB intervention.
2. Runs are observable end-to-end with station history and actionable logs/artifacts.
3. Cancel and retry paths are operator-safe and tested.
4. Platform has staging and production deployment playbooks with rollback.
5. Alerting exists for queue backlog growth, workflow failures, and provider outages.

## 13. Immediate Next Action (Post-Merge GitHub PR Creation Slice)

After GitHub PR #5 merges, start the GitHub PR Creation slice immediately.

GitHub PR Creation slice goals:

1. Define `@bob/adapters-github` contract and error taxonomy.
2. Replace `create_pr` placeholder with real branch push + PR creation behavior.
3. Enforce idempotent retries for partial-success cases (branch already pushed, PR not yet created).
4. Persist branch, commit, and PR metadata in `runs`/artifacts.
5. Add CI-safe mock GitHub tests plus one credentialed manual QA flow.
6. Include any required Adapter-Driven Execution stabilization fixes discovered during review before tagging this slice complete.
