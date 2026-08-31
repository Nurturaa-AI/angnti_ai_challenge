# Repo Archaeologist

**Understand an unfamiliar codebase before you change it.**

You have been handed a repository you did not write. Before you touch anything, you need to
know what it does, how it is put together, where the sharp edges are, and which files to
read first. Repo Archaeologist produces that briefing — and cites its sources, so you can
check it instead of trusting it.

> **Status: baseline measured, Iteration 1 rejected, Iteration 2 measured and kept.** The
> baseline analyser and the evaluation harness are complete and have been run against a real
> model. Iteration 1 — letting the model search and read files — **scored 7.1 points worse than
> the baseline** and was rejected. Iteration 2 — making the search deterministic and running it
> *before* the model gets a turn — **scored 21.4 points better**, at 85.7 % against the
> baseline's 64.3 %. See [`docs/improvement-changelog.md`](docs/improvement-changelog.md) for
> both numbers and the diagnosis behind each.

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
pnpm repo:advanced -- ./path/to/repository     # same, but it searches and reads files first

# Aim the search phase at a question you already have
pnpm repo:advanced -- ./path/to/repository --focus "how are steps dispatched?"

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
`--cases`, `--case`, `--system`, `--case-delay`, `--quiet`, `--focus`, plus the ten
exploration-budget flags).

## Test

```sh
pnpm test         # 362 tests
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

It keeps all of the above — the reconnaissance context is **preserved, not replaced** — and adds
two things.

**A deterministic Evidence Scout (Iteration 2), which runs before the model gets a turn.** It
extracts search terms, searches the repository for each, deduplicates and ranks the matching
files, and reads the highest-scoring few. No model call is involved: term extraction is
tokenize → drop stop words → keep technical tokens → detect compounds → apply a small synonym
table, all pure functions. This exists because Iteration 1 gave the model a search tool and it
used it **zero** times out of seven calls, guessing filenames from the directory tree instead.

**Three read-only tools plus a bounded number of turns**, which the model still has after the
scout finishes — the scout sets a floor on the evidence, not a ceiling:

| Tool | Does | Produces citable evidence? |
| --- | --- | --- |
| `search_code` | Literal, case-insensitive substring search with surrounding context lines | No — locations only |
| `read_file` | Line-numbered read, optionally a line range | **Yes** |
| `list_directory` | Bounded-depth listing | No |

The structure that makes this trustworthy is the **evidence ledger**. It begins as the four
reconnaissance sources and grows *only* when a tool actually returns bytes. The scout's reads go
through the same `read_file`, the same boundary check and the same `recordAll` — there is no
privileged path in. Grounding then runs against the ledger, so the model's own prose can never be
the thing that authorises a citation: claim to have read a file you never opened and the citation
is dropped, the claim is marked unsupported, and the reason is recorded in the trajectory.

Exploration is bounded and every bound is configurable — turns, tool calls, search results, file
lines, file bytes, directory entries, directory depth, and the three scout limits. See
[`docs/architecture.md`](docs/architecture.md#advanced--search-then-targeted-exploration-iterations-12).

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

**Yes. The first iteration made it worse; the second beat the baseline.**

Both systems, same 14 questions, same model (`gemini-3.5-flash-lite`), same seed, same
evaluator, same unmodified cases, neither run with a failed case:

| | Baseline | Iteration 1 (rejected) | Iteration 2 (kept) |
| --- | --- | --- | --- |
| **Evidence-backed task accuracy** | **64.3 % (9/14)** | 57.1 % (8/14) | **85.7 % (12/14)** |
| Answer accuracy | 85.7 % (12/14) | 85.7 % (12/14) | 100.0 % (14/14) |
| Cases passed | 0 / 2 | 0 / 2 | 2 / 2 |
| Mean evidence relevance | 0.85 (n=10) | 0.68 | 0.7321 (n=14) |
| Fabrications | 0 | 0 | 0 |
| Dropped citations | 0 | 0 | 0 |
| Cost | $0.011935 | $0.024957 | $0.033038 |

Iteration 2 is **+21.4 points** on the primary metric over the baseline and **+28.6** over
Iteration 1, for 2.77× the baseline's cost — or 2.08× per evidence-backed answer actually
delivered.

What changed between the two iterations is *when* the search happens. Iteration 1 offered the
model a search tool and it never used it; the question that motivated the whole exercise —
*"how is a step's declared type mapped to the function that runs it?"* — failed because the
agent guessed filenames instead of searching for the concept. Iteration 2 searches first,
deterministically: the term `dispatch`, drawn from the repository's own documentation, matched
`pyflow/steps/__init__.py`, the scout read it, and an answer that had failed twice became correct
and cited.

Two things are reported honestly rather than quietly. One question regressed —
`pyflow/q3-execution-order` still answers correctly but cites `pipeline.py` where the case names
`README.md`, the same dataset artefact that cost Iteration 1 three questions and is still
unfixed. And mean evidence relevance fell, because it is a precision measure averaged over
different numbers of questions for the two systems (10 vs 14) and it penalises a claim for citing
three verified sources where the case named one. Like-for-like the decline is 0.075, and every
extra citation was grounded. Both are decomposed in
[`docs/improvement-changelog.md`](docs/improvement-changelog.md).

Worth stating separately, because it is the result that carries across all three runs: **the
grounding layer held completely.** Zero fabrications and zero dropped citations every time — 31
of 31 citations grounded on Iteration 2. Giving the model file access, and then handing it four
more files it did not ask for, bought no invented quotations at all.

---

## Layout

```
apps/cli/              Argument parsing, the three commands, exit codes
baseline/              The baseline analyser: prompt, run loop, Markdown rendering
advanced/              The exploring agent: prompt, scout phase, tool loop, budget
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

The most serious one is the dataset's, and it survived two iterations: each case's
`expectedEvidence` was written when reconnaissance context was all any system had, so it lists
only files the baseline could see. A system that cites the implementation instead of the README
describing it is scored down for citing better evidence. **Both questions Iteration 2 still fails
are this artefact** — the answers are correct and the citations are grounded in files that genuinely
contain the answer; they are simply not the files the case names. Fixing it *after* seeing which
files the advanced system chose would be fitting the ruler to the result, so it has been left
alone twice and belongs to its own pre-registered iteration, re-run against both systems.

One more worth naming, since it is the number that moved the wrong way: mean evidence relevance is
a precision measure averaged only over questions where it was measurable, so the two systems'
figures have different denominators — and it scores a claim *lower* for citing three verified
sources where the case named one. Read it alongside the primary metric, not as a substitute.
