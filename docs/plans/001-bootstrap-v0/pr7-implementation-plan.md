# PR7 Detailed Implementation Plan

Status: Ready  
Date: 2026-02-25  
Parent Plan: `docs/plans/001-bootstrap-v0/001-bootstrap-v0.md`  
Previous Slice: `docs/plans/001-bootstrap-v0/pr6-implementation-plan.md`

## 1. PR7 Objective

Deliver the bootstrap hardening slice required for safer run operations and stronger operator controls.

Concretely:

1. Add operator-safe run control endpoints (`cancel`, `retry`).
2. Improve workflow behavior for canceled runs to avoid post-cancel progression.
3. Expand run artifact retrieval ergonomics for operator debugging.
4. Add targeted integration/e2e coverage for cancel/retry and artifact retrieval paths.

## 2. Scope

### In Scope

1. Control-worker endpoints:
   - `POST /v1/runs/:id/cancel`
   - `POST /v1/runs/:id/retry`
2. Control-worker route support:
   - `GET /v1/runs/:id/artifacts/:artifactId` (payload retrieval)
3. Queue-consumer cancellation hardening:
   - stop further station progression when run becomes canceled
4. Tests:
   - control-worker unit/integration for cancel/retry/artifact retrieval
   - queue-consumer tests for cancellation behavior
   - end-to-end smoke path covering operator retry after terminal failure
5. Docs for operator usage and expected semantics.

### Out of Scope

1. Full auth replacement and identity system.
2. Full R2 artifact offload architecture.
3. Deployment/SLO rollout work (Phase C).
4. Complex pause/resume UX in web dashboard.

## 3. Endpoint Semantics

## 3.1 `POST /v1/runs/:id/cancel`

1. Allowed from `queued` or `running` runs.
2. Idempotent when run is already terminal.
3. Response includes updated run payload.
4. For canceled runs:
   - `status = canceled`
   - `finished_at` set
   - `failure_reason` cleared

## 3.2 `POST /v1/runs/:id/retry`

1. Allowed for terminal runs (`failed` or `canceled`).
2. Creates a new queued run with the same repo/issue/requestor/goal/prMode.
3. Enqueues the new run immediately.
4. Response includes:
   - new run payload
   - `retriedFromRunId`

## 3.3 Queue-Consumer Cancel Awareness

1. Before each station execution, reload run status.
2. If status is `canceled`, stop station loop without marking succeeded/failed.
3. Keep already completed station rows intact.

## 4. Testing Strategy

1. Extend control-worker tests for:
   - cancel happy path + idempotent behavior
   - retry creates new run and queue message
   - artifact payload retrieval shape and not-found handling
2. Extend queue-consumer tests for:
   - run canceled mid-flow prevents further station progression
3. Keep e2e issue-to-pr suite green.
4. Keep dashboard e2e suite green with artifact retrieval and retry/cancel controls.

## 5. Acceptance Criteria

1. Operators can cancel queued/running runs safely via API.
2. Operators can retry terminal runs without mutating historical run records.
3. Queue-consumer does not continue station progression after cancellation is observed.
4. Artifact payload retrieval supports dashboard and API-based debugging.
5. Lint/tests/smoke/e2e commands pass for touched surfaces.
6. README/docs describe control endpoint semantics and QA flow.
