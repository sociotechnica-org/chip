# Launch Checklist (Staging -> Production)

Status: Active  
Owner: Release Driver  
Last Updated: 2026-02-25

Use this checklist before every production promotion. All required gates must be checked.

## 1. Build and Test Gates (Required)

- [ ] `pnpm lint:check` passes on release commit.
- [ ] `pnpm test` passes on release commit.
- [ ] `pnpm smoke` passes on release commit.
- [ ] `pnpm test:e2e` passes on release commit.
- [ ] `pnpm test:e2e:issue-pr` passes on release commit.

## 2. SLO Gates (Required)

- [ ] 24h success ratio >= 95%.
- [ ] 24h p95 end-to-end latency <= 20 minutes.
- [ ] 24h retry ratio <= 5%.
- [ ] No `critical` baseline alerts firing at promotion start.

## 3. Rollback Readiness Gates (Required)

- [ ] Previous known-good commit SHA is documented.
- [ ] Rollback operator is assigned.
- [ ] Rollback command path has been dry-run in staging.
- [ ] Reversible migration steps are documented for any non-additive migration.

## 4. Operator QA Gates (Required)

- [ ] Staging canary run passes end-to-end.
- [ ] Staging canary includes artifact fetch verification.
- [ ] Cancel flow validated on staging run.
- [ ] Retry flow validated on staging run.
- [ ] Dashboard run list/detail/artifact views load correctly.

## 5. Signoff

Promotion may proceed only when all required gates are complete and approved.

1. Release Driver: [signoff]
2. On-call Operator: [signoff]
3. Engineering Approver: [signoff]
4. Promotion Start (UTC): [timestamp]
5. Promotion End (UTC): [timestamp]
