import { describe, expect, it } from "vitest";
import { checkThresholds, gatePassed, type Thresholds } from "../src/gate";
import type { RunSummary } from "../src/types";

function summary(o: Partial<RunSummary> = {}): RunSummary {
  return {
    total: 10,
    passed: 9,
    passRate: 0.9,
    schemaFailures: 0,
    errors: 0,
    byTag: {
      billing: { total: 5, passed: 5, passRate: 1 },
      bug: { total: 5, passed: 4, passRate: 0.8 },
    },
    byGrader: {},
    latencyP50Ms: 0,
    latencyP95Ms: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    judgeCostUsd: 0,
    cacheHits: 0,
    retries: 0,
    ...o,
  };
}

const thresholds: Thresholds = { overall_pass_rate: 0.85, min_tag_pass_rate: 0.7, max_schema_failures: 0 };
const failing = (checks: ReturnType<typeof checkThresholds>) => checks.filter((c) => !c.pass).map((c) => c.name);

describe("checkThresholds", () => {
  it("passes when every floor is met", () => {
    const checks = checkThresholds(summary(), thresholds);
    expect(gatePassed(checks)).toBe(true);
  });

  it("treats thresholds as inclusive", () => {
    expect(gatePassed(checkThresholds(summary({ passRate: 0.85 }), thresholds))).toBe(true);
  });

  it("fails on overall pass rate", () => {
    expect(failing(checkThresholds(summary({ passRate: 0.8 }), thresholds))).toEqual(["overall pass rate"]);
  });

  it("fails on any schema failure when the max is 0", () => {
    expect(failing(checkThresholds(summary({ schemaFailures: 1 }), thresholds))).toEqual(["schema failures"]);
  });

  it("fails a single weak tag even when the overall rate is fine", () => {
    const s = summary({ byTag: { ...summary().byTag, "multi-issue": { total: 3, passed: 1, passRate: 1 / 3 } } });
    expect(failing(checkThresholds(s, thresholds))).toEqual(['tag "multi-issue"']);
  });

  it("applies per-tag overrides", () => {
    const strict = { ...thresholds, tag_overrides: { bug: 1 } };
    expect(failing(checkThresholds(summary(), strict))).toEqual(['tag "bug"']);
    const lenient = { ...thresholds, min_tag_pass_rate: 0.9, tag_overrides: { bug: 0.5 } };
    expect(gatePassed(checkThresholds(summary(), lenient))).toBe(true);
  });

  it("fails when an override names a tag with no cases", () => {
    const checks = checkThresholds(summary(), { ...thresholds, tag_overrides: { "prompt-injecton": 1 } });
    expect(failing(checks)).toEqual(['tag "prompt-injecton"']);
  });
});
