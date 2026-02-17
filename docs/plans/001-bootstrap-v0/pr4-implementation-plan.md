# PR4 Detailed Implementation Plan

Status: Implemented  
Date: 2026-02-13  
Parent Plan: `docs/plans/001-bootstrap-v0/001-bootstrap-v0.md`  
Previous Slice: `docs/plans/001-bootstrap-v0/pr3-implementation-plan.md`

## 1. PR4 Objective

Replace PR3 placeholder execution behavior with real execution adapters while preserving PR3 orchestration guarantees.

Concretely:

1. Implement `@bob/adapters-sprites` as the execution transport layer.
2. Implement `@bob/adapters-coderunner` with a Claude Code runner contract.
3. Wire queue-consumer `implement` and `verify` stations to the adapters.
4. Persist actionable artifacts and logs from real execution.
5. Keep system idempotent and recoverable under queue redelivery and worker restarts.

## 2. Why This Slice Now

PR3 proved orchestration, persistence, and queue idempotency shape. The biggest remaining gap is business value inside station bodies. PR4 should make execution real so a run does meaningful work before PR5 adds GitHub branch push + PR creation.

## 3. Scope

### In Scope

1. Adapter contracts in shared domain package(s) and concrete implementations in:
   - `packages/adapters-sprites`
   - `packages/adapters-coderunner`
2. Queue-consumer station implementation for:
   - `implement` (real coderunner execution path)
   - `verify` (real verification command execution path)
3. Artifact persistence for execution outputs:
   - run logs summary
   - implement summary
   - verify summary
4. Execution resume semantics for stale running runs, including external job references.
5. Unit/integration/smoke coverage for adapter-driven station paths.
6. Local QA flow that can run in:
   - mock adapter mode (CI/default)
   - real adapter mode (manual with secrets)

### Out of Scope

1. Real GitHub branch push/commit/PR creation (PR5).
2. Web dashboard feature expansion (PR6).
3. R2 artifact offloading and log chunk storage hardening (PR7).
4. New auth model changes.
5. Large cancellation semantics redesign.

## 4. Target Behavior After PR4

For `POST /v1/runs`:

1. Run is enqueued and consumed as today.
2. `intake` and `plan` still produce lightweight artifacts.
3. `implement` uses adapters to execute Claude Code task in Sprites-backed runtime.
4. `verify` executes configured checks using the same runtime contract.
5. Run ends `succeeded` only if both `implement` and `verify` are successful.
6. `GET /v1/runs/:id` returns station timeline and execution artifacts that are meaningful for operators.

## 5. Design Principles for PR4 (to reduce review churn)

1. Separate orchestration concerns from station business logic.
2. Keep one authoritative failure path per station type.
3. Use explicit typed result envelopes from adapters.
4. Never infer external-execution success from local bridge behavior.
5. Make resume/retry decisions based on persisted execution metadata, not heuristics.
6. Keep DB writes compare-and-set where races are possible.

## 6. Architecture Changes

## 6.1 Introduce Station Executor Layer

Inside queue-consumer, split current flow into:

1. `processQueueMessage` for claim/defer/ack/retry policy only.
2. `runWorkflowSkeleton` for station ordering and terminal transitions.
3. `executeStation` as a thin wrapper around per-station executors.
4. `executeImplementStation` and `executeVerifyStation` for adapter orchestration.

This keeps redelivery and run-state policy stable while allowing station internals to evolve.

## 6.2 Adapter Contract-First Integration

Define contracts before implementation:

1. Sprites transport contract:
   - submit execution
   - poll execution status
   - fetch logs/result payload
2. Coderunner contract:
   - run implement task
   - run verify task
   - return structured status + summaries + optional logs reference

Queue-consumer should depend on interfaces, not on concrete adapter construction details.

## 7. Data Model Changes

PR3 has enough base schema for run/station/artifact state, but PR4 needs stable resume data for external jobs.

Add migration `apps/control-worker/migrations/0003_station_execution_external_refs.sql`:

1. `ALTER TABLE station_executions ADD COLUMN external_ref TEXT;`
2. `ALTER TABLE station_executions ADD COLUMN metadata_json TEXT;`

Usage:

1. `external_ref`: provider execution id (Sprites execution id or equivalent).
2. `metadata_json`: compact JSON for adapter-specific resume data (attempt, runner mode, timing).

Why this is necessary:

1. Avoid restarting station work blindly on stale resume.
2. Allow redelivery path to continue polling known external execution instead of spawning duplicates.

## 8. Shared Contracts and Types

Add domain types to `packages/core` (or a focused shared module if preferred):

1. `ExecutionPhase = "implement" | "verify"`
2. `ExecutionOutcome = "succeeded" | "failed" | "canceled" | "timeout"`
3. `StationExecutionResult`:
   - `outcome`
   - `summary`
   - `logsInline?`
   - `externalRef?`
   - `metadata?`
4. Adapter interfaces:
   - `SpritesExecutionTransport`
   - `CoderunnerAdapter`

Add validators/type guards for any JSON persisted in `metadata_json`.

## 9. Adapter Implementation Plan

## 9.1 `@bob/adapters-sprites`

Implement:

1. Auth config loader from env:
   - `SPRITE_TOKEN`
   - `SPRITE_NAME`
   - `SPRITES_API_BASE_URL` (optional)
   - `SPRITES_TIMEOUT_MS` (optional)
2. Minimal client with explicit request/response parsing.
3. `submitJob`, `getJobStatus`, `getJobResult` style primitives.
4. Error mapping:
   - auth/config errors
   - retryable transport errors
   - terminal provider errors

Non-goal in PR4:

1. Broad Sprites API surface.

## 9.2 `@bob/adapters-coderunner`

Implement:

1. `ClaudeCodeRunner` using Sprites transport dependency injection.
2. `runImplementTask(input)` and `runVerifyTask(input)` returning `StationExecutionResult`.
3. Standardized summary fields for DB and artifact writing.

Execution modes:

1. `mock` mode for tests/CI.
2. `sprites` mode for real manual QA.

Mode selected by env var (for example `CODERUNNER_MODE=mock|sprites`).

## 10. Queue Consumer Integration Plan

## 10.1 Implement Station

For `implement`:

1. Load run context from D1 (repo, issue, goal, requestor, base branch, pr mode).
2. If station has `external_ref` and non-terminal metadata, resume/poll existing external execution.
3. Else start new execution via coderunner.
4. Persist `external_ref` and `metadata_json` as soon as available.
5. On terminal success:
   - station `succeeded`
   - write implement artifact(s)
6. On terminal failure:
   - station `failed`
   - bubble to workflow failure path.

## 10.2 Verify Station

For `verify`:

1. Use same resume-or-start pattern as `implement`.
2. Execute verification commands from configured repo instructions path.
3. Persist verify summary artifact and logs summary.

## 10.3 Resume Semantics

When stale `running` run is reclaimed:

1. Continue from `current_station` logic added in PR3.
2. For externalized stations, check station `external_ref`:
   - if present: poll/resume existing external execution
   - if missing: start new execution
3. Never rewind already-succeeded stations.

## 11. Artifact Strategy in PR4

Keep storage simple and inline first:

1. `implement_summary` artifact.
2. `verify_summary` artifact.
3. `runner_logs_excerpt` artifact (bounded size).

Rules:

1. Truncate large logs to bounded payload with note.
2. Save provider execution ids in station metadata, not in ad-hoc text only.

## 12. Configuration and Environment

Add/standardize worker env vars:

1. `SPRITE_TOKEN`
2. `SPRITE_NAME`
3. `CLAUDE_CODE_API_KEY`
4. `CODERUNNER_MODE` (`mock` default for local tests)
5. `SPRITES_API_BASE_URL` (optional)
6. `SPRITES_TIMEOUT_MS` (optional)

Update:

1. `apps/queue-consumer-worker/wrangler.jsonc` vars section.
2. local `.dev.vars` templates and setup docs.

## 13. Testing Strategy

## 13.1 Unit Tests

Add adapter tests:

1. Sprites client request auth headers and error mapping.
2. Coderunner adapter success/failure/timeout mapping.
3. Resume behavior when `external_ref` exists.

Extend queue-consumer unit tests:

1. `implement` success path writes station + artifacts.
2. `implement` error path sets station `failed` and run `failed`.
3. stale resume continues from `current_station` without replaying succeeded stations.
4. redelivery with active `external_ref` polls instead of spawning duplicate execution.

## 13.2 Integration Tests

1. Keep smoke tests in mock mode.
2. Add integration cases around:
   - station metadata persistence
   - artifact payload shape
   - retry behavior under transient adapter errors.

## 13.3 CI

No external Sprites dependency in CI. CI should stay deterministic with mock adapter mode.

## 14. Manual QA Plan

### Mock Mode (required for merge confidence)

1. `pnpm setup`
2. `pnpm dev`
3. Create repo and run via API.
4. Verify `implement` and `verify` have real-looking summaries and artifacts (not placeholders).
5. Verify idempotency replay returns existing run and does not duplicate execution.

### Real Mode (pre-PR5 confidence path)

1. Set Sprites and Claude credentials in local env.
2. Set `CODERUNNER_MODE=sprites`.
3. Run same API flow.
4. Verify station metadata includes external refs and logs are captured.
5. Simulate consumer restart during `implement`; verify resume uses persisted external ref.

## 15. Acceptance Criteria

1. `implement` and `verify` no longer use placeholder station logic.
2. Adapter contracts are typed and unit-tested.
3. Queue redelivery/restart does not restart succeeded stations.
4. For externalized stations, stale resume prefers poll/continue over duplicate-start when `external_ref` exists.
5. Run/station/artifact state is internally consistent on success and failure.
6. `pnpm lint:check` and `pnpm test` pass.
7. Smoke tests pass in CI-safe mock mode.

## 16. Risks and Mitigations

1. Risk: duplicate external execution under redelivery.
   Mitigation: persist `external_ref` early and resume by polling.
2. Risk: provider API instability causes flaky runs.
   Mitigation: adapter-level retry classification and bounded backoff.
3. Risk: oversized logs in D1 artifacts.
   Mitigation: bounded excerpts in PR4, full log storage deferred to PR7/R2.
4. Risk: another iteration of failure-path churn.
   Mitigation: single station failure helper + contract-first adapters + explicit resume rules.

## 17. Suggested PR4 Internal Milestones

1. Milestone A: Contracts + migrations + adapter scaffolds with tests.
2. Milestone B: Sprites adapter concrete transport and tests.
3. Milestone C: Claude runner adapter and queue-consumer station integration.
4. Milestone D: Resume/idempotency hardening + smoke QA docs.

## 18. Handoff to PR5

After PR4:

1. `create_pr` can switch from placeholder to real GitHub adapter flow.
2. `implement` output can provide branch/patch metadata needed by PR creation.
3. Existing station persistence and artifact model should remain unchanged.

## 19. Open Questions for Post-PR4 Follow-up

1. Should PR4 set `work_branch` on runs from implement output even before PR5 pushes to GitHub?
2. Do we want verify failures to emit a separate `verify_report` artifact type now, or keep one generic summary artifact per station?
3. For real-mode local QA, do we want PR4 merge to require one credentialed manual run, or keep that optional until PR5?
