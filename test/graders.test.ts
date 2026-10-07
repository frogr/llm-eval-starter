import { describe, expect, it } from "vitest";
import { parseTriage } from "../src/feature";
import {
  gradeCategory,
  gradeNeedsHuman,
  gradePriority,
  gradeSchema,
  gradeSummaryLength,
} from "../src/graders/deterministic";
import { createMockJudge, parseVerdicts, verdictsToGrade } from "../src/graders/judge";
import type { GoldenCase, Triage } from "../src/types";

const out = (o: Partial<Triage> = {}): Triage => ({
  category: "billing",
  priority: "high",
  needs_human: true,
  summary: "Customer was charged twice and wants a refund.",
  ...o,
});

const expected = (e: Partial<GoldenCase["expected"]> = {}): GoldenCase["expected"] => ({
  category: "billing",
  priority: "high",
  needs_human: true,
  ...e,
});

describe("parseTriage + schema grader", () => {
  const valid = JSON.stringify(out());

  it("accepts valid JSON", () => {
    expect(gradeSchema(parseTriage(valid))).toMatchObject({ pass: true, score: 1 });
  });

  it("tolerates a markdown code fence", () => {
    expect(parseTriage("```json\n" + valid + "\n```").ok).toBe(true);
  });

  it("rejects prose around the JSON", () => {
    const g = gradeSchema(parseTriage(`Sure! Here you go:\n${valid}`));
    expect(g.pass).toBe(false);
    expect(g.reason).toMatch(/not valid JSON/);
  });

  it("rejects values outside the enums and wrong types", () => {
    const r = parseTriage(JSON.stringify({ category: "refunds", priority: "p1", needs_human: "yes", summary: 3 }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/bad category/);
      expect(r.error).toMatch(/bad priority/);
      expect(r.error).toMatch(/needs_human/);
      expect(r.error).toMatch(/summary/);
    }
  });

  it("rejects arrays and non-objects", () => {
    expect(parseTriage("[]").ok).toBe(false);
    expect(parseTriage("null").ok).toBe(false);
  });
});

describe("gradeCategory", () => {
  it("is exact match", () => {
    expect(gradeCategory(out(), expected()).pass).toBe(true);
    const g = gradeCategory(out({ category: "bug" }), expected());
    expect(g).toMatchObject({ pass: false, score: 0 });
    expect(g.reason).toBe('expected "billing", got "bug"');
  });
});

describe("gradePriority", () => {
  it("gives full score for an exact match", () => {
    expect(gradePriority(out({ priority: "high" }), expected())).toMatchObject({ pass: true, score: 1 });
  });

  it("passes with partial credit within the default tolerance of 1", () => {
    expect(gradePriority(out({ priority: "medium" }), expected())).toMatchObject({ pass: true, score: 0.5 });
    expect(gradePriority(out({ priority: "urgent" }), expected())).toMatchObject({ pass: true, score: 0.5 });
  });

  it("fails beyond tolerance", () => {
    expect(gradePriority(out({ priority: "low" }), expected())).toMatchObject({ pass: false, score: 0 });
  });

  it("respects a per-case tolerance of 0", () => {
    const g = gradePriority(out({ priority: "high" }), expected({ priority: "urgent", priority_tolerance: 0 }));
    expect(g.pass).toBe(false);
    expect(g.reason).toContain("±0");
  });
});

describe("gradeNeedsHuman", () => {
  it("is exact match on the boolean", () => {
    expect(gradeNeedsHuman(out({ needs_human: true }), expected()).pass).toBe(true);
    expect(gradeNeedsHuman(out({ needs_human: false }), expected()).pass).toBe(false);
  });
});

describe("gradeSummaryLength", () => {
  it("checks word count bounds", () => {
    expect(gradeSummaryLength(out({ summary: "Double charge, refund wanted." })).pass).toBe(true);
    expect(gradeSummaryLength(out({ summary: "Refund approved" })).pass).toBe(false);
    expect(gradeSummaryLength(out({ summary: "" })).pass).toBe(false);
    expect(gradeSummaryLength(out({ summary: Array(26).fill("word").join(" ") })).pass).toBe(false);
  });
});

describe("judge", () => {
  it("parses well-formed verdicts and fails on malformed ones", () => {
    const raw = JSON.stringify({
      faithful: { pass: true, reason: "ok" },
      complete: { pass: false, reason: "misses the sync issue" },
      english: { pass: true, reason: "ok" },
    });
    const v = parseVerdicts(raw);
    expect(v).not.toBeNull();
    const g = verdictsToGrade(v!);
    expect(g).toMatchObject({ grader: "judge", pass: false });
    expect(g.score).toBeCloseTo(2 / 3);
    expect(g.reason).toBe("complete: misses the sync issue");

    expect(parseVerdicts("not json")).toBeNull();
    expect(parseVerdicts(JSON.stringify({ faithful: { pass: "yes" } }))).toBeNull();
  });

  it("mock judge applies the rubric", async () => {
    const judge = createMockJudge();
    const ok = await judge.grade({ message: "", summary: "Customer reports duplicate charge and refund request.", mustMention: ["charge", "refund"] });
    expect(ok.grade.pass).toBe(true);

    const missing = await judge.grade({ message: "", summary: "Customer reports duplicate charge.", mustMention: ["charge", "refund"] });
    expect(missing.grade.reason).toContain('missing "refund"');

    const claims = await judge.grade({ message: "", summary: "Refund approved for the customer.", mustMention: [] });
    expect(claims.grade.reason).toContain("faithful");

    const spanish = await judge.grade({ message: "", summary: "Hola, no puedo iniciar sesión", mustMention: [] });
    expect(spanish.grade.reason).toContain("english");
  });
});
