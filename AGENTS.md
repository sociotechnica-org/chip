# AGENTS.md

This file defines baseline guidance for agents working in `chip`.

## Mission

Build a Cloudflare-first software factory that turns GitHub issues into pull requests.

v0 target is intentionally narrow: `sociotechnica-org/lifebuild` only.

## Current Phase

Bootstrap phase (PR1-focused): establish monorepo foundations, shared contracts, and minimal runnable path toward issue-to-PR orchestration.

Primary references:

- `README.md`
- `docs/architecture.md`
- `docs/plans/001-bootstrap-v0/001-bootstrap-v0.md`
- `docs/plans/001-bootstrap-v0/pr1-implementation-plan.md`

## v0 Constraints

1. Orchestration primitives: Cloudflare Agents + Workflows + Queues.
2. Execution runtime for implementation/verify: Modal VMs.
3. Storage: SQLite-based (Cloudflare D1 and/or Durable Object SQLite).
4. Web app: Vite + React (not Next.js App Router).
5. Language/tooling baseline: TypeScript, PNPM, Vitest, Playwright, ESLint, Prettier.
6. GitHub auth: PAT via `GITHUB_TOKEN`.
7. Initial coderunner: Claude Code, with adapter design left swappable.

## Expected Repository Shape

```text
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

## Working Principles

1. Prefer vertical slices over broad abstraction.
2. Keep adapters explicit and swappable.
3. Persist and log station transitions (`queued -> running -> terminal states`).
4. Default to draft PRs unless run instructions explicitly request ready-for-review.
5. Keep scope tight to v0 outcomes; avoid speculative platforming.
6. Always run `pnpm lint-all` before committing to catch lint/typecheck/formatting issues early.

## MVP Workflow Contract

1. Accept run request from GitHub issue reference.
2. Enqueue and orchestrate via Queue + Workflow.
3. Execute implementation in Modal with coderunner.
4. Run verification commands based on target repo instructions.
5. Push branch and open PR (`draft` or `ready` per run mode).
6. Expose run status/logs for UI consumption.

## Security (v0)

Use shared password gate:

- API: `Authorization: Bearer <password>`
- Web: lightweight signed cookie
- Secret: `BOB_PASSWORD`

Keep security logic isolated in `packages/security` to simplify replacement later.

## Definition of Done (Bootstrap)

1. Lint/typecheck/tests pass for implemented slice.
2. Run lifecycle state is persisted and queryable.
3. One local end-to-end path executes: submit run -> queue -> workflow -> implement -> verify -> PR.
4. Documentation is updated when contracts/shape change.

## Development Loop (Required)

For implementation-plan execution work, use this loop until completion:

1. Read the target plan doc and implement all acceptance criteria (not a subset).
2. Update contracts, migrations, adapters, worker wiring, and docs together so behavior is coherent.
3. Add/extend unit + integration coverage; add smoke/e2e coverage when station behavior changes.
4. Run quality gates locally:
   - `pnpm lint:check`
   - `pnpm test`
   - relevant smoke/e2e commands for touched surfaces
5. Run local QA of the affected flow (API + queue + station artifacts/state validation).
6. Open/update a PR from the working branch and ensure CI checks pass.
7. Resolve all review feedback and BugBot comments; BugBot must be `pass` (not `neutral`).
8. Repeat steps 2-7 until all checks are green and plan criteria are fully satisfied.

## Non-Goals (for v0)

1. Multi-repo rollout beyond `sociotechnica-org/lifebuild`.
2. Full auth/identity system (beyond shared password gate).
3. Postgres or non-SQLite persistence.
4. Tight coupling to a single coderunner implementation.
