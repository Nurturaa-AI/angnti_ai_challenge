# Future work

The limitations that are deliberate, each with what is actually true now, why it was left, and what
closing it would take. Nothing here is a defect being deferred quietly — every item is either out of
scope for a hardening release, or blocked behind a re-measurement it is not allowed to do on its own.

[`../CHANGELOG.md#next`](../CHANGELOG.md#next) is the same material in the order the iterations found
it, with the measured numbers attached. This page is the grouped version.

**A rule that governs the whole page.** Six of these items would change what the benchmark measures.
The project's method is hypothesis first, one variable, decision against a threshold written down
beforehand — so each of those belongs to an iteration that is *allowed* to re-measure, and none of
them belongs to a release pass. Production hardening improves operational reliability, security,
testing, documentation and release readiness; it does not touch analytical behaviour, and it did not.

---

## Analysis and measurement

### The briefing is question-blind, and the Q&A path has never been scored

This is the open lever with evidence behind it. Iteration 7 established that a question-blind
synthesis step cannot be instructed to organise itself around a question it never sees — it moved one
question of 38 and moved it the wrong way. Iteration 8 then took the *representational* half of the
successor and kept it: composition gave claims somewhere to put two literals at once, recovering two
cases against a +8 pp threshold. That leaves the other half untouched and untried.

The product already has grounded Q&A downstream of the briefing, running the same scout, the same
read-only tools, the same bounded loop and the same grounding. **Whether that path answers the
Challenge questions is a completely different measurement from whether the briefing happens to
contain them, and it has never been run.** It needs no new analytical mechanism, which is what makes
it the cheapest remaining experiment and the one most likely to say something.

### `pyflow-q04` is an inference gap, not a retrieval or representation one

The clearest single case for the item above, and the reason it is stated separately: two iterations
have now failed it for two different reasons, and neither reason was the obvious one.

Iteration 7 recovered the literal `insert` that the control dropped — and the case still failed,
because it also needs one of `append` / `history` / `every run` / `new row` / `accumulat`. None of
those follows from having the literal in a sentence. Iteration 8's composition does not reach it
either: the missing step is establishing what the code *does* with the insert, not putting two
already-established facts beside each other.

"The evidence was in context" is a much weaker claim than "the model had established the fact", and
this case is where the gap between them is visible. **It is deliberately not being fixed**, because
the only changes that would reach one question are changes fitted to that question — and a system
tuned to a benchmark case stops being a system the benchmark can measure.

### Composition has no headroom left, so the rule set is closed

Iteration 8 equalled its own pre-registered ceiling **exactly**. Before implementing, the 17 challenge
failures were re-classified by asking not "did one claim satisfy this" but "do the required keywords
appear anywhere in the briefing at all": 14 fail that second test and no arrangement of claims can
recover them, one more was excluded as a keyword coincidence, and 9 of 24 was what remained. The
treatment reached precisely 9, with no margin.

So **no new composition rules should be added now.** Adding rules to chase the other 14 would be
fitting the mechanism to the questions rather than to the repository, which is the failure mode this
whole project is arranged to prevent. Two caps are worth restating as the boundary of the design: 8
compositions and 6 cross-kind parts, with a list composition all-or-nothing and an over-long one
dropped rather than trimmed — because "taken together, these are the entries" is false if an entry was
dropped to fit a cap.

One loose end, honest rather than actionable: both recovered cases came from the same-list rule over a
dependency manifest. The **shared-subject** rule fires on every analysis, produces compositions citing
four or five distinct files each, and moved no question. Cross-file composition is implemented,
tested, live, and **unvalidated by this benchmark**.

### The benchmark stays at 38 cases

14 frozen questions (Regression Set v1, byte-identical, which is what keeps Iteration 3's number
comparable) and 24 challenge questions (Challenge Set v2, written before any system ran against
them). `evaluation/benchmark.json` re-derives every count from the case files and fails the load on a
mismatch, so the size is enforced rather than remembered.

Expanding it is legitimate future work, and the right shape for it is **more repositories, not more
questions about the same two** — both fixtures are still JavaScript and Python, so nothing yet tests
whether the scout's term extraction generalises past that vocabulary, and the multi-language category
scores 0 of 2, which is suggestive but is two questions rather than a finding.

But expanding the set changes the denominator, which makes every existing number incomparable until
everything is re-run against it and reported **per set**. That is an iteration, not a task. **It must
not be expanded during a hardening pass**, and it was not.

### Decide what mean evidence relevance is for

It has moved the wrong way twice while the primary metric moved the right way. The precision pass adds
corroborations unconditionally up to its cap, so a claim that cited exactly the expected source drops
from 1.0 to 0.3333 for being *better* supported. Three possible fixes, and the choice between them is
the actual work: report it over a fixed denominator, split precision from coverage, or stop treating a
verified-but-unexpected citation as a miss. Then make corroboration conditional on the claim's
existing citations being weak, rather than unconditional. The bounds already exist
(`--max-corroborations`); what is missing is a rule for when to spend them.

The failure analysis gives this a second reason to matter: citations were found attaching to import
lines rather than defining lines. Whether that is the metric being wrong or the citations being wrong
is unresolved, and it is the kind of question a 38-question dataset can now answer.

---

## The product layer

### A cancelled run still finishes its pipeline

**What happens now.** Deleting a running analysis cooperatively abandons persistence while the
already-issued model operation may continue. Its result is discarded. Concretely: the runner is told
first, stops writing at its next boundary, and the record is gone — no half-written row, no
resurrection, and `DELETE` reports `cancelled: true`. That is the half that was corrupting state, and
it is fixed and tested.

**What is left.** The model calls already issued still complete. That is wasted tokens and, with a
slow provider, a worker busy for a minute on a result nobody will see.

**What closing it takes.** Threading an `AbortSignal` through `analyzeRepository` into the tool loop.
That is the measured path — `advanced/src` — so it is a real improvement that is *not* a lifecycle
fix, and it belongs to an iteration allowed to re-measure. **It is not being implemented now**, and
the Iteration 5 lifecycle contract it would extend is deliberately untouched: `AnalysisNotFoundError`,
`runner.isRunning()`, `runner.abandon()`, `runner.observeDeletion()` and `runner.discard()` all stand
as they are. The invariant they exist for — *a running analysis record must not disappear underneath a
detached run without the runner being informed* — is the thing any future cancellation work must keep.

### The mid-run delete has never been raced against a real provider

It is proven over a real socket against a real database file, and against the mock — which finishes
too fast to race. The original defect report came from `gemini-3.5-flash`, and reproducing those
conditions needs a paid run. Worth doing once, deliberately, the next time a paid run happens anyway.

### The store is single-process

WAL, `busy_timeout` and `BEGIN IMMEDIATE` make a second writer **safe rather than fast**, and nothing
coordinates two servers sharing one file. Do not run two instances against one database path.

That is correct for a local single-user tool and wrong for anything shared. Making it right would mean
either a real database or a coordination layer — and "anything shared" also opens authentication,
authorization and multi-tenancy, which this project has deliberately left closed. **The runner and
store architecture is not being redesigned in this release pass**; the constraint is documented in
[`operations.md`](operations.md#the-database) instead, which is the honest treatment for a limit that
is a consequence of a scope decision rather than an oversight.

### Nothing prunes the database

An analysis lives until someone deletes it, and a report plus a graph plus an evidence projection is
not small. `MAX_STORED_QUESTIONS = 50` bounds one axis; the number of analyses is unbounded **by
design**, because a tool that silently discards the analysis you wanted is worse than one whose file
grows. A retention policy is a decision for whoever has too many, not a default worth guessing at.

### There is still no checked-in browser gate

`browser-smoke.test.ts` executes the shipped `app.js` against a jsdom document, which proves the
script boots against the shipped markup and wires its handlers to elements that exist. jsdom is **not
a browser**: no layout, no paint, no CSS cascade, no real network stack.

This is not a hypothetical caveat, it is a shipped defect. `.drawer { display: flex }` outranks the
user-agent `[hidden]` rule, so the evidence drawer painted over half the workspace from boot — through
`0.6.0`, `0.6.1` and `0.6.2`, past two suites written specifically to catch that class of bug, and it
was visible in the first screenshot the first time a real headless Chrome was pointed at the page.
jsdom resolves `hidden` ahead of the cascade, so both suites reported a drawer that opened and closed
correctly while a browser showed one that never shut.

The cost estimate was also wrong, which removes the reason it was deferred: no dependency was added,
Chrome was already on the machine, and ~140 lines drove it over the DevTools protocol. **The narrowed
item is to make that a checked-in gate** — the browser discovered rather than downloaded, the suite
skipping cleanly when there is none, asserting the handful of geometric facts no other suite can
reach: `[hidden]` elements measuring 0×0, the drawer sharing the row rather than overlapping `main`,
nothing overlapping the top bar, and the empty state landing in the workspace. A scratch script that
found a shipped defect and was then deleted is a gate the project had for one afternoon.

---

## Not planned

Stated because a list of future work that omits its own boundaries reads like a roadmap.

- **Authentication, authorization, multi-tenancy.** This is a local single-user tool that binds
  loopback. Adding users means adding a real database, a session model and an audit trail, which is a
  different product.
- **Redacting bare high-entropy strings.** `redactSecrets` recognises a credential by its shape or by
  the name of the variable holding it. A heuristic wide enough to catch an unnamed, unshaped secret
  would also redact hashes, UUIDs, base64 assets and minified code — and a redactor that mangles
  ordinary source is one people switch off.
- **Widening the frozen questions' `expectedEvidence`.** Each of the original 14 lists only files the
  baseline could see, so a system that cites the implementation instead of the README describing it is
  scored down for citing better evidence. Fixing that *after* seeing which files the advanced system
  chose would be fitting the ruler to the result. It has been left alone three times, and Challenge
  Set v2 addresses the same problem from the honest end instead.
