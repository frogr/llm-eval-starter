// Shared types. Kept in one file so the shape of the whole system is easy to see.

export const CATEGORIES = ["billing", "bug", "account", "feature_request", "other"] as const;
export type Category = (typeof CATEGORIES)[number];

// Ordered from least to most urgent. Order matters: the priority grader
// measures distance between levels.
export const PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];

/** What the feature under test returns. */
export interface Triage {
  category: Category;
  priority: Priority;
  needs_human: boolean;
  summary: string;
}

/** One row of evals/golden.jsonl. */
export interface GoldenCase {
  id: string;
  input: string;
  expected: {
    category: Category;
    priority: Priority;
    /** How many levels off is still acceptable. Default 1; use 0 where it matters. */
    priority_tolerance?: number;
    needs_human: boolean;
    /** Facts a good summary must cover. Used by the judge, not by exact match. */
    summary_must_mention?: string[];
  };
  tags: string[];
  /** Never looked at while tuning a prompt. Run with --split holdout to score it. */
  holdout?: boolean;
  notes?: string;
}

// ---------- providers ----------

export interface CompletionRequest {
  system: string;
  user: string;
  maxTokens: number;
  temperature: number;
}

export interface CompletionResult {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface Provider {
  name: string;
  model: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

// ---------- grading ----------

export interface GradeResult {
  grader: string;
  pass: boolean;
  /** 0..1. Lets you track partial credit even when pass/fail is binary. */
  score: number;
  reason: string;
}

export interface CaseResult {
  id: string;
  tags: string[];
  input: string;
  pass: boolean;
  /** True when the raw output could not be parsed into a valid Triage. */
  schemaFailure: boolean;
  output: Triage | null;
  rawOutput: string;
  grades: GradeResult[];
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  /** Cost of the feature call. null when the model has no price in the pricing table. */
  costUsd: number | null;
  /** Cost of the judge call (eval overhead, not production cost). */
  judgeCostUsd: number | null;
  cached: boolean;
  retries: number;
  /** Set when the call failed after all retries. */
  error?: string;
}

export interface RunSummary {
  total: number;
  passed: number;
  passRate: number;
  schemaFailures: number;
  errors: number;
  byTag: Record<string, { total: number; passed: number; passRate: number }>;
  byGrader: Record<string, { total: number; passed: number; passRate: number }>;
  latencyP50Ms: number;
  latencyP95Ms: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  judgeCostUsd: number | null;
  cacheHits: number;
  retries: number;
}

export interface RunRecord {
  version: 1;
  startedAt: string;
  prompt: string;
  provider: string;
  model: string;
  judgeModel: string;
  summary: RunSummary;
  cases: CaseResult[];
}
