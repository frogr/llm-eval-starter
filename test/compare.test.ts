import { describe, expect, it } from "vitest";
import { compareRuns } from "../src/compare";
import { summarize } from "../src/runner";
import type { CaseResult, RunRecord } from "../src/types";

function caseResult(id: string, pass: boolean, tags: string[]): CaseResult {
  return {
    id,
    tags,
    input: "",
    pass,
    schemaFailure: false,
    output: null,
    rawOutput: "",
    grades: pass ? [] : [{ grader: "category", pass: false, score: 0, reason: "wrong" }],
    latencyMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    judgeCostUsd: 0,
    cached: false,
    retries: 0,
  };
}

function run(prompt: string, cases: CaseResult[]): RunRecord {
  return { version: 1, startedAt: "", prompt, provider: "mock", model: "m", judgeModel: "j", summary: summarize(cases), cases };
}

describe("compareRuns", () => {
  const before = run("v1", [
    caseResult("a", true, ["x"]),
    caseResult("b", false, ["x"]),
    caseResult("c", false, ["y"]),
    caseResult("gone", true, ["y"]),
  ]);
  const after = run("v2", [
    caseResult("a", false, ["x"]),
    caseResult("b", true, ["x"]),
    caseResult("c", false, ["y"]),
    caseResult("new", true, ["y"]),
  ]);
  const cmp = compareRuns(before, after);

  it("finds flips in both directions", () => {
    expect(cmp.regressions.map((f) => f.id)).toEqual(["a"]);
    expect(cmp.regressions[0].reasons).toEqual(["category: wrong"]);
    expect(cmp.fixes.map((f) => f.id)).toEqual(["b"]);
    expect(cmp.stillFailing).toEqual(["c"]);
  });

  it("reports cases present in only one run", () => {
    expect(cmp.onlyInBefore).toEqual(["gone"]);
    expect(cmp.onlyInAfter).toEqual(["new"]);
  });

  it("computes per-tag deltas, worst first", () => {
    // tag x: 1/2 -> 1/2 (flat, despite two flips). tag y: 1/2 -> 1/2.
    expect(cmp.tagDeltas.map((t) => [t.tag, t.delta])).toEqual([
      ["x", 0],
      ["y", 0],
    ]);
  });
});
