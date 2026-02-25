# Observability Baseline and SLOs

Status: Active  
Owner: Platform + On-call  
Last Updated: 2026-02-25

## 1. Scope

This baseline defines required launch metrics and alerts for `chip` v0:

1. Queue depth pressure
2. Terminal failure rate
3. Retry spike detection

Structured baseline definitions are exported from `@bob/observability` so UI and alerting integrations can consume a single source of truth.

## 2. SLO Targets (Launch Gates)

For a rolling 24-hour window:

1. Run success ratio (terminal succeeded / terminal total) >= 95%
2. p95 run end-to-end latency <= 20 minutes
3. Retry ratio (retried runs / terminal runs) <= 5%

If any SLO falls below target for two consecutive windows, promotion is blocked until remediated.

## 3. Dashboard Baseline

Required dashboard panels:

1. Queue Depth (live + 15m trend)
2. Run Throughput (queued, started, terminal by 5m bucket)
3. Terminal Status Breakdown (`succeeded`, `failed`, `canceled`)
4. End-to-End Run Latency p50/p95
5. Retry Ratio (retries / terminal)
6. Station Failure Hotspots (`intake`, `plan`, `implement`, `verify`, `create_pr`)

## 4. Alert Baseline

Required alerts and thresholds:

1. Queue depth high: queue depth > 50 for 10 minutes
2. Terminal failure-rate high: failure ratio > 10% for 10 minutes
3. Retry spike: retry ratio > 15% for 15 minutes
4. Stuck running runs: any run `running` for > 45 minutes

Severity guidance:

1. `warn`: requires operator acknowledgement and follow-up
2. `critical`: blocks promotion, initiate incident playbook

## 5. Telemetry Requirements

Event streams must include:

1. run id, station, status transition, timestamp
2. correlation id for queue message + workflow execution
3. retry source run id for replayed runs
4. failure taxonomy code (`adapter_error`, `provider_timeout`, `verification_failure`, `platform_error`)

## 6. Operator Use

1. During promotion, monitor all baseline alerts for 30 minutes post-production deploy.
2. During incidents, use dashboard panels to classify queue pressure vs workflow correctness failures.
3. During launch reviews, attach dashboard screenshots and alert history links to checklist evidence.
