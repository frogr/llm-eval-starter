// npm run eval -- --prompt v2 --provider mock
//
// Exit codes: 0 = gate passed, 1 = gate failed, 2 = usage or setup error.

import { parseArgs } from "node:util";
import { completeWithCache } from "../cache";
import { withRetry } from "../concurrency";
import { isPromptVersion, PROMPTS } from "../feature";
import { c } from "../format";
import { checkThresholds, gatePassed, loadThresholds } from "../gate";
import { createLlmJudge, createMockJudge, type Judge } from "../graders/judge";
import { createProvider, PROVIDERS } from "../providers";
import { renderTerminal, writeReports } from "../report";
import { loadGolden, runEval } from "../runner";
import type { Provider } from "../types";

const HELP = `Usage: npm run eval -- [options]

  --prompt <v>         Prompt version: ${Object.keys(PROMPTS).join(", ")} (default: v2)
  --provider <p>       ${PROVIDERS.join(" | ")} (default: mock)
  --model <id>         Model for the feature under test (provider default otherwise)
  --judge-model <id>   Model for the LLM judge (default: same as --model)
  --golden <path>      Golden set (default: evals/golden.jsonl)
  --thresholds <path>  Gate thresholds (default: evals/thresholds.json)
  --tag <tag>          Only run cases with this tag
  --split <s>          all | tune | holdout: cases marked "holdout" in the golden set are for scoring only (default: all)
  --concurrency <n>    Parallel requests (default: 4)
  --attempts <n>       Attempts per request, including the first (default: 3)
  --no-cache           Ignore and don't write .cache/
  --no-gate            Report only; always exit 0
  -h, --help`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      prompt: { type: "string", default: "v2" },
      provider: { type: "string", default: "mock" },
      model: { type: "string" },
      "judge-model": { type: "string" },
      golden: { type: "string", default: "evals/golden.jsonl" },
      thresholds: { type: "string", default: "evals/thresholds.json" },
      tag: { type: "string" },
      split: { type: "string", default: "all" },
      concurrency: { type: "string", default: "4" },
      attempts: { type: "string", default: "3" },
      "no-cache": { type: "boolean", default: false },
      "no-gate": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (!isPromptVersion(values.prompt)) {
    console.error(`unknown prompt "${values.prompt}". Expected one of: ${Object.keys(PROMPTS).join(", ")}`);
    return 2;
  }

  const cache = { dir: ".cache", enabled: !values["no-cache"] };
  const attempts = Math.max(1, Number(values.attempts));
  const provider: Provider = createProvider(values.provider, values.model);

  // In demo mode the judge is a heuristic stand-in. With a real provider it's
  // an LLM call that shares the cache and retry logic with the feature calls.
  let judge: Judge;
  if (provider.name === "mock") {
    judge = createMockJudge();
  } else {
    const judgeProvider = createProvider(values.provider, values["judge-model"] ?? provider.model);
    judge = createLlmJudge(judgeProvider.model, async (req) => {
      const { value } = await withRetry(() => completeWithCache(judgeProvider, req, cache), {
        attempts,
        baseDelayMs: 250,
      });
      return value.result;
    });
  }

  let cases = await loadGolden(values.golden);
  if (values.tag) cases = cases.filter((x) => x.tags.includes(values.tag!));
  if (values.split === "tune") cases = cases.filter((x) => !x.holdout);
  else if (values.split === "holdout") cases = cases.filter((x) => x.holdout);
  else if (values.split !== "all") {
    console.error(`unknown split "${values.split}". Expected all, tune or holdout`);
    return 2;
  }
  if (!cases.length) {
    console.error("no cases to run");
    return 2;
  }

  process.stderr.write(c.dim(`Running ${cases.length} cases (prompt ${values.prompt}, ${provider.name}/${provider.model})\n`));
  const run = await runEval({
    prompt: values.prompt,
    provider,
    judge,
    cases,
    concurrency: Math.max(1, Number(values.concurrency)),
    attempts,
    cache,
    onCaseDone: (_r, done, total) => {
      if (process.stderr.isTTY) process.stderr.write(`\r  ${done}/${total}`);
    },
    onRetry: (id, err, attempt) => {
      const clear = process.stderr.isTTY ? "\r\x1b[K" : "";
      process.stderr.write(`${clear}${c.yellow(`  retry ${id} (attempt ${attempt} failed: ${err.message})`)}\n`);
    },
  });
  if (process.stderr.isTTY) process.stderr.write("\r\x1b[K");

  // Gating a filtered run against global thresholds would be misleading.
  const gate = values["no-gate"] || values.tag || values.split !== "all" ? null : checkThresholds(run.summary, await loadThresholds(values.thresholds));

  console.log(renderTerminal(run, gate));
  const path = await writeReports(run, gate, "reports");
  console.log(c.dim(`Report: ${path}`));

  if (gate && !gatePassed(gate)) {
    console.log(c.red(c.bold("Gate FAILED")) + c.dim(` (thresholds: ${values.thresholds})`));
    return 1;
  }
  if (gate) console.log(c.green(c.bold("Gate passed")));
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(c.red(`error: ${(err as Error).message}`));
    process.exit(2);
  },
);
