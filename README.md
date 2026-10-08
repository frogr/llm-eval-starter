# llm-eval-starter

A small, readable test harness for LLM features: a golden set, deterministic and LLM-as-judge graders, regression comparison between prompt versions, and a CI gate. TypeScript, no runtime dependencies, runs fully offline in demo mode.

## Why

An LLM feature is code that returns different output when you change a prompt, swap a model, or the provider ships an update. Most teams test it by trying a handful of inputs by hand and deciding it "looks better". That works for the first week. After that, nobody remembers which inputs were tried, a fix for one complaint quietly breaks something that used to work, and the only signal is a support ticket.

The fix is the same one we use for any other code: a test suite. A fixed set of realistic inputs with known-good answers, graders that score outputs the same way every time, a diff that shows which cases changed between versions, and a gate in CI that blocks merges when quality drops below a floor.

This repo is a working example of that loop, small enough to read in one sitting. The example feature is support-ticket triage, but the structure carries over to any feature that turns input into structured output.

## 60-second quickstart (offline, no API key)

Requires Node 20.19+.

```bash
git clone https://github.com/frogr/llm-eval-starter
cd llm-eval-starter
npm install

npm run eval -- --prompt v1 --provider mock   # first-draft prompt: fails the gate, exits 1
npm run eval -- --prompt v2 --provider mock   # revised prompt: passes the gate
npm run compare -- v1 v2                      # which cases flipped, and which tags moved
```

`--provider mock` is the default, so `npm run eval -- --prompt v2` does the same thing. Each run prints a summary and writes `reports/<timestamp>-<prompt>-<provider>.md` (readable) and `.json` (used by `compare`).

What you will see:

```
  Overall  26/29  89.7%   schema failures: 0

  tag               pass  rate
  account           5/5   100.0%  ████████████████████
  ambiguous         3/4   75.0%   ███████████████░░░░░
  ...
  multi-issue       3/4   75.0%   ███████████████░░░░░

Failing cases (3)
  ✗ billing-calm-cancel [billing]
      needs_human: expected false, got true
  ✗ bug-sarcastic-data-loss [bug, ambiguous, tone]
      category: expected "bug", got "billing"
  ✗ multi-three-issues [multi-issue]
      judge: complete: missing "bulk-edit"
```

v2 fixes most of v1's failures (unparseable output, prompt injection, non-English summaries, tone-driven priority). It also introduces two regressions that the headline number hides: a stricter summary length cap drops the third issue from a three-issue ticket, and a new escalation rule over-escalates a polite cancellation. `npm run compare -- v1 v2` lists both. The `multi-issue` tag goes from 100% to 75% while every other tag improves or holds.

That is the point of the demo: the average went up 38 points, and you would still want to read the regressions before merging.

## Running against a real model

```bash
export ANTHROPIC_API_KEY=...
npm run eval -- --prompt v2 --provider anthropic

export OPENAI_API_KEY=...
npm run eval -- --prompt v2 --provider openai --model gpt-4o-mini
```

Providers are plain `fetch` calls (`src/providers/anthropic.ts`, `src/providers/openai.ts`). The Anthropic call does not send `temperature`: current Claude models reject sampling overrides, so the request's temperature only feeds the cache key. Default models are small and cheap; override with `--model`, `ANTHROPIC_MODEL` or `OPENAI_MODEL`. The judge uses the same provider; pass `--judge-model` to use a stronger model for grading.

Responses are cached in `.cache/`, so re-running after editing a grader or the report costs nothing. Changing the prompt, input, model or sampling params changes the cache key and triggers a fresh call. Use `--no-cache` to force fresh calls (for example, to measure run-to-run variance).

A note on the mock: it is a keyword classifier with deliberate failure modes, and it reacts to a few specific phrases in the v1/v2 prompts. It exists so the harness can run in CI and in this README without a key. It does not evaluate your prompts. Once you edit `src/feature.ts`, use a real provider.

### What a real model did, once

On 2026-10-07 both prompts ran against `claude-haiku-4-5` (judge: the same model), one run each, no cache. The reports and the compare output are in `evals/runs/2026-10-07-claude-haiku-4-5/`.

| | v1 | v2 |
| --- | --- | --- |
| Overall | 13/29 (44.8%) | 17/29 (58.6%) |
| Schema failures | 1 | 0 |
| Gate | fail | fail |
| Tokens | 3,581 in / 1,834 out | 9,352 in / 1,544 out |
| Cost (triage + judge) | $0.03 | $0.04 |
| Latency p50 / p95 | 863 / 1130 ms | 782 / 833 ms |

v2 fixed five cases and broke one (`account-add-teammate`, now categorized as `other`). Eleven cases fail under both prompts, and most of them fail the same way: the model sets `needs_human: true` on tickets the golden set says it should handle alone (the empty greeting, the German export bug, a routine locked-out account). That is a real disagreement between the labels and the model, and it is the kind of thing this harness exists to surface. Neither prompt was written for this model, so treat the numbers as a baseline, not a verdict. The point is that the gate held: a prompt that looks fine on the mock does not get to merge on a real model.

### v3: tuned on the real model, with a holdout

Tuning a prompt against the whole golden set turns the set into training data. So before writing v3, every third case in `evals/golden.jsonl` was marked `"holdout": true` (9 of 29, chosen by position, not by content). `--split tune` runs the other 20 and `--split holdout` runs the 9. The v3 rules were written from v2's failures on the tune split only, in two rounds; the holdout was scored after each round and never read.

| | tune (20) | holdout (9) | all (29) |
| --- | --- | --- | --- |
| v2 | 13 (65.0%) | 4 (44.4%) | 17 (58.6%) |
| v3, first draft | 15 (75.0%) | 6 (66.7%) | |
| v3, second draft | 18 (90.0%) | 7 (77.8%) | 25 (86.2%) |

The holdout moved with the tune split, which is the sign the rules generalize instead of memorizing. And v3 still fails the gate. Its overall rate clears the 85% floor, but `prompt-injection` fell from 100% to 50%: the new "most tickets do not need a person" rule talked the model out of flagging the fake `SYSTEM:` tag. That is the per-tag floor doing its job. The fix is one more rule and one more run, which is the loop this repo is for. Reports: `evals/runs/2026-10-07-claude-haiku-4-5/v3.md` and `compare-v2-v3.txt`.

## Adapting it to your own feature

1. **Define the output.** Edit `src/types.ts` (`Triage`, `GoldenCase`) to describe what your feature returns and what a correct answer looks like.
2. **Point it at your feature.** Replace `src/feature.ts`: your prompt versions, `buildRequest`, and a strict `parseX` function. Import this from your app if you can, so you test the code you ship.
3. **Write the golden set.** Replace `evals/golden.jsonl`. Start with 20 to 50 cases. Pull them from real traffic where possible, label them by hand, and include the ugly ones: empty input, other languages, injection attempts, multi-part requests. Tag every case; tags are how you find out *where* quality changed.
4. **Adjust the deterministic graders** in `src/graders/deterministic.ts`. Anything with a right answer (enum fields, numeric ranges, required keys, length limits) belongs here.
5. **Rewrite the judge rubric** in `src/graders/judge.ts` for the fuzzy parts. Keep criteria binary and independent. Give the judge reference points from the golden set.
6. **Run it against a real provider**, read every failing case, and fix labels that turn out to be wrong before you fix prompts.
7. **Set thresholds** in `evals/thresholds.json` slightly below where you are today. Raise them as the feature improves.
8. **Wire up CI.** `.github/workflows/evals.yml` runs the mock eval on every PR. Swap in a real provider with a secret when you're ready.
9. **Delete the mock**, or keep it as a harness smoke test.

## File map

```
evals/
  golden.jsonl          29 synthetic cases: input, expected fields, tags, notes
  thresholds.json       gate floors (overall, per tag, schema failures)
src/
  feature.ts            the feature under test: prompts v1 and v2, request builder, strict parser
  types.ts              shared types
  runner.ts             loads the golden set, runs cases, grades, summarizes
  cache.ts              response cache keyed by hash(provider, model, prompt, input, params)
  concurrency.ts        concurrency limit and retry with backoff
  gate.ts               threshold checks for CI
  compare.ts            regression diff between two runs
  report.ts             terminal summary + markdown/JSON reports
  format.ts             small terminal formatting helpers
  graders/
    deterministic.ts    schema, category, priority (with tolerance), needs_human, summary length
    judge.ts            LLM-as-judge rubric, plus an offline stand-in
  providers/
    index.ts            provider factory, default models, price table
    mock.ts             deterministic fake model with realistic failure modes
    anthropic.ts        Messages API via fetch
    openai.ts           Chat Completions API via fetch
    errors.ts           retryable vs non-retryable errors
  cli/
    eval.ts             npm run eval
    compare.ts          npm run compare
test/                   vitest: graders, cache keys, gating, compare, end-to-end demo
.github/workflows/
  evals.yml             CI example: typecheck, tests, mock eval gate
```

## Concepts

**Golden set.** A fixed, versioned list of inputs with the answers you'd accept. It is the spec for the feature. The value is in the hard cases, so many of these 29 are edge cases: shouting, sarcasm, three issues in one message, a fake `SYSTEM:` tag, a message that just says "hi". Each case has tags (`multi-issue`, `prompt-injection`, `non-english`, ...) so a report can tell you that injection handling broke, not just that the score dropped 3%. Cases can carry `notes` explaining a non-obvious label, because six months from now someone will ask why that ticket is `bug` and not `billing`.

**Deterministic graders vs LLM judge.** Use code wherever there is a right answer: valid JSON, enum membership, exact category, priority within a tolerance, length limits. Those graders are free, fast and never disagree with themselves. Use an LLM judge only for what code can't check, here whether the summary is faithful, complete and in English. The judge gets an explicit rubric with independent pass/fail criteria (not "rate 1 to 10") and reference points from the golden set, and it must give a reason for each verdict. A judge is itself a model that can be wrong, so treat its scores as a measurement to validate, not ground truth.

**Partial credit.** Every grader returns a score from 0 to 1 and a reason, as well as pass/fail. Priority one level off within tolerance passes with 0.5. Pass/fail drives the gate; scores let you see drift before it crosses a line.

**Regression compare.** Pass rate is a lossy summary. Two prompts can both score 85% while failing completely different cases. `npm run compare` matches cases by id and lists what flipped in each direction, plus per-tag deltas sorted worst first. Read the regressions before merging, even when the total went up.

**CI gates.** `evals/thresholds.json` sets floors: overall pass rate, a minimum for every tag (so a strong average can't hide a collapsed category), per-tag overrides (`prompt-injection` must be 100%), and a maximum number of schema failures (usually zero, since unparseable output is an outage). `npm run eval` exits 1 when any floor is violated, which fails the CI job. `npm run compare -- <before> <after> --fail-on-regression` exits 1 if any case went from pass to fail.

**Cost and latency.** Every run records p50/p95 latency, token counts and estimated cost (from a small price table in `src/providers/index.ts`; unknown models show `n/a` instead of a guess). In the demo, v2's longer prompt nearly triples input tokens: 3,454 for v1 against 9,745 for v2 across the 29 cases, as the mock provider counts them. That is a real trade-off and it belongs in the same report as the quality numbers.

## CLI reference

```
npm run eval -- [options]
  --prompt <v1|v2>       prompt version (default v2)
  --provider <name>      mock | anthropic | openai (default mock)
  --model <id>           model for the feature under test
  --judge-model <id>     model for the judge (default: same as --model)
  --golden <path>        default evals/golden.jsonl
  --thresholds <path>    default evals/thresholds.json
  --tag <tag>            run only cases with this tag (skips the gate)
  --concurrency <n>      parallel requests (default 4)
  --attempts <n>         attempts per request incl. the first (default 3)
  --no-cache             don't read or write .cache/
  --no-gate              report only, always exit 0

npm run compare -- <before> <after> [--provider <name>] [--fail-on-regression]
  <before>/<after> are prompt versions (latest report) or paths to report .json files

npm test                 unit + end-to-end tests
npm run typecheck        tsc --noEmit
```

Exit codes: `0` pass, `1` gate failed or regression found, `2` usage or setup error.

## Going further

This repo is the first step of my course, [Evals in Production](https://austn.net/courses/evals-in-production), which covers golden sets from production logs, calibrating a judge, autonomy gating, cost and latency, and evals in CI.

## License

MIT © Austin French. See [LICENSE](LICENSE).

Built by [Austin French](https://austn.net) ([@frogr](https://github.com/frogr)).
