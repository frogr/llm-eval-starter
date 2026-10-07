// End-to-end check of the offline demo: golden set + mock provider + graders
// + gate. Guards the story the README tells (v1 fails the gate, v2 passes,
// v2 regresses on multi-issue) against accidental edits.

import { describe, expect, it } from "vitest";
import { compareRuns } from "../src/compare";
import { checkThresholds, gatePassed, loadThresholds } from "../src/gate";
import { createMockJudge } from "../src/graders/judge";
import { createMockProvider } from "../src/providers/mock";
import { loadGolden, runEval } from "../src/runner";

async function demoRun(prompt: "v1" | "v2") {
  return runEval({
    prompt,
    provider: createMockProvider({ latencyScale: 0 }),
    judge: createMockJudge(),
    cases: await loadGolden("evals/golden.jsonl"),
    concurrency: 8,
    attempts: 3,
    cache: { dir: ".cache", enabled: false },
  });
}

describe("offline demo", () => {
  it("v1 fails the gate, v2 passes, and compare shows the multi-issue regression", async () => {
    const thresholds = await loadThresholds("evals/thresholds.json");
    const v1 = await demoRun("v1");
    const v2 = await demoRun("v2");

    expect(gatePassed(checkThresholds(v1.summary, thresholds))).toBe(false);
    expect(gatePassed(checkThresholds(v2.summary, thresholds))).toBe(true);
    expect(v2.summary.passRate).toBeGreaterThan(v1.summary.passRate);

    const cmp = compareRuns(v1, v2);
    expect(cmp.regressions.map((r) => r.id)).toContain("multi-three-issues");
    expect(cmp.tagDeltas.find((t) => t.tag === "multi-issue")!.delta).toBeLessThan(0);
  });
});
