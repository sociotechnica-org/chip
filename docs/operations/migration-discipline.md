# Migration Discipline

Status: Active  
Owner: Platform Engineering  
Last Updated: 2026-02-25

## 1. Goals

Ensure D1 schema changes are promotion-safe and rollback-aware.

## 2. Rules

1. Prefer additive migrations.
2. Never combine destructive DDL with same-release application behavior changes.
3. Ship backfills in bounded batches.
4. Ensure queue-consumer and control-worker remain compatible across one-release skew.
5. Every migration PR must include rollback notes.

## 3. Required PR Contents for Schema Changes

1. Migration SQL file(s) in `apps/control-worker/migrations`.
2. Compatibility notes describing old/new worker behavior.
3. Rollback strategy:
   - reversible SQL when possible, or
   - explicit forward-fix-only statement when not reversible
4. Updated tests covering schema-dependent behavior.

## 4. Promotion Sequence

Use this order for production changes:

1. Deploy migration-compatible code to staging.
2. Run staging migration (`pnpm migrate:staging`).
3. Validate staging canary flow.
4. Run production migration (`pnpm migrate:production`).
5. Deploy production workers (`pnpm deploy:production`).
6. Monitor baseline alerts for 30 minutes.

## 5. Rollback Notes

If migration is additive, rollback should usually be code-only (deploy previous worker release).

If migration is non-additive:

1. Block production promotion unless an explicit restore path is documented.
2. Pair rollback execution with on-call operator and migration owner.
3. Capture migration state and affected run IDs in incident notes.

## 6. Verification Checklist

Before marking migration complete:

1. Run one canary run through full lifecycle.
2. Verify run detail and artifact queries return expected payload shape.
3. Confirm cancel/retry actions remain functional post-migration.
