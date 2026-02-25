# Environment Promotion and Rollback Runbook

Status: Active  
Owner: Platform Operators  
Last Updated: 2026-02-25

## 1. Purpose

Define the required path for promoting `chip` from staging to production and the rollback procedure if regression is detected.

This runbook applies to:

1. `apps/control-worker`
2. `apps/queue-consumer-worker`

## 2. Preconditions

Before promotion:

1. Main branch is green (`lint:check`, `test`, smoke suites, and e2e suites).
2. Current release commit is tagged in git.
3. Staging environment uses the same commit as the intended production candidate.
4. Launch checklist (`docs/operations/launch-checklist.md`) gates are pre-validated.
5. On-call operator is assigned and reachable for the full promotion window.

## 3. Environment Mapping

Worker config uses explicit Wrangler environments:

1. `staging`
2. `production`

These are defined in:

1. `apps/control-worker/wrangler.jsonc`
2. `apps/queue-consumer-worker/wrangler.jsonc`

## 4. Staging Promotion Procedure

Run from repository root:

1. `pnpm migrate:staging`
2. `pnpm deploy:staging`
3. `pnpm smoke`
4. `pnpm test:e2e:issue-pr`

Post-deploy verification:

1. Submit one canary run against staging and confirm terminal success.
2. Verify dashboard panels and alert inputs are populating.
3. Confirm no sustained retry spike in queue-consumer logs.

If any step fails, stop and follow rollback procedure.

## 5. Production Promotion Procedure

Promotion is only allowed after staging soak passes.

1. `pnpm migrate:production`
2. `pnpm deploy:production`
3. Run post-deploy canary:
   - submit one production run
   - verify `queued -> running -> terminal` lifecycle
   - verify artifact retrieval for the canary run
4. Monitor for 30 minutes:
   - queue depth alert state
   - terminal failure rate alert state
   - retry spike alert state

Declare promotion successful only after canary + 30-minute monitor window are clean.

## 6. Rollback Procedure

Trigger rollback if any of the following is true:

1. Canary run fails in a new or unknown way.
2. Terminal failure rate exceeds launch gate for 10 minutes.
3. Queue backlog grows without recovery for 15 minutes.
4. Critical run lifecycle bug is detected (`running` runs not progressing, duplicated terminal transitions, or failed retry loops).

Rollback steps:

1. Pause new run submissions at operator boundary.
2. Deploy previous known-good release commit to production workers:
   - `git checkout <previous-good-sha>`
   - `pnpm deploy:production`
   - `git checkout -`
3. If migration introduced incompatible behavior:
   - execute documented reversible migration SQL (see migration discipline section)
   - otherwise leave additive migration in place
4. Re-run canary flow and restore traffic only when canary is healthy.
5. Open incident report and attach:
   - failing run IDs
   - rollback timestamp
   - suspected root cause

## 7. Promotion Evidence Requirements

Each promotion must record:

1. commit SHA promoted
2. migration command output
3. deploy command output
4. canary run ID(s)
5. final go/no-go decision and approver

Store evidence in release notes or incident ticket.
