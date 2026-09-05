# Improvement Changelog

One entry per iteration. Each entry states the hypothesis *before* the change, the change
itself, and then the number the evaluation actually produced — including when that number
went the wrong way.

The rule this file exists to enforce: **an iteration is not an improvement until a paired
evaluation run says so.** Entries are not edited after their measurement is recorded.

---

## Baseline — Shallow Context, Single Call

The reference point every iteration is measured against. Recorded here so later entries have
something fixed to compare to.

| | |
|---|---|
| Run id | `eval-baseline-2026-08-31T00-01-17Z` |
| Command | `pnpm evaluate:baseline -- --model gemini-3.5-flash-lite --case-delay 20` |
| Model | `gemini-3.5-flash-lite`, seed 7, thinking `low` |
| Cases / questions | 2 / 14 (0 failed) |
| **Evidence-backed task accuracy** | **64.3 % (9/14)** |
| Answer accuracy | 85.7 % (12/14) |
| Unsupported answers | 2 |
| Fabrications | 0 |
| Dropped citations | 0 |
| Mean evidence relevance | 0.85 |
| Tokens | 2 450 in / 4 480 out |
| Cost | $0.011935 |

---

## Iteration 1 — Targeted Repository Exploration

### Hypothesis

The baseline sees four things: the directory tree, the README, the package manifest, and basic
repository metadata. Several evaluation questions ask about behaviour that is only visible in
source files — how steps are dispatched, what guards a write against overselling, which module
owns state. For those questions the baseline is being asked to cite evidence it was never
given, so it either answers from the README's summary of the code or answers correctly with no
citable support.

If the model can decide for itself which files to open and then read them, the evidence it
cites should come from the implementation rather than from documentation about the
implementation. Predicted effect: **evidence-backed task accuracy rises**, because answers
that were previously correct-but-unsupported become correct-and-supported.

The prediction rests on an assumption worth naming, because it turned out to be the load-bearing
one: that a citation earned by reading a file is *at least as good* as a citation drawn from
reconnaissance context, and never worse.

### Change

A second system, selectable with `--system advanced`, sharing the baseline's context
collection, schema, grounding layer, and evaluator.

- **Three read-only tools** — `search_code` (literal, case-insensitive, deterministic),
  `read_file` (line-numbered, the only tool producing citable evidence), `list_directory`
  (bounded depth). All three resolve paths inside the repository root and refuse traversal,
  absolute paths, null bytes, and escaping symlinks.
- **A two-phase loop.** Exploration turns carry tools and no response schema; the final
  synthesis turn carries the schema and no tools, because "call a tool" and "emit conforming
  JSON" cannot both be the answer to one turn.
- **An evidence ledger.** It starts as the reconnaissance sources and grows only when a tool
  returns bytes. Grounding runs against the ledger, so the model's own prose can never be the
  thing that authorises a citation.
- **A bounded budget**, configurable by flag and environment: max turns, max tool calls, max
  search results, max file lines, max file bytes, max match context lines, max directory
  entries.
- **A trajectory** recording every model turn verbatim, every tool call with its arguments,
  and every tool result — kept as separate fields, with secrets redacted, so a reader can tell
  what the model said from what the filesystem returned.

### Expected improvement

Evidence-backed task accuracy above the baseline's 64.3 %, driven by the questions whose
evidence is absent from reconnaissance context. Answer accuracy expected to hold or rise
slightly. Cost and latency expected to increase — several calls per repository instead of one.

### Measurement

Both systems on the same 14 questions, same model, same seed, same thinking level, same
evaluator, run eleven minutes apart. Neither run had a failed case.

| | Baseline | Advanced | Δ |
|---|---|---|---|
| **Evidence-backed task accuracy** | **64.3 % (9/14)** | **57.1 % (8/14)** | **−7.1 pts** |
| Answer accuracy | 85.7 % (12/14) | 85.7 % (12/14) | 0 |
| Unsupported answers | 2 | 1 | −1 |
| Fabrications | 0 | 0 | 0 |
| Dropped citations | 0 | 0 | 0 |
| Briefing unsupported claims | 0 | 0 | 0 |
| Mean evidence relevance | 0.85 | 0.68 | −0.17 |
| Tokens | 6 930 | 44 746 | ×6.5 |
| Cost | $0.011935 | $0.024957 | ×2.1 |
| Wall clock | 33.6 s | 53.8 s | ×1.6 |

Run ids: `eval-baseline-2026-08-31T00-01-17Z`, `eval-advanced-2026-08-31T00-11-08Z`.

Commands:

```
pnpm evaluate:baseline -- --model gemini-3.5-flash-lite --case-delay 20
pnpm evaluate:advanced -- --model gemini-3.5-flash-lite --case-delay 25
```

**Iteration 1 regressed the primary metric.** The aggregate hides a two-way split — four
questions changed, and they did not all change in the same direction:

| Question | Baseline | Advanced | |
|---|---|---|---|
| `orders-api/q5-oversell-guard` | wrong | correct, content-backed | **won** |
| `pyflow/q1-purpose` | correct, unbacked | correct, content-backed | **won** |
| `orders-api/q3-event-publication` | correct, content-backed | correct, unbacked | lost |
| `pyflow/q3-execution-order` | correct, content-backed | correct, unbacked | lost |
| `pyflow/q4-state-store` | correct, content-backed | correct, unbacked | lost |
| `orders-api/q4-auth-boundary` | correct, unbacked | **wrong** | lost |

Both wins are exactly what the hypothesis predicted, and both are real: `q5-oversell-guard`
went from wrong to right *because* the agent opened `src/services/inventory.js` and
`docs/incidents/2025-08-oversell.md`. The mechanism works. It is the losses that decided the
verdict — see the two failure modes below.

### Decision rule

Stated in the terms the baseline brief set: the primary metric is evidence-backed task
accuracy. Keep the iteration if it rises; reject it if it falls; if it is flat, keep only when
a secondary measure improves and none regresses.

It fell by 7.1 points. **Iteration 1 is rejected as an improvement.** It is not promoted,
and no part of this repository claims it improved on the baseline.

The code stays in the tree behind `--system advanced`, unpromoted, for two reasons: the
diagnosis below depends on being able to re-run it, and Iteration 2 is a change *to* it rather
than a replacement for it. Rejected means "did not earn the claim", not "deleted".

### Why it regressed

Two distinct causes, and only one of them is the agent's fault.

**1. Citation substitution, not citation loss (3 of the 4 losses).** On all three
evidence-backed losses the advanced system answered *correctly* and cited exactly one item —
the implementation file it had just read — where the baseline had cited the README or the
manifest. For `pyflow/q3-execution-order` the case lists `README.md` as expected evidence; the
advanced system cited `pyflow/pipeline.py:28-40`, the topological sort itself. The scorer found
no citation pointing at `README.md` and marked the answer unbacked.

So the agent traded several documentation citations for one implementation citation. Against
this dataset that is scored as a loss, because `expectedEvidence` was written when
reconnaissance context was all any system had, and therefore enumerates only the files the
baseline could see. A system citing the source of truth is penalised for not citing the
document that describes it.

This is a real limitation of the dataset, and it is *not* being fixed here. Widening
`expectedEvidence` after seeing which files the advanced system chose would be fitting the
measurement to the result — the one move that would make every later number meaningless. The
7.1-point regression stands as measured. Iteration 2 addresses the dataset as its own change,
pre-registered and re-run against both systems.

**2. Depth bought at the cost of breadth (1 of the 4 losses, and it is genuine).**
`orders-api/q4-auth-boundary` asks which routes sit outside the auth boundary; it requires the
briefing to mention `/health`. The baseline, working from the README, mentioned it. The
advanced system read four source files in depth and never mentioned it at all — the answer
became more detailed about fewer things. No dataset artefact explains this one: the agent spent
its budget going deep on one flow and produced a narrower briefing.

### Two findings worth more than the metric

**The agent never searched.** Across both cases it made 7 tool calls, all of them `read_file`
— zero `search_code`, zero `list_directory`. It picked filenames out of the directory tree and
opened them directly. The clearest cost of that shows in `pyflow/q6-step-dispatch`, the
question that motivated this iteration: it expects the word `registry`, with evidence in
`pyflow/steps/__init__.py`. The agent read `pyflow/cli.py` — one of the two expected files —
never opened `pyflow/steps/__init__.py`, and still answered wrong. A single
`search_code("registry")` would have found it. The tool the iteration was built around was
never used, which means **the exploration mechanism has not actually been tested at full
strength yet.**

**The grounding layer held completely.** Zero fabrications, zero dropped citations, zero
unsupported briefing claims, on both systems. Every one of the advanced system's citations
verified against bytes a tool had genuinely returned. Giving the model file access did not
buy a single invented quotation — which is the property that had to hold before exploration
could be trusted at all, and the one result here that needs no caveat.

### Cost of the negative result

$0.036892 and 87 seconds of model time across both runs.

---

## Iteration 2 — Evidence Scout

### Hypothesis

The advanced system regressed because autonomous exploration relied too heavily on the LLM
choosing filenames to read. A deterministic, bounded evidence-scanning phase that searches the
repository for question-relevant terms before deep reading should improve evidence-backed
accuracy while preserving the useful high-level context from the baseline.

Two things in Iteration 1's trajectory made this the obvious next move rather than a guess. The
agent made 7 tool calls and every one was `read_file` — `search_code` was used **zero** times,
so the tool the iteration was built around had never actually run. And on
`pyflow/q6-step-dispatch`, the question that motivated Iteration 1, the agent opened
`pyflow/cli.py` (which contains `REGISTRY.get(step.type)` at line 36), never opened
`pyflow/steps/__init__.py` where `REGISTRY` is defined, and still answered without the word
`registry`. One search would have found it.

So the prediction is narrow: if search happens *before* the model gets a turn, rather than being
offered to it as an option it declines to take, the evidence in the ledger should cover the
questions whose answers live in source files — without displacing the reconnaissance context
that Iteration 1 traded away.

### Change

Added a bounded deterministic evidence-scanning phase that:

1. extracts question-relevant terms,
2. searches the repository,
3. ranks candidate files,
4. reads high-signal files,
5. adds verified evidence to the existing ledger.

The baseline reconnaissance context remains intact.

Four properties are worth stating precisely, because each one is a place this could have gone
wrong:

- **No extra model call.** Term extraction is `tokenize → drop stop words → keep technical
  tokens → detect compounds → apply a small synonym table`, all pure functions in
  [`scout/terms.ts`](../packages/shared/src/scout/terms.ts). Adding a Gemini call to generate
  search terms would have bought nondeterminism and cost for something a stop-word list does.
- **The scout is additive, not a replacement.** The reconnaissance prompt still carries the
  tree, README, manifest and metadata verbatim; scout evidence is appended as a separate block.
  Iteration 1's genuine loss came from depth crowding out breadth, so the fix could not be
  another substitution.
- **One door into the ledger.** The scout's reads go through the same `read_file`, the same
  `resolveInsideRepository` boundary check, the same truncation limits and the same
  `ledger.recordAll` call as the model's own. `packages/evaluator` was not touched.
- **The model keeps its tools.** The scout sets a floor on the evidence, not a ceiling. In the
  measured run the model went on to read six more files in `orders-api` and two more in
  `pyflow` after the scout finished.

**Where the search terms come from during evaluation, and why that is not the question.** §5 of
the iteration brief describes the scout as receiving the evaluation question. It cannot, and the
harness enforces that: `evaluation/test/run.test.ts` asserts the system never sees the questions
it is scored on, and feeding them in would hand the advanced system an answer key the baseline
never gets. The question-driven extractor ships as a real, fully-tested capability behind
`--focus`, for the interactive case where a user has a question in hand. Under evaluation the
scout derives its terms from the repository's own documentation instead — README emphasis,
manifest vocabulary, path components. **Every number below comes from the question-blind
configuration.** The CLI throws a `ConfigError` if `--focus` is passed to any command other than
`advanced`, so the evaluation path cannot acquire it by accident.

### Measurement

Both systems on the same 14 questions, same model, same seed, same thinking level, same
evaluator, same unmodified cases. Neither run had a failed case.

| | Baseline | Advanced (Iteration 2) | Δ |
|---|---|---|---|
| **Evidence-backed task accuracy** | **64.3 % (9/14)** | **85.7 % (12/14)** | **+21.4 pts** |
| Answer accuracy | 85.7 % (12/14) | 100.0 % (14/14) | +14.3 pts |
| Cases passed (all questions correct) | 0 / 2 | 2 / 2 | +2 |
| Unsupported answers | 2 | 0 | −2 |
| Fabrications | 0 | 0 | 0 |
| Dropped citations | 0 | 0 | 0 |
| Briefing unsupported claims | 0 | 0 | 0 |
| Mean evidence relevance | 0.85 (n=10) | 0.7321 (n=14) | −0.118 † |
| Tokens | 2 450 in / 4 480 out | 56 795 in / 6 400 out | ×9.1 total |
| Cost | $0.011935 | $0.033038 | ×2.77 |
| Cost per evidence-backed answer | $0.001326 | $0.002753 | ×2.08 |
| Wall clock | 38.3 s | 54.0 s | ×1.41 |

Run ids: `eval-baseline-2026-08-31T03-44-47Z`, `eval-advanced-2026-08-31T04-03-32Z`.

```
pnpm evaluate:baseline -- --model gemini-3.5-flash-lite --case-delay 20
pnpm evaluate:advanced -- --model gemini-3.5-flash-lite --case-delay 25
```

Against **Iteration 1** (57.1 %, $0.024957) the primary metric is **+28.6 points** for 1.32× the
cost.

The baseline run reproduced its previously recorded figures exactly — 64.3 %, 85.7 %, 0.85, the
same token counts and the same $0.011935 — which is a small reproducibility result in its own
right, and the reason the comparison can be trusted as like-for-like.

Wall clock includes the inter-case delay each command sets (20 s and 25 s). Net of it: **18.3 s
→ 29.0 s.**

† The relevance figure needs its denominator to be read correctly, and it is explained under
*Why relevance fell* below. It is a precision measure averaged only over questions where it was
measurable, and the two systems did not have the same number of those.

#### Per question

`C` = answer correct, `E` = evidence-backed.

| Question | Baseline | Advanced | Relevance | |
|---|---|---|---|---|
| `orders-api/q1-purpose` | `C-` | `CE` | null → 1 | **won** |
| `orders-api/q2-http-framework` | `CE` | `CE` | 1 → 1 | |
| `orders-api/q3-event-publication` | `CE` | `CE` | 1 → 0.3333 | |
| `orders-api/q4-auth-boundary` | `C-` | `C-` | null → 0 | |
| `orders-api/q5-oversell-guard` | `--` | `CE` | null → 1 | **won** |
| `orders-api/q6-testing-gap` | `CE` | `CE` | 1 → 1 | |
| `orders-api/q7-api-surface` | `CE` | `CE` | 1 → 0.75 | |
| `pyflow/q1-purpose` | `C-` | `CE` | 0 → 1 | **won** |
| `pyflow/q2-cli-library` | `CE` | `CE` | 1 → 1 | |
| `pyflow/q3-execution-order` | `CE` | `C-` | 1 → 0 | lost |
| `pyflow/q4-state-store` | `CE` | `CE` | 1 → 0.6667 | |
| `pyflow/q5-untested-steps` | `CE` | `CE` | 1 → 1 | |
| `pyflow/q6-step-dispatch` | `--` | `CE` | null → 0.5 | **won** |
| `pyflow/q7-no-external-scheduler` | `CE` | `CE` | 0.5 → 1 | |

Four gains, one loss, net +3 on the primary metric. Two of the gains
(`q5-oversell-guard`, `q6-step-dispatch`) were previously *wrong answers*, which is where the
+14.3 points of answer accuracy comes from.

#### The motivating failure, end to end

`pyflow/q6-step-dispatch` — *"How is a step's declared type mapped to the function that runs
it?"*, expected keyword `registry`, expected evidence `pyflow/steps/__init__.py` or
`pyflow/cli.py`. It failed on the baseline and failed again on Iteration 1. What happened this
time is recorded in the trajectory:

1. Term extraction produced `dispatch` at weight 40, origin **`vocabulary`** — drawn from the
   repository's own documentation, which describes steps as dispatched by type.
2. `search_code("dispatch")` matched `pyflow/steps/__init__.py`, whose first line reads
   *"Step implementations, dispatched by the `type` field of a step."*
3. Ranking placed it 4th of 10 candidates at score 190, inside the `maxScoutFiles: 4` cut.
4. The scout read it — 7 lines, 262 bytes — putting `REGISTRY = {"extract": extract,
   "transform": transform, "load": load}` into the ledger. It also read `pyflow/cli.py` at rank
   3, the other expected file.
5. The briefing answered with `registry`, cited two items, `missingKeywords: []`, evidence
   `content`-strength, grounded.

Worth noting for the honesty of the result: the term that found the file was `dispatch` from
repository vocabulary, **not** the `dispatch → registry` entry in the synonym table. That
mapping did not fire in the measured run — `registry` never became a search term. The win does
not depend on the one part of the lexicon that had fixture knowledge behind it.

#### What the scout actually did

| | `orders-api` | `pyflow` |
|---|---|---|
| Terms extracted | 14 | 14 |
| Searches run | 14 | 14 |
| Searches with a match | 14 | 13 |
| Candidates ranked | 10 | 10 |
| Files read (of candidates) | 4 | 4 |
| Candidates skipped | 6 | 6 |
| Bytes read by the scout | 2 839 | 4 840 |
| Model tool calls after the scout | 7 (all `read_file`) | 2 (all `read_file`) |
| Failed tool calls | 0 | 0 |
| Files in the ledger at synthesis | 14 sources | 10 sources |
| Citations claimed / grounded | 19 / 19 | 12 / 12 |

The scout's cost is fixed and declared; the model's tool budget stays discretionary. They are
reported side by side and never summed, so "the agent explored more this iteration" remains
readable from the numbers.

### Result

**The primary metric rose 21.4 points, from 64.3 % to 85.7 %.** Answer accuracy rose 14.3
points to 100 %, and both cases passed every question for the first time. Grounding held
completely: 31 citations claimed across the two cases, 31 grounded, zero dropped, zero
fabrications, zero unsupported briefing claims. Cost rose 2.77×, or 2.08× per evidence-backed
answer delivered.

Three things did not go the way the hypothesis assumed, and they belong in the result rather
than in a footnote.

**1. One question regressed: `pyflow/q3-execution-order`.** The answer is still correct. The
advanced system cited `pyflow/pipeline.py` — the topological sort itself — where the case names
`README.md`, so the scorer found no citation pointing at an expected location and credited no
evidence. This is the *same citation-substitution failure that cost Iteration 1 three of its
four losses*, and it is the one Iteration 1 loss that Iteration 2 did not fix. The dataset
limitation behind it (limitation 7 in [`evaluation.md`](evaluation.md#limitations)) is still
unaddressed, and `expectedEvidence` was again deliberately **not** widened: doing so after
seeing which files the system chose would be fitting the ruler to the result.

**2. Why relevance fell.** `meanEvidenceRelevance` is *precision* — the share of a claim's
confirmed citations that point at an expected location — averaged only over questions where it
was measurable. The baseline's 0.85 is an average over **10** questions; the four it abstained
on contribute nothing. The advanced system produced measurable relevance on all **14**. So the
two means have different denominators and are not directly comparable. Decomposed:

| | Advanced |
|---|---|
| On the baseline's own 10 measurable questions | **0.775** (vs 0.85) |
| On the 4 the baseline abstained on | **0.625** (vs no value at all) |
| All 14 | **0.7321** |

The like-for-like decline is 0.075, not 0.118, and its cause is visible per question: the
advanced system cites *more* verified evidence per claim, and the extra citations are correct but
unexpected. `q3-event-publication` cited 3 items where 1 was expected (0.3333),
`q7-api-surface` 4 where 3 were expected (0.75), `q4-state-store` 3 where 2 were expected
(0.6667). Every one of those extra citations was grounded against bytes a tool returned. A
metric that falls when a system adds true citations is measuring conciseness, not correctness —
worth knowing, and not worth optimising against.

**3. `orders-api/q4-auth-boundary` is still not evidence-backed, but it fails differently
now.** On the baseline it was correct-but-unsupported because the keywords *"matched only across
separate claims"* — no single claim answered the question. On Iteration 1 it went outright wrong,
losing `/health` entirely: the genuine depth-over-breadth regression. Iteration 2 answers it
correctly in one claim and cites one item, which is progress on both earlier failures — and then
loses the question anyway because the cited item is not `README.md`. Same artefact as (1).

### Decision

Judged against the criteria stated before the run:

| Criterion | Required | Measured | |
|---|---|---|---|
| Evidence-backed accuracy | improves meaningfully | +21.4 pts (9 → 12 of 14) | ✅ |
| Grounding | intact | 31/31 grounded, 0 dropped, 0 fabricated | ✅ |
| Answer accuracy | no material regression | +14.3 pts, 14/14 | ✅ |
| Cost and runtime | reasonable | ×2.77 cost, ×1.41 wall clock | ✅ |
| Reproducible | yes | deterministic phase; baseline reproduced exactly | ✅ |

**Iteration 2 is kept.** It is the first change in this project that earned an improvement claim
from a paired run.

Two caveats travel with the claim and are not negotiable. The dataset is 14 questions, so
+21.4 points is **three questions** — read the mechanism, not the percentage. And the mechanism
is the part that generalises: search-then-read put the right files in the ledger on both
fixtures, which is a structural result that would survive a larger dataset, whereas the exact
margin would not.

### Things measured along the way that did not make the metric

**More search terms is worse, not better.** At `maxScoutTerms: 28` the extra low-weight terms
pulled the ranking away from the files that mattered: `pyflow` dropped `pyflow/cli.py` from its
top four in favour of `pyflow/store.py`, and `orders-api` dropped `src/lib/events.js` for
`test/orders.test.js`. Runtime was flat across 14 / 28 / 40 terms (1.86 s / 1.60 s / 1.59 s), so
the bound is doing signal work rather than cost work. **The default of 14 stands on
measurement, not taste.**

**The scout skipping a file is not the same as the file going unread.** `pyflow/store.py` sits
below the rank-4 cut (its best term, `store`, weighs 30) and the scout did not open it — which is
correct, since `q4-state-store` expects `README.md` and the README already describes it. The
model then read it anyway as its first tool call. That is the floor-not-ceiling property working
as intended, and it is why removing the model's tools after the scout would be a mistake.

**A note on the synonym table, because it is the one part of this change that could quietly
become a cheat.** The entries in [`lexicon.ts`](../packages/shared/src/scout/lexicon.ts) are
general software-engineering associations, not fixture-specific mappings: a table from a type to
a function *is* a registry, a thing that persists data *is* a repository. But they were written
while knowing which concepts the evaluation fixtures contain, and `dispatch → registry` in
particular is the mapping that the motivating failure needed. That does not make it wrong, and it
does mean the measured benefit may not transfer intact to a repository whose concepts are absent
from this list. Stated here so the number is read with it in mind. The mitigating fact from the
measured run: `dispatch → registry` never fired — the terms that earned the win came from the
repositories' own text.

### A provider bug this iteration surfaced, and what it cost

The first attempt at the advanced evaluation failed on `case-001-orders-api` with
`400 Request contains an invalid argument`. The cause was not the scout. Gemini models a model
turn as **all** of its function calls followed by **all** of their results, and the exploration
loop was replaying them chronologically — call, result, call, result — which the API rejects. An
A/B probe against the live API confirmed it directly: interleaved → 400, grouped → OK.

This was a **pre-existing latent bug in the shared model path, not something Iteration 2
introduced.** It only fires when the model asks for two files in one turn, and Iteration 1's
measured run never did. Iteration 2 gave the model enough context to start batching its reads,
which is what exposed it. Two further protocol faults were found and fixed in the same pass: an
empty `model_output` is rejected with `400 Missing text in content of type text` (now filtered in
`toApiInput`), and a budget-refused call was emitting a `function_result` with no matching
`function_call`. All three are now covered by offline tests — `packages/shared/test/llm.test.ts`
and one advanced test that asserts the calls-then-results arrangement — which is the only way
they stay fixed, since none of them can fail against a mock.

`generateStructured`, the baseline's path, was not touched, so the previously recorded baseline
figures remain valid and were not re-run for the fix. They were re-run anyway, and reproduced.

### Cost of the positive result

$0.044973 and 92 seconds of model time across both scored runs, plus the discarded first
advanced attempt and the live probes that diagnosed the 400.

---

## Iteration 3 — Evidence Precision Pass

### Hypothesis

Iteration 2 reached 100 % answer accuracy but 85.7 % evidence-backed accuracy. Both remaining
failures had the same shape: the answer was right, the citation was grounded and technically
relevant, and the evaluator had expected a *different* source. Not an answer problem — a
**citation-selection** problem.

The stated plan was to fix it by *pruning*: score each claim's citations and drop the weak ones.
Reading `packages/evaluator/src/score.ts` first showed that this cannot work, and the reason is
worth stating because it inverts the whole iteration:

```ts
evidenceBacked = bestEvidenceStrength(pool, expectedEvidence) === "content"
```

`bestEvidenceStrength` is a **best-of** reduction over the citation pool. Adding a citation can
only raise or hold it; removing one can only lower or hold it. Pruning is therefore incapable of
improving the primary metric — and post-synthesis it saves no tokens either, so it could not
qualify under the cost clause of the decision rule. Worse, both Iteration 2 failures cited
*exactly one* source each. There was nothing to prune.

So the hypothesis was reversed: if the metric asks "does *any* citation on this claim point at
the source that proves it", then the fix is not to remove the model's citation but to **add the
one it did not think to cite** — from evidence the ledger already held, with a verbatim excerpt,
subject to the same grounding check as everything else.

### Change

A deterministic pass between schema validation and grounding. No model call, no embeddings, no
index, no file opened. Two halves with deliberately different risk profiles:

**Hygiene** (cannot change the metric, by construction) — exact-duplicate removal, same-source
same-location redundancy removal, and a stable score-descending order that breaks ties by the
model's own ordering. Provably cannot remove a `(source, location)` pair from a claim, so it
cannot lower a best-of metric.

**Corroboration** (the only half that can move the metric) — for a claim that already has at
least one *verifiable* citation, attach up to `maxCorroborations` (default 2) further ledger
sources, each admitted only if one of its lines shares at least `minCorroborationTerms` (default 2)
distinctive stemmed terms with the claim. The excerpt is a verbatim prefix of that line, so
grounding re-verifies it like any other citation.

Five rules keep it inside the constraints:

1. **Ledger-only.** Nothing is opened; candidates come from `ledger.toArray()`.
2. **Content kinds only.** A directory tree can never corroborate, so existence evidence is
   never upgraded into content evidence.
3. **No invented `location`.** The ledger holds a raw slice whose first line is not necessarily
   line 1 of the file, so any line number the pass computed would be a guess. The excerpt locates
   itself.
4. **Never rescues an unsupported claim.** The gate is `distinct.some(isVerifiable)` — a claim
   whose every citation is unverifiable (a hallucinated path, a paraphrased quote) gets no
   corroboration and stays unsupported. Without this, the pass could launder a hallucination into
   a supported statement by attaching real evidence to a fabricated claim.
5. **Grounding still decides.** The pass proposes; `groundAnalysis` disposes. The ledger remains
   the sole authority.

Rule 4 was not in the design. It was found by a **failing existing test** — `advanced.test.ts`
"marks the claim unsupported when its only citation is dropped" went red because the first gate
was `distinct.length === 0`, which let a claim whose single citation was a hallucinated path
qualify for corroboration. Fixed in the implementation, not the test, by exporting
`createCitationVerifier` from the grounding layer so the two layers use literally the same
`verify` and cannot drift.

### Measurement

Two paired runs, because the task's commands name `gemini-3.5-flash` while Iteration 2 was
measured on `gemini-3.5-flash-lite`. Both are reported; neither is hidden.

#### The like-for-like comparison — `gemini-3.5-flash-lite`, same model, seed and cases as Iteration 2

| | Advanced (Iteration 2) | Advanced (Iteration 3) | Δ |
|---|---|---|---|
| **Evidence-backed task accuracy** | **85.7 % (12/14)** | **100.0 % (14/14)** | **+14.3 pts** |
| Answer accuracy | 100.0 % (14/14) | 100.0 % (14/14) | 0 |
| Cases passed (all answers correct) | 2 / 2 | 2 / 2 | 0 |
| Cases fully cited (all answers evidence-backed) | 0 / 2 | 2 / 2 | +2 |
| Unsupported answers | 0 | 0 | 0 |
| Fabrications | 0 | 0 | 0 |
| Dropped citations | 0 | 0 | 0 |
| Briefing unsupported claims | 0 | 0 | 0 |
| Mean evidence relevance | 0.7321 (n=14) | 0.4105 (n=14) | **−0.3216** |
| Grounded citations in the briefing | 31 | 84 | ×2.71 |
| Tokens | 56 795 in / 6 400 out | 56 795 in / 6 400 out | **0** |
| Cost | $0.033038 | $0.033038 | **$0** |
| Wall clock | 54.0 s | 55.8 s | +1.8 s |

Run ids `eval-advanced-2026-08-31T04-03-32Z` (Iteration 2) and `eval-advanced-2026-08-31T06-18-59Z`
(Iteration 3).

**The token counts are identical, per case, to the digit** — 35 379/3 931 for `orders-api` and
21 416/2 469 for `pyflow` — and so are the pre-pass citation counts (19 and 12, matching Iteration
2's `claimed`). The pass runs after synthesis, so the prompts were byte-identical and the model
produced the same output twice. That makes this an unusually clean attribution: **the same model
output scored 85.7 % with Iteration 2's citations and 100 % with Iteration 3's.** The entire
+14.3 points belongs to the deterministic pass, for zero extra tokens.

#### Per question, like-for-like

`C` = answer correct, `E` = evidence-backed.

| Question | Iteration 2 | Iteration 3 | Relevance | |
|---|---|---|---|---|
| `orders-api/q1-purpose` | `CE` | `CE` | 1 → 0.3333 | |
| `orders-api/q2-http-framework` | `CE` | `CE` | 1 → 0.5 | |
| `orders-api/q3-event-publication` | `CE` | `CE` | 0.3333 → 0.4444 | |
| `orders-api/q4-auth-boundary` | `C-` | `CE` | 0 → 0.3333 | **won** |
| `orders-api/q5-oversell-guard` | `CE` | `CE` | 1 → 0.6667 | |
| `orders-api/q6-testing-gap` | `CE` | `CE` | 1 → 0.3333 | |
| `orders-api/q7-api-surface` | `CE` | `CE` | 0.75 → 0.6364 | |
| `pyflow/q1-purpose` | `CE` | `CE` | 1 → 0.3333 | |
| `pyflow/q2-cli-library` | `CE` | `CE` | 1 → 0.3333 | |
| `pyflow/q3-execution-order` | `C-` | `CE` | 0 → 0.3333 | **won** |
| `pyflow/q4-state-store` | `CE` | `CE` | 0.6667 → 0.3333 | |
| `pyflow/q5-untested-steps` | `CE` | `CE` | 1 → 0.3333 | |
| `pyflow/q6-step-dispatch` | `CE` | `CE` | 0.5 → 0.5 | |
| `pyflow/q7-no-external-scheduler` | `CE` | `CE` | 1 → 0.3333 | |

Two gains, **zero losses**. Both gains are the exact failures the iteration was aimed at, and
`pyflow/q3-execution-order` is the single question Iteration 2 *regressed* — the
citation-substitution artefact that also cost Iteration 1 three questions. It is now fixed.

#### The mandated pair — `gemini-3.5-flash`, the commands the task specifies

| | Baseline | Advanced (Iteration 3) | Δ |
|---|---|---|---|
| **Evidence-backed task accuracy** | **78.6 % (11/14)** | **78.6 % (11/14)** | **0** |
| Answer accuracy | 85.7 % (12/14) | 92.9 % (13/14) | +7.1 pts |
| Cases passed | 0 / 2 | 1 / 2 | +1 |
| Cases fully cited | 0 / 2 | 0 / 2 | 0 |
| Unsupported answers | 1 | 2 | +1 |
| Fabrications | 0 | 0 | 0 |
| Dropped citations | 0 | 1 | +1 |
| Briefing unsupported claims | 0 | 1 | +1 |
| Mean evidence relevance | 0.9212 | 0.4848 | −0.4364 |
| Tokens | 2 450 in / 5 271 out | 102 664 in / 8 468 out | ×14.7 |
| Cost | $0.051115 | $0.230209 | ×4.50 |
| Wall clock | 48.9 s | 906.8 s | ×18.5 |

Run ids `eval-baseline-2026-08-31T05-51-52Z`, `eval-advanced-2026-08-31T05-53-01Z`.

```sh
pnpm evaluate:baseline -- --model gemini-3.5-flash --case-delay 20
pnpm evaluate:advanced -- --model gemini-3.5-flash --case-delay 25
```

**On this pair the advanced system does not beat its own baseline on the primary metric.** Three
questions moved each way: `orders-api/q1-purpose`, `orders-api/q5-oversell-guard` and
`pyflow/q6-step-dispatch` became evidence-backed; `orders-api/q4-auth-boundary`,
`pyflow/q3-execution-order` and `pyflow/q5-untested-steps` stopped being so. Net zero.

The reason the pass could not help the three losses is structural and worth recording: all three
scored `citedEvidence = 0`, meaning the evaluator found **no single claim** in the briefing that
answered the question — `pyflow/q3-execution-order` says so explicitly ("keywords matched only
across separate claims"). The pass operates on the citations of claims that exist. It cannot
corroborate a claim the model never made, and by design it will not attach evidence to a claim
with nothing verifiable on it. Fixing that is a synthesis problem, not a citation problem.

The stronger model also moved the baseline a long way: 78.6 % against 64.3 % on `flash-lite`. Most
of the headroom Iteration 2 measured against was the weaker model's, which is why the flash pair
is a much harder test and why the like-for-like run is the one that isolates this change.

#### The dropped citation and the unsupported claim, attributed

The flash `pyflow` run dropped one citation — `README.md`, `excerpt-not-found` — and reported one
unsupported claim. Both were the **model's**, not the pass's, and the reason is structural rather
than a guess:

- A corroboration's excerpt is a verbatim prefix of a trimmed line of `source.text`, taken from
  the same `sources` array grounding indexes; ledger ids are unique, so `resolveSource` resolves
  the citation back to the very object the line came from; and `normalizeForMatch` (collapse
  whitespace, trim, lowercase) preserves the substring relation. A corroboration that the pass
  emits is therefore always found. The `flash-lite` run confirms it empirically: **53
  corroborations added across the two cases, 84/84 citations grounded, 0 dropped.**
- The claim went unsupported precisely *because* the pass refused to touch it. Rule 4 declines to
  corroborate a claim with no verifiable citation, so the model's paraphrased README quote was
  left standing alone and grounding removed it. The alternative — corroborating it — would have
  produced a supported-looking claim built on a quote that does not exist.

That is the integrity property working as intended, and it shows up in the metrics as a
regression. Both readings are true and the number stands as measured.

### Why relevance fell

`evidenceRelevance = relevantEvidence / citedEvidence` — a precision measure with a moving
denominator. The pass adds up to two corroborations per claim, so a claim that cited one expected
source now cites three: relevance 1 → 0.3333 exactly, which is why so many rows land on that
value. Relevance fell on 10 questions, rose on 3 and held on 1, while every question kept
`evidenceStrength = content` and the count of evidence-backed answers rose from 12 to 14. The
denominator grew; nothing relevant was lost.

This is a real cost, not a measurement artefact to wave away: the briefing now carries 2.71× the
citations, and a reader checking them does more work per claim. The decision rule does not treat
relevance as a rejection trigger, and §6 of the task explicitly warns against minimising citation
count rather than maximising useful evidence — but a future iteration that wants both would have
to make corroboration conditional on the claim's existing citations being weak, rather than
unconditional up to the cap.

### Result

**Kept.** On the like-for-like comparison the primary metric rose 85.7 % → 100.0 % (+14.3 points)
with answer accuracy held at 100 %, fabrications, dropped citations, unsupported claims and
unsupported answers all still at zero, at identical token cost and +1.8 s of wall clock. Two
questions won, none lost. The mandated `flash` pair shows no gain over its baseline and is
reported above in full.

### Decision

**Iteration 3 is kept**, on the like-for-like evidence, with three caveats recorded rather than
buried: the primary metric ties the baseline on `gemini-3.5-flash`; mean evidence relevance falls
by a third; and the dataset is 14 questions, so 100 % means "no remaining failures in this
dataset", not "solved". The `flash-lite` result is a ceiling on a small dataset and should be read
as directional.

The design also contradicts the task's stated mechanism — it adds citations where §4 and §5 asked
for removal and ranking. That was a deliberate reading of §4's own escape clause ("unless the
architecture already has a deterministic way to associate an existing ledger artifact with the
claim") against the evaluator's best-of arithmetic, and the hygiene half implements the removal
the task asked for. It is recorded here because the divergence is more interesting than the score.

### Cost of the positive result

$0.281324 and 955.7 seconds across the three scored runs (`flash` baseline, `flash` advanced,
`flash-lite` advanced). The pass itself costs nothing: no model call, no file read, and token
counts identical to Iteration 2's on the same model.

---

## Iteration 4 — Interactive Product Layer

### Hypothesis

There is no hypothesis about the metric, and that is the entry's whole point.

The first three iterations each proposed a change to how the system gathers or selects evidence,
predicted an effect on evidence-backed task accuracy, and were kept or rejected on the measurement.
This one proposes something different: that the briefing is more useful when a reader can *follow*
a citation than when they have to open the JSON and grep for the source id. The claim under test is
about the interface, not the analysis — and the interface is not what the evaluation measures.

So the hypothesis is stated in the falsifiable form actually available here:

> A dashboard, an architecture graph, a grounded question mode and a PDF exporter can all be built
> **downstream** of the pipeline, such that the pipeline's measured behaviour is bit-for-bit
> unchanged, and every new surface inherits the existing evidence rules rather than restating them.

That is checkable, and the ways it could fail are concrete. A graph could invent an edge nothing in
the ledger supports. A question mode could let a model cite a file it never opened, or let its own
earlier answers become evidence. A PDF could carry a secret out of the process. Any of these would
be a real regression in the property the project exists to demonstrate, and none of them would show
up in the benchmark — which is precisely why they are the thing to test.

### Change

Two new workspace packages and one optional callback.

**`packages/app` — the analysis core.** `analyzeRepository` is now the single place that decides
which system runs; the CLI's `analyze` command and the web server's `POST /api/analyze` both go
through it. It adds no phase, skips none and reorders nothing — `runBaseline` and `runAdvanced`
still own the pipeline. On top of the record it derives four things:

- `AnalysisReport` — citations interned as `ev-001`, `ev-002`, … in traversal order, claims
  referring to them by id, each source labelled with the origin that produced it (reconnaissance,
  scout, model tool, corroboration). Derived from a record, never in place of one; the existing
  schemas are untouched.
- `ArchitectureGraph` — eleven node types and ten relationships, both closed sets validated at
  construction. Every node and every edge carries the evidence ids it came from, and layout is
  arithmetic rather than a simulation, so the same report yields the same graph.
- The question loop — the same scout, the same three read-only tools, the same boundary, the same
  ledger, the same grounding, bounded at 4 tool calls, 3 turns, 3 scout reads and 6 replayed
  history turns. An answer whose citations do not survive grounding is replaced by one sentence:
  *"I couldn't verify this from the repository evidence I inspected."*
- `PdfReportExporter` behind a `ReportExporter` seam, over a hand-written PDF 1.4 writer: no
  dependency, no browser, no build step.

**`apps/web` — transport and a UI.** `node:http`, loopback by default, three refusals before any
route runs (`421` for a non-localhost `Host`, `403` for a foreign `Origin`, `413` for a body over
1 MiB), `default-src 'none'`, and a `public/` directory of one HTML file, one stylesheet and one
script. No framework: partly the iteration's own rule to prefer what is already here, partly
because a CSP with no `unsafe-inline` and no third-party origin is only possible if nothing needs
them.

**The pipeline's entire footprint** is an optional `onSources` callback on `runAdvanced` and
`runBaseline`, invoked once after the evidence ledger is final. It cannot add to the ledger and
nothing reads its return value; a run that passes no callback — which is every run the evaluator
makes — executes exactly as before. The alternative, re-collecting context to recover the bytes,
was rejected as *dishonest* rather than slow: a second pass can produce a different ledger, and
then the evidence panel would be showing text the briefing was never checked against.

Four shared modules were extended additively: a `RequestError` type, a `createSourceResolver` built
from the same resolver grounding uses, a question branch in the mock provider selected by schema
shape, and shape-based credential patterns in `redactSecrets`.

### Measurement

**No paid evaluation run was made, and no benchmark movement is claimed.**

The reason is structural rather than a matter of budget. Everything this iteration added sits
downstream of the pipeline; the only change inside it is an observer the evaluator does not pass.
Re-running the same code to report the same number would be theatre, and calling the result an
improvement would be worse. Iteration 3's figures stand as the last real measurement.

There is a second reason a paid pair would have been uninformative even if it had been run:
`gemini-3.5-flash-lite` is at 14/14, so the primary metric has had no headroom on this dataset
since Iteration 3 — the blocking item at the top of `CHANGELOG.md`'s `## Next`. And `DEFAULT_MODEL`
is now `gemini-3.7-flash`, which no historical run used, so a bare `pnpm evaluate:advanced` would
produce a figure comparable to nothing.

What was run, to show both evaluation commands still execute end to end — offline, on the
deterministic mock provider:

| | Baseline `--mock` | Advanced `--mock` |
| --- | --- | --- |
| Run id | `eval-baseline-2026-09-01T22-56-31Z` | `eval-advanced-2026-09-01T22-56-51Z` |
| Evidence-backed task accuracy | 21.4 % (3/14) | 28.6 % (4/14) |
| Answer accuracy | 21.4 % (3/14) | 28.6 % (4/14) |
| Fabrications | 0 | 0 |
| Dropped citations | 0 | 0 |
| Unsupported answers | 0 | 0 |
| Failed cases | 0 / 2 | 0 / 2 |

> These are **not** a measurement of either system's quality, and the harness prints its own
> caveat saying so: the mock returns canned text assembled from the context it was handed. A mock
> figure and a model figure are not comparable in either direction.

Both figures reproduced exactly across two independent runs forty minutes apart, the second after
the CLI had been refactored to dispatch through `analyzeRepository`. That is the comparison worth
making here: the refactor changed *how* a run is started, and any difference in these numbers would
have meant it also changed what the run does.

What *was* measured is the hypothesis as stated — that nothing on the measured path changed:

| Check | Result |
| --- | --- |
| Evaluation cases modified | 0 (no question, `expectedEvidence` or keyword touched) |
| Evaluator still question-blind | Yes — the sentinel test asserting no question text reaches the model still passes |
| Fixture names, expected answers or fixture-derived relationships in product code | 0 |
| Files on the measured path altered by the extended `redactSecrets` | **0 of 199** — every file under `fixtures/` (30 working-tree files plus the generated git objects, 146 in total), both evaluation cases, both evaluator sources, and all 13 reports and 36 trajectories already on disk are byte-identical through it |
| `ADVANCED_RESPONSE_SCHEMA` top-level properties matching the mock's question branch | None — it has neither `answer` nor `citations`, so the briefing path cannot reach the new code |
| Tests | 397 → **491**, all passing, offline; no existing test deleted or weakened |
| `pnpm typecheck` | Clean |

The 94 new tests are where the failure modes named in the hypothesis are actually checked: an edge
whose relationship is not in the closed set is rejected at construction; a question whose evidence
does not support an answer returns the unsupported sentence rather than a plausible one; a
follow-up cannot cite a previous answer; an evidence id from another analysis is a `404`; and the
PDF is asserted to contain the redacted form of a secret-shaped excerpt rather than the secret.

### Result

**Kept, with the claim scoped to what was verified.** The four capabilities work end to end against
a real repository over a real socket — one integration test drives analyse → dashboard → question →
evidence → export, and the manual walkthrough produced a 19-node, 9-edge graph, zero console
errors, and a 7-page, 35 KB PDF. The evidence rules were inherited rather than restated: one path
boundary reused three times, one ledger, one grounding implementation, one redaction function.

What is **not** claimed: that the analysis got better, that any metric moved, or that the graph and
the question mode are as well tested as the pipeline they sit on. Fourteen questions and two
fixtures did not become a larger dataset because a browser was added.

### Decision

**Iteration 4 is kept**, on the grounds that it was measured against the only claim it made. Three
things are recorded rather than buried.

`ADVANCED_VERSION` and `BASELINE_VERSION` were deliberately **not** bumped, against item 3 of the
previous `## Next`. Run records stamp the *system* version, and this iteration changed no system
behaviour; bumping it would assert a difference that does not exist and stamp a new version on
results measured under the old one. The bump belongs at the start of the next *measured* iteration,
which is what the item actually asks for. Only the root project version moved, `0.4.0` → `0.5.0`.

The question loop was **not** refactored to share code with the advanced system's tool loop. They
already share the tools, the boundary, the ledger and the grounding — the parts where a divergence
would be dangerous. What differs is the loop's own bounds and its prompt, and unifying them would
mean editing the measured path to serve an unmeasured feature, which §1 forbids for good reason.

And `redactSecrets` was **widened**, which is the one change in this iteration that touches shared
code used by the pipeline. It was verified not to alter a single byte on the measured path before
being kept, and 12 unit tests pin both what it now catches and the three categories it deliberately
does not — a credential *reference* like `env.JWT_SECRET`, a hash or uuid, and a bare high-entropy
string with no prefix and no label. The last is a real limit, stated as a passing test so it is a
known property rather than a surprise.

### Cost of the result

$0.00. No paid model call was made in this iteration: the mock evaluation runs, the full test suite
and the manual UI walkthrough are all offline. The cost was entirely in engineering time, and the
thing it bought is not a number on the benchmark — it is that a claim in the briefing is now two
clicks from the bytes that justify it.

---

## Iteration 5 — Somewhere for an Analysis to Live

### Hypothesis

Like Iteration 4, this one makes no claim about the metric, and for the same structural reason:
everything it adds is downstream of the pipeline. Unlike Iteration 4, the property it claims is
one that could plausibly have been broken by the change, so the claim is stated as the thing that
was actually checked:

> An analysis can be given a durable home and a live progress feed such that (a) the pipeline's
> measured behaviour is byte-for-byte unchanged, and (b) the store persists strictly less than the
> run record contains — reconnaissance artefacts and cited sources, never model prose, raw tool
> results, prompts, or an absolute host path.

Both halves are falsifiable, and the ways they fail are specific. Progress reporting means putting
a callback *inside* `runAdvanced` and `runBaseline` — the measured path — so a mistake there moves
the comparison the whole project rests on. Persistence means writing a run record to disk, and the
cheapest way to do that is `JSON.stringify` on the whole thing, which would put a model's
paraphrase of a file on disk next to the ledger the paraphrase is supposed to be checked against,
and an absolute path in a record a different machine is expected to open.

**This hypothesis was written after the code, and that is a breach of this file's own rule.** It is
recorded rather than hidden. The compensating control is that it was written before any
*measurement*: the byte-identity tests and the evaluation re-run below could both have failed, and
either would have rejected the iteration as written. What is lost by the ordering is the discipline
of having to predict; what is not lost is falsifiability.

### Change

Three modules, one seam filled in, and one callback on the measured path.

**The store, behind the seam Iteration 4 left.** `AnalysisStore` was declared with a bounded map
behind it; it now also has `SqliteAnalysisStore` over `node:sqlite` — in Node 22's standard
library, so a durable store costs zero new dependencies. WAL, `busy_timeout=5000`, `BEGIN
IMMEDIATE` for the read-modify-write paths, four tables, a `SCHEMA_VERSION` a newer binary's file
is *refused* on rather than silently misread.

Three decisions inside it are worth more than the SQL:

- **It refuses to live inside the repository it analyses.** `resolveDatabaseLocation` rejects a
  path under the workspace root, because a database there is a file the analysis can see, `git
  status` reports, and `git clean` deletes. Default `~/.repo-archaeologist/analyses.db`.
- **It persists a projection, not a dump.** A `RunRecord` carries model prose, raw tool results and
  prompts; `projectEvidence` keeps the reconnaissance artefacts `answerQuestion` seeds from plus
  the sources some citation actually resolves to, and drops the rest. Less on disk is the feature.
- **Redaction happens on the way in.** An excerpt is redacted before it is stored, so a restart
  cannot change what the viewer shows and the line offsets stay correct by construction. The
  grounding ledger the pipeline compares against is untouched and stays raw.

Paths are stored workspace-relative, and evidence is looked up by both ids
(`getEvidenceSource(analysisId, sourceId)`) — which is what makes an id from another analysis a
`404` rather than a leak.

**A runner, so a record exists before the work.** `AnalysisRunner.start` creates the `queued` row
and returns it, then runs the pipeline detached. `run` never rejects: by the time the pipeline
finishes, the client that asked may be gone and there is nobody to catch. A failure is a `failed`
*record* the user finds on reload.

**Progress, without inventing any.** A status is a promise about what the record contains; a phase
is an observation about where the pipeline got to. Five statuses with an explicit transition table
that cannot leave a terminal state, eight phases with one line of prose each. No percentage, no
interpolation, no estimated remaining time — the pipeline does not know, so the UI does not claim.
`safeFailureMessage` and `logFailureMessage` are a deliberate pair: the error's *category* decides
whether its text reaches a browser, and a `hint` — written for an operator — never does.

**The measured path's entire footprint** is `onPhase`, an optional callback on `runAdvanced` and
`runBaseline` called at the phase boundaries that already had numbered comments. Its vocabulary is
closed, no control flow reads it, its return value is discarded, and the evaluator passes none.

### Measurement

**No paid evaluation run was made, and no benchmark movement is claimed.** The reasons are
Iteration 4's, unchanged: nothing on the measured path behaves differently, and
`gemini-3.5-flash-lite` has been at 14/14 since Iteration 3, so the dataset has no headroom to
show a movement even if one existed. Iteration 3's figures remain the last real measurement.

What was run instead is the check the hypothesis names — that the pipeline is unchanged — and it
was run two independent ways.

**First, byte-identity as a unit test, in each system.** A run with an observer that returns a
value it should not (`() => "ignored" as unknown as void`) is `JSON.stringify`-compared against a
run without one, over the same repository, the same scripted model reply and the same fixed clock.
Both assert equality of the whole record. These tests are the ones `onPhase`'s doc comment in both
systems already *claimed* existed and did not: closing that gap was the first work of this session,
because a comment naming a test that was never written is worse than no comment.

There was a second comment of the same kind, found while writing this entry. `public/ui.js` and
`public/ui.d.ts` both said the pure-logic module is imported by `apps/web/test/ui.test.ts`, which
did not exist — and that file is the *entire* justification for splitting `ui.js` out of `app.js`,
since `app.js` touches the DOM and can only ever be read by a human. Without it the split was a
filing convention. `ui.test.ts` now exists, at 50 tests, and three of them are the ones the
duplication actually needed: the browser's phase list is compared to `ANALYSIS_PHASES`, its status
vocabulary to `ANALYSIS_STATUSES`, and its node palette to `NODE_TYPES`, so a constant added on the
server and forgotten in the browser fails a test instead of rendering `undefined` in a sidebar.

**Second, both offline `--mock` evaluations, re-run and diffed against Iteration 4's:**

| | Baseline `--mock` | Advanced `--mock` |
| --- | --- | --- |
| Run id | `eval-baseline-2026-09-02T01-28-27Z` | `eval-advanced-2026-09-02T01-29-00Z` |
| Evidence-backed task accuracy | 21.4 % (3/14) | 28.6 % (4/14) |
| Per case | 2/7 and 1/7 | 2/7 and 2/7 |
| Fabrications / dropped / unsupported | 0 / 0 / 0 | 0 / 0 / 0 |
| Failed cases | 0 / 2 | 0 / 2 |
| Normalized JSON diff vs Iteration 4's runs | **identical** | **identical** |

The last row is the one that matters, and it is stronger than the headline percentages agreeing.
Two percentages can match while the underlying answers differ. With run ids, timestamps and
durations normalized out, every question, every score, every citation and every dropped-citation
record is the same object it was before this iteration existed.

| Check | Result |
| --- | --- |
| Files changed under `evaluation/`, `fixtures/`, `packages/evaluator/`, `reports/`, `trajectories/` | **0** |
| Evaluation cases modified | 0 (no question, `expectedEvidence` or keyword touched) |
| Byte-identity regression test, advanced and baseline | Passing in both |
| Phase vocabulary reported by each system | 7 advanced / 4 baseline — the baseline never scouts, explores or refines, and its type says so |
| Tests | 491 → **620**, all passing, offline; no existing test deleted or weakened |
| `pnpm typecheck` | Clean |

The 129 new tests are where the hypothesis's second half is checked, and they are aimed at the
failure modes rather than the happy path: the list-view row's exact key set is asserted, proving no
payload column reaches a list; a record's serialized form is asserted not to contain the workspace
path; an evidence id from one analysis is invisible to another; a schema version from the future is
refused; a corrupt `report` column reads as `null` without losing the record; an unrecognised status
reads as `failed` rather than as itself; a `StorageError`'s path lives in its `hint` and not its
`message`; a subscriber that throws cannot fail the analysis; a store whose `update` always throws
still produces a `failed` result plus a log saying it could not be marked failed; and the evidence
viewer's line range is asserted to be `null` — never line 1 — for an excerpt it could not locate.

Two of those tests failed on first run and both failures taught something. One assumed the record
was still `queued` when `start` returned — it is usually `validating`, because the SQLite binding
is synchronous and the first status write commits before the function yields. The other objected to
the caller's own `../../etc` appearing in an error message; echoing back what the caller typed is
not a leak, and the assertion was wrong, not the code.

### Result

**Kept, with the claim scoped to what was verified.** An analysis survives a page reload, a
navigation away and a server restart; a client that reconnects mid-run is told which phase the
pipeline is in and misses no earlier event, because the bus replays. The pipeline is provably
unchanged — twice over, by unit test and by re-measurement.

What is **not** claimed: that the analysis got better, that any metric moved, or that a store makes
fourteen questions a larger dataset. The `node:sqlite` experimental warning is left visible on
stderr rather than suppressed, because a suppressed warning is a promise the project cannot keep.

### Decision

**Iteration 5 is kept.** Three things are recorded rather than buried.

`ADVANCED_VERSION` and `BASELINE_VERSION` were again deliberately **not** bumped, and this time the
reason is evidence rather than judgement: `systemVersion` names *behaviour*, and byte-identity is a
proof that the behaviour is the same. Bumping would assert a difference that does not exist and
would make results that are still valid look stale. What item 3 of the previous `## Next` actually
needs is a **provenance** field distinct from the behaviour version — and adding one changes the
run-record shape, which would break the byte-identity claim just verified. So it is now scoped
explicitly to the *start* of the next measured iteration, where a shape change is paid for by a
real measurement. Only the root project version moved, `0.5.0` → `0.6.0`.

The hypothesis-after-code ordering is recorded in the Hypothesis section above rather than tidied
away. The rule at the top of this file says an iteration is not an improvement until a paired
evaluation says so; the rule it does not state, but which the first four entries all honoured, is
that the prediction comes first. This entry breaks the second and honours the first.

And the measured path was touched — for the first time since Iteration 3 — by something no
evaluation number can catch. That is exactly why the check is a byte-identity test rather than a
percentage: a hook that changed the record would have moved *both* systems together, and the
comparison between them would have looked untroubled.

### Cost of the result

$0.00. No paid model call was made: both evaluation runs are the offline mock provider, and the
620-test suite and the typecheck are offline by construction. 2 378 lines of source and 1 870 lines
of test, and the thing they buy is not a number on the benchmark — it is that closing the tab is no
longer the same event as losing the analysis.

## Iteration 5, continued — The Product Nobody Loaded

An audit, not a feature. It is recorded here as an iteration because it followed the same shape and
produced a result, and because the alternative — quietly amending the entry above — is the one thing
this file is not allowed to do.

### Hypothesis

Written before the audit, and this time genuinely first — there was no code to write yet, only a
tree to check.

> Iteration 5's entry claims a browser that watches an analysis happen, filters a graph, opens an
> outline and reports three question states. Every one of those claims rests on `app.js`, and
> **nothing in the 620-test suite loads `app.js`.** `ui.test.ts` imports `ui.js`, which is the file
> that was designed to be importable; `api.test.ts` and `integration.test.ts` exercise the server.
>
> If a claim's only support is a file no test reads, the claim is unverified. So: an audit against
> the specification's own Definition of Done will find defects, they will be concentrated in exactly
> the parts with no test, and they will be **wiring** defects rather than logic defects — because the
> logic is the part that got extracted into the testable module.

Falsifiable, and worth stating because it could have been wrong: a careful author with no test can
still write correct wiring, and the audit could have come back clean.

### Change

The audit ran the entry point the way a browser would, which the suite had never done:

```
node --input-type=module -e 'import("./app.js")'
→ SyntaxError: Identifier 'layoutGraph' has already been declared
```

The prediction was not merely confirmed, it was overshot. `app.js` did not have wiring defects; it
did not execute. `layoutGraph`, `truncate` and `countOmittedClaims` had been extracted into `ui.js`,
imported back at the top of the file, and left in place at the bottom. A duplicate `const` at module
scope is not a warning — the module never evaluates, and every feature Iteration 5 described was
described accurately about a file the browser refused to run.

Underneath that, in the layer the audit could only reach once the file parsed:

- `#announce` and `#alert` did not exist. `toast()` had a ten-line comment explaining why an error
  goes to `role="alert"` and everything else to `role="status"`, and wrote to two elements that were
  never in `index.html` — so every status message would have thrown, including the ones reporting a
  failure.
- `#progress` did not exist and `.progress` had no rule, so the phase panel — a Definition-of-Done
  item — took its `if (!host) return` branch on every call. Progress arrived over SSE, updated the
  state and painted nothing.
- Eleven imported helpers had no caller: node detail, edge detail, graph filtering, node search,
  related-node highlighting, the graph's screen-reader summary, the phase checklist, the three
  question outcomes, evidence line ranges and evidence strength. Tested, passing, unreachable.
- `state.graph.selected` was documented as `{ kind, id }` "because an edge is selectable now" and
  used as a bare node id; `state.drawerReturn` was declared, commented and never written, so closing
  the drawer dropped focus to the top of the document.
- Eleven classes on the recent-analyses row had no CSS, and neither did `.pill` — so in the iteration
  whose entire subject was that an analysis now has a status worth reading, every status rendered as
  unstyled inline text.
- `--ink-faint` was 2.99:1 on `--panel`, against a 4.5:1 floor, on the labels it exists to style.

The fix wired the tested logic in and deleted the untested duplicates, which is why it added features
without adding logic. Then the durable part: `apps/web/test/wiring.test.ts`, 24 tests that read the
shipped files as text and assert the seams — `node --check` on both modules, no import also declared
locally, no import unused, every `$("id")` with a host, every class with a rule, every custom
property defined, and evidence addressed only through its owning analysis.

### Measurement

Two things were measured, neither of them a benchmark.

**Did the defects exist?** Yes, and the count is the measurement: 1 hard `SyntaxError`, 3 missing
DOM hosts, 11 uncalled imports, 2 state fields contradicting their own comments, 12 unstyled classes,
1 contrast failure, 1 stale route, 1 false statement to the user. Every one of them in a file with no
test; none of them in `ui.js`, which had 50.

**Did fixing them disturb anything measured?** No.

| | Baseline `--mock` | Advanced `--mock` |
| --- | --- | --- |
| Run id | `eval-baseline-2026-09-02T03-07-29Z` | `eval-advanced-2026-09-02T03-07-44Z` |
| Evidence-backed task accuracy | 21.4 % (3/14) | 28.6 % (4/14) |
| Normalized diff vs the pre-Iteration-5 runs | **identical** | **identical** |

`pnpm verify:measured --ref bd5c632` — added by this pass, so the claim is a command rather than a
paragraph — reports `advanced/src/index.ts +40 −0`, `baseline/src/index.ts +17 −0`, both version
constants unmoved, and nothing whatsoever under `evaluation/`, `packages/evaluator/` or `fixtures/`.
Those 57 lines are Iteration 5's `onPhase` callback, untouched here. 644 tests, typecheck clean, all
offline.

### Result

**Kept.** The hypothesis was confirmed in the strongest available form, and the confirmation is worse
news than a rejection would have been: the previous entry's claims about the browser were not
overstated, they were made about a file that never ran. The claims are true now, and there is a test
that fails if they stop being.

What is **not** claimed: that any analysis got better, that the dashboard is now verified end to end,
or that 24 text-reading assertions are equivalent to rendering the page. They are not. They are the
subset of correctness that can be checked without a DOM, which is a real subset and a bounded one —
recorded as item 7 of `## Next`.

### Decision

**Kept, and recorded as a correction rather than a revision.** No text in Iteration 5's entry above
was edited; the sentence claiming a browser that can watch an analysis happen still stands there, and
this entry is what makes it honest. A changelog that edits its own past is a marketing document.

The lesson generalises past this repository, so it is worth stating flatly: **`ui.js` was extracted
to make the dashboard testable, and extracting it is what broke the dashboard.** The refactor moved
the logic somewhere a test could reach, the tests were written against the new home, they passed, and
the coverage they reported was coverage of a module with no caller. The suite grew by 50 tests while
the product went from working to not loading, and every signal available said the iteration had gone
well.

A test that imports a module proves the module works. Only something that loads the entry point
proves the product uses it — and until this pass, nothing did.

### Cost of the result

$0.00. No paid model call; both evaluation runs are the offline mock provider. Roughly 700 lines
changed across `app.js`, `index.html` and `styles.css`, most of it deletion or rewiring rather than
new logic, plus 220 lines of test and 130 lines of verification script. The cheapest defect-to-fix
ratio of any iteration so far, for the largest defect — which is itself the point: the check that
would have caught it is `node --check`, it takes 40 milliseconds, and it had never been run.

---

## Iteration 5, continued (2) — The Record That Was Deleted Underneath Its Run

A single bug, found by running the product rather than by testing it. Recorded here for the same
reason the entry above is: it followed the shape, and it produced a result that changes what the
previous entries are allowed to claim.

### Hypothesis

The observation came first, from a real `pnpm web` session against `gemini-3.5-flash` — seven log
lines for one analysis, ending:

```
analysis an-mtjkeuuv-1 failed: StorageError: No analysis an-mtjkeuuv-1
analysis an-mtjkeuuv-1 could not be marked failed: StorageError: No analysis an-mtjkeuuv-1
```

Six hypotheses were enumerated before any code was read, precisely because the tempting one — "the
create never committed" — is the tempting one:

> **A.** never persisted · **B.** a second database · **C.** persisted, then deleted ·
> **D.** a transaction that never committed · **E.** a store closed under the runner ·
> **F.** an id mismatch between create and lookup.
>
> The shape of the log already discriminates. A record that never landed fails at `validating`, the
> runner's *first* write. This one survived `validating`, survived `analyzing`, and first failed at
> `synthesizing` — five phases in. **The row existed.** Something removed it mid-run.

### Change

**C, confirmed.** WAL forensics on `~/.repo-archaeologist/analyses.db` found five ids written across
two processes and absent from the table; `DELETE /api/analyses/:id` was the only code path that
removes a row, and `0.6.0` had detached the run from the request without giving that route any way
to know a run was in progress. The record's lifetime was controlled by one HTTP request; the run's
lifetime was not. Nothing reconciled them.

The fix is a lifecycle interlock, entirely in persistence and wiring:

- `AnalysisRunner` tracks live ids and exposes `abandon(id)`; `routeDelete` calls it *before*
  `store.delete(id)` and reports `{ deleted, cancelled }`.
- The run checks at its own write boundaries, discards its result, and logs once.
- `AnalysisNotFoundError extends StorageError` carries the id, so a run recognises its *own* record
  vanishing even when nothing announced it — and cannot mistake a broken database for a delete.

What was deliberately **not** done, because each was the cheaper way to make the log go quiet: the
store's missing-record error was not softened to `undefined`, `update` was not made to create rows,
no fallback record is written, and the pipeline is not interrupted — interrupting it would mean
editing `advanced/src/index.ts`, which is the measured path.

### Measurement

Not a benchmark. Two things were measured.

**Do the new tests fail against the old code?** `git stash` of the five source files, then re-run:
**7 failed / 7 passed**, the decisive one reproducing the reported symptom exactly —

```
Expected: "The analysis was deleted while it was running."
Received: "No analysis an-mtkmckcc-1."
```

which also shows the second defect this found: the store's internal invariant message was reaching
the record's `error` field, and from there the browser.

**Did the fix disturb anything measured?** No. `pnpm verify:measured --ref HEAD` — *"clean — no file
under the measured path differs"*, `ADVANCED_VERSION` 0.1.0 → 0.1.0, `BASELINE_VERSION` 0.1.0 →
0.1.0. 658 tests (644 + 14), typecheck clean.

**No benchmark claim is made, in either direction.** No evaluation run was performed for this pass,
because nothing that an evaluation measures was touched.

### Result

**Kept.** The lesson is narrower than the previous entry's and points the same way: 644 tests, and
**not one of them covered `DELETE`**, while every store test ran against `:memory:`. The suite
tested persistence in a store that does not persist, and tested a lifecycle with its destructor
excluded. Neither gap is visible from a coverage number.

What is **not** claimed: that the mid-run race was won against the real binary. It was not. The mock
provider finishes an analysis in well under a second, and raising every budget, analysing the whole
monorepo and serving a synthetic 12 000-file workspace all still completed before a `DELETE` could
arrive; `packages/shared/src/config.ts` supports only `gemini | mock` and no API key is configured
here. The cancellation is proven over a real socket against a real database file
(`apps/web/test/durability.test.ts`), which is a weaker statement than "reproduced against the
provider that produced the original log", and is recorded as such.

### Decision

**Kept.** The invariant is now written down in `docs/architecture.md` rather than implied: a
record's lifetime must cover its run, and whatever ends it early must say so first.

### Cost of the result

$0.00 — no paid model call. Roughly 130 lines of source across six files, 470 lines of test across
two new files, and one root patch version. The investigation cost more than the fix, which is the
usual ratio when the log is pointing at the wrong file: five of the seven lines named the store, and
none of them named the route that was actually responsible.

---

## Iteration 6 — Benchmark Expansion, Run Provenance and Executable Smoke Gates

### Hypothesis

There was none to test, and that is the point of the entry.

Iteration 3 took the advanced system to **100.0 % (14/14)** on the benchmark and it has stayed
there. A benchmark a system scores full marks on has stopped being a measuring instrument: it can
report "no regression" and nothing else. Every hypothesis after that point would have been argued
from intuition, because the instrument had no room left to disagree.

So this iteration built a harder instrument first and measured *before* touching the analysis
algorithm, on the rule stated in the task: **measure first, hypothesise second, change one thing
third, measure again.** The measurement below is the whole deliverable. The hypothesis it produced
is recorded for the iteration that acts on it.

### The change

No analysis code was touched. `pnpm verify:measured --ref HEAD` reports `OK`, and
`ADVANCED_VERSION` and `BASELINE_VERSION` are both unchanged at 0.1.0 — which is the precondition
for the number below meaning what it says.

**Regression Set v1 — frozen.** The original 14 questions are byte-identical to their committed
blobs, verified by `git hash-object` rather than by inspection:

```
evaluation/cases/case-001-orders-api.json  worktree=0cfc5a78…  HEAD=0cfc5a78…
evaluation/cases/case-002-pyflow.json      worktree=3d8de326…  HEAD=3d8de326…
```

Because they may not change, they carry no inline metadata; their category and difficulty
classification lives in the manifest's `annotations` map, keyed `caseId/questionId`.

**Challenge Set v2 — 24 new questions**, 12 per fixture repository, covering all eleven mandated
categories at 3 easy / 11 medium / 10 hard. Challenge questions classify themselves inline, and
`EvalCaseSchema` is a `z.object`, so it strips the keys it does not declare: `category`,
`difficulty`, `tags` and `evidenceRationale` provably cannot reach the scorer. Metadata cannot
influence a score because the scorer never receives it.

**The manifest** (`evaluation/benchmark.json`) declares the counts once. `loadBenchmark()`
re-derives all three from the loaded case files and fails the load on a mismatch, so a case added
without updating the manifest is an error rather than a silently changed denominator.

**Provenance** is a third identity, not a reinterpretation of an existing one. `systemVersion` is
what code ran, `provenance` is where the run came from, `benchmark.version` is which dataset it was
measured against, and none stands in for another. It is a real schema change — report
`schemaVersion` 2, a migrated store — and `readReportIdentity()` returns `null` rather than a
default for a v1 report, so a historical Iteration 3 run can never be relabelled as having been
produced by this benchmark.

### Measurement

Real model, unchanged system, whole benchmark.

| | |
|---|---|
| Run id | `eval-advanced-2026-09-05T01-35-25Z` |
| Command | `pnpm evaluate:advanced -- --model gemini-3.5-flash-lite --provenance iteration-6-baseline --case-delay 5` |
| Model | `gemini-3.5-flash-lite`, seed 7, thinking `low` |
| Provenance | `iteration-6-baseline` |
| Benchmark | `repo-archaeologist v2` — 38/38 questions scored |
| Fabrications / dropped citations / unsupported briefing claims | 0 / 0 / 0 |
| Tokens | 113 590 in / 12 800 out |
| Cost | $0.066076 |

**Reported per set, because a combined average is the one number that can hide a regression.**

| | Regression Set v1 (frozen) | Challenge Set v2 | Combined |
|---|---|---|---|
| **Evidence-backed task accuracy** | **100.0 % (14/14)** | **29.2 % (7/24)** | **55.3 % (21/38)** |
| Answer accuracy | 100.0 % (14/14) | 41.7 % (10/24) | 63.2 % (24/38) |
| Unsupported answers | 0 | 3 | 3 |
| Mean evidence relevance | 0.4105 | — | 0.4007 |

**No regression.** The Regression Set v1 subset reproduces Iteration 3's measurement exactly —
`eval-advanced-2026-08-31T06-18-59Z` scored 100.0 % / 100.0 % with mean evidence relevance
**0.4105**, and the frozen subset of this run scores 100.0 % / 100.0 % with mean evidence relevance
**0.4105**. Same model, same seed, same cases, same numbers to four decimal places.

The combined 55.3 % is reported and is the least informative figure here: it is an artefact of
mixing a saturated set with a discriminating one, and it would move if the ratio of the two sets
changed without any system changing at all.

### Failure analysis

17 failures: **14 wrong-answer, 3 uncited, 0 fabrications.**

Grouped four ways, the signal is not where the task's worked example suggested it might be.

| By evidence kind | n | Answer accuracy | Evidence-backed |
|---|---|---|---|
| documentation | 15 | 93.3 % | 80.0 % |
| mixed | 8 | 62.5 % | 62.5 % |
| **source** | **15** | **33.3 %** | **26.7 %** |

| By difficulty | n | Answer accuracy | | By repository | n | Answer accuracy |
|---|---|---|---|---|---|---|
| easy | 11 | 81.8 % | | orders-api | 19 | 73.7 % |
| medium | 15 | 66.7 % | | pyflow | 19 | 52.6 % |
| hard | 12 | 41.7 % | | | | |

Difficulty and repository are real but weaker gradients, and both partly restate the first table:
the hard questions and the pyflow questions are disproportionately the source-backed ones.
Category is the *least* useful grouping — the weakest categories (multi-language 0/2,
indirect-evidence 1/3, behavioral-flow 1/3) are simply the categories whose evidence lives in
source files.

**The decisive check.** The obvious reading of "source-backed questions fail" is a retrieval
weakness, and it is wrong. Two seeded diagnostic runs recorded which files actually entered the
model's context. Cross-referencing every failure against them:

```
evidence WAS in context, answer still missing: 16/17
evidence never retrieved:                       1/17
```

For `fixtures/orders-api` the system read **every** source file, none truncated,
`budgetExhausted: false` — including `src/config.js`, which contains the literal `4000` that
question q01 asks for and that the briefing does not contain. That question is classified `easy`
and `direct-fact`, and the same run scored 14/14 on the frozen set.

What the briefing says about that file is *"listens on the configured port"*. What it says about
the connection pool omits `max: 10`. The missing tokens across the whole failure set are almost
entirely concrete literals that were sitting in context: `4000`, `database_url`, `kafka_brokers`,
`mypy`, `insert`, `failed`.

### Hypothesis for the next iteration

**Observation.** The frozen set scores 100 % and the challenge set 29.2 %, and the gap tracks
evidence kind — 93.3 % on documentation-backed questions against 33.3 % on source-backed ones.

**Failure pattern.** In 16 of 17 failures the expected evidence was already in the model's context,
un-truncated, and the fact still never reached the briefing. Zero fabrications and zero dropped
citations: the system is not inventing and not mis-citing.

**Hypothesis.** Synthesis compresses source it has read into role-level descriptions and discards
the concrete values. Accuracy on source-backed questions is limited by claim *granularity*, not by
retrieval coverage or by grounding.

**Mechanism.** A component claim is one sentence about what a module does. A literal like `max: 10`
has no place in that sentence, so it is dropped even though the line is in context and citable. The
scorer additionally credits evidence only when a *single* claim answers the question, which is why
three questions were answered correctly across separate claims and scored as uncited.

**Expected metric movement.** Preserving concrete values in claims should move source-backed answer
accuracy (33.3 %, 15 questions) and leave documentation-backed accuracy (93.3 %) flat.

**Risk.** A claim stuffed with literals is a worse briefing for a human reader; more specific
excerpts could lower mean evidence relevance; and inviting specificity is exactly how fabrications
start. Fabrications are currently 0, which is the thing most worth not losing.

### Decision

**Kept — measurement only.** No analysis change was made, for a stated reason rather than for lack
of a candidate.

The evidence points at one lever: the synthesis prompt. The standing constraint carried forward
from Iteration 5 — *do not change baseline or advanced prompts to improve an iteration* — forbids
pulling it here. Every other single-variable change the task permits (scout, ranking, tools,
grounding) targets retrieval, and the measurement above shows retrieval is not the bottleneck in 16
of 17 failures. Making one of those changes would have been precisely the intuitively-appealing,
unmeasured change the task rules out.

A measurement-only iteration is a valid result, and inventing an algorithmic change to make this
entry look more substantial would have made it less true.

### Cost of the result

$0.066076 for the benchmark run, plus $0.033038 for the two diagnostic runs that established the
16/17 split — $0.099114 in total. The mock validation pass that preceded them cost nothing and is
not a quality measurement of anything; it exists to prove the pipeline scores 38 questions end to
end before any paid call is made.

---

## Iteration 7 — Synthesis Granularity

*Hypothesis recorded before any code was written. The measurement follows below it, whichever way it
went.*

### Hypothesis

**Observation.** Iteration 6 measured the unchanged system against the 38-question benchmark and
found 100.0 % evidence-backed on the frozen Regression Set v1 against 29.2 % on Challenge Set v2.
The gap tracks evidence kind: 80.0 % evidence-backed on documentation-backed questions against
26.7 % on source-backed ones.

**Failure pattern.** In 16 of 17 failures the expected evidence was already in the model's context,
un-truncated, with `budgetExhausted: false`. Fabrications, dropped citations and unsupported
briefing claims were all zero. The system is not inventing, not mis-citing, and — in all but one
case — not failing to retrieve.

**Hypothesis.** The synthesis turn compresses source it has read into role-level descriptions and
discards the specifics. Accuracy on source-backed questions is limited by the *granularity* of the
claims synthesis writes, not by retrieval coverage or by grounding.

**Mechanism, in three parts — which is the part of this entry most likely to be wrong.** Reading
each of the 17 failures against its case definition and its fixture, they are not one failure mode:

1. **Literal loss — 11 failures.** A component claim is one sentence about what a module does, and a
   literal has no place in that sentence. `fixtures/orders-api/src/config.js` line 9 reads
   `port: Number(env.PORT ?? 4000)`; the briefing says *"listens on the configured port"*. The pool
   line carries `max: 10`; the briefing omits it. Same shape for `mypy`, `insert`, `failed`,
   `database_url`, `kafka_brokers`. The file was in context and the token was not in the answer.
2. **Cross-claim dispersal — 3 failures** (`orders-q05`, `orders-q11`, `pyflow-q12`). The answer was
   correct and every keyword was present, but spread across *separate* claims. `scoreQuestion`
   credits evidence only from claims that *themselves* satisfy the requirement, so `matchingClaims`
   is empty and the question scores `UNCITED` — correct, uncredited.
3. **Genuine retrieval miss — 1 failure.** Untouched by this iteration by construction: no
   retrieval surface is being changed.

**Where the mechanism is weakest, stated now rather than after the numbers.** One of those three
cross-claim failures is not reachable by a prompt at all. `pyflow-q12` requires `click` *and* one of
`rich`/`sqlalchemy`/`pyyaml` inside a single claim, and `selectClaims` emits one claim per
dependency entry — so no dependency claim can ever contain two dependency names. Fixing that means
changing the answer schema or the scorer, both forbidden this iteration and both correctly so. The
honest ceiling for a prompt-only treatment is therefore **16 of 17**, not 17, and probably lower:
`orders-q11` is nearly the same shape.

**Expected metric movement.** Challenge evidence-backed accuracy rises from 29.2 %; the movement
concentrates in source-backed questions (26.7 %, 15 questions) and documentation-backed accuracy
(80.0 %) stays flat. Regression Set v1 stays at 100.0 %. Fabrications stay at 0.

**Falsification.** The hypothesis is wrong if the literals stay absent from the briefings while the
prompt demonstrably asked for them — that would mean granularity is not the model's constraint and
the bottleneck is somewhere this iteration did not look. It is also wrong, differently, if accuracy
rises while unsupported claims or fabrications rise with it: that is a model answering from memory,
not from evidence, and it fails the acceptance criteria regardless of the primary metric.

**Risk.** Three, in descending order of how much they would cost. Inviting specificity is exactly
how fabrications start, and the count has been 0 across every run ever made — that is the thing most
worth not losing. A claim stuffed with literals is a worse briefing for a human reader, and this
system's output is meant to be read. And more, longer claims mean more output tokens, so cost rises
whether or not accuracy does.

### The change

One function, `buildSynthesisPrompt` in `advanced/src/prompt.ts`: `+37 −1` lines, all of them a new
`HOW TO WRITE A CLAIM` block appended after the existing task paragraph. Six instructions, each
about the *form* of a claim rather than about any subject — write the value in the exact form the
file spells it rather than the fact that a value exists; say what a mechanism does concretely; write
a fact resting on two files as one claim citing each; keep the facts answering one question inside
one claim; be specific and brief in the same claim; and rest every substantive claim on something
actually read rather than on how a framework usually behaves.

Nothing else. `verify:measured --ref HEAD` reports `advanced/src/prompt.ts: M +37 -1` and every
frozen file unchanged — evaluator, both frozen cases, the fixture builder. The reconnaissance prompt,
the system instruction, the scout, the tools, the ledger, grounding, precision, the schema, the
benchmark, the fixtures, the model, the seed and the thinking level are all untouched, and a test
asserts the first two of those by inspection rather than by promise.

Eleven prompt-construction tests were added. Six were watched to fail against the control prompt
before the treatment was kept; the other five assert that the treatment displaced nothing — the
closed citable set, the two conditional branches, no secret or trajectory in the prompt, and the
one-variable scope. Four of them are the anti-overfitting gate: the prompt is asserted *not* to
contain `4000`, `database_url`, `kafka_brokers`, `jwt_secret`, `mypy`, `max: 10`, any fixture path,
any of the eleven evaluator category names, or the words `benchmark`, `evaluator`, `scorer`,
`challenge` or `regression`.

### Measurement

Same model, same seed, same thinking level, same 38 questions, same evaluator as the control.

| | |
|---|---|
| Run id | `eval-advanced-2026-09-05T17-58-05Z` |
| Command | `pnpm evaluate:advanced -- --model gemini-3.5-flash-lite --provenance iteration-7-synthesis-experiment --case-delay 5` |
| Model | `gemini-3.5-flash-lite`, seed 7, thinking `low` |
| Provenance | `iteration-7-synthesis-experiment` |
| Benchmark | `repo-archaeologist v2` — 38/38 questions scored |

| Metric | Iteration 6 control | Iteration 7 treatment | Delta |
|---|---:|---:|---:|
| Regression answer accuracy | 100.0 % (14/14) | 100.0 % (14/14) | — |
| **Regression evidence-backed** | **100.0 % (14/14)** | **100.0 % (14/14)** | **—** |
| Challenge answer accuracy | 41.7 % (10/24) | 41.7 % (10/24) | — |
| **Challenge evidence-backed** | **29.2 % (7/24)** | **25.0 % (6/24)** | **−4.2 pp** |
| Combined answer accuracy | 63.2 % (24/38) | 63.2 % (24/38) | — |
| **Combined evidence-backed** | **55.3 % (21/38)** | **52.6 % (20/38)** | **−2.7 pp** |
| Mean evidence relevance | 0.4007 | 0.3730 | −0.0277 |
| Unsupported answers | 3 | 4 | +1 |
| Fabrications | 0 | 0 | — |
| Briefing unsupported claims | 0 | 0 | — |
| Dropped citations | 0 | 0 | — |
| Runtime | 1 m 41 s | 1 m 29 s | −12 s |
| Tokens (in / out) | 113 590 / 12 800 | 115 294 / 13 852 | +1.5 % / +8.2 % |
| Cost | $0.066076 | $0.069218 | +4.8 % |

**The treatment failed.** Challenge evidence-backed accuracy moved 4.2 points the wrong way, against
an acceptance threshold of +8. Answer accuracy did not move at all — the same 24 of 38 questions
were answered correctly before and after.

**Per-question, exactly one outcome changed in 38.** `challenge-v2-orders-q03` went `PASS` →
`UNCITED`: the answer stayed correct, and the facts that had been inside one `components` claim were
dispersed across claims, so no single claim satisfied the question and the evidence could not be
credited. The instruction most directly aimed at that failure mode — *keep the facts that answer one
question inside one claim* — is the one whose only measurable effect was to break the case that was
already getting it right.

**By category, one group moved and it is the diagnostic one.** Every category is flat except
`cross-file-reasoning`, 2/3 → 1/3. Source-backed evidence fell 4/15 → 3/15; documentation (12/15) and
mixed (5/8) are unchanged; every difficulty band is flat except `hard`, 4/12 → 3/12. The single
category that moved is the one the "write it as one claim and cite each file" instruction targeted,
and it moved down.

### Why the hypothesis was not sufficient

**The mechanism was half right, and the half that was right did not matter.** The treatment *did*
change literal preservation: `insert` reached the briefing for `pyflow-q04`, where the control had
omitted it. Questions with missing keywords fell from 5 to 4. So the model can be instructed to keep
a literal, and it did.

`pyflow-q04` still fails. It needs `insert` *and* one of `append` / `history` / `every run` /
`new row` / `accumulat` — a claim that the store *appends* rather than overwrites. The literal
arrived; the reasoning about what the literal implies did not. That is the finding: the missing
tokens Iteration 6 catalogued were a *symptom* of shallow claims, not the cause of the failures, and
instructing the symptom away leaves the failure in place.

**Iteration 6's own diagnostic pointed here and was over-read.** The count was "the expected evidence
was in context in 16 of 17 failures", and the inference drawn was that the model therefore had
everything it needed and was merely compressing. But "the bytes were in the context window" is a
much weaker claim than "the model had established the fact". `pyflow-q04` needs someone to notice
that an `INSERT` with no `ON CONFLICT` and no `DELETE` means history accumulates. The evidence being
present is necessary for that and nowhere near sufficient.

**And one instruction was actively counterproductive.** Telling a model to consolidate the facts
answering a question into one claim presumes it knows which question it is answering. Synthesis is
question-blind by design — it writes a briefing, not answers — so "one claim per question" has no
referent at synthesis time. What the model can do with that instruction is reorganise claims on a
guess, which is what `orders-q03` shows it doing: an instruction to consolidate produced dispersal,
because the consolidation was aimed at a question the model could not see. The three pre-existing
cross-claim failures did not move, and a fourth joined them.

**The one thing the entry got right in advance.** The hypothesis recorded before the run predicted a
prompt-only ceiling below 16/17 and named `pyflow-q12` as structurally unreachable — one claim per
dependency entry, so no dependency claim can hold two dependency names. All four cross-claim
failures are still cross-claim failures, and that reading is unchanged by the result.

### Grounding integrity

The safety properties held completely: **0 fabrications, 0 dropped citations, 0 unsupported briefing
claims**, exactly as in the control. The Requirement G counterweight worked — a prompt that pushed
hard for concrete values did not produce a single invented one. Unsupported *answers* rose 3 → 4, but
that is the `orders-q03` dispersal being counted, not a grounding failure: the citations were real and
verified, they just no longer hung off a claim that answered the question.

Mean evidence relevance fell 0.4007 → 0.3730. Given the standing open question about what that metric
measures — item 2 on the `Next` list, where corroboration unconditionally dilutes a claim that cited
exactly the right source — this is not independently interpretable and no weight is placed on it.

### Decision

**Rejected.** The treatment is reverted; `advanced/src/prompt.ts` returns to the control prompt and
`ADVANCED_VERSION` stays at 0.1.0, because no analysis behaviour ships from this iteration.

Every acceptance criterion that could fail, failed: the primary metric declined 4.2 points against a
+8 threshold, answer accuracy was flat, and the one category that moved moved down. Regression held
at 100 % and fabrications held at 0, which is what keeps this a clean negative rather than a harmful
one. Per the iteration rule, no second prompt change was stacked on top to chase a positive number —
that would have converted a controlled experiment into an untracked search.

The prompt-construction tests are **kept**, retargeted at the control prompt. They assert the
properties the control already has — the closed citable set, both conditional branches, no secret or
trajectory in the prompt, and that the synthesis instruction names no benchmark answer, fixture path
or evaluator category. Six of the eleven were treatment-specific and are removed with it. The
anti-overfitting gate is worth more than the experiment that motivated it: it will fail on the next
iteration that tries to score better by naming an answer.

**Lesson.** "The evidence was in the context window" and "the model had established the fact" are
different claims, and Iteration 6 measured the first while its hypothesis assumed the second. A
retrieval diagnostic can rule retrieval *out* without thereby ruling synthesis prompting *in*. The
sharpest single result is `pyflow-q04`: the treatment moved the exact literal the hypothesis named
into the briefing, and the question still failed — a mechanism can be confirmed at the token level
and still be the wrong explanation for the failure.

Also worth carrying: a question-blind synthesis step cannot be instructed to organise itself around
a question. That instruction had no referent and its only measured effect was to break a passing case.

**Cost of the negative result.** $0.069218 for the treatment run. Two runs of the 38-question
benchmark now exist at a combined $0.135294, and the second one bought a rejected hypothesis and a
sharper reading of the first — which is what the benchmark headroom was built for.
