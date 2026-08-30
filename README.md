# Repo Archaeologist

**Understand an unfamiliar codebase before you change it.**

You have been handed a repository you did not write. Before you touch anything, you need to
know what it does, how it is put together, where the sharp edges are, and which files to
read first. Repo Archaeologist produces that briefing — and cites its sources, so you can
check it instead of trusting it.

> **Status: foundation only.** This repository contains the project skeleton, the
> **baseline** analyser, and the **evaluation harness**. The advanced multi-tool agent is
> deliberately not built yet. The harness exists first so that when the agent arrives there
> is a number to move.

---

## The idea

Ask any model to explain a repository and you get fluent prose. Some of it is true. The
parts that are wrong are indistinguishable from the parts that are right, so you end up
reading the code anyway — you have paid for the summary and kept the work.

So the unit of output here is not prose. It is a **claim with a citation**:

```json
{
  "name": "express",
  "version": "^4.19.2",
  "scope": "runtime",
  "evidence": [
    { "type": "manifest", "source": "package.json", "location": "dependencies.express", "grounded": true }
  ]
}
```

Every citation is verified against the context the model was actually given, *after* the
model replies. A citation naming a file that was never supplied is deleted and recorded in
an audit. A claim that loses its last citation stays in the briefing and is **marked
unsupported** — hiding it would flatter the system; showing it tells you which sentences to
distrust.

That verification step is the product. Everything else is scaffolding for measuring it.

---

## Install

Requires **Node.js ≥ 22** and **pnpm**.

```sh
pnpm install          # install dependencies
pnpm setup            # build the two local git fixtures used by the evaluation cases
```

There is no build step. `tsx` runs the TypeScript directly.

For real model calls, copy the example environment file and add a key:

```sh
cp .env.example .env  # then set GEMINI_API_KEY
```

`.env` is gitignored. No key is needed for `--mock` runs, and the key is never printed to
stdout and never written to any file in `reports/`, `trajectories/` or
`evaluation/results/` — see [`redactSecrets`](packages/shared/src/paths.ts).

## Run

```sh
# Brief a local repository
pnpm repo:baseline -- ./path/to/repository

# Same, with no API key and no cost — the offline deterministic provider
pnpm repo:baseline -- ./fixtures/orders-api --mock

# Run every evaluation case
pnpm evaluate:baseline

# Evaluate offline, or one case at a time
pnpm evaluate:baseline --mock
pnpm evaluate:baseline --case case-001-orders-api
```

A baseline run writes three files: a Markdown briefing and the full JSON run record in
[`reports/`](reports/), and the step trajectory in [`trajectories/`](trajectories/). An
evaluation run writes a timestamped JSON report and Markdown summary in
[`evaluation/results/`](evaluation/results/), plus a stable `latest-baseline.{json,md}`
pair for tooling.

`--help` lists every flag (`--model`, `--seed`, `--thinking`, `--max-output`, `--out`,
`--cases`, `--case`, `--system`, `--quiet`).

## Test

```sh
pnpm test         # 199 tests
pnpm typecheck    # tsc --noEmit, strict
```

The whole suite runs offline with the model stubbed: no API key, no network, no cost.

---

## What the baseline does, and does not do

The baseline is meant to be beatable. It is the honest version of "just ask the model",
built well enough that beating it means something.

It collects four context sources and makes **exactly one** model call:

| Source | Content |
| --- | --- |
| `tree` | Directory listing, breadth-first, truncated at a budget |
| `README.md` | The README, if one exists, truncated at a budget |
| `package.json` | The package manifest (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, …), if one exists |
| `metadata` | File and directory counts, total bytes, language mix by extension |

It deliberately does **not**: read git history, open any source file, run tests, search the
code, use tools, use more than one model call, or verify anything by execution. Those are
the advanced agent's job, and the gap between the two is the thing being measured.

The prompt names the four source ids and tells the model it may cite only those. The
grounding step then enforces that claim rather than trusting it — a
[test](baseline/test/baseline.test.ts) asserts the prompt never contains a commit hash, a
branch name, or the body of any source file.

## Scoring

Four measures per question, from the evaluation cases in
[`evaluation/cases/`](evaluation/cases/):

1. **Correct answer** — the expected keywords appear in the field the case targets.
2. **Evidence-backed answer** — correct *and* cited *and* the citation carries the content
   of a location the case expects. **This is the primary metric.**
3. **Unsupported claim** — correct but uncited, or contradicted by a forbidden phrase.
4. **Evidence relevance** — the share of a claim's citations that point somewhere the case
   expects.

The one subtlety worth stating up front: a `tree` citation naming `src/services/inventory.js`
proves the file **exists**, not what is in it. That earns `partialEvidence`, never the
primary metric. It is how the harness keeps a shallow-context system from scoring like a
system that actually read the file. [`docs/evaluation.md`](docs/evaluation.md) works through
this in full.

## Has it been measured?

**No.** Not yet, and this README will not pretend otherwise.

What has been verified is the pipeline, end to end, using the offline mock provider: both
cases load, both produce a validated briefing, every citation is checked, the report and
summary are written, and the numbers are arithmetically consistent. A mock provider returns
canned text, so **its scores measure the harness, not any model** — the runner stamps every
such report with a caveat saying exactly that.

Real numbers require `GEMINI_API_KEY` and a run of `pnpm evaluate:baseline`. Until that has
happened, there is no baseline result to quote and no claim here that the results are good.

---

## Layout

```
apps/cli/              Argument parsing, the two commands, exit codes
baseline/              The baseline analyser: prompt, run loop, Markdown rendering
evaluation/            The evaluation runner, plus cases/ and results/
packages/shared/       Schemas, context collection, grounding, LLM clients, IO
packages/evaluator/    Case loading, matching, scoring, aggregation, reporting
fixtures/              Generated git repositories used by the cases (pnpm setup)
reports/               Baseline briefings (JSON + Markdown)
trajectories/          What each run did, step by step
docs/                  Architecture and evaluation method
scripts/               Fixture builder
```

[`docs/architecture.md`](docs/architecture.md) explains why the boundaries fall where they
do. [`docs/evaluation.md`](docs/evaluation.md) explains the metric in enough detail to
argue with.

## Limitations

Known and deliberate, in [`docs/evaluation.md`](docs/evaluation.md#limitations). The short
version: two cases is a tiny dataset, keyword matching is not comprehension,
`mustNotContain` is naive substring matching, and the baseline cannot answer any question
whose evidence lives inside a source file.
