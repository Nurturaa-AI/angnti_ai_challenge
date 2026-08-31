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
