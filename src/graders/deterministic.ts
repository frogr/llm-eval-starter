// Deterministic graders: cheap, fast, exact, and free to run on every commit.
// Use them for anything that has a right answer. Save the LLM judge for the
// fuzzy parts (here: summary quality).

import type { ParseResult } from "../feature";
import { PRIORITIES, type GoldenCase, type GradeResult, type Triage } from "../types";

export const SUMMARY_MIN_WORDS = 3;
export const SUMMARY_MAX_WORDS = 25;

export function gradeSchema(parsed: ParseResult): GradeResult {
  return parsed.ok
    ? { grader: "schema", pass: true, score: 1, reason: "valid JSON matching schema" }
    : { grader: "schema", pass: false, score: 0, reason: parsed.error };
}

export function gradeCategory(out: Triage, expected: GoldenCase["expected"]): GradeResult {
  const pass = out.category === expected.category;
  return {
    grader: "category",
    pass,
    score: pass ? 1 : 0,
    reason: pass ? `matched "${expected.category}"` : `expected "${expected.category}", got "${out.category}"`,
  };
}

/**
 * Priority is ordinal, so being one level off is not the same as being three
 * levels off. Within tolerance passes; exact gets full score, so partial
 * credit stays visible in the score even when the case passes.
 */
export function gradePriority(out: Triage, expected: GoldenCase["expected"]): GradeResult {
  const tolerance = expected.priority_tolerance ?? 1;
  const distance = Math.abs(PRIORITIES.indexOf(out.priority) - PRIORITIES.indexOf(expected.priority));
  const pass = distance <= tolerance;
  const score = distance === 0 ? 1 : pass ? 0.5 : 0;
  const reason =
    distance === 0
      ? `matched "${expected.priority}"`
      : `expected "${expected.priority}" (±${tolerance}), got "${out.priority}"`;
  return { grader: "priority", pass, score, reason };
}

export function gradeNeedsHuman(out: Triage, expected: GoldenCase["expected"]): GradeResult {
  const pass = out.needs_human === expected.needs_human;
  return {
    grader: "needs_human",
    pass,
    score: pass ? 1 : 0,
    reason: pass ? `matched ${expected.needs_human}` : `expected ${expected.needs_human}, got ${out.needs_human}`,
  };
}

export function gradeSummaryLength(out: Triage, min = SUMMARY_MIN_WORDS, max = SUMMARY_MAX_WORDS): GradeResult {
  const words = out.summary.trim().split(/\s+/).filter(Boolean).length;
  const pass = words >= min && words <= max;
  return {
    grader: "summary_length",
    pass,
    score: pass ? 1 : 0,
    reason: `${words} words (allowed ${min}-${max})`,
  };
}

export function runDeterministicGraders(out: Triage, expected: GoldenCase["expected"]): GradeResult[] {
  return [
    gradeCategory(out, expected),
    gradePriority(out, expected),
    gradeNeedsHuman(out, expected),
    gradeSummaryLength(out),
  ];
}
