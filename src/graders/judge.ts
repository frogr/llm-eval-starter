// LLM-as-judge for the part of the output that has no single right answer:
// the summary.
//
// Rules of thumb baked in here:
//   - An explicit rubric with independent pass/fail criteria, not "rate 1-10".
//     Binary criteria are easier to calibrate against human labels and their
//     failures are easier to act on.
//   - The judge sees reference points from the golden set, so it checks
//     coverage against what a human decided mattered, not its own opinion.
//   - The judge must explain each verdict, and the reason ends up in the report.

import type { CompletionRequest, CompletionResult, GradeResult } from "../types";

export const JUDGE_CRITERIA = ["faithful", "complete", "english"] as const;
type Criterion = (typeof JUDGE_CRITERIA)[number];
type Verdicts = Record<Criterion, { pass: boolean; reason: string }>;

export const JUDGE_RUBRIC = `You are grading the "summary" field produced by a support-ticket triage system. Grade each criterion independently as pass or fail.

Criteria:
1. faithful: The summary only states things the customer said. It must not claim that actions were taken (for example "refund approved") and must not invent details.
2. complete: The summary covers every distinct issue the customer raised. Reference points it should cover are provided; paraphrases count. If there are no reference points, pass when the summary does not invent an issue.
3. english: The summary is written in English, regardless of the customer's language.

Return only a JSON object, no prose:
{"faithful": {"pass": true, "reason": "..."}, "complete": {"pass": true, "reason": "..."}, "english": {"pass": true, "reason": "..."}}
Keep each reason under 20 words.`;

export interface JudgeInput {
  message: string;
  summary: string;
  mustMention: string[];
}

export interface Judge {
  model: string;
  grade(input: JudgeInput): Promise<{ grade: GradeResult; usage?: CompletionResult }>;
}

export function buildJudgeRequest(input: JudgeInput): CompletionRequest {
  const refs = input.mustMention.length ? input.mustMention.map((m) => `- ${m}`).join("\n") : "(none)";
  return {
    system: JUDGE_RUBRIC,
    user: `<customer_message>\n${input.message}\n</customer_message>\n\n<summary>\n${input.summary}\n</summary>\n\n<reference_points>\n${refs}\n</reference_points>`,
    maxTokens: 300,
    temperature: 0,
  };
}

/** Collapse per-criterion verdicts into one GradeResult. Exported for tests. */
export function verdictsToGrade(v: Verdicts): GradeResult {
  const failed = JUDGE_CRITERIA.filter((c) => !v[c].pass);
  const score = (JUDGE_CRITERIA.length - failed.length) / JUDGE_CRITERIA.length;
  return {
    grader: "judge",
    pass: failed.length === 0,
    score,
    reason: failed.length
      ? failed.map((c) => `${c}: ${v[c].reason}`).join("; ")
      : "faithful, complete, english",
  };
}

export function parseVerdicts(raw: string): Verdicts | null {
  try {
    const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const data = JSON.parse(text) as Record<string, { pass?: unknown; reason?: unknown }>;
    const out = {} as Verdicts;
    for (const c of JUDGE_CRITERIA) {
      if (typeof data[c]?.pass !== "boolean") return null;
      out[c] = { pass: data[c].pass as boolean, reason: String(data[c].reason ?? "") };
    }
    return out;
  } catch {
    return null;
  }
}

/** A judge backed by a real model. `call` is injected so it shares the runner's cache and retries. */
export function createLlmJudge(model: string, call: (req: CompletionRequest) => Promise<CompletionResult>): Judge {
  return {
    model,
    async grade(input) {
      const usage = await call(buildJudgeRequest(input));
      const verdicts = parseVerdicts(usage.text);
      if (!verdicts) {
        // A broken judge is a harness problem, not a feature problem, but we
        // still fail loudly rather than silently passing the case.
        return {
          grade: { grader: "judge", pass: false, score: 0, reason: `judge returned unparseable output: ${usage.text.slice(0, 80)}` },
          usage,
        };
      }
      return { grade: verdictsToGrade(verdicts), usage };
    },
  };
}

const NON_ENGLISH = /[áéíóúñçàèêäöüß¿¡]|\b(hola|bonjour|der|und|nicht|puedo|pouvez|desde|mais)\b/i;
const CLAIMS_ACTION = /\b(approved|refunded|has been (resolved|fixed)|issued)\b/i;

/**
 * Offline stand-in for the LLM judge. Applies the same rubric with string
 * heuristics: reference points must appear verbatim (a real judge accepts
 * paraphrases), no claims of actions taken, no non-English markers.
 */
export function createMockJudge(): Judge {
  return {
    model: "mock-judge-1",
    async grade({ summary, mustMention }) {
      const lower = summary.toLowerCase();
      const missing = mustMention.filter((m) => !lower.includes(m.toLowerCase()));
      const verdicts: Verdicts = {
        faithful: CLAIMS_ACTION.test(summary)
          ? { pass: false, reason: "claims an action was taken" }
          : { pass: true, reason: "no unsupported claims" },
        complete: missing.length
          ? { pass: false, reason: `missing ${missing.map((m) => `"${m}"`).join(", ")}` }
          : { pass: true, reason: "covers all reference points" },
        english: NON_ENGLISH.test(summary)
          ? { pass: false, reason: "not written in English" }
          : { pass: true, reason: "English" },
      };
      return { grade: verdictsToGrade(verdicts) };
    },
  };
}
