# Adapter-Driven Execution Plan

Status: In Review  
Date: 2026-02-21  
Parent Plan: `docs/plans/001-bootstrap-v0/001-bootstrap-v0.md`  
Legacy Label: PR4  
Current GitHub Delivery: PR #5 (`Implement PR4 adapter-driven execution pipeline`)

## 1. Objective

Replace placeholder station execution with real adapter-driven behavior while preserving queue/workflow idempotency guarantees.

Concretely:

1. Implement `@bob/adapters-modal` transport primitives.
2. Implement `@bob/adapters-coderunner` mock + modal runner modes.
3. Wire queue-consumer `implement` and `verify` stations to adapters.
4. Persist execution artifacts and resumable external execution metadata.
5. Keep stale-run resume and redelivery behavior deterministic.

## 2. Why This Slice Exists

The orchestration skeleton already proves queue consumption and station lifecycle persistence, but business value is still missing inside station bodies. This slice makes `implement` and `verify` execute real adapter logic so runs produce actionable execution outputs.

## 3. Scope

### In Scope

1. Contracts and types in `packages/core` for execution phases, outcomes, and adapter interfaces.
2. Concrete adapter implementation in:
   - `packages/adapters-modal`
   - `packages/adapters-coderunner`
3. Queue-consumer integration for `implement` and `verify` station execution paths.
4. Migration for station external execution metadata:
   - `apps/control-worker/migrations/0003_station_execution_external_refs.sql`
5. Artifact persistence for execution summaries and bounded log excerpts.
6. Unit + integration + smoke coverage for adapter and queue-consumer behavior.

### Out of Scope

1. Real `create_pr` behavior (next slice: GitHub PR Creation).
2. Dashboard feature expansion.
3. Full R2 artifact offload and retention policy hardening.
4. Final auth model replacement.

## 4. Target Behavior

For each queued run:

1. `intake` and `plan` continue lightweight artifact behavior.
2. `implement` invokes coderunner adapter and persists station summary + execution metadata.
3. `verify` invokes coderunner adapter and persists station summary + execution metadata.
4. Non-terminal adapter responses persist `external_ref` + `metadata_json` and trigger retry.
5. Terminal adapter failures mark station and run as failed with operator-usable summaries.
6. Successful terminal responses produce execution artifacts and continue workflow progression.

## 5. Data and Contracts

## 5.1 D1 Changes

1. Add `station_executions.external_ref`.
2. Add `station_executions.metadata_json`.

## 5.2 Shared Contracts

1. `ExecutionPhase`, `ExecutionOutcome`, and modal status enums.
2. `StationExecutionResponse` terminal vs in-progress envelopes.
3. `ModalExecutionTransport` and `CoderunnerAdapter` interfaces.
4. Metadata parser/validator for `metadata_json`.

## 6. Adapter Design

## 6.1 Modal Adapter

1. Load/validate auth env (`MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`).
2. Provide `submitJob`, `getJobStatus`, `getJobResult` primitives.
3. Map HTTP/provider errors into explicit retryable vs terminal classes.

## 6.2 Coderunner Adapter

1. Support `CODERUNNER_MODE=mock|modal`.
2. Implement `runImplementTask` and `runVerifyTask`.
3. Return structured terminal/in-progress responses with summaries, logs, and metadata.
4. Resume existing external executions when `external_ref` already exists.

## 7. Queue-Consumer Station Integration

1. Load run context before station execution.
2. Reuse persisted `external_ref` and `metadata_json` for resume paths.
3. Persist external state early for in-progress responses.
4. Maintain compare-and-set status updates for run/station transitions.
5. Persist summary and log excerpt artifacts for `implement` and `verify`.

## 8. Stability Checkpoints Before Slice Completion

1. Command construction must avoid shell injection risk when passing dynamic run/repo fields to execution environments.
2. Local retry/resume behavior must be verified to keep progressing after in-progress station responses.

These checks are required before declaring Adapter-Driven Execution fully complete.

## 9. Testing and QA

## 9.1 Unit

1. Modal auth/config parsing and error mapping.
2. Coderunner mock + modal outcome mapping and resume behavior.
3. Queue-consumer station transitions on success, in-progress retry, and failure.

## 9.2 Integration/Smoke

1. Queue-consumer smoke validates end-to-end run progression in mock mode.
2. Integration validates station metadata persistence and artifact shapes.
3. Retry behavior validates that transient adapter errors do not produce duplicate external jobs.

## 9.3 Manual QA

1. Run mock mode flow to completion and inspect station/artifact payloads.
2. Run modal mode flow with credentials and verify `external_ref` resume behavior across retry/restart.

## 10. Acceptance Criteria

1. `implement` and `verify` no longer use placeholder station logic.
2. Adapter contracts are typed and tested.
3. `external_ref`/`metadata_json` persistence supports resume without duplicate execution starts.
4. Artifacts include implement/verify summary and bounded logs excerpts.
5. Queue redelivery and stale-run resume preserve run/station consistency.
6. Lint/typecheck/tests/smoke pass for touched surfaces.

## 11. Handoff

After this slice is complete, move directly to `GitHub PR Creation`:

1. Replace `create_pr` placeholder with real branch + PR operations.
2. Persist branch/commit/PR metadata in `runs` and artifacts.
3. Preserve idempotent behavior for partial-success PR creation paths.
