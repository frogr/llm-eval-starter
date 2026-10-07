import { readFile } from "node:fs/promises";
import { completeWithCache } from "./cache";
import { mapWithConcurrency, withRetry } from "./concurrency";
import { buildRequest, parseTriage, type PromptVersion } from "./feature";
import { gradeSchema, runDeterministicGraders } from "./graders/deterministic";
import type { Judge } from "./graders/judge";
import { estimateCostUsd } from "./providers";
import { ProviderError } from "./providers/errors";
import { CATEGORIES, PRIORITIES, type CaseResult, type GoldenCase, type Provider, type RunRecord, type RunSummary } from "./types";

export async function loadGolden(path: string): Promise<GoldenCase[]> {
  const lines = (await readFile(path, "utf8")).split("\n");
  const cases: GoldenCase[] = [];
  const seen = new Set<string>();
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    const where = `${path}:${i + 1}`;
    let c: GoldenCase;
    try {
      c = JSON.parse(line) as GoldenCase;
    } catch {
      throw new Error(`${where}: invalid JSON`);
    }
    // Catch typos in the golden set early; a mislabeled case is worse than none.
    if (!c.id || typeof c.input !== "string") throw new Error(`${where}: needs "id" and "input"`);
    if (seen.has(c.id)) throw new Error(`${where}: duplicate id "${c.id}"`);
    if (!CATEGORIES.includes(c.expected?.category)) throw new Error(`${where}: bad expected.category`);
    if (!PRIORITIES.includes(c.expected?.priority)) throw new Error(`${where}: bad expected.priority`);
    if (typeof c.expected.needs_human !== "boolean") throw new Error(`${where}: bad expected.needs_human`);
    if (!Array.isArray(c.tags)) throw new Error(`${where}: "tags" must be an array`);
    seen.add(c.id);
    cases.push(c);
  });
  return cases;
}

export interface RunOptions {
  prompt: PromptVersion;
  provider: Provider;
  judge: Judge;
  cases: GoldenCase[];
  concurrency: number;
  attempts: number;
  cache: { dir: string; enabled: boolean };
  onCaseDone?: (result: CaseResult, done: number, total: number) => void;
  onRetry?: (caseId: string, err: Error, attempt: number) => void;
}

export async function runEval(opts: RunOptions): Promise<RunRecord> {
  const startedAt = new Date().toISOString();
  let done = 0;

  const results = await mapWithConcurrency(opts.cases, opts.concurrency, async (c) => {
    const result = await runCase(c, opts);
    opts.onCaseDone?.(result, ++done, opts.cases.length);
    return result;
  });

  return {
    version: 1,
    startedAt,
    prompt: opts.prompt,
    provider: opts.provider.name,
    model: opts.provider.model,
    judgeModel: opts.judge.model,
    summary: summarize(results),
    cases: results,
  };
}

async function runCase(c: GoldenCase, opts: RunOptions): Promise<CaseResult> {
  const base = {
    id: c.id,
    tags: c.tags,
    input: c.input,
  };

  let call;
  let retries = 0;
  try {
    const r = await withRetry(() => completeWithCache(opts.provider, buildRequest(opts.prompt, c.input), opts.cache), {
      attempts: opts.attempts,
      baseDelayMs: 250,
      onRetry: (err, attempt) => opts.onRetry?.(c.id, err, attempt),
    });
    call = r.value;
    retries = r.retries;
  } catch (err) {
    // Bad key, no access, unknown model: every case will fail the same way,
    // so stop the run instead of producing a report full of identical errors.
    if (err instanceof ProviderError && [401, 403, 404].includes(err.status ?? 0)) throw err;
    // Any other error counts as a failed case. It shows up in the report with the
    // error so you can tell "model got it wrong" from "API fell over".
    return {
      ...base,
      pass: false,
      schemaFailure: false,
      output: null,
      rawOutput: "",
      grades: [],
      latencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: null,
      judgeCostUsd: null,
      cached: false,
      retries,
      error: (err as Error).message,
    };
  }

  const { result, latencyMs, cached } = call;
  const parsed = parseTriage(result.text);
  const grades = [gradeSchema(parsed)];
  let judgeCostUsd: number | null = 0;

  // If the output doesn't parse there is nothing meaningful to grade, so the
  // other graders are skipped (and excluded from per-grader stats).
  if (parsed.ok) {
    grades.push(...runDeterministicGraders(parsed.value, c.expected));
    const j = await opts.judge.grade({
      message: c.input,
      summary: parsed.value.summary,
      mustMention: c.expected.summary_must_mention ?? [],
    });
    grades.push(j.grade);
    judgeCostUsd = j.usage ? estimateCostUsd(j.usage.model, j.usage.inputTokens, j.usage.outputTokens) : 0;
  }

  return {
    ...base,
    pass: grades.every((g) => g.pass),
    schemaFailure: !parsed.ok,
    output: parsed.ok ? parsed.value : null,
    rawOutput: result.text,
    grades,
    latencyMs,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd: estimateCostUsd(result.model, result.inputTokens, result.outputTokens),
    judgeCostUsd,
    cached,
    retries,
  };
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function sumOrNull(values: Array<number | null>): number | null {
  return values.some((v) => v === null) ? null : values.reduce<number>((a, v) => a + (v ?? 0), 0);
}

export function summarize(cases: CaseResult[]): RunSummary {
  const rate = (passed: number, total: number) => (total ? passed / total : 0);

  const byTag: RunSummary["byTag"] = {};
  for (const c of cases) {
    for (const t of c.tags) {
      byTag[t] ??= { total: 0, passed: 0, passRate: 0 };
      byTag[t].total++;
      if (c.pass) byTag[t].passed++;
    }
  }
  for (const s of Object.values(byTag)) s.passRate = rate(s.passed, s.total);

  const byGrader: RunSummary["byGrader"] = {};
  for (const g of cases.flatMap((c) => c.grades)) {
    byGrader[g.grader] ??= { total: 0, passed: 0, passRate: 0 };
    byGrader[g.grader].total++;
    if (g.pass) byGrader[g.grader].passed++;
  }
  for (const s of Object.values(byGrader)) s.passRate = rate(s.passed, s.total);

  const answered = cases.filter((c) => !c.error);
  const latencies = answered.map((c) => c.latencyMs).sort((a, b) => a - b);
  const passed = cases.filter((c) => c.pass).length;

  return {
    total: cases.length,
    passed,
    passRate: rate(passed, cases.length),
    schemaFailures: cases.filter((c) => c.schemaFailure).length,
    errors: cases.length - answered.length,
    byTag,
    byGrader,
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    inputTokens: answered.reduce((a, c) => a + c.inputTokens, 0),
    outputTokens: answered.reduce((a, c) => a + c.outputTokens, 0),
    costUsd: sumOrNull(answered.map((c) => c.costUsd)),
    judgeCostUsd: sumOrNull(answered.map((c) => c.judgeCostUsd)),
    cacheHits: cases.filter((c) => c.cached).length,
    retries: cases.reduce((a, c) => a + c.retries, 0),
  };
}
