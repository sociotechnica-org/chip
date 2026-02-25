# PR6 Detailed Implementation Plan

Status: Ready  
Date: 2026-02-25  
Parent Plan: `docs/plans/001-bootstrap-v0/001-bootstrap-v0.md`  
Previous Slice: `docs/plans/001-bootstrap-v0/pr4-implementation-plan.md`

## 1. PR6 Objective

Deliver the first real operator dashboard in `apps/web` for authenticated run tracking and artifact inspection.

Concretely:

1. Replace the placeholder React shell with a usable run dashboard.
2. Support authenticated API access using the existing shared password model.
3. Show run list + run detail timeline + artifact summaries and artifact payload view.
4. Allow operators to submit new runs and immediately track progression.
5. Add deterministic CI-safe end-to-end dashboard coverage using a mocked control API.

## 2. Scope

### In Scope

1. Web UI state and views for:
   - API/password configuration
   - run list with loading/empty/error states
   - run detail pane with station timeline
   - artifact/log payload viewer
2. Run submission flow:
   - `POST /v1/runs` with `Idempotency-Key`
   - optimistic refresh/polling behavior for selected run
3. Control-worker API support required for dashboard:
   - fetch single artifact payload by run and artifact id
4. Playwright e2e smoke coverage with mocked API behavior.
5. README/docs updates for local dashboard QA.

### Out of Scope

1. Realtime websockets/Agents stream integration.
2. Full auth replacement beyond shared password model.
3. Dashboard-level user management or RBAC.
4. R2 browsing UX for offloaded artifacts (deferred to hardening slice).

## 3. UX Requirements

1. Operator can enter API base URL and password once; values persist locally.
2. Operator can refresh run list on demand.
3. Selecting a run loads run detail and station timeline in deterministic order.
4. Selecting an artifact loads and renders JSON payload (or clear error if unavailable).
5. Run submit form supports:
   - issue number
   - requestor
   - optional goal
   - PR mode (`draft|ready`)
6. UI exposes obvious loading/error/empty states for each panel.

## 4. API Additions for PR6

### `GET /v1/runs/:id/artifacts/:artifactId`

1. Auth required under `/v1/*`.
2. Validate `runId` and `artifactId` route params.
3. Return:
   - artifact metadata (`id`, `runId`, `type`, `storage`, `createdAt`)
   - parsed payload for `inline` artifacts
4. Return `404` if run or artifact does not exist, or artifact is not attached to run.

## 5. Testing Strategy

## 5.1 Unit / Integration

1. Extend control-worker tests for artifact retrieval endpoint.
2. Keep existing smoke coverage green for run/repo APIs.

## 5.2 Dashboard E2E

1. Add Playwright suite with mocked API service that validates:
   - auth config and run list load
   - run selection and station timeline rendering
   - artifact payload loading
   - run submission request wiring
2. Keep e2e deterministic (no external network calls).

## 6. Acceptance Criteria

1. `apps/web` is no longer a placeholder and can operate the run flow.
2. Artifact payloads are inspectable from the dashboard.
3. Dashboard behavior is covered by automated e2e tests.
4. `pnpm lint:check`, relevant tests, and smoke/e2e commands pass.
5. Docs include operator steps for local dashboard QA.
