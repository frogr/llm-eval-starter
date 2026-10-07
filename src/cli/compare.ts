// npm run compare -- v1 v2
// npm run compare -- reports/a.json reports/b.json --fail-on-regression
//
// Each argument is a prompt version (uses its most recent report) or a path
// to a report .json written by `npm run eval`.

import { parseArgs } from "node:util";
import { compareRuns, renderComparison, resolveRun } from "../compare";
import { c } from "../format";

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      provider: { type: "string" },
      reports: { type: "string", default: "reports" },
      "fail-on-regression": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help || positionals.length !== 2) {
    console.log(`Usage: npm run compare -- <before> <after> [--provider mock] [--fail-on-regression]

  <before>, <after>      prompt version (latest report) or path to a report .json
  --provider <p>         only consider reports from this provider
  --reports <dir>        reports directory (default: reports)
  --fail-on-regression   exit 1 if any case went from pass to fail`);
    return values.help ? 0 : 2;
  }

  const [beforeRef, afterRef] = positionals;
  const before = await resolveRun(beforeRef, values.reports, values.provider);
  const after = await resolveRun(afterRef, values.reports, values.provider);
  if (before.provider !== after.provider || before.model !== after.model) {
    console.log(c.yellow(`Note: comparing different models (${before.provider}/${before.model} vs ${after.provider}/${after.model}).`));
  }

  const cmp = compareRuns(before, after);
  console.log(renderComparison(cmp));

  if (values["fail-on-regression"] && cmp.regressions.length) {
    console.log(c.red(c.bold(`${cmp.regressions.length} regression(s)`)));
    return 1;
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(c.red(`error: ${(err as Error).message}`));
    process.exit(2);
  },
);
