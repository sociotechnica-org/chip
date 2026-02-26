export const OBSERVABILITY_BASELINE_VERSION = "2026-02-25-launch-readiness-v1";

export const OBSERVABILITY_METRICS = [
  "queue_depth",
  "run_success_ratio",
  "terminal_failure_rate",
  "retry_ratio",
  "run_latency_p95_minutes",
  "running_stale_count"
] as const;

export type ObservabilityMetric = (typeof OBSERVABILITY_METRICS)[number];

export const ALERT_SEVERITIES = ["warn", "critical"] as const;

export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const COMPARISON_OPERATORS = ["gt", "lt", "gte", "lte"] as const;

export type ComparisonOperator = (typeof COMPARISON_OPERATORS)[number];

export const SLO_OPERATORS = ["gte", "lte"] as const;

export type SloOperator = (typeof SLO_OPERATORS)[number];

export interface SloTarget {
  id: string;
  name: string;
  metric: ObservabilityMetric;
  windowMinutes: number;
  threshold: number;
  operator: SloOperator;
  description: string;
}

export interface DashboardPanelDefinition {
  id: string;
  title: string;
  metric: ObservabilityMetric;
  visualization: "timeseries" | "stat" | "table";
  description: string;
}

export interface AlertRuleDefinition {
  id: string;
  metric: ObservabilityMetric;
  severity: AlertSeverity;
  operator: ComparisonOperator;
  threshold: number;
  durationMinutes: number;
  description: string;
}

export interface LaunchReadinessObservabilityBaseline {
  version: string;
  sloTargets: readonly SloTarget[];
  dashboardPanels: readonly DashboardPanelDefinition[];
  alertRules: readonly AlertRuleDefinition[];
}

export const launchReadinessObservabilityBaseline: LaunchReadinessObservabilityBaseline = {
  version: OBSERVABILITY_BASELINE_VERSION,
  sloTargets: [
    {
      id: "slo_run_success_ratio_24h",
      name: "Run success ratio (24h)",
      metric: "run_success_ratio",
      windowMinutes: 24 * 60,
      threshold: 0.95,
      operator: "gte",
      description: "At least 95% of terminal runs should complete successfully."
    },
    {
      id: "slo_run_latency_p95_24h",
      name: "Run latency p95 (24h)",
      metric: "run_latency_p95_minutes",
      windowMinutes: 24 * 60,
      threshold: 20,
      operator: "lte",
      description: "24h p95 run completion latency should stay within 20 minutes."
    },
    {
      id: "slo_retry_ratio_24h",
      name: "Retry ratio (24h)",
      metric: "retry_ratio",
      windowMinutes: 24 * 60,
      threshold: 0.05,
      operator: "lte",
      description: "Retry ratio should remain below 5% over a rolling 24h window."
    }
  ],
  dashboardPanels: [
    {
      id: "panel_queue_depth",
      title: "Queue Depth",
      metric: "queue_depth",
      visualization: "timeseries",
      description: "Current queue depth and trend over time."
    },
    {
      id: "panel_terminal_failure_rate",
      title: "Terminal Failure Rate",
      metric: "terminal_failure_rate",
      visualization: "timeseries",
      description: "Ratio of failed terminal runs over total terminal runs."
    },
    {
      id: "panel_run_success_ratio",
      title: "Run Success Ratio",
      metric: "run_success_ratio",
      visualization: "timeseries",
      description: "Ratio of succeeded terminal runs over total terminal runs."
    },
    {
      id: "panel_retry_ratio",
      title: "Retry Ratio",
      metric: "retry_ratio",
      visualization: "timeseries",
      description: "Ratio of retried runs over total terminal runs."
    },
    {
      id: "panel_run_latency_p95",
      title: "Run Latency p95 (minutes)",
      metric: "run_latency_p95_minutes",
      visualization: "timeseries",
      description: "p95 end-to-end run latency."
    },
    {
      id: "panel_running_stale",
      title: "Stale Running Runs",
      metric: "running_stale_count",
      visualization: "stat",
      description: "Count of runs in running state beyond stale threshold."
    }
  ],
  alertRules: [
    {
      id: "alert_queue_depth_high",
      metric: "queue_depth",
      severity: "warn",
      operator: "gt",
      threshold: 50,
      durationMinutes: 10,
      description: "Queue depth has remained above 50 for 10 minutes."
    },
    {
      id: "alert_terminal_failure_rate_high",
      metric: "terminal_failure_rate",
      severity: "critical",
      operator: "gt",
      threshold: 0.1,
      durationMinutes: 10,
      description: "Terminal failure rate has exceeded 10% for 10 minutes."
    },
    {
      id: "alert_retry_ratio_spike",
      metric: "retry_ratio",
      severity: "critical",
      operator: "gt",
      threshold: 0.15,
      durationMinutes: 15,
      description: "Retry ratio has exceeded 15% for 15 minutes."
    },
    {
      id: "alert_running_stale_runs",
      metric: "running_stale_count",
      severity: "warn",
      operator: "gt",
      threshold: 0,
      durationMinutes: 15,
      description: "At least one run has remained in running state for too long."
    }
  ]
};

export function listBaselineAlertIds(): string[] {
  return launchReadinessObservabilityBaseline.alertRules.map((rule) => rule.id);
}

export function hasBaselineMetricCoverage(metric: ObservabilityMetric): boolean {
  const hasPanel = launchReadinessObservabilityBaseline.dashboardPanels.some(
    (panel) => panel.metric === metric
  );
  const hasAlert = launchReadinessObservabilityBaseline.alertRules.some(
    (rule) => rule.metric === metric
  );

  return hasPanel || hasAlert;
}

export function hasLaunchReadinessRequiredCoverage(): boolean {
  const requiredMetrics: readonly ObservabilityMetric[] = [
    "queue_depth",
    "terminal_failure_rate",
    "retry_ratio"
  ];
  return requiredMetrics.every((metric) => hasBaselineMetricCoverage(metric));
}
