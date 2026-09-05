# Repo Archaeologist

**Understand an unfamiliar codebase before you change it.**

You have been handed a repository you did not write. Before you touch anything, you need to
know what it does, how it is put together, where the sharp edges are, and which files to
read first. Repo Archaeologist produces that briefing — and cites its sources, so you can
check it instead of trusting it.

> **Status: four measured iterations, one of them rejected. Iterations 4 and 5 are the product layer.**
> Iteration 1 — letting the model search and read files — **scored 7.1 points worse than the
> baseline** and was rejected. Iteration 2 — making the search deterministic and running it
> *before* the model gets a turn — **scored 21.4 points better**, 85.7 % against the baseline's
> 64.3 %. Iteration 3 — a deterministic pass that re-orders and corroborates the citations the
> model already produced — reached **100 % evidence-backed (14/14) for zero additional tokens**
> on the same model, seed and cases. Iterations 4 and 5 add no analysis capability: they put a
> browser in front of the existing pipeline — dashboard, architecture graph, grounded Q&A, PDF
> export, durable analyses, live progress — and claim no benchmark movement. Iteration 5 was the
> first to touch the measured path at all, by one observation callback, so it *checked* rather than
> asserted that nothing changed: a byte-identity test in each system, and both offline evaluations
> re-run and found identical to Iteration 4's question by question. Iteration 6 is
> **measurement only**: 100 % had left the benchmark unable to say anything, so it added 24 harder
> questions beside the frozen 14 and measured the unchanged system — **100.0 % on the frozen set,
> 29.2 % on the new one** — then declined to change the analysis, because the failure it found
> names a lever the iteration was not allowed to pull. See
> [`docs/improvement-changelog.md`](docs/improvement-changelog.md) for every number and the
> diagnosis behind each.

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

# Or in the browser: the same pipeline, plus an architecture graph, Q&A and PDF export
pnpm web -- --root ./fixtures                  # then open http://127.0.0.1:4173
pnpm web -- --root ./fixtures --mock           # offline, no key, no cost

# Run every evaluation case, against either system
pnpm evaluate:baseline
pnpm evaluate:advanced

# Evaluate offline, or one case at a time
pnpm evaluate:baseline --mock
pnpm evaluate:baseline --case case-001-orders-api

# Label where a run came from, so a result is still interpretable in six weeks
pnpm evaluate:advanced -- --provenance iteration-6-baseline
```

A run writes three files: a Markdown briefing and the full JSON run record in
[`reports/`](reports/), and the step trajectory in [`trajectories/`](trajectories/). An
evaluation run writes a timestamped JSON report and Markdown summary in
[`evaluation/results/`](evaluation/results/), plus a stable `latest-<system>.{json,md}` pair
for tooling. The two systems write to separate `latest-` files and never overwrite each
other's.

`--help` lists every flag (`--model`, `--seed`, `--thinking`, `--max-output`, `--out`,
`--cases`, `--case`, `--system`, `--case-delay`, `--quiet`, `--focus`, `--provenance`, plus the ten
exploration-budget flags). `pnpm web -- --help` lists the server's own (`--root`, `--port`,
`--host`, `--system`, `--db`, `--provenance`) and accepts the same model, budget, scout and
precision flags, so a repository analysed from the browser runs under the same bounds as one
analysed from the terminal. The only thing the web server writes is its own analysis database,
which lives outside the analysed workspace — never inside it, where the analysis could see it and
`git clean` could delete it.

Every run carries three separate labels, and none substitutes for another: `systemVersion` (which
code ran), `provenance` (where the run came from — `--provenance`, else
`REPO_ARCHAEOLOGIST_PROVENANCE`, else `unlabelled`), and, on an evaluation, the benchmark version
it was measured against. Two runs of the same code against different datasets are not comparable,
and one field cannot be asked to remember both.

## Test

```sh
pnpm test         # 778 tests
pnpm typecheck    # tsc --noEmit, strict
```

The whole suite runs offline with the model stubbed: no API key, no network, no cost.

Several of those tests are a different kind and are worth knowing about, because their absence
cost an entire iteration each. `apps/web/test/ui.test.ts` imports the browser's pure logic and
asserts what it decides; `apps/web/test/wiring.test.ts` reads the shipped `app.js`,
`index.html` and `styles.css` as text and asserts the **seams** — that the entry point
parses, that nothing imported is also declared locally or left uncalled, that every element
id has a host, that every class has a rule. A unit test proves a module works. Only the
second kind proves the product reaches it.

Three more actually *execute* the things you ship, because `tsc --noEmit` and `node --check` both
pass on an entry point that throws on line one:

| Suite | What runs |
| --- | --- |
| `apps/cli/test/cli-smoke.test.ts` | The real binary as a child process — help, every parse refusal, one full `--mock` analysis. |
| `apps/web/test/entry-smoke.test.ts` | `main.ts` spawned with real flags, then answered over TCP. |
| `apps/web/test/browser-smoke.test.ts` | `public/app.js` executed against a jsdom document. |

Both process suites blank `GEMINI_API_KEY` in the child and use the offline provider: a machine
that happens to have a key must not turn `pnpm test` into a paid run.

The jsdom gate is **not** a browser — no layout, no paint, no CSS cascade — so it cannot see a
control rendered off-screen or hidden by a stylesheet. It proves the shipped script boots against
the shipped markup and wires its handlers to elements that exist, which is the failure that had
actually shipped here.

That distinction is not a caveat, it is a defect this project shipped. The first time a real
headless Chrome was pointed at the dashboard, the evidence drawer was painting over half the
workspace from boot — `.drawer { display: flex }` outranks the user-agent `[hidden]` rule, and
jsdom resolves `hidden` ahead of the cascade, so both suites reported a drawer that opened and
closed correctly while a browser showed one that never shut. Fixed in `Unreleased`, along with the
`render()` call that issued an un-awaited HTTP `GET` on every repaint. **There is still no
checked-in browser gate**, and the layout facts in this repository are asserted as stylesheet text
rather than measured; see item 7 of [`CHANGELOG.md`](CHANGELOG.md#next) for what one would cover.

```sh
pnpm verify:measured --ref <git-ref>                    # what changed under the measured path
pnpm verify:measured --compare before.json after.json   # did the systems answer differently?
```

Every iteration since the first has carried a benchmark number forward by arguing the
measured path did not change. This turns the argument into a command with an exit code: it
fails on any deletion under `advanced/src`, `baseline/src`, `evaluation/`,
`packages/evaluator/` or `fixtures/`, on any change at all to the frozen ones, and on a
`systemVersion` that moved without a re-measurement. The two frozen evaluation cases are compared
by **content**, so a re-baseline is not a way past it.

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

Both systems, the same 14 questions now known as Regression Set v1, same model
(`gemini-3.5-flash-lite`), same seed, same evaluator, same unmodified cases, neither run with a
failed case:

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

### The benchmark ran out of room, so Iteration 6 built a harder one

Iteration 3 took the advanced system to 14/14 and it stayed there. A benchmark you score full
marks on has stopped measuring anything: it can report *not worse* and nothing else, and every
subsequent decision would have been argued from intuition.

So Iteration 6 added **24 new questions** across eleven categories — keeping the original 14 frozen
and byte-identical — and measured the **unchanged** system against all 38 before touching any
analysis code:

| | Regression Set v1 (frozen) | Challenge Set v2 |
| --- | --- | --- |
| **Evidence-backed task accuracy** | **100.0 % (14/14)** | **29.2 % (7/24)** |
| Answer accuracy | 100.0 % (14/14) | 41.7 % (10/24) |
| Fabrications / dropped citations | 0 / 0 | 0 / 0 |

Reported per set, never combined into one average — a single 55.3 % would have hidden both facts
worth knowing. Nothing regressed, and the frozen half reproduces Iteration 3's run *exactly*, down
to a mean evidence relevance of 0.4105 in both.

The new questions found something the old ones structurally could not. Accuracy splits by where
the evidence lives — 93.3 % when the answer is in documentation, 33.3 % when it is in source — and
the obvious explanation is wrong. Two diagnostic runs recorded which files reached the model:
**in 16 of 17 failures the evidence was already in context, un-truncated.** What is missing from
the briefings is concrete literals the system was looking at — `4000`, `database_url`, `max: 10` —
because a component claim is one sentence about what a module does, and a port number has no place
in that sentence.

**No analysis change was made.** The evidence names one lever, the synthesis prompt, which this
iteration's constraints put out of scope; every other single-variable change available targets
retrieval, and retrieval is not the bottleneck in 16 of 17 failures. Making one anyway would have
been the intuitively-appealing, unmeasured change the whole method exists to prevent. The
hypothesis is written down in [`docs/improvement-changelog.md`](docs/improvement-changelog.md) for
the iteration that acts on it.

---

## The web application

Iterations 4 and 5 add no analysis capability. They put a browser in front of the pipeline that
already exists, make every claim on screen clickable back to the bytes it came from, and give the
result somewhere to live.

```sh
pnpm web -- --root ./fixtures --mock     # then open http://127.0.0.1:4173
```

```
browser ──HTTP──► apps/web ──► packages/app ──► advanced/ or baseline/ ──► packages/shared
   UI            routes,        service,          the unchanged             tools, boundary,
                 server,        report,           pipeline                  ledger, grounding
                 static,        graph, Q&A,
                 SSE            store, PDF
```

`apps/web` owns transport and nothing else. `packages/app` is the analysis core both the CLI and
the server call. Neither reaches past it into the pipeline, and the pipeline was not modified to
accommodate them: `runAdvanced` and `runBaseline` gained two optional callbacks — one that hands
over the finished evidence ledger, one that says which phase has been reached — and nothing else.
Neither is read by any control flow, and a regression test in each system asserts that a run with
them produces a byte-identical record to a run without.

**Five capabilities.**

- **Dashboard.** Pick a repository from the workspace, run the analysis, then read it in nine
  sections — overview, architecture, components, data flow, dependencies, testing, evidence,
  questions, export. Every claim carries its citations inline; an uncited claim is labelled
  **unsupported** rather than hidden.
- **Durable analyses, and live progress.** An analysis is a record before it is a result: closing
  the tab, navigating away or restarting the server does not lose it, and a failure is a `failed`
  record you find on reload rather than a request that vanished. A sidebar lists what the workspace
  holds; while one runs, a phase checklist says which of the eight phases the pipeline has reached.
  **No percentage and no estimate** — the pipeline reports phases, not progress, and a bar would be
  the UI claiming something nobody measured.
- **Architecture graph.** Eleven node types (application, package, module, api, database, queue,
  worker, external-service, cli, configuration, test-suite) and ten relationships (imports,
  calls, depends-on, reads-from, writes-to, publishes, consumes, tests, exposes, configures),
  laid out deterministically, with pan, zoom, search, type filters and click-to-evidence. **Every
  node and every edge carries the evidence ids it was derived from** — a graph that cannot say
  where an arrow came from is a drawing.
- **Questions.** Ask in prose. The question goes through the same scout, the same read-only
  tools, the same bounded loop and the same grounding as a briefing claim: `question → scout →
  tools → answer → citation extraction → grounding → verified answer`. A question whose evidence
  does not support an answer gets exactly one sentence — *"I couldn't verify this from the
  repository evidence I inspected."* Follow-ups see the earlier turns as context, and **the
  conversation never becomes evidence**: only repository bytes can be cited.
- **PDF export.** The briefing, a key-findings page, a drawn architecture figure, the evidence
  table and the answered questions as a self-contained document, generated by a hand-written writer
  with no dependency and no browser. Unsupported claims are labelled in the PDF too.

**Where an analysis lives.** A SQLite file, via `node:sqlite` — in Node 22's standard library, so
durability costs no new dependency. Three properties are worth stating because each was a decision:

- It **refuses to live inside the repository it analyses.** A database there is a file the analysis
  can see, `git status` reports and `git clean` deletes. Default `~/.repo-archaeologist/analyses.db`;
  `--db` or `REPO_ARCHAEOLOGIST_DB` overrides it, and `:memory:` opts out of persistence entirely.
- It stores a **projection, not a dump.** A run record carries model prose, raw tool results and
  prompts; the store keeps the reconnaissance artefacts a question needs in order to still be
  answerable after a restart, plus the sources some citation actually resolves to. Less on disk is
  the feature.
- Excerpts are **redacted on the way in**, so a restart cannot change what the viewer shows and its
  line offsets are correct by construction. The ledger the pipeline grounds against stays raw.
- A record **outlives the request that created it, and covers the run it started.** `POST` returns as
  soon as the row is durable and the analysis continues in the background, so the only thing that can
  pull the record out from under it is a delete — which is therefore a *cancellation*: the run is
  told first, stops writing at its next boundary and discards its result. It is not resurrected, and
  nothing else invents a record for it.

**The API**, all JSON, all loopback:

| Route | Does |
| --- | --- |
| `GET /api/health` | Provider, model, systems, question limit, export formats |
| `GET /api/repositories` | The analysable directories inside the workspace |
| `POST /api/analyses` | Starts an analysis and returns the `queued` record immediately |
| `GET /api/analyses` | Every analysis the workspace still holds |
| `GET /api/analyses/:id` | The stored report, graph and answered questions |
| `DELETE /api/analyses/:id` | Forgets one analysis, and cancels it first if it is still running |
| `GET /api/analyses/:id/events` | Server-sent progress, replayed from the start of the run |
| `POST /api/analyses/:id/questions` | Answers a question against a stored analysis |
| `GET /api/analyses/:id/evidence/:evidenceId` | One evidence item, its source text, and the excerpt's offsets |
| `GET /api/analyses/:id/export/pdf` | The PDF |

Iteration 4's `POST /api/analyze`, `GET /api/analysis/:id` and body-scoped `POST /api/questions`
still work; the paths above are the canonical forms.

**Security boundaries**, because the input is a repository nobody vetted:

- **One path mechanism.** `resolveInsideRepository` — the boundary the CLI already used — holds
  every read inside its root, rejecting absolute paths, `..`, null bytes and symlink escapes. The
  workspace check and the static-asset server reuse it rather than reimplementing it.
- **Loopback only.** Binds `127.0.0.1`, answers `421` to a non-localhost `Host` (so a rebound DNS
  name cannot drive a local file reader) and `403` to a foreign `Origin`. Bodies over 1 MiB are
  refused with `413` unread.
- **`default-src 'none'`.** The dashboard renders names, paths and excerpts taken from untrusted
  code, so the CSP makes a successful injection inert; no `unsafe-inline`, no CDN, no framework.
- **Read-only, no shell.** No command execution anywhere, and nothing is ever written to an
  analysed repository.
- **Redaction at every exit.** `redactSecrets` runs on HTTP responses, metrics and the PDF. The
  ledger itself keeps raw bytes, because grounding has to verify an excerpt against what the file
  actually says.
- **Evidence ids are keys, not paths.** A citation can only name an artefact the ledger already
  holds, and an evidence id is scoped to the analysis that issued it. An id from another analysis
  is a `404`.

---

## Layout

```
apps/cli/              Argument parsing, the three commands, exit codes
apps/web/              HTTP server, routes, static assets, and the browser UI in public/
baseline/              The baseline analyser: prompt, run loop, Markdown rendering
advanced/              The exploring agent: prompt, scout phase, tool loop, budget
evaluation/            The evaluation runner, benchmark.json, plus cases/ and results/
packages/shared/       Schemas, context collection, tools, grounding, LLM clients, IO
packages/app/          The analysis core: service, runner, lifecycle, report, graph, Q&A, store, PDF
packages/evaluator/    Case loading, matching, scoring, aggregation, reporting, benchmark metadata
fixtures/              Generated git repositories used by the cases (pnpm setup)
reports/               Briefings from both systems (JSON + Markdown)
trajectories/          What each run did, step by step
docs/                  Architecture, evaluation method, improvement changelog
scripts/               Fixture builder, measured-path guard, and a structural check for the PDF writer
```

[`docs/architecture.md`](docs/architecture.md) explains why the boundaries fall where they
do. [`docs/evaluation.md`](docs/evaluation.md) explains the metric in enough detail to
argue with. [`docs/improvement-changelog.md`](docs/improvement-changelog.md) is the
experiment log: one entry per iteration, hypothesis first, measurement after, never edited
to match the outcome.

## Limitations

Known and deliberate, in [`docs/evaluation.md`](docs/evaluation.md#limitations). The short
version: 38 questions is still a small dataset, keyword matching is not comprehension,
`mustNotContain` is naive substring matching, and the baseline cannot answer any question
whose evidence lives inside a source file.

The most serious one is the dataset's, and on the frozen half it is permanent: each of the original
14 questions' `expectedEvidence` was written when reconnaissance context was all any system had, so
it lists only files the baseline could see. A system that cites the implementation instead of the
README describing it is scored down for citing better evidence. Fixing it *after* seeing which files
the advanced system chose would be fitting the ruler to the result, so those lists have been left
alone three times now. Iteration 6 took the other route instead: Challenge Set v2 names
implementation files as expected evidence from the start, written before any system was run against
it, which is why 14 of its 24 questions are source-backed — and why its scores are so much lower
than the frozen set's.

One more worth naming, since it is the number that moved the wrong way: mean evidence relevance is
a precision measure averaged only over questions where it was measurable, so the two systems'
figures have different denominators — and it scores a claim *lower* for citing three verified
sources where the case named one. Read it alongside the primary metric, not as a substitute.

The product layer has three of its own. The store is **single-process**: WAL and a busy timeout
make a second writer safe rather than fast, and nothing coordinates two servers sharing one file —
correct for a local tool, wrong for anything shared. **Nothing prunes it**, either: an analysis
lives until someone deletes it, because a tool that silently discards the analysis you wanted is
worse than one whose file grows. And `redactSecrets` recognises a credential by its shape or by the
name of the variable holding it, which cannot catch a bare high-entropy string with neither: a
heuristic wide enough to catch that would redact hashes, UUIDs and minified code.
