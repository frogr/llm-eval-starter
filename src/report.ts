// Two views of the same run: a terminal summary for the person at the keyboard
// and a markdown file to attach to a PR or skim later. Plus the raw JSON,
// which `npm run compare` reads.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bar, c, pct, table, truncate, usd } from "./format";
import type { GateCheck } from "./gate";
import type { CaseResult, RunRecord } from "./types";

function failReasons(r: CaseResult): string[] {
  if (r.error) return [`error: ${r.error}`];
  return r.grades.filter((g) => !g.pass).map((g) => `${g.grader}: ${g.reason}`);
}

function sortedTags(run: RunRecord) {
  return Object.entries(run.summary.byTag).sort(([a], [b]) => a.localeCompare(b));
}

export function renderTerminal(run: RunRecord, gate: GateCheck[] | null): string {
  const s = run.summary;
  const out: string[] = [];
  const rateColor = (rate: number) => (rate >= 0.85 ? c.green : rate >= 0.7 ? c.yellow : c.red);

  out.push("");
  out.push(c.bold(`Eval: prompt=${run.prompt}  provider=${run.provider}  model=${run.model}  judge=${run.judgeModel}`));
  out.push(
    c.dim(
      `${s.total} cases · ${s.cacheHits} from cache · ${s.retries} retries · ` +
        `latency p50 ${s.latencyP50Ms}ms p95 ${s.latencyP95Ms}ms · ` +
        `${s.inputTokens.toLocaleString()} in / ${s.outputTokens.toLocaleString()} out tokens · ` +
        `cost ${usd(s.costUsd)} (+ judge ${usd(s.judgeCostUsd)})`,
    ),
  );
  out.push("");
  out.push(rateColor(s.passRate)(c.bold(`  Overall  ${s.passed}/${s.total}  ${pct(s.passRate)}`)) + `   schema failures: ${s.schemaFailures}` + (s.errors ? `   errors: ${s.errors}` : ""));
  out.push("");

  const tagRows = sortedTags(run).map(([tag, t]) => [tag, `${t.passed}/${t.total}`, pct(t.passRate), bar(t.passRate)]);
  const tagLines = table([["tag", "pass", "rate", ""], ...tagRows]).split("\n");
  out.push(c.dim(tagLines[0]));
  tagLines.slice(1).forEach((line, i) => out.push(rateColor(sortedTags(run)[i][1].passRate)(line)));
  out.push("");

  const graderRows = Object.entries(s.byGrader).map(([g, t]) => [g, `${t.passed}/${t.total}`, pct(t.passRate)]);
  const graderLines = table([["grader", "pass", "rate"], ...graderRows]).split("\n");
  out.push(c.dim(graderLines[0]), ...graderLines.slice(1));

  const failing = run.cases.filter((r) => !r.pass);
  if (failing.length) {
    out.push("");
    out.push(c.bold(`Failing cases (${failing.length})`));
    for (const r of failing) {
      out.push(`  ${c.red("✗")} ${r.id} ${c.dim(`[${r.tags.join(", ")}]`)}`);
      for (const reason of failReasons(r)) out.push(`      ${truncate(reason, 110)}`);
    }
  }

  if (gate) {
    out.push("");
    out.push(c.bold("Gate"));
    // Show failures in full; collapse passing tag checks to keep output short.
    for (const g of gate) {
      if (g.pass && g.name.startsWith("tag ")) continue;
      const mark = g.pass ? c.green("✓") : c.red("✗");
      out.push(`  ${mark} ${g.name}: ${g.actual} (required ${g.required})`);
    }
    const passingTags = gate.filter((g) => g.pass && g.name.startsWith("tag ")).length;
    if (passingTags) out.push(c.dim(`  ✓ ${passingTags} tag floors met`));
  }
  out.push("");
  return out.join("\n");
}

export function renderMarkdown(run: RunRecord, gate: GateCheck[] | null): string {
  const s = run.summary;
  const md: string[] = [];
  md.push(`# Eval report: prompt \`${run.prompt}\``);
  md.push("");
  md.push(`- Started: ${run.startedAt}`);
  md.push(`- Provider: \`${run.provider}\` · model: \`${run.model}\` · judge: \`${run.judgeModel}\``);
  md.push(`- Cases: ${s.total} (${s.cacheHits} from cache, ${s.retries} retries, ${s.errors} errors)`);
  md.push(`- Latency: p50 ${s.latencyP50Ms}ms · p95 ${s.latencyP95Ms}ms`);
  md.push(`- Tokens: ${s.inputTokens.toLocaleString()} in / ${s.outputTokens.toLocaleString()} out · cost ${usd(s.costUsd)} (judge ${usd(s.judgeCostUsd)})`);
  md.push("");
  md.push(`**Overall: ${s.passed}/${s.total} (${pct(s.passRate)}) · schema failures: ${s.schemaFailures}**`);
  md.push("");

  if (gate) {
    md.push(`## Gate: ${gate.every((g) => g.pass) ? "PASS" : "FAIL"}`);
    md.push("");
    md.push("| Check | Actual | Required | |");
    md.push("|---|---|---|---|");
    for (const g of gate) md.push(`| ${g.name} | ${g.actual} | ${g.required} | ${g.pass ? "pass" : "**FAIL**"} |`);
    md.push("");
  }

  md.push("## By tag");
  md.push("");
  md.push("| Tag | Passed | Rate |");
  md.push("|---|---|---|");
  for (const [tag, t] of sortedTags(run)) md.push(`| ${tag} | ${t.passed}/${t.total} | ${pct(t.passRate)} |`);
  md.push("");

  md.push("## By grader");
  md.push("");
  md.push("Graders after `schema` only run on outputs that parsed.");
  md.push("");
  md.push("| Grader | Passed | Rate |");
  md.push("|---|---|---|");
  for (const [g, t] of Object.entries(s.byGrader)) md.push(`| ${g} | ${t.passed}/${t.total} | ${pct(t.passRate)} |`);
  md.push("");

  const failing = run.cases.filter((r) => !r.pass);
  md.push(`## Failing cases (${failing.length})`);
  md.push("");
  for (const r of failing) {
    md.push(`### \`${r.id}\``);
    md.push("");
    md.push(`Tags: ${r.tags.map((t) => `\`${t}\``).join(", ")}`);
    md.push("");
    md.push(`> ${r.input.replace(/\n/g, "\n> ") || "(empty)"}`);
    md.push("");
    for (const reason of failReasons(r)) md.push(`- ${reason}`);
    md.push("");
    md.push("<details><summary>Raw output</summary>");
    md.push("");
    md.push("~~~~"); // not ``` because raw output often contains code fences
    md.push(r.rawOutput || "(none)");
    md.push("~~~~");
    md.push("");
    md.push("</details>");
    md.push("");
  }
  return md.join("\n");
}

/** Writes <stamp>-<prompt>-<provider>.md and .json. Returns the markdown path. */
export async function writeReports(run: RunRecord, gate: GateCheck[] | null, dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const stamp = run.startedAt.replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
  const base = join(dir, `${stamp}-${run.prompt}-${run.provider}`);
  await writeFile(`${base}.md`, renderMarkdown(run, gate));
  await writeFile(`${base}.json`, JSON.stringify(run, null, 2));
  return `${base}.md`;
}
