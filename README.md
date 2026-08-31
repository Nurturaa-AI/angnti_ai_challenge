# Repo Archaeologist

**Understand an unfamiliar codebase before you change it.**

You have been handed a repository you did not write. Before you touch anything, you need to
know what it does, how it is put together, where the sharp edges are, and which files to
read first. Repo Archaeologist produces that briefing — and cites its sources, so you can
check it instead of trusting it.

> **Status: baseline measured, Iteration 1 measured and rejected.** The baseline analyser and
> the evaluation harness are complete and have been run against a real model. Iteration 1 —
> letting the model search and read files — is implemented, tested, and **scored 7.1 points
> worse than the baseline** on the primary metric. It ships behind `--system advanced`,
> unpromoted. See [`docs/improvement-changelog.md`](docs/improvement-changelog.md) for the
> numbers and the diagnosis.

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
pnpm repo:advanced -- ./path/to/repository     # same, but it may search and read files

# Same, with no API key and no cost — the offline deterministic provider
pnpm repo:baseline -- ./fixtures/orders-api --mock
pnpm repo:advanced -- ./fixtures/orders-api --mock   # exercises a real tool trajectory

# Run every evaluation case, against either system
pnpm evaluate:baseline
pnpm evaluate:advanced

# Evaluate offline, or one case at a time
pnpm evaluate:baseline --mock
pnpm evaluate:baseline --case case-001-orders-api
```

A run writes three files: a Markdown briefing and the full JSON run record in
[`reports/`](reports/), and the step trajectory in [`trajectories/`](trajectories/). An
evaluation run writes a timestamped JSON report and Markdown summary in
[`evaluation/results/`](evaluation/results/), plus a stable `latest-<system>.{json,md}` pair
for tooling. The two systems write to separate `latest-` files and never overwrite each
other's.

`--help` lists every flag (`--model`, `--seed`, `--thinking`, `--max-output`, `--out`,
`--cases`, `--case`, `--system`, `--case-delay`, `--quiet`, plus the seven exploration-budget
flags).

## Test

```sh
pnpm test         # 292 tests
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
the advanced system's job, and the gap between the two is the thing being measured.

The prompt names the four source ids and tells the model it may cite only those. The
grounding step then enforces that claim rather than trusting it — a
[test](baseline/test/baseline.test.ts) asserts the prompt never contains a commit hash, a
branch name, or the body of any source file.

## What the advanced system adds

Iteration 1 keeps all of the above and adds three read-only tools plus a bounded number of
turns in which to use them:

| Tool | Does | Produces citable evidence? |
| --- | --- | --- |
| `search_code` | Literal, case-insensitive substring search with surrounding context lines | No — locations only |
| `read_file` | Line-numbered read, optionally a line range | **Yes** |
| `list_directory` | Bounded-depth listing | No |

The structure that makes this trustworthy is the **evidence ledger**. It begins as the four
reconnaissance sources and grows *only* when a tool actually returns bytes. Grounding then runs
against the ledger, so the model's own prose can never be the thing that authorises a citation:
claim to have read a file you never opened and the citation is dropped, the claim is marked
unsupported, and the reason is recorded in the trajectory.

Exploration is bounded and every bound is configurable — turns, tool calls, search results,
file lines, file bytes, directory entries, directory depth. See
[`docs/architecture.md`](docs/architecture.md#advanced--targeted-exploration-iteration-1).

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

**Yes — and the first iteration made it worse.**

Both systems, same 14 questions, same model (`gemini-3.5-flash-lite`), same seed, same
evaluator, neither run with a failed case:

| | Baseline | Advanced (Iteration 1) |
| --- | --- | --- |
| **Evidence-backed task accuracy** | **64.3 % (9/14)** | **57.1 % (8/14)** |
| Answer accuracy | 85.7 % (12/14) | 85.7 % (12/14) |
| Mean evidence relevance | 0.85 | 0.68 |
| Fabrications | 0 | 0 |
| Dropped citations | 0 | 0 |
| Cost | $0.011935 | $0.024957 |

Iteration 1 cost 2.1× as much and scored 7.1 points lower on the metric it was built to move.
Under the pre-stated decision rule it is **rejected**: it ships, but nothing here claims it as
an improvement.

Two of the four changed questions did improve exactly as predicted — one went from wrong to
right *because* the agent opened the source file. Three regressed because the agent cited the
implementation where the case expects the README, and one regressed for real: it went deep on
one flow and produced a narrower briefing that missed a detail the baseline caught. The full
decomposition, including why the dataset is not being adjusted to rescue the result, is in
[`docs/improvement-changelog.md`](docs/improvement-changelog.md).

Worth stating separately, because it is the result that carries: **the grounding layer held
completely.** Zero fabrications and zero dropped citations on both sides. Giving the model file
access bought no invented quotations at all.

---

## Layout

```
apps/cli/              Argument parsing, the three commands, exit codes
baseline/              The baseline analyser: prompt, run loop, Markdown rendering
advanced/              Iteration 1: the exploring agent — prompt, tool loop, budget
evaluation/            The evaluation runner, plus cases/ and results/
packages/shared/       Schemas, context collection, tools, grounding, LLM clients, IO
packages/evaluator/    Case loading, matching, scoring, aggregation, reporting
fixtures/              Generated git repositories used by the cases (pnpm setup)
reports/               Briefings from both systems (JSON + Markdown)
trajectories/          What each run did, step by step
docs/                  Architecture, evaluation method, improvement changelog
scripts/               Fixture builder
```

[`docs/architecture.md`](docs/architecture.md) explains why the boundaries fall where they
do. [`docs/evaluation.md`](docs/evaluation.md) explains the metric in enough detail to
argue with. [`docs/improvement-changelog.md`](docs/improvement-changelog.md) is the
experiment log: one entry per iteration, hypothesis first, measurement after, never edited
to match the outcome.

## Limitations

Known and deliberate, in [`docs/evaluation.md`](docs/evaluation.md#limitations). The short
version: two cases is a tiny dataset, keyword matching is not comprehension,
`mustNotContain` is naive substring matching, and the baseline cannot answer any question
whose evidence lives inside a source file.

Iteration 1 added one more, and it is the reason the measurement above should be read as a
signal rather than a verdict on exploration itself: each case's `expectedEvidence` was written
when reconnaissance context was all any system had, so it lists only files the baseline could
see. A system that cites the implementation instead of the README describing it is scored down
for citing better evidence. That is a real flaw in the dataset — but fixing it *after* seeing
which files the advanced system chose would be fitting the ruler to the result, so Iteration 1's
number stands as measured and the dataset is Iteration 2's problem.
