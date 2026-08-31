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
