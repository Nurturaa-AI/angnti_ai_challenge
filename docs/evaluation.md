# Evaluation method

The point of this harness is to be hard to please. A briefing that sounds right and cites
nothing should score badly, and a briefing that cites the directory listing as proof of what
is inside a file should score *partially* — not fully. Getting those two cases right is most
of the design.

---

## The primary metric

**Evidence-backed task accuracy** — the share of all questions, across all cases, where the
system got the answer right **and** cited it from a location that actually contains the
answer.

```
evidenceBackedTaskAccuracy = evidenceBackedAnswers / totalQuestions
```

The denominator is every question in every case that was asked, including questions in cases
where the run crashed. There is no way to raise the metric by producing less.

Answer accuracy — correct answers over the same denominator — is reported alongside it. The
gap between the two is the interesting number: it is the share of the system's correct
answers that it could not substantiate, which is to say the share you would have had to
verify by hand.

## The four measures

Each question yields four independent judgements, computed in
[`score.ts`](../packages/evaluator/src/score.ts).

### 1. Correct answer

`expectedKeywords` must **all** appear in the targeted field. `anyOfKeywords` is a list of
alternative groups; at least one group must match in full. Matching is case-insensitive over
whitespace-collapsed text, so `Order.Created` matches `order.created` and a keyword split
across a line break still matches.

`field` narrows the search — `summary`, `dependencies`, `testing`, and so on, or `any` to
search the whole briefing. When a question matches under `any`, the score records
**which** section answered, so a failure can be traced without re-reading the briefing.

A question with neither `expectedKeywords` nor `anyOfKeywords` is **rejected at load time**.
An unscorable question that loaded successfully would sit in the denominator forever.

### 2. Evidence-backed answer — the primary metric

Three conditions, all required:

1. The answer is correct (measure 1).
2. The **claim that answered** carries at least one citation the grounding step confirmed
   (`grounded: true`). An unverified citation earns nothing.
3. If the case names `expectedEvidence`, one of those confirmed citations points at an
   expected location **with content strength**.

Condition 2 is stricter than it first looks. Evidence is credited **per claim**, not per
briefing. If a case asks for `express` and `routing`, and the briefing mentions `express` in
one component and routing in another, the joined text satisfies the keywords but no single
claim does — the score records a note reading *"matched across separate claims"* and credits
no evidence. Otherwise a briefing could earn the metric by being long.

### The content/existence distinction

This is the decision the whole metric turns on.

A citation of `tree` with `location: "src/services/inventory.js"` proves that file **exists**.
It does not prove anything about what is in it. A briefing that says *"the inventory service
has a race condition"* and cites the directory listing has not shown its work; it has shown
that a plausible-sounding filename exists.

So evidence carries a strength:

| Strength | Meaning | Earns |
| --- | --- | --- |
| `content` | The cited source's own text covers the expected location | **`evidenceBacked`** |
| `existence` | Only `tree` or `metadata` naming the path | `partialEvidence` |

`existence` is reported separately and never counts toward the primary metric. The score
records a note: *"the location was only shown to exist"*.

The practical consequence is that cases can be written on both sides of the line. In
`case-001-orders-api`, `q2-http-framework` expects `package.json`, which the baseline
genuinely receives — it can win that question outright. `q5-oversell-guard` expects
`src/services/inventory.js` and `docs/incidents/2025-08-oversell.md`, which the baseline never
opens — the best it can do is `partialEvidence`, and only an agent that reads files can earn
the metric.

That is deliberate: the baseline scores above zero, so the harness is measuring something,
and there is measurable headroom left for the agent to claim.

### 3. Unsupported claim

Two ways to earn one:

- **Uncited**: the answer is correct but the answering claim has no confirmed citation.
- **Fabricated**: the field contains a phrase from `mustNotContain`. This also fails the
  answer and sets `fabricationDetected`.

An *incorrect* answer is not "unsupported" — it is simply wrong, and counting it twice would
overstate the fabrication rate.

Separately, every briefing carries its own `evidenceAudit` from the grounding step:
citations claimed, citations verified, citations dropped with reasons, and claims left with
nothing behind them. Those numbers reach the report as `droppedCitations` and
`briefingUnsupportedClaims`, and they answer a different question than the per-case scores do:
not "was this answer supported?" but "what did the system try to claim that it could not back
up at all?"

### 4. Evidence relevance

Of the confirmed citations on the answering claim, the share pointing at a location the case
expects. `null` when the case names no expected location — reporting `0` there would be
false. The report averages relevance only over questions where it was measurable.

---

## Case format

```json
{
  "id": "case-001-orders-api",
  "title": "orders-api — write-side HTTP service for customer orders",
  "repository": "fixtures/orders-api",
  "notes": "Why this case exists and what it discriminates.",
  "questions": [
    {
      "id": "q2-http-framework",
      "question": "Which HTTP framework does the service use?",
      "field": "dependencies",
      "expectedAnswer": "Express (declared as a runtime dependency in package.json).",
      "expectedKeywords": ["express"],
      "anyOfKeywords": [],
      "mustNotContain": ["fastify", "koa", "nestjs"],
      "expectedEvidence": ["package.json"]
    }
  ]
}
```

`expectedAnswer` is documentation for a human reader and is never matched against.
`repository` is relative to the project root so cases are portable across machines.
`expectedEvidence` accepts a directory prefix (`src/services/`), which matches any file
beneath it.

Challenge-set questions additionally carry `category`, `difficulty`, `tags` and
`evidenceRationale`. Those keys are for grouping failures, they are declared nowhere in
`EvalCaseSchema`, and the parser therefore strips them before the scorer sees the case — see
[Metadata cannot reach the scorer](#metadata-cannot-reach-the-scorer).

### Writing a good question

- **Ask what a new engineer asks on day one.** "Which framework?" and "what breaks if I
  touch this?" — not trivia that happens to be greppable.
- **Choose `mustNotContain` phrases that could only appear as inventions.** `graphql` in a
  REST-only service is a good forbidden phrase. See the limitation below before choosing one
  with a natural negated form.
- **Set `expectedEvidence` to where the answer really lives**, not to where a shallow system
  could plausibly find it. A case that lowers its bar to let the baseline pass stops measuring
  the thing that matters.
- **Prefer few keywords.** Every extra keyword is another way for a correct answer to fail on
  phrasing rather than on substance.

## Dataset

Four cases against two generated fixtures ([`scripts/build-fixtures.ts`](../scripts/build-fixtures.ts)),
**38 questions in two sets**. The split is the point: one set is frozen so numbers stay comparable
across iterations, the other is hard enough to still have something to say.

| Case | Set | Repository | Questions | Discriminates |
| --- | --- | --- | --- | --- |
| `case-001-orders-api` | regression-v1 | Node/Express write-side service | 7 | Manifest reading vs. source reading; a race condition documented only in an incident note |
| `case-002-pyflow` | regression-v1 | Python CLI ETL runner with SQLite state | 7 | A non-Node manifest (`pyproject.toml`); dispatch logic that lives only in source |
| `case-003-orders-api-challenge` | challenge-v2 | same fixture, harder questions | 12 | Whether the system *looks*, rather than whether it can read |
| `case-004-pyflow-challenge` | challenge-v2 | same fixture, harder questions | 12 | Python-specific surfaces: entry points, packaging metadata, lazy validation |

The fixtures are built with pinned author, email and commit dates, so commit hashes are
reproducible — which matters for a later agent that reads history. **No fixture was modified to
accommodate a question**: the challenge cases ask about the repositories as they already were.

### Regression Set v1 is frozen

The original 14 questions do not change. Not the wording, not the expected answers, not the
expected evidence, not the forbidden phrases — including when the system fails them. This is what
lets Iteration 6's number be compared to Iteration 3's at all, and the freeze is checked
mechanically rather than by intention: `pnpm verify:measured` byte-compares both case files against
their committed blobs.

The most valuable thing a frozen set does is go stale. By Iteration 5 the advanced system scored
14/14 on it, which means it had stopped being able to report anything except *not worse*. That is
the signal to add a set, not to edit the old one.

### Challenge Set v2

24 questions, 12 per repository, written to span the eleven categories in
[`BENCHMARK_CATEGORIES`](../packages/evaluator/src/benchmark.ts) — direct fact, cross-file
reasoning, indirect evidence, keyword mismatch, architecture inference, behavioral flow,
configuration/dependency, negative/absence, competing evidence, evidence precision, multi-language.
Every category has at least two questions, and the difficulty split is 3 easy / 11 medium / 10 hard.

The distribution that turned out to matter most is not in that list. Regression v1 expects
documentation evidence for 12 of its 14 questions; Challenge v2 expects **source** evidence for 14
of 24. That is deliberate, and it is the direct answer to [limitation 7](#limitations): rather than
widening the frozen lists after seeing which files the system chose — fitting the ruler to the
result — the new set names implementation files as the expected evidence *from the start*, before
any system was run against it.

### The manifest, and why counts are derived

[`evaluation/benchmark.json`](../evaluation/benchmark.json) declares the benchmark's identity
(`repo-archaeologist v2`), its sets, and its counts. `loadBenchmark()` re-derives every count from
the loaded case files and fails the load when the two disagree:

> The manifest is the declaration and the case files are the dataset. Fix whichever is wrong; do
> not adjust a count to match a mistake.

So a case added without updating the manifest is a test failure, not a silently changed
denominator — which is the failure mode that makes a percentage move without anyone changing a
system.

### Metadata cannot reach the scorer

Challenge questions carry their `category`, `difficulty`, `tags` and `evidenceRationale` inline.
Frozen questions cannot — that would change their bytes — so their classification lives in the
manifest's `annotations` map, keyed `caseId/questionId`.

The asymmetry is ugly and it is load-bearing. What makes the inline half safe is that
`EvalCaseSchema` is a `z.object`, which strips keys it does not declare: the classification is
provably unable to reach `scoreQuestion`, because the parsed object the scorer receives never
contains it. A question cannot be scored more leniently for being labelled `hard`.

## Running it

```sh
pnpm evaluate:baseline                          # every case, baseline system
pnpm evaluate:advanced                          # every case, exploring agent
pnpm evaluate:baseline --mock                   # offline, deterministic, no cost
pnpm evaluate:baseline --case case-001-orders-api
pnpm evaluate:baseline --cases ./my-cases --out ./my-results
pnpm evaluate:advanced -- --model gemini-3.5-flash-lite --case-delay 25
pnpm evaluate:advanced -- --provenance iteration-6-baseline
```

Output in [`evaluation/results/`](../evaluation/results/): a timestamped JSON report, a
timestamped Markdown summary, and a stable `latest-<system>.{json,md}` pair. The two systems
write to separate `latest-` files, so a comparison never depends on remembering which run
happened last. The `latest-` pair is a moving pointer and is overwritten by design; the
timestamped files are the history.

The report records total cases, passed cases (all questions correct), fully-cited cases,
failed cases, total questions, correct answers, evidence-backed answers, partial-evidence
answers, unsupported answers, fabrications, dropped citations, average evidence relevance,
runtime, token usage, estimated cost, and the full per-question breakdown.

### Three identities, and none of them substitutes for another

A result is only interpretable if you know all three of these, and they answer different questions:

| | Question it answers | Example |
| --- | --- | --- |
| `systemVersion` | Which code ran? | `0.1.0` |
| `provenance` | Where did this run come from? | `iteration-6-baseline` |
| `benchmark.version` | Which dataset was it measured against? | `v2` |

Two runs of the same `systemVersion` against different benchmark versions are not comparable, and a
run's provenance is what distinguishes a pre-registered measurement from someone trying a flag.
Overloading one field to carry another's meaning is how a table of numbers becomes a table of
numbers that quietly compares different things.

`--provenance` is accepted by both entry points and by the web server, defaults to
`REPO_ARCHAEOLOGIST_PROVENANCE` and then to `unlabelled`, and is validated before anything binds a
port or opens a database — a label that fails `/^[a-z0-9][a-z0-9._/-]{0,63}$/` stops the process
rather than reaching a stored row.

Reports are `schemaVersion` 2. A v1 report on disk is still readable, and `readReportIdentity()`
returns `null` for its benchmark and provenance rather than defaulting them: an Iteration 3 run
predates this benchmark, and labelling it `v2` at read time would be inventing a fact about
history.

### The evaluator cannot tell the systems apart

This is the property that makes a comparison mean anything, so it is worth stating as a rule
rather than an aspiration: **`runSystem` is the only code in the repository that branches on
system identity.** Everything downstream receives a `RunRecord` and has no way to learn which
system produced it — no flag, no version check, no heuristic on the evidence types present.

Scoring Iteration 1 required **no** change to `packages/evaluator`: no new evidence type, no
new matching rule, no threshold adjustment, no exemption. The `file` evidence type a tool
produces was already in `CONTENT_TYPES` because the schema always allowed it. Scoring
Iteration 2 required none either — the deterministic search phase produces `file` evidence
through the same `read_file`, so the scorer cannot tell a scout-read file from a model-read one,
and does not try. If either system's number had required touching the scorer to obtain, the
number would not have been worth reporting.

For the same reason, `--case-delay` and the retry backoff apply identically to both systems. A
harness more patient with one of them would be measuring its own retry loop.

### Determinism

As deterministic as the harness can make it:

- Scoring is pure string logic — no model judge.
- Cases load in filename order; questions in file order.
- The seed, model, thinking level and Node version are recorded on every report.
- Timestamps and durations come from an injectable clock, so tests pin them.

What is *not* deterministic is the model. Gemini's Interactions API takes a seed rather than a
temperature, and a fixed seed is a best effort, not a guarantee. Two runs against the real API
may differ; two runs against `--mock` will not.

### Cost

`estimatedCostUsd` is computed from token usage and published per-model prices. If any run in
the report used a model with no published price, the total is reported as a **lower bound**
(`costEstimateComplete: false`, and the Markdown says "at least $…"). If no run could be
priced, the figure is `null` and the summary says `unknown` rather than `$0.000000` — a zero
there would read as free.

---

## Results

In iteration order, oldest first. Nothing here is edited when a later run disagrees with it — a
superseded number is still a true record of what the system did that day, and the
[latest measurement](#iteration-6--the-benchmark-that-could-still-disagree) is the last section.

### Iterations 1–3, both systems on Regression Set v1

Both systems, same 14 questions, same model, same seed, same thinking level, same evaluator,
same unmodified cases. Neither run had a failed case.

| | Baseline | Advanced (Iteration 2) |
| --- | --- | --- |
| Run id | `eval-baseline-2026-08-31T03-44-47Z` | `eval-advanced-2026-08-31T04-03-32Z` |
| **Evidence-backed task accuracy** | **64.3 % (9/14)** | **85.7 % (12/14)** |
| Answer accuracy | 85.7 % (12/14) | 100.0 % (14/14) |
| Cases passed | 0 / 2 | 2 / 2 |
| Partial-evidence answers | 0 | 0 |
| Unsupported answers | 2 | 0 |
| Fabrications | 0 | 0 |
| Briefing unsupported claims | 0 | 0 |
| Dropped citations | 0 | 0 |
| Mean evidence relevance | 0.85 (n=10) | 0.7321 (n=14) |
| Tokens | 2 450 in / 4 480 out | 56 795 in / 6 400 out |
| Cost | $0.011935 | $0.033038 |
| Cost per evidence-backed answer | $0.001326 | $0.002753 |
| Wall clock | 38.3 s | 54.0 s |

Model `gemini-3.5-flash-lite`, seed 7, thinking level `low`, provider `gemini`. Commands:

```sh
pnpm evaluate:baseline -- --model gemini-3.5-flash-lite --case-delay 20
pnpm evaluate:advanced -- --model gemini-3.5-flash-lite --case-delay 25
```

Wall clock includes the inter-case delay each command sets. Net of it, 18.3 s → 29.0 s.

**Iteration 2 improved the primary metric by 21.4 points.** It adds a deterministic search
phase — extract terms, search, rank candidates, read the best few — before the model gets a
turn, on the finding that Iteration 1's agent never called `search_code` once. Four questions
became evidence-backed, one regressed, two previously-wrong answers became right. Under the
pre-stated decision rule it is **kept**. Full decomposition in
[`improvement-changelog.md`](improvement-changelog.md).

For the record, since a rejected iteration is easy to quietly forget: **Iteration 1 scored
57.1 %, below the baseline's 64.3 %, and was rejected.** Iteration 2 is measured against the
baseline, not against it.

Read these numbers with caveat 1 below firmly in mind: on a 14-question dataset, 21.4 points is
**three questions**. What deserves more weight than the percentage is the mechanism the
per-question breakdown exposes. `pyflow/q6-step-dispatch` — the question that motivated both
iterations — failed on the baseline and failed again on Iteration 1 because the agent guessed
filenames instead of searching. Iteration 2's search phase found
`pyflow/steps/__init__.py` from the term `dispatch`, read it, and the answer became correct and
cited. That is a structural result; it would not change if the dataset were ten times larger.
The exact margin would.

Two results need no caveat. **Zero fabrications and zero dropped citations on both systems** —
31 citations claimed across the advanced system's two cases, 31 grounded. And the baseline run
**reproduced its previously recorded figures exactly**, down to the token counts and the cost,
which is what makes the comparison like-for-like rather than two runs on different days.

One figure moved the wrong way and is explained rather than excused: mean evidence relevance
fell from 0.85 to 0.7321. See caveat 10 — the two means have different denominators, and the
like-for-like decline is 0.075, driven by the advanced system citing *more* verified evidence
per claim than the cases anticipate.

An earlier pair of runs on `gemini-3.7-flash` is **not** reported here: that model's free-tier
quota was exhausted mid-run, and the resulting failures were provider artefacts rather than
model quality. Both systems were re-run on a model with quota headroom so the comparison stays
like-for-like. A first Iteration 2 advanced run is also not reported: it crashed on a Gemini
protocol error (parallel function calls replayed in the wrong arrangement) that was a
pre-existing latent bug in the shared model path, and a crashed run is not a measurement.

### Iteration 3, like-for-like

Same model, seed, thinking level and unmodified cases as the pair above. Run id
`eval-advanced-2026-08-31T06-18-59Z`.

| | Iteration 2 | Iteration 3 | Δ |
| --- | --- | --- | --- |
| **Evidence-backed task accuracy** | **85.7 % (12/14)** | **100.0 % (14/14)** | **+14.3 pts** |
| Answer accuracy | 100.0 % (14/14) | 100.0 % (14/14) | 0 |
| Cases fully cited | 0 / 2 | 2 / 2 | +2 |
| Fabrications / dropped / briefing unsupported claims | 0 / 0 / 0 | 0 / 0 / 0 | 0 |
| Mean evidence relevance | 0.7321 (n=14) | 0.4105 (n=14) | −0.3216 |
| Tokens | 56 795 in / 6 400 out | 56 795 in / 6 400 out | **0** |
| Cost | $0.033038 | $0.033038 | **$0** |

The token counts match per case to the digit, because the precision pass runs *after* synthesis:
the prompts were byte-identical and the model produced the same output twice. The same model
output scored 85.7 % with Iteration 2's citations and 100 % with Iteration 3's. On the stronger
`gemini-3.5-flash` the advanced system ties its own baseline at 78.6 %, with one dropped citation
and one unsupported claim. Both pairs, per question, are decomposed in
[`improvement-changelog.md`](improvement-changelog.md) and [`../CHANGELOG.md`](../CHANGELOG.md).

Note what this means for the next iteration: on `gemini-3.5-flash-lite` the primary metric has no
headroom left. 14/14 cannot improve, so any change measured on this dataset and model scores 100 %
or worse, and a tie says nothing. Growing the dataset is the blocking item.

### Iteration 4 — the product layer is not on this path

Iteration 4 added a web application, an architecture graph, a question mode and a PDF exporter.
**It was not measured against a model and it claims no movement in any metric.**

That is structural rather than a shortcut. Everything it added sits *downstream* of the pipeline:
it reads a `RunRecord` and the evidence ledger the run produced. The only change inside
`runAdvanced` and `runBaseline` was one optional `onSources` callback, invoked after the ledger is
final, which cannot add to what a run may cite and which the evaluator does not pass. Measuring
the same pipeline again to report the same number would be theatre; measuring it and *calling* the
result an improvement would be worse.

Three properties held while the layer was built, and each is worth naming because a product layer
is exactly where they would erode:

- **No evaluation case was modified.** Not a question, not an `expectedEvidence` list, not a
  keyword.
- **The evaluator is still question-blind.** `runEvaluation` passes only a repository path into
  `runBaseline`/`runAdvanced`, and the sentinel test that asserts no question text reaches the
  model's input still passes. The question mode *does* aim the scout at a question — that is what
  a reader asked at runtime, and the evaluation path never calls it. `--focus` remains unused by
  the evaluator for the same reason.
- **Nothing was tuned to a fixture.** No fixture name, expected answer, expected keyword or
  fixture-derived architecture relationship appears in the product layer's code.

What *was* run, for compatibility rather than for a number — both offline, on the deterministic
mock provider:

| | Baseline (`--mock`) | Advanced (`--mock`) |
| --- | --- | --- |
| Run id | `eval-baseline-2026-09-01T22-56-31Z` | `eval-advanced-2026-09-01T22-56-51Z` |
| Evidence-backed task accuracy | 21.4 % (3/14) | 28.6 % (4/14) |
| Answer accuracy | 21.4 % (3/14) | 28.6 % (4/14) |
| Fabrications / dropped citations | 0 / 0 | 0 / 0 |
| Failed cases | 0 / 2 | 0 / 2 |

> These are **not** a measurement of any system's quality, and the harness says so in a caveat on
> the run itself: the mock provider returns canned text assembled from the context it was handed,
> so these figures measure the harness and the fixture, not a model. They are reported here only
> to show that both evaluation commands still execute end to end after the product layer landed.

Both pairs of figures reproduced exactly across two independent runs, the second made after the CLI
was refactored to dispatch through `analyzeRepository`. Since the mock provider is deterministic,
an identical result is the expected outcome — which is what makes a *differing* one informative: it
would have shown the refactor changed what a run does, not just how it is started.

No paid run was made for Iteration 4. `DEFAULT_MODEL` is now `gemini-3.7-flash`, which no
historical run used, so a bare `pnpm evaluate:advanced` would produce a number comparable to
nothing; a comparable run needs `--model gemini-3.5-flash-lite --case-delay 20` on both systems,
and it would re-measure a pipeline that did not change. Iteration 3's figures stand as the last
real measurement, unedited.

### Iteration 6 — the benchmark that could still disagree

Iteration 6 expanded the dataset from 14 questions to 38 and measured the **unchanged** system
against it before touching any analysis code. `pnpm verify:measured --ref HEAD` reports `OK` and
both system versions are unchanged at 0.1.0, which is what makes the frozen column below meaningful.

| | Regression Set v1 (frozen) | Challenge Set v2 | Combined |
| --- | --- | --- | --- |
| Run id | `eval-advanced-2026-09-05T01-35-25Z` | same run | same run |
| **Evidence-backed task accuracy** | **100.0 % (14/14)** | **29.2 % (7/24)** | **55.3 % (21/38)** |
| Answer accuracy | 100.0 % (14/14) | 41.7 % (10/24) | 63.2 % (24/38) |
| Unsupported answers | 0 | 3 | 3 |
| Fabrications / dropped citations | 0 / 0 | 0 / 0 | 0 / 0 |
| Mean evidence relevance | 0.4105 | — | 0.4007 |

`gemini-3.5-flash-lite`, seed 7, thinking `low`, provenance `iteration-6-baseline`, $0.066076.

**The per-set split is not a presentation choice.** The combined 55.3 % is the least informative
number in the table: it mixes a saturated set with a discriminating one, and it would move if the
ratio between them changed while nothing about the system did. Reported alone it would have hidden
both facts worth knowing — that nothing regressed, and that the new questions are hard.

**Nothing regressed, exactly.** Iteration 3's measurement was 100.0 % / 100.0 % with mean evidence
relevance **0.4105**; the frozen subset of this run scores 100.0 % / 100.0 % with mean evidence
relevance **0.4105**. Same model, same seed, same fourteen questions, identical to four decimal
places.

#### Where the failures are

Grouped four ways, one grouping dominates — and it is not the one that looks most likely.

| By evidence kind | n | Answer accuracy | Evidence-backed |
| --- | --- | --- | --- |
| documentation | 15 | 93.3 % | 80.0 % |
| mixed | 8 | 62.5 % | 62.5 % |
| **source** | **15** | **33.3 %** | **26.7 %** |

Difficulty (easy 81.8 % → medium 66.7 % → hard 41.7 %) and repository (orders-api 73.7 % vs pyflow
52.6 %) are real gradients but largely restate that table: the hard questions and the pyflow
questions are disproportionately the source-backed ones. Category is the least useful grouping for
the same reason — the weakest categories are simply those whose evidence lives in source files.

The obvious reading is a retrieval weakness, and it is wrong. Two diagnostic runs recorded which
files entered the model's context. Cross-referencing every failure against them: **in 16 of 17
failures the expected evidence was already in context, un-truncated** — for `orders-api` the system
read every relevant source file with budget to spare. Exactly one failure was a genuine retrieval
miss.

What is missing from the briefings is concrete literals the model was looking at: `4000`,
`database_url`, `kafka_brokers`, `mypy`, `max: 10`. A component claim is one sentence about what a
module does, and a port number has no place in that sentence — so it is dropped even though the line
is in context and citable. Three further questions were answered correctly across *separate* claims,
which the scorer does not credit because no single claim answers the question.

The hypothesis this produces — that source-backed accuracy is limited by claim **granularity**
rather than by retrieval or grounding — is recorded in full in the
[improvement changelog](improvement-changelog.md). **No analysis change was made in Iteration 6**:
the lever the evidence names is the synthesis prompt, which the iteration's constraints put out of
scope, and every other available single-variable change targets retrieval that the 16/17 split shows
is not the bottleneck.

### Iteration 7 — the hypothesis was tested, and it was wrong

Iteration 7 spent the lever Iteration 6 named. One variable changed — six form-level instructions
appended to the synthesis prompt, telling the model to keep a fact and its identifier in the same
sentence rather than splitting them across claims. Everything else was held: same model, same seed,
same thinking level, same 38 questions, same scorer, same fixtures, same tools, same budgets.

| | Regression Set v1 (frozen) | Challenge Set v2 | Combined |
| --- | --- | --- | --- |
| Control run | `eval-advanced-2026-09-05T01-35-25Z` | same run | same run |
| Treatment run | `eval-advanced-2026-09-05T17-58-05Z` | same run | same run |
| **Evidence-backed accuracy** | **100.0 % → 100.0 %** | **29.2 % (7/24) → 25.0 % (6/24)** | **55.3 % → 52.6 %** |
| Answer accuracy | 100.0 % → 100.0 % | 41.7 % (10/24) → 41.7 % (10/24) | 63.2 % → 63.2 % |
| Unsupported answers | 0 → 0 | 3 → 4 | 3 → 4 |
| Fabrications / dropped citations | 0 / 0 → 0 / 0 | 0 / 0 → 0 / 0 | 0 / 0 → 0 / 0 |
| Mean evidence relevance | 0.4105 → 0.3781 | — | 0.4007 → 0.3730 |

Provenance `iteration-6-baseline` → `iteration-7-synthesis-experiment`; `systemVersion` 0.1.0 in
both, because the treatment was never kept. The acceptance threshold was **+8 pp** on Challenge
evidence-backed accuracy. The measurement is **−4.2 pp**. The treatment is **rejected**.

**Exactly one question of 38 changed outcome, and it changed the wrong way.**
`challenge-v2-orders-q03` went PASS → UNCITED: the instruction written to consolidate a fact and its
identifier into one claim caused dispersal on the one case that was already getting it right. No
question was recovered.

The mechanism was confirmed at the token level and was still the wrong explanation. `pyflow-q04`
recovered the literal `insert` the control had dropped — the instruction did what it was written to
do — and the question still failed, because it also requires one of `append` / `history` /
`every run` / `new row` / `accumulat`. Getting the literal into the sentence is not the same as
having established what the code does with it.

Of the four groupings, only one moved: **`cross-file-reasoning` 2/3 → 1/3**, with source-evidence
questions 4/15 → 3/15 and hard questions 4/12 → 3/12. Everything else is flat, question for
question. The single category that moved is the one the treatment targeted, and it moved down.

**What the negative result establishes.** "The expected evidence was in context" — Iteration 6's
16-of-17 finding — is a much weaker claim than "the model had established the fact". Reading a line
into the ledger makes it citable; it does not make the model know what the line means for a question
it cannot see. Synthesis here is deliberately question-blind: the model writes one briefing, and the
scorer later asks 19 questions of it. A prompt cannot instruct a writer to organise a paragraph
around a question that is not in the prompt. Three of the 17 failures are also structurally out of
reach of any prompt — `selectClaims` emits one claim per dependency entry, so a question needing two
dependency names in a single claim cannot be satisfied by better writing.

Cost of the negative result: one paid run, 1m29s, $0.069218 (+4.8 % over control on +8.2 % output
tokens). The full hypothesis — written before the code, so the result could be judged rather than
rationalised — and the per-case table are in the
[improvement changelog](improvement-changelog.md).

### Iteration 8 — the constraint was the shape of the data, not the prose

Iteration 7's rejected entry contained the next hypothesis. It recorded that three failures were out of
reach of *any* prompt because `selectClaims` emits one claim per array entry, so no dependency claim can
hold two dependency names. That is a statement about representation, made while testing instructions.
Iteration 8 changed the representation and left the prompt alone.

One variable changed: the advanced response contract. After schema validation and before precision and
grounding, the pipeline projects the validated body into atomic claims addressed to an evidence ledger,
composes claims that are structurally about one thing, and appends the compositions into the body's own
arrays as ordinary marked entries. No model call was added, the synthesis prompt is byte-identical to
Iteration 7's reverted control, and `packages/evaluator` is untouched.

| | Regression Set v1 (frozen) | Challenge Set v2 | Combined |
| --- | --- | --- | --- |
| Control run | `eval-advanced-2026-09-05T01-35-25Z` | same run | same run |
| Treatment run | `eval-advanced-2026-09-06T11-28-46Z` | same run | same run |
| **Evidence-backed accuracy** | **100.0 % → 100.0 %** | **29.2 % (7/24) → 37.5 % (9/24)** | **55.3 % → 60.5 %** |
| Answer accuracy | 100.0 % → 100.0 % | 41.7 % (10/24) → 41.7 % (10/24) | 63.2 % → 63.2 % |
| Unsupported answers | 0 → 0 | 3 → 1 | 3 → 1 |
| Fabrications / dropped citations | 0 / 0 → 0 / 0 | 0 / 0 → 0 / 0 | 0 / 0 → 0 / 0 |
| Mean evidence relevance | 0.4105 → 0.4387 | 0.3809 → 0.4052 | 0.4007 → 0.4256 |

Provenance `iteration-6-baseline` → `iteration-8-atomic-claims-experiment`; `systemVersion` 0.1.0 →
0.2.0, because this treatment shipped. The acceptance threshold was again **+8 pp** on Challenge
evidence-backed accuracy. The measurement is **+8.3 pp**. The treatment is **kept**.

**Exactly two questions of 38 changed outcome, both upward.** `challenge-v2-orders-q11` and
`challenge-v2-pyflow-q12` each went UNCITED → BACKED with `matchedIn = dependencies` and `content`
evidence strength — the two cases the hypothesis named in advance as the only ones reachable. Nothing
regressed. Of the groupings, only `configuration-dependency` moved (2/5 → 4/5); `documentation`-kind
questions went 12/15 → 14/15 with `source` and `mixed` flat; `hard` questions stayed at 4/12.

**The result equals its own measured ceiling, which is the honest way to read it.** Before implementing,
the 17 challenge failures were re-classified by asking of each not just "did one claim satisfy this"
but "do the required keywords appear anywhere in the briefing at all". Fourteen fail the second test —
no arrangement of claims can recover them. Of the three that pass it, `orders-q05` was excluded as a
keyword coincidence: its only satisfied alternative is the bare word `all`, in an unrelated
authentication claim, while `rollback`, `begin` and `atomic` appear nowhere. That put the ceiling at
9 of 24 — 37.5 %, the threshold exactly — and the treatment reached precisely it. So the mechanism
recovered everything available to it and has no headroom left. `orders-q05` remains the benchmark's one
correct-but-uncited question, left alone deliberately.

**What the positive result establishes, and what it does not.** When a metric is bounded by the *shape*
of the structure a downstream consumer reads, instructing the producer to write better prose cannot move
it; changing the structure can, and did, on the first attempt. The diagnostic that distinguishes the two
situations is whether the required facts are present in the output but never in the same claim. What is
*not* established is the cross-file half of the mechanism: both recovered cases came from the same-list
rule over a dependency manifest. The shared-subject rule fired on every analysis and produced
compositions citing four or five distinct files each, and moved no question — implemented, tested, live,
and unvalidated by this benchmark.

Cost: $0.066076, byte-identical to the control, because the claim pass adds no model call. The claim
pass itself runs in 5–22 ms per analysis. Full hypothesis, per-case tables and the offline replay that
predicted the outcome before the run are in the
[improvement changelog](improvement-changelog.md).

<a name="limitations"></a>
## Limitations

Stated plainly, because a metric whose weaknesses are undocumented invites being gamed by
accident.

1. **Four cases, 38 questions.** One question is 2.6 percentage points overall — but the number
   worth quoting is per set, because that is how results are reported: one question is 7.1 points
   on Regression v1 and 4.2 points on Challenge v2. Differences of a question or two are still
   noise, and the report says so in a caveat on every run.
2. **Keyword matching is not comprehension.** A briefing can contain `express` while being
   confused about how it is used. Matching rewards the presence of the right token, not
   understanding — it is the trade taken to keep scoring deterministic and model-free.
3. **`mustNotContain` is naive substring matching.** A briefing that correctly says *"there is
   no GraphQL layer"* trips a `graphql` forbidden phrase. Choose forbidden phrases that could
   only appear as inventions, and check the per-question notes before believing a fabrication
   count.
4. **Excerpt verification is textual, not semantic.** An excerpt that genuinely appears in the
   cited source passes even if it does not actually support the claim built on it. Grounding
   proves provenance, not relevance.
5. **Truncated sources can cause false drops.** A long README is cut at a budget; an excerpt
   from the discarded tail is unverifiable through no fault of the model. The drop reason says
   `truncated` so these are distinguishable, but they still cost the metric.
6. **The baseline cannot answer file-internal questions at all.** Roughly a third of the
   questions in the dataset expect evidence from a source file the baseline never opens. Its
   ceiling on those is `partialEvidence`. This is intentional headroom, not an oversight — but
   it means the baseline's score is not a measure of "how good is an LLM at reading code".
7. **Regression v1's `expectedEvidence` lists only what the baseline could see.** This is the
   limitation Iteration 1 exposed, and on the frozen set it is **permanent by construction**. Each
   of those 14 expected-evidence lists was written when reconnaissance context was all any system
   had, so it names READMEs and manifests. A system that answers correctly while citing the
   *implementation* — `pipeline.py` for the topological sort, rather than the README sentence
   describing it — is scored as not evidence-backed. It is penalised for citing the source of truth.

   Three of Iteration 1's four regressions were this artefact. Iteration 2 lost
   `pyflow/q3-execution-order` and `orders-api/q4-auth-boundary` to it; Iteration 3 recovered both,
   and every advanced run since has scored 14/14 on the set.

   Widening those lists has deliberately **not** been applied, three times now: adjusting
   `expectedEvidence` after seeing which files the advanced system chose would be fitting the ruler
   to the result and would make every subsequent number unfalsifiable. Iteration 6 took the other
   route instead — **Challenge Set v2 does not inherit this flaw.** Its expected evidence names
   implementation files where the answer actually lives, written before any system was run against
   it, which is why 14 of its 24 questions are source-backed. The frozen lists stay as they are, and
   the number they produce stays comparable to 2026-08-31's.

   The cost of that route is visible in the Iteration 6 results: the source-backed group scores
   33.3 % where the documentation-backed group scores 93.3 %. Some of that gap is a genuinely
   harder task, and some of it is that the frozen set never asked.
8. **Fixture repositories are synthetic.** They were written to have the properties the cases
   test. Real repositories are messier, larger, and less tidily documented; scores here are an
   upper bound on what to expect in the wild.
9. **`passedCases` is all-or-nothing.** A case where six of seven questions are right counts
   as not passed. It is a deliberately harsh secondary figure; the primary metric is the
   per-question one.
10. **Mean evidence relevance has a moving denominator, and it penalises extra true
    citations.** Two separate flaws in one number, both exposed by Iteration 2.

    It is averaged only over questions where relevance was *measurable* — a question whose
    claim carries no confirmed citation contributes nothing rather than a zero, because
    reporting `0` there would be false. So a system that abstains on hard questions is averaged
    over fewer, easier ones. The baseline's 0.85 is over 10 questions; Iteration 2's 0.7321 is
    over all 14. Like-for-like on the baseline's own 10, Iteration 2 scores 0.775 — a 0.075
    decline, not 0.118.

    And because it is precision over `expectedEvidence`, a claim citing three verified sources
    where the case names one scores 0.33 — *lower* than a claim citing that one source alone.
    Every extra citation in the measured run was grounded against bytes a tool returned. The
    metric is measuring conciseness there, not correctness. Read it alongside the primary
    metric, never as a substitute for it, and do not optimise against it.
11. **The scout's ranking rationale is only partially recoverable from the trajectory.** The
    `scout-search` step records every candidate with its score, matched terms and reasons, but
    the trajectory recorder caps a serialized detail at 2 000 characters
    (`MAX_DETAIL_CHARS`); both fixtures land at 2 015 and are clipped with `... [truncated]`.
    The search terms and the top-ranked candidates survive, and everything
    reproducibility-critical is intact in `meta.exploration.scout` and the `scout-read` step —
    but a full post-hoc audit of *why a losing candidate lost* is not always possible from the
    trajectory file alone. Left as-is deliberately: raising a shared, intentionally-bounded
    recorder's limit to improve one iteration's introspection was outside this experiment's
    scope. The clean fix is a dedicated scout artefact rather than a bigger detail cap.

12. **`systemVersion` does not distinguish Iteration 1 from Iteration 2.** Both advanced runs
    record `systemVersion: "0.1.0"`, because `ADVANCED_VERSION` was deliberately left alone so
    that a recorded run keeps matching the code that produced it. The consequence is that the
    rejected 57.1 % run and the kept 85.7 % run are indistinguishable by that field alone. They
    are distinguishable in practice — by `runId` timestamp, and by following a case's `runId`
    into `trajectories/`, where only an Iteration 2 run contains `scout-search` and
    `scout-read` steps — but the field that exists to identify the system does not do it on its
    own. The fix belongs with the next change to the advanced system: bump the constant then, so
    the version moves at the same moment the behaviour does, rather than retroactively now, which
    would leave every already-recorded run pointing at a version that no longer exists.

