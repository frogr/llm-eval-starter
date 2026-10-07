// CI gate: turn a run summary into pass/fail against thresholds checked into
// the repo. Thresholds are floors, not targets. Raise them as the feature
// improves so regressions can't sneak back in.

import { readFile } from "node:fs/promises";
import { pct } from "./format";
import type { RunSummary } from "./types";

export interface Thresholds {
  /** Minimum fraction of all cases that must pass. */
  overall_pass_rate: number;
  /** Minimum pass rate for every tag (catches regressions hidden by a good average). */
  min_tag_pass_rate: number;
  /** Maximum outputs that fail to parse. Usually 0: unparseable output is an outage. */
  max_schema_failures: number;
  /** Per-tag floors that override min_tag_pass_rate, e.g. { "prompt-injection": 1 }. */
  tag_overrides?: Record<string, number>;
}

export interface GateCheck {
  name: string;
  pass: boolean;
  actual: string;
  required: string;
}

export async function loadThresholds(path: string): Promise<Thresholds> {
  return JSON.parse(await readFile(path, "utf8")) as Thresholds;
}

export function checkThresholds(summary: RunSummary, t: Thresholds): GateCheck[] {
  const checks: GateCheck[] = [
    {
      name: "overall pass rate",
      pass: summary.passRate >= t.overall_pass_rate,
      actual: pct(summary.passRate),
      required: `>= ${pct(t.overall_pass_rate)}`,
    },
    {
      name: "schema failures",
      pass: summary.schemaFailures <= t.max_schema_failures,
      actual: String(summary.schemaFailures),
      required: `<= ${t.max_schema_failures}`,
    },
  ];

  for (const [tag, stats] of Object.entries(summary.byTag).sort(([a], [b]) => a.localeCompare(b))) {
    const floor = t.tag_overrides?.[tag] ?? t.min_tag_pass_rate;
    checks.push({
      name: `tag "${tag}"`,
      pass: stats.passRate >= floor,
      actual: `${pct(stats.passRate)} (${stats.passed}/${stats.total})`,
      required: `>= ${pct(floor)}`,
    });
  }

  // An override for a tag with no cases is almost always a typo or a case that
  // got deleted. Fail rather than silently gating on nothing.
  for (const tag of Object.keys(t.tag_overrides ?? {})) {
    if (!summary.byTag[tag]) {
      checks.push({ name: `tag "${tag}"`, pass: false, actual: "no cases", required: "at least 1 case" });
    }
  }

  return checks;
}

export function gatePassed(checks: GateCheck[]): boolean {
  return checks.every((c) => c.pass);
}
