// Regression diff between two runs. The headline pass rate hides the most
// useful information: WHICH cases changed. A new prompt can go from 80% to 85%
// while breaking three cases that used to work. This surfaces those.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { c, pct, table, truncate } from "./format";
import type { CaseResult, RunRecord } from "./types";

export interface Flip {
  id: string;
  tags: string[];
  /** Failing grader reasons in the run where the case fails. */
  reasons: string[];
}

export interface TagDelta {
  tag: string;
  before: number | null;
  after: number | null;
  delta: number | null;
}

export interface Comparison {
  before: RunRecord;
  after: RunRecord;
  regressions: Flip[]; // pass -> fail
  fixes: Flip[]; // fail -> pass
  stillFailing: string[];
  onlyInBefore: string[];
  onlyInAfter: string[];
  tagDeltas: TagDelta[];
}

const reasonsOf = (r: CaseResult) =>
  r.error ? [`error: ${r.error}`] : r.grades.filter((g) => !g.pass).map((g) => `${g.grader}: ${g.reason}`);

export function compareRuns(before: RunRecord, after: RunRecord): Comparison {
  const a = new Map(before.cases.map((r) => [r.id, r]));
  const b = new Map(after.cases.map((r) => [r.id, r]));
  const regressions: Flip[] = [];
  const fixes: Flip[] = [];
  const stillFailing: string[] = [];

  for (const [id, rb] of b) {
    const ra = a.get(id);
    if (!ra) continue;
    if (ra.pass && !rb.pass) regressions.push({ id, tags: rb.tags, reasons: reasonsOf(rb) });
    else if (!ra.pass && rb.pass) fixes.push({ id, tags: rb.tags, reasons: reasonsOf(ra) });
    else if (!ra.pass && !rb.pass) stillFailing.push(id);
  }

  const tags = new Set([...Object.keys(before.summary.byTag), ...Object.keys(after.summary.byTag)]);
  const tagDeltas = [...tags]
    .map((tag) => {
      const x = before.summary.byTag[tag]?.passRate ?? null;
      const y = after.summary.byTag[tag]?.passRate ?? null;
      return { tag, before: x, after: y, delta: x !== null && y !== null ? y - x : null };
    })
    // Biggest regressions first, then biggest improvements.
    .sort((p, q) => (p.delta ?? 0) - (q.delta ?? 0) || p.tag.localeCompare(q.tag));

  return {
    before,
    after,
    regressions,
    fixes,
    stillFailing,
    onlyInBefore: [...a.keys()].filter((id) => !b.has(id)),
    onlyInAfter: [...b.keys()].filter((id) => !a.has(id)),
    tagDeltas,
  };
}

function signed(delta: number | null): string {
  if (delta === null) return "n/a";
  if (Math.abs(delta) < 1e-9) return "  0.0";
  return `${delta > 0 ? "+" : ""}${(delta * 100).toFixed(1)}`;
}

const label = (r: RunRecord) => `${r.prompt}@${r.provider}`;

export function renderComparison(cmp: Comparison): string {
  const { before, after } = cmp;
  const out: string[] = [];
  const d = after.summary.passRate - before.summary.passRate;
  out.push("");
  out.push(c.bold(`Compare: ${label(before)} (${before.startedAt}) -> ${label(after)} (${after.startedAt})`));
  out.push("");
  out.push(
    `  Overall  ${pct(before.summary.passRate)} -> ${pct(after.summary.passRate)}  ` +
      (d >= 0 ? c.green : c.red)(`(${signed(d)} pts)`) +
      `   schema failures ${before.summary.schemaFailures} -> ${after.summary.schemaFailures}`,
  );
  out.push("");

  const rows = cmp.tagDeltas.map((t) => [
    t.tag,
    t.before === null ? "-" : pct(t.before),
    t.after === null ? "-" : pct(t.after),
    signed(t.delta),
  ]);
  const lines = table([["tag", label(before), label(after), "delta (pts)"], ...rows]).split("\n");
  out.push(c.dim(lines[0]));
  lines.slice(1).forEach((line, i) => {
    const delta = cmp.tagDeltas[i].delta ?? 0;
    out.push(delta < -1e-9 ? c.red(line) : delta > 1e-9 ? c.green(line) : line);
  });

  out.push("");
  out.push(c.bold(c.red(`Regressions: pass -> fail (${cmp.regressions.length})`)));
  if (!cmp.regressions.length) out.push(c.dim("  none"));
  for (const f of cmp.regressions) {
    out.push(`  ${c.red("✗")} ${f.id} ${c.dim(`[${f.tags.join(", ")}]`)}`);
    for (const r of f.reasons) out.push(`      ${r}`);
  }

  out.push("");
  out.push(c.bold(c.green(`Fixes: fail -> pass (${cmp.fixes.length})`)));
  if (!cmp.fixes.length) out.push(c.dim("  none"));
  for (const f of cmp.fixes) {
    out.push(`  ${c.green("✓")} ${f.id} ${c.dim(`[${f.tags.join(", ")}]  was: ${truncate(f.reasons.join("; "), 90)}`)}`);
  }

  if (cmp.stillFailing.length) {
    out.push("");
    out.push(c.bold(`Still failing (${cmp.stillFailing.length})`));
    out.push(`  ${cmp.stillFailing.join(", ")}`);
  }
  if (cmp.onlyInBefore.length || cmp.onlyInAfter.length) {
    out.push("");
    out.push(c.yellow(`Case sets differ. Only in ${label(before)}: ${cmp.onlyInBefore.join(", ") || "-"}. Only in ${label(after)}: ${cmp.onlyInAfter.join(", ") || "-"}.`));
  }
  out.push("");
  return out.join("\n");
}

/**
 * Resolve a CLI argument to a run: either a path to a report .json, or a
 * prompt version, which picks the most recent report for that prompt.
 */
export async function resolveRun(ref: string, reportsDir: string, provider?: string): Promise<RunRecord> {
  if (ref.endsWith(".json")) return JSON.parse(await readFile(ref, "utf8")) as RunRecord;

  const files = await readdir(reportsDir).catch(() => [] as string[]);
  const suffix = provider ? `-${ref}-${provider}.json` : null;
  const matches = files
    .filter((f) => f.endsWith(".json") && (suffix ? f.endsWith(suffix) : f.includes(`-${ref}-`)))
    .sort(); // timestamps sort lexically
  const latest = matches.at(-1);
  if (!latest) {
    throw new Error(
      `no report found for prompt "${ref}" in ${reportsDir}/. Run: npm run eval -- --prompt ${ref}${provider ? ` --provider ${provider}` : ""}`,
    );
  }
  return JSON.parse(await readFile(join(reportsDir, latest), "utf8")) as RunRecord;
}
