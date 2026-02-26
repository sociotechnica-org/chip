import { describe, expect, it } from "vitest";

import {
  hasLaunchReadinessRequiredCoverage,
  launchReadinessObservabilityBaseline,
  listBaselineAlertIds
} from "../src/index";

describe("@bob/observability launch-readiness baseline", () => {
  it("includes required launch-readiness metric coverage", () => {
    expect(hasLaunchReadinessRequiredCoverage()).toBe(true);
  });

  it("uses unique alert ids", () => {
    const alertIds = listBaselineAlertIds();
    const uniqueIds = new Set(alertIds);
    expect(uniqueIds.size).toBe(alertIds.length);
  });

  it("defines launch SLO thresholds within expected bounds", () => {
    const targets = launchReadinessObservabilityBaseline.sloTargets;
    expect(targets).toHaveLength(3);

    for (const target of targets) {
      expect(target.windowMinutes).toBeGreaterThan(0);
      expect(target.threshold).toBeGreaterThan(0);
      expect(target.threshold).toBeLessThanOrEqual(60);
    }
  });
});
