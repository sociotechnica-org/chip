# Incident Response Playbook: Run Lifecycle Failures

Status: Active  
Owner: Platform On-call  
Last Updated: 2026-02-25

## 1. Trigger Conditions

Use this playbook when any of the following is observed:

1. Queue depth alert remains firing for > 15 minutes.
2. Terminal failure-rate alert enters `critical`.
3. Retry spike alert enters `critical`.
4. Operators report stuck runs or repeated station regression.

## 2. Severity Classification

1. `SEV-1`
   - production run creation unavailable, or
   - `>= 50%` terminal failures for 15 minutes, or
   - widespread data integrity risk
2. `SEV-2`
   - elevated failures/retries with degraded service but partial run success
3. `SEV-3`
   - localized failures with available workaround

## 3. Triage Workflow

1. Confirm incident scope:
   - affected environment (`staging` or `production`)
   - first detected timestamp
   - impacted run IDs
2. Check run lifecycle state:
   - `GET /v1/runs`
   - sample failing run via `GET /v1/runs/:id`
3. Check station concentration:
   - identify failing station (`intake`, `plan`, `implement`, `verify`, `create_pr`)
4. Classify root-cause domain:
   - queue backlog/scheduling
   - adapter/provider dependency
   - migration/schema mismatch
   - platform logic regression

## 4. Containment Actions

Apply in order:

1. Stop promotions and freeze deploys.
2. If failure is severe, pause new run intake at operator boundary.
3. For queue pressure incidents:
   - scale queue consumer where possible
   - prioritize oldest runs first
4. For regression incidents:
   - rollback to previous known-good release
   - re-run canary validation

## 5. Recovery Verification

Recovery is complete only when:

1. Queue depth returns below threshold.
2. Failure-rate alert clears.
3. Retry spike trend normalizes.
4. Three consecutive canary runs succeed end-to-end.

## 6. Communication and Evidence

Incident record must include:

1. severity and timeline
2. run IDs used as evidence
3. mitigations performed
4. rollback details (if any)
5. follow-up action items with owners and due dates

## 7. Post-Incident Requirements

Within 48 hours:

1. Publish incident review.
2. Add regression test coverage if failure was code-driven.
3. Update runbooks/checklists when process gaps are found.
4. Track remediation in backlog before next production promotion.
