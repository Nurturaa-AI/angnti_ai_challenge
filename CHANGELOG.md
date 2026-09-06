# Changelog

All notable changes to Repo Archaeologist. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added — atomic claims and evidence composition, and Iteration 8 kept it

Iteration 7's rejected entry contained the next hypothesis. It recorded that three challenge failures
were out of reach of *any* prompt because `selectClaims` emits one claim per array entry, so no
dependency claim can hold two dependency names. That is a statement about representation, made while
testing instructions. Iteration 8 changed the representation and left the prompt alone.

**`packages/shared/src/claims/` — five modules, no model call.** The advanced pipeline gains one
deterministic step between schema validation and the precision pass:

- `schema.ts` — an `AtomicClaim` is `{ id, kind, text, evidenceIds, subject? }`, a `ComposedClaim` adds
  `claimIds`, a `ClaimSet` is `{ evidence, claims, composed }`. Claims address evidence **by id** into
  the set's own ledger and never carry a copy, so a claim cannot acquire evidence its parts did not have.
- `build.ts` — projects the validated body into atomic claims whose texts mirror the joins the evaluator
  already performs. Ids are `sha256` over kind, text and sorted evidence ids: content-derived, stable,
  with no timestamp, case id or evaluator metadata in them.
- `compose.ts` — the mechanism. *Same-list*: claims of one kind citing one artefact become one claim
  about that list. *Shared-subject*: claims of different kinds whose texts name each other's subjects
  become one claim citing both files. Capped at 8 compositions, 6 parts cross-kind, 2 000 characters; a
  list composition is all-or-nothing and an over-long one is dropped rather than trimmed, because "taken
  together, these are the entries" is false if an entry was dropped to fit a cap.
- `integrity.ts` — rejects unknown evidence ids, duplicate claim ids, orphaned compositions and evidence
  escape. A claim with no evidence is reported as unsupported, not treated as a structural failure.
- `materialize.ts` — appends compositions into the body's own `components` / `flows` / `dependencies` /
  `risks` arrays, marked `Composite:`, carrying only their parts' evidence.

**That last choice is the load-bearing one.** Because a composition lands in a list the rest of the
system already walks, grounding, precision, the audit, the report, the PDF, the graph and the frozen
evaluator all needed no change — a composed entry is an ordinary entry to every one of them, and in
particular it faces exactly the same citation verification as everything else. `packages/evaluator` is
untouched, the synthesis prompt is byte-identical to Iteration 7's reverted control, the fixtures are
untouched, and no second model call was added.

The claim pass cannot see a question. `buildClaimSet` and `composeClaimSet` each take one parameter and
a test asserts their arity, so no channel for one can be added quietly. `meta.exploration.claims`
reports counts and cited **source ids** only; internal claim-evidence addressing never leaves the
process.

`ADVANCED_VERSION` 0.1.0 → **0.2.0**, because the response contract changed. `AnalysisBodySchema` did
not change, so `BASELINE_VERSION` stays 0.1.0 and no migration was needed.

### Measured — Iteration 8's composition experiment, and kept it

**The acceptance threshold was +8 pp on Challenge evidence-backed accuracy. The result was +8.3 pp.**

| | Control | Treatment |
| --- | --- | --- |
| Run id | `eval-advanced-2026-09-05T01-35-25Z` | `eval-advanced-2026-09-06T11-28-46Z` |
| Provenance | `iteration-6-baseline` | `iteration-8-atomic-claims-experiment` |
| System version | 0.1.0 | 0.2.0 |
| Challenge evidence-backed | 29.2 % (7/24) | **37.5 % (9/24)** |
| Challenge answer accuracy | 41.7 % (10/24) | 41.7 % (10/24) |
| Regression (frozen, 14) | 100.0 % / 100.0 % | 100.0 % / 100.0 % |
| Combined evidence-backed | 55.3 % (21/38) | **60.5 % (23/38)** |
| Fabrications / dropped citations | 0 / 0 | 0 / 0 |
| Briefing unsupported claims | 0 | 0 |
| Unsupported answers | 3 | 1 |
| Mean evidence relevance | 0.4007 | 0.4256 |
| Runtime / cost | 1m41s / $0.066076 | 1m42s / $0.066076 |

**Exactly two questions of 38 changed outcome, both upward, both named in advance.**
`challenge-v2-orders-q11` and `challenge-v2-pyflow-q12` each went UNCITED → BACKED with
`matchedIn = dependencies` and `content` evidence strength, citing `package.json` and
`pyproject.toml L7-L12` respectively — the exact expected locations. Nothing regressed. Of the
groupings only `configuration-dependency` moved (2/5 → 4/5), with `documentation` evidence 12/15 → 14/15
and `hard` questions flat at 4/12. Cost is byte-identical to the control because the claim pass adds no
model call; it runs in 5–22 ms per analysis.

**The mechanism is present in the affected cases, not just the aggregate.** All four run trajectories
report `integrityOk: true` and `unsupportedClaims: 0`, with 19 atomic / 3 composed / 3 materialized on
orders and 12 / 3 / 3 on pyflow. Every citation on every composed claim came back `grounded: true`.

**The result equals its own measured ceiling, which is the honest reading.** Before implementing, the 17
challenge failures were re-classified by asking of each not "did one claim satisfy this" but "do the
required keywords appear anywhere in the briefing at all". Fourteen fail that second test — no
arrangement of claims can recover them. Of the three that pass it, `orders-q05` was excluded as a
keyword coincidence: its only satisfied alternative is the bare word `all`, in an unrelated
authentication claim, while `rollback`, `begin` and `atomic` appear nowhere in the briefing. That put the
ceiling at 9 of 24 — the threshold exactly — and the treatment reached precisely it, with no margin left.
`orders-q05` is now the benchmark's one remaining correct-but-uncited question, and it is left alone
deliberately: composing toward it would score a point by exploiting an accident.

Also narrower than the framing: both recovered cases came from the same-list rule over a dependency
manifest. The shared-subject rule fires on every analysis and produces compositions citing four or five
distinct files each — and moved no question. Cross-file composition is implemented, tested, live, and
unvalidated by this benchmark.

**Tests.** 30 new in `packages/shared/test/claims.test.ts` covering creation, multi-evidence claims,
determinism, both composition rules, all four integrity failures, materialization, and two properties
that matter most: grounding *marks* composed citations, and grounding *drops* an invented one while
raising `audit.unsupportedClaims` — so composition cannot become a laundering channel for unverified
evidence. Two new ordering assertions in `advanced/test/advanced.test.ts` pin `validate-schema` before
`compose-claims` before `ground-evidence`. Suite 35 files / 801 tests → **36 / 831**, with no assertion
weakened. `pnpm verify:measured --ref HEAD` reports all nine frozen files unchanged.

### The dashboard, looked at in a real browser for the first time

No measured behaviour changed in the entries below: no prompt, no tool, no scorer, no benchmark. Every
number in `0.7.0` still stands, and nothing here was re-measured because nothing here is on the measured
path. What changed is the product layer, and the reason it could change is that the layout was
finally *observed* rather than asserted — headless Chrome over the DevTools protocol, driving
the shipped page against the real server.

### Fixed — the drawer was on screen from boot, over half the page

`[hidden] { display: none }` is a user-agent rule, and any author declaration outranks the whole
user-agent origin however weak its selector. `.drawer { display: flex }` therefore defeated
`<aside class="drawer" hidden>`, so the evidence drawer — a `position: fixed` panel over the
right-hand third of the viewport, top bar included — painted empty over the workspace on every
load. `drawer.hidden = false` had nothing to do and `closeDrawer` nothing to undo.

- **`[hidden] { display: none !important }`**, declared once near the top of the stylesheet, and
  `.drawer`'s flex column moved to `:not([hidden])` so the attribute keeps the last word.
- **The drawer is now a sibling of `<main>` inside `.layout`.** Where it docks it takes its width
  from the row and the workspace reflows into what is left. Verified in Chrome at 1440×900:
  `main` goes 1224px → 835px, the drawer takes 389px beside it, both at `y=74` below the top bar.
- **Below 1180px it overlays instead**, positioned against `.layout` rather than the viewport, so
  it cannot reach over the top bar. Verified at 1100×800: `position: absolute`, `y=74`.
- **Nothing in the suite could see any of this.** jsdom resolves `hidden` ahead of the cascade, so
  `getAttribute("hidden")` reported an open-and-shut drawer while a browser showed one that never
  shut. `wiring.test.ts` now gates the rule as stylesheet text, which is the assertion that was
  actually available.

### Fixed — `render()` fetched, and nobody awaited it

`render()` opened with `void loadAnalyses()`, so every repaint issued an HTTP `GET` for the
analysis list: a section change, a diagram/outline toggle, an answered question, every terminal
stream event. The docstring on `loadAnalyses` had argued against exactly this since Iteration 5
without the call ever being removed.

Un-awaited was the worse half — a failed list fetch during a repaint had nowhere to report, and a
repaint late in the page's life left a promise resolving against a document that was going away.
That is what the browser suite caught, as an unhandled rejection rather than a failed assertion:
`renderAnalysisList` reaching for `document` after the window had closed.

- **`render()` paints and fetches nothing.** The five events that can change the list each
  `await loadAnalyses()` themselves — a run started, one opened, one deleted, one reaching a
  terminal state, and a question answered, which changes a row's question count and was the one
  the old fire-and-forget call had been quietly covering.
- **Three gates in `wiring.test.ts`**, verified by reintroducing the defect and watching them fail.

### Fixed — the delete confirmation focused the destructive button

Closes item 10 of the previous `## Next`. Arming the two-step confirm moved focus to *"Delete for
good"*, and arming replaces the button the user just activated — so an Enter already on its way
down destroyed an analysis and its evidence. A confirmation whose destructive half is what the
next keypress fires is a speed bump wearing a safeguard's clothes.

*Cancel* now takes the focus **and** comes first in source order, which is the tab order and the
screen-reader reading order too: all three ways in favour the safe control. Gated twice — in
`wiring.test.ts` as source, and in `browser-smoke.test.ts` by clicking the real Delete button and
asserting `document.activeElement`, so a focus call that finds nothing to focus fails. Confirmed
in Chrome: `activeElement` is `analysis-cancel`.

### Changed — the empty state, per section

`#architecture` with nothing open answered with the overview's landing copy, so the view the
product is named for was the one view that never showed anything. There were two `.empty`
implementations and room for nine.

- **One `emptyState()` shape**, plus a `NOTHING_OPEN` table with a sentence per section saying what
  that section *would* show. `wiring.test.ts` counts the class to keep it at one, and reads
  `SECTIONS` out of `ui.js` so a tenth section fails the suite until it has been given words.
- **The newest finished analysis is offered as a one-click action**, and opened on boot when one
  exists. The store is durable, so the second visit is the common one, and arriving at a saved
  workspace to be shown a landing page with the analysis collapsed in a sidebar made
  `#architecture` a brochure. `GET` only; it starts nothing.
- **`render()` is called at the end of `boot()`.** `renderNav()` runs only from `render()`, so on a
  cold load the section list was an empty `<ul>` and the only route to `#architecture` was to type
  it — which is how the primary workspace came to be reached by URL and greeted with a landing page.

### Changed — the citation chips say what they do

Each chip is a disclosure button: `aria-controls="drawer"`, `aria-expanded` tracking whether the
drawer is showing *that* citation, and a second click on the open chip closes it. The open chip is
styled off `aria-expanded` rather than a class, so there is one fact and not two. Chips are synced
in place rather than through `render()`, because a citation opening is not a reason to throw away
the diagram's pan and zoom or the reader's scroll position.

Two races closed with it: a slow evidence fetch no longer paints over a newer request or a closed
drawer, and opening a second citation from inside the drawer no longer records the drawer's own
close button as the place Escape should return focus to.

### Changed — the sidebar was a wall of 9px prose

Every row printed its full summary, so eight rows of three-line text at 10px had no shape to scan.
The summary is now earned rather than given — the open row, a running one (where it is the live
phase), and a failed one (where it is the reason) — and clamped to three lines. Nothing was moved
behind a hover: a control a keyboard user cannot see until they have focused it is one they cannot
find.

### Added — a browser gate that is a browser

`browser-smoke.test.ts` gains the delete-focus assertion; `wiring.test.ts` gains five gates. Both
still run offline with no new dependency.

**The verification that found these defects is not in the suite, and should be.** It was headless
Chrome driven over CDP by a throwaway script — real layout, real cascade, real geometry. Every
layout claim above is quoted from it. That it was a scratch file is the honest limitation: the
`[hidden]` defect shipped in `0.6.0`, survived two suites written specifically to catch it, and
was found the first time a browser looked at the page. See item 7 of `## Next`, now narrowed to
one concrete thing.

### Measured — Iteration 7's synthesis experiment, and rejected it

Iteration 6 ended with a hypothesis rather than a change: source-backed accuracy is limited by claim
**granularity**, not retrieval, because in 16 of 17 failures the expected evidence was already in
context. Iteration 7 spent that lever. One variable moved — six form-level instructions appended to
`buildSynthesisPrompt`, asking the model to keep a fact and its identifier in the same sentence
instead of splitting them across claims. Model, seed, thinking level, tools, budgets, scout,
grounding, schema, evaluator, benchmark and fixtures were all held.

**The acceptance threshold was +8 pp on Challenge evidence-backed accuracy. The result was −4.2 pp.**

| | Control | Treatment |
| --- | --- | --- |
| Run id | `eval-advanced-2026-09-05T01-35-25Z` | `eval-advanced-2026-09-05T17-58-05Z` |
| Provenance | `iteration-6-baseline` | `iteration-7-synthesis-experiment` |
| Challenge evidence-backed | 29.2 % (7/24) | **25.0 % (6/24)** |
| Challenge answer accuracy | 41.7 % (10/24) | 41.7 % (10/24) |
| Regression (frozen, 14) | 100.0 % / 100.0 % | 100.0 % / 100.0 % |
| Combined evidence-backed | 55.3 % (21/38) | 52.6 % (20/38) |
| Fabrications / dropped citations | 0 / 0 | 0 / 0 |
| Briefing unsupported claims | 0 | 0 |
| Mean evidence relevance | 0.4007 | 0.3730 |
| Runtime / cost | 1m41s / $0.066076 | 1m29s / $0.069218 |

**Exactly one question of 38 changed outcome.** `challenge-v2-orders-q03` went PASS → UNCITED: an
instruction written to consolidate a fact with its identifier produced dispersal on the one case
already getting it right. Nothing was recovered. Of four groupings only `cross-file-reasoning` moved
(2/3 → 1/3) — the category the treatment targeted, moving down.

**The mechanism fired and the hypothesis was still wrong.** `pyflow-q04` recovered the literal
`insert` the control dropped, and still failed: it also needs one of `append` / `history` /
`every run` / `new row` / `accumulat`. Getting a literal into a sentence is not the same as having
established what the code does with it. "The evidence was in context" is a much weaker claim than
"the model had established the fact", and synthesis here is question-blind by design — the model
writes one briefing and the scorer later asks nineteen questions of it. Three failures are out of
reach of any prompt: `selectClaims` emits one claim per dependency entry, so a question needing two
dependency names in one claim cannot be satisfied by better writing.

**Rejected, and nothing experimental was left behind.** `advanced/src/prompt.ts` is byte-identical
to its pre-experiment state, `ADVANCED_VERSION` stays at 0.1.0 because no behaviour shipped, and no
second prompt change was stacked into the same iteration. What is kept is the measurement, the
Iteration 6 baseline it was compared against (not overwritten), and six tests in
`advanced/test/advanced.test.ts` retargeted at the control prompt — including the gate that the
synthesis prompt names no benchmark answer, fixture path, case id or evaluator category label.
`pnpm verify:measured --ref HEAD` reports `OK` with all nine frozen files unchanged.

## [0.7.0] — 2026-09-05

**The benchmark had stopped being able to disagree.**

Since Iteration 3 the advanced system has scored 14/14. A dataset you score full marks on cannot
report anything except *not worse*: every subsequent decision would have been argued from
intuition, and every subsequent number would have been 100 % or a tie. Iteration 6 fixed the
instrument rather than the system, measured the unchanged system against it, and then — on the
evidence — declined to change the analysis.

### Added — Challenge Set v2, beside a frozen Regression Set v1

- **24 new questions**, 12 per fixture repository, spanning eleven categories at 3 easy / 11 medium
  / 10 hard. The dataset is now 38 questions in two sets.
- **The original 14 are frozen and byte-identical**, verified by `git hash-object` rather than by
  intention. They are Regression Set v1, and they are what makes Iteration 3's number still
  comparable.
- **14 of the 24 expect *source* evidence**, against 2 of 14 on the frozen set. This is the
  long-standing [limitation 7](docs/evaluation.md#limitations) addressed from the other end:
  rather than widening the frozen lists after seeing which files the system chose — fitting the
  ruler to the result — the new questions name implementation files from the start, written before
  any system ran against them.
- **`evaluation/benchmark.json`** declares the benchmark's identity, sets and counts.
  `loadBenchmark()` re-derives every count from the case files and fails the load on a mismatch, so
  a case added without updating the manifest is a test failure rather than a silently changed
  denominator.
- **Metadata provably cannot reach the scorer.** Challenge questions carry `category`,
  `difficulty`, `tags` and `evidenceRationale` inline; `EvalCaseSchema` is a `z.object` and strips
  what it does not declare, so the object the scorer receives never contains them. The frozen
  questions cannot carry metadata at all without changing their bytes, so theirs lives in the
  manifest's `annotations` map — an asymmetry that is ugly and load-bearing.
- **`benchmark-report.ts`** splits a scored report by set, category, difficulty, repository and
  evidence kind, each a complete partition. Per-set reporting is not a presentation choice: a
  combined average is the one number that can hide a regression.

### Added — run provenance, as a schema change

- **Three identities, none substituting for another.** `systemVersion` is which code ran,
  `provenance` is where the run came from, `benchmark.version` is which dataset it was measured
  against. This closes item 3 of the previous `## Next`, which had been deferred twice — and it
  closes it the way that item eventually specified, with a new field rather than a version bump
  that would have asserted a behaviour change that did not happen.
- **`--provenance` on both entry points and the web server**, defaulting to
  `REPO_ARCHAEOLOGIST_PROVENANCE` then `unlabelled`, validated against
  `/^[a-z0-9][a-z0-9._/-]{0,63}$/` *before* anything binds a port or opens a database. A shell
  expansion that produced `$(whoami) run` fails as a sentence rather than landing in a stored row
  and an HTTP body.
- **A real migration.** Report `schemaVersion` 1 → 2; store `SCHEMA_VERSION` 1 → 2, adding
  `system_version` and `provenance` as nullable columns. Existing databases upgrade on open, and a
  version-1 row reads back as *unrecorded* rather than being backfilled with a plausible value — it
  genuinely does not know where its run came from, and inventing an answer is what this whole
  project is against.
- **`readReportIdentity()` returns `null` for a v1 report.** Labelling a historical Iteration 3 run
  as benchmark `v2` at read time would be fabricating a fact about history to fill a column.

### Added — the entry points, actually executed

`tsc --noEmit` and `node --check` both pass on an entry point that throws on line one. Three suites
now close that gap, all offline, all with `GEMINI_API_KEY` blanked in the child:

- **`apps/cli/test/cli-smoke.test.ts`** spawns the real binary — help, every parse refusal, the
  evaluation-integrity refusal, and one full `--mock` analysis that is checked to have written the
  files it printed.
- **`apps/web/test/entry-smoke.test.ts`** spawns `main.ts` with real flags and answers over TCP:
  `.env` load, config and budget resolution, database location, store construction, bind order,
  the banner, and a full analysis whose stored row carries the provenance the process started with
  and does not carry the workspace path.
- **`apps/web/test/browser-smoke.test.ts`** executes the shipped `public/app.js` against a jsdom
  document. This closes item 7 of the previous `## Next` — partially, and the limit is documented
  rather than glossed: jsdom is **not a browser**, has no layout, paint or CSS cascade, and cannot
  see a control rendered off-screen or hidden by a stylesheet.

Both drift checks compare each entry point's `--help` against the flags its parser accepts, in both
directions.

### Changed — the measured-path guard moved in both directions

Stated plainly because a guard that quietly loosens is worse than no guard. **Stronger:** the two
frozen case files are now compared by *content* against the ref rather than watched for a diff
entry, untracked files are covered (a new file under a guarded directory used to be invisible), and
fixtures are checked through their tracked generator. **Weaker:** two named plumbing files under
`evaluation/` are exempt, because a benchmark manifest cannot be threaded through the runner
otherwise. The exemption is per-file, never per-directory, and each exempt file prints its own
justification on every run.

### Measured — and then nothing was changed

`eval-advanced-2026-09-05T01-35-25Z`, `gemini-3.5-flash-lite`, seed 7, thinking low, provenance
`iteration-6-baseline`, $0.066076. `pnpm verify:measured --ref HEAD` reports `OK`;
`ADVANCED_VERSION` and `BASELINE_VERSION` are unchanged at 0.1.0.

| | Regression Set v1 (frozen) | Challenge Set v2 |
| --- | --- | --- |
| **Evidence-backed task accuracy** | **100.0 % (14/14)** | **29.2 % (7/24)** |
| Answer accuracy | 100.0 % (14/14) | 41.7 % (10/24) |
| Fabrications / dropped citations | 0 / 0 | 0 / 0 |

**Nothing regressed, exactly.** Iteration 3 scored 100.0 % / 100.0 % with mean evidence relevance
0.4105; the frozen subset of this run scores 100.0 % / 100.0 % with mean evidence relevance 0.4105.

**Where the failures are.** Accuracy tracks *where the evidence lives* — 93.3 % documentation-backed
against 33.3 % source-backed — more strongly than it tracks difficulty or category. The obvious
reading is a retrieval weakness and it is wrong: two diagnostic runs recorded which files reached
the model, and **in 16 of 17 failures the expected evidence was already in context, un-truncated.**
What is missing from the briefings is concrete literals the system was looking at — `4000`,
`database_url`, `max: 10` — because a component claim is one sentence about what a module does, and
a port number has no place in that sentence.

**No analysis change was made, and that is the result rather than a shortfall.** The evidence names
the synthesis prompt, which this iteration's constraints put out of scope; every other
single-variable change available targets retrieval, which 16 of 17 failures show is not the
bottleneck. The hypothesis is recorded in full in
[`docs/improvement-changelog.md`](docs/improvement-changelog.md) for the iteration allowed to act
on it.

### Also

- 644 → 776 tests. No existing test was modified to accommodate new behaviour.
- `@types/jsdom` is deliberately **not** installed: `tsconfig.json` omits the DOM lib so server code
  cannot reach for `document` by accident, and those types reintroduce DOM globals project-wide.
  `apps/web/test/jsdom.d.ts` declares only what the one suite needs.

## [0.6.2] — 2026-09-02

**A record was deleted out from under the run that owned it.**

A real `pnpm web` session produced seven lines for one analysis:

```
analysis an-mtjkeuuv-1 phase synthesizing not recorded: StorageError: No analysis an-mtjkeuuv-1
… four more phases …
analysis an-mtjkeuuv-1 failed: StorageError: No analysis an-mtjkeuuv-1
analysis an-mtjkeuuv-1 could not be marked failed: StorageError: No analysis an-mtjkeuuv-1
```

The row *was* created and committed — the shape of the log proves it, since a create that never
landed would have failed at `validating`, not at `synthesizing`. It was `DELETE
/api/analyses/:id`, on an analysis that was still running. `0.6.0` detached the run from the request
that started it and gave the delete route no way to know that. Nothing in 644 tests covered `DELETE`
at all, and every store test ran against `:memory:`.

### Fixed — the record's lifetime now covers its run

- **A delete of a running analysis is a cancellation.** `AnalysisRunner` tracks its live ids and
  exposes `abandon(id)`; `routeDelete` calls it before `store.delete(id)` and answers
  `{ deleted, cancelled }`. The browser's toast says which happened.
- **The run stops writing instead of failing seven times.** It checks at each of its own write
  boundaries, discards its result and logs one line. Cooperative on purpose: the pipeline underneath
  is *not* interrupted — that would mean reaching into the measured analysis path — so an in-flight
  model call finishes and its output is dropped.
- **The record is never recreated.** Resurrecting the row would be the runner overruling the person
  who deleted it.
- **`No analysis an-… .` no longer reaches the browser.** The store's internal invariant message was
  being carried into the record's `error` field by `safeFailureMessage`. A cancelled run now says
  *"The analysis was deleted while it was running."*

### Changed

- `AnalysisNotFoundError extends StorageError`, thrown by `get`, `update` and `appendQuestion`
  instead of a bare `StorageError`, and carrying the `analysisId`. The store was **not** weakened —
  a missing row is still a thrown invariant violation, `update` still never creates a row, and the
  subclass's `name` stays `"StorageError"` so the HTTP mapping is byte-identical. The subclass
  exists so the record's owner can tell *"the row I created is gone"* from *"the database is
  broken"*, which is what lets a run stop on the first observation even when nothing announced the
  delete.

### Tests

Two new files, 14 tests, both against the real `SqliteAnalysisStore` on a real file:

- [`packages/app/test/persistence.test.ts`](packages/app/test/persistence.test.ts) — durability
  across close/reopen, a detached run continuing after `start()` returns, delete-while-running both
  announced and unannounced, and the missing-analysis invariant still holding.
- [`apps/web/test/durability.test.ts`](apps/web/test/durability.test.ts) — a real server on a real
  socket: POST → completion → **restart the process** → still readable; and a mid-run DELETE that
  leaves no storage error in the log.

Both fail against the pre-fix code with the reported symptom. 658 tests pass; `verify:measured`
reports no change under the measured path, and `ADVANCED_VERSION` / `BASELINE_VERSION` are
unchanged because the analysis itself was not touched.

## [0.6.1] — 2026-09-02

Iteration 5, continued: **the browser did not load.**

`0.6.0` shipped `app.js` with a `SyntaxError` in it. Three functions — `layoutGraph`, `truncate`,
`countOmittedClaims` — were extracted into `ui.js`, imported back at the top of `app.js`, and never
deleted from the bottom. A duplicate `const` at module scope is not a warning; the module never
evaluates. Every claim `0.6.0` made about the dashboard was a claim about a file the browser
refused to run.

The tests did not catch it and could not have. `ui.test.ts` asserted fifty things about `ui.js` and
all fifty were true. Nothing in it, or in the 570 tests around it, ever asked whether `app.js`
parses.

This entry replaces no text in [`0.6.0`](#060--2026-09-02). Corrections are additive here, which is
the only way a changelog stays evidence rather than marketing — the claims below are what was
actually wrong with it.

### Fixed — the dashboard runs

- **`app.js` parses.** The three duplicated declarations are gone, so the imported — and tested —
  versions are the ones that execute.
- **`#announce` and `#alert` exist.** `toast()` carried a ten-line comment explaining why an error
  goes to `role="alert"` and everything else to `role="status"`, and then wrote to two elements that
  were never in `index.html`. Every status message in `0.6.0` would have thrown a `TypeError` on the
  first line that reached the live region — including the ones reporting a failure.
- **`#progress` exists, and has a rule.** The phase panel — a deliverable of `0.6.0` — had no host
  element and no CSS. `renderProgress` took its `if (!host) return` branch on every call, so live
  progress arrived over SSE, updated the state and painted nothing. The host is deliberately
  outside `<main>`, because `render()` clears `#main` on every section change.
- **Eleven imported helpers are now called.** `architectureOutline`, `nodeDetail`, `edgeDetail`,
  `filterGraph`, `nodeMatchesSearch`, `relatedNodeIds`, `graphSummaryLabel`, `phaseChecklist`,
  `questionOutcome`, `evidenceLineRange`, `evidenceStrength` — imported, tested, and unreachable.
  They are precisely the logic behind clicking a node, clicking an edge, the outline view, the phase
  panel and the three question states. The features existed as pure functions with passing tests and
  no caller. `absoluteTime` was the exception and was removed: `describeAnalysisRow` already formats
  it, so importing it was the redundant half of the same mistake.
- **`state.graph.selected` matches its own comment.** Documented as `{ kind, id }` because an edge is
  selectable too, used as a bare node id. Now the documented shape, and an edge selection opens a
  panel naming its relationship and both endpoints rather than the address of a line.
- **`state.drawerReturn` is used.** Declared, commented, never written. Closing the evidence drawer
  dropped focus to the top of the document; it now returns to the chip that opened it.
- **The recent-analyses list is styled.** Eleven classes arrived with the durable store — the row,
  the name, the path, the summary, the provenance line, both delete states — and none of them had a
  rule. Neither did `.pill`, so every status in the product rendered as unstyled inline text, in the
  one iteration whose whole point was that an analysis now has a status worth reading. The surviving
  `.recent button.on` rule pointed at a structure that no longer existed.
- **`--ink-faint` meets AA.** `#5f6b7a` computes to 2.99:1 on `--panel`, against a 4.5:1 floor, and
  it styles the 10px provenance labels. Now `#7d8895` — 4.50:1 on `--panel`, 5.25:1 on `--bg`.
- **The browser is off the Iteration 4 aliases.** The PDF download was the last route still on
  `/api/analysis/:id/…`. The aliases stay on the server so Iteration 4's tests keep passing
  unmodified; nothing in the browser reaches for them.
- **The sidebar stopped lying.** It read "Analyses are held in memory. Restarting the server clears
  them" — written for Iteration 4 and left in place by the iteration that made it false.

### Added — `apps/web/test/wiring.test.ts`, the kind of test that was missing

24 tests, 620 → **644**. Not more coverage of the same kind; a different kind. A unit test imports a
module and proves the module works — nothing in it can prove the module is *reached*. These read the
shipped files as text and assert the seams between them:

- `app.js` and `ui.js` parse as ES modules (`node --check`, zero dependencies), which is the check
  that would have caught the failure outright.
- No imported name is also declared locally — the bug itself.
- No imported name is unused — its other half, and the one that hid eleven working features.
- Every `$("id")` resolves to an element `index.html` or `app.js` creates, with `#announce`,
  `#alert`, `#status`, `#progress`, `#main` and `#drawer` named explicitly because their absence is
  silent, plus an assertion that the progress host precedes `#main` in the document.
- Every class the app applies has a rule, and every custom property it reads is defined.
- The browser addresses evidence only as `/api/analyses/:id/evidence/:evidenceId`, never through a
  global endpoint, and never names `repositoryRoot`, `trajectory` or `apiKey`.

### Added — `scripts/verify-measured-path.ts`

Every iteration since the first has carried forward a benchmark number by arguing the measured path
did not change. This makes the argument a command with an exit code: `pnpm verify:measured --ref
<ref>` reports what differs under `advanced/src`, `baseline/src`, `evaluation/`, `packages/evaluator`
and `fixtures`, fails on any deletion or any change to a frozen directory, checks whether
`ADVANCED_VERSION` / `BASELINE_VERSION` moved, and `--compare a.json b.json` normalizes two result
files down to what the systems actually answered and diffs them.

### Measurement

No product change here can move a benchmark, and none is claimed. What is checked is that it did not
move anything:

| | Baseline `--mock` | Advanced `--mock` |
| --- | --- | --- |
| Run id | `eval-baseline-2026-09-02T03-07-29Z` | `eval-advanced-2026-09-02T03-07-44Z` |
| Evidence-backed task accuracy | 21.4 % (3/14) | 28.6 % (4/14) |
| Normalized JSON diff vs the pre-Iteration-5 runs | **identical** | **identical** |

`pnpm verify:measured --ref bd5c632` reports `advanced/src/index.ts +40 −0`,
`baseline/src/index.ts +17 −0`, both version constants unmoved, and nothing at all under
`evaluation/`, `packages/evaluator/` or `fixtures/`. Those 57 lines are `0.6.0`'s `onPhase` callback
and its phase unions, unchanged by this entry. `pnpm typecheck` clean, 644 tests passing, offline.

### Versioning

Root `0.6.0` → `0.6.1`. `ADVANCED_VERSION` / `BASELINE_VERSION` stay at `0.1.0`: nothing on the
measured path was touched, and `verify:measured` says so rather than a paragraph asserting it.

## [0.6.0] — 2026-09-02

Iteration 5: **somewhere for an analysis to live.** A durable store behind the `AnalysisStore` seam
Iteration 4 declared, a runner that creates the record before the work begins, and live phase
reporting. **No benchmark improvement is claimed.** What *was* measured is that the pipeline is
unchanged — asserted as a byte-identity regression test in each system, and confirmed by re-running
both offline evaluations and diffing them against Iteration 4's, which came back identical question
by question. See [Measurement](#iteration-5-measurement).

### Added — `packages/app/src/store/`, persistence behind the existing seam

Iteration 4 declared `AnalysisStore` and put a bounded map behind it. This fills it in with
`node:sqlite` — Node 22's standard library, so a durable store costs **zero new dependencies**. WAL,
`busy_timeout=5000`, `BEGIN IMMEDIATE` on the read-modify-write paths, four tables, two indexes.

- `store/types.ts` — the seam, widened to what a durable store needs: `create` / `get` / `list` /
  `update` / `delete` / `appendQuestion` / `getEvidenceSource` / `close`. Five statuses
  (`queued`, `validating`, `analyzing`, `completed`, `failed`) and eight phases, both closed sets.
  `MAX_STORED_QUESTIONS = 50` per analysis, oldest evicted.
- `store/sqlite.ts` — `SqliteAnalysisStore`. `SCHEMA_VERSION = 1`; a file written by a *newer*
  build is **refused** rather than misread, because half-understanding a schema is worse than
  declining it. A corrupt JSON column reads as `null` with a `process.emitWarning` instead of
  losing the whole record. An unrecognised status reads as `failed`, never as `completed`.
- `store/location.ts` — `resolveDatabaseLocation`. It **refuses a path inside the analysed
  workspace**: a database there is a file the analysis can see, `git status` reports and `git clean`
  deletes. Precedence is explicit `--db` > `REPO_ARCHAEOLOGIST_DB` >
  `~/.repo-archaeologist/analyses.db`. `:memory:` is accepted for a session that should not persist.
- `store/projection.ts` — what the store is *allowed* to remember. A `RunRecord` carries model
  prose, raw tool results, prompts and an absolute root; `projectEvidence` keeps the reconnaissance
  artefacts a question needs to be answerable after a restart, plus the sources some citation
  actually resolves to, and drops everything else. Excerpts are **redacted on the way in**, so a
  restart cannot change what the viewer shows and its line offsets are correct by construction —
  the ledger the pipeline grounds against is untouched and stays raw. Paths are stored
  workspace-relative; evidence is keyed by `(analysisId, sourceId)`, which is what makes an id from
  another analysis a 404 rather than a leak.

### Added — `packages/app/src/runner.ts`, a record before the work

`AnalysisRunner.start` writes the `queued` row and returns it, then runs the pipeline detached.
`run` **never rejects**: by the time the pipeline finishes, the client that asked may be gone and
there is nobody to catch. A failure is a `failed` *record* the user finds on reload, naming the
repository as the caller named it rather than as this machine's filesystem does.

### Added — `packages/app/src/lifecycle.ts`, progress without inventing any

A status is a promise about what the record contains; a phase is an observation about where the
pipeline got to. The two are kept separate on purpose.

- An explicit transition table. A terminal status has no successor, so a finished analysis cannot
  be reopened and its status stays a promise rather than a guess.
- `AnalysisEventBus` — five event kinds, per-analysis replay so a browser that POSTs and *then*
  opens the stream does not miss the first two events, bounded at 64 events × 64 analyses, and a
  subscriber that throws (a dead socket) cannot take the analysis down with it.
- `PHASE_MESSAGES` — one line of prose per phase. **No percentage, no interpolation, no estimate:**
  the pipeline reports phases, not progress, and a bar would be the UI claiming something nobody
  measured.
- `safeFailureMessage` / `logFailureMessage` — a deliberate pair. The error's *category* decides
  whether its text reaches a browser: our own errors were written to be read, an unanticipated
  exception is replaced wholesale rather than filtered, and a `hint` — written for an operator —
  never leaves the process.

### Added — `apps/web/src/dto.ts`, every response constructed field by field

No internal object is handed to a serialiser. That sounds like ceremony until you notice what it
catches: `AnsweredQuestion` carries a trajectory of model prose and raw tool bytes, and
`AnalysisRun` carries an absolute `repositoryRoot` — both were one `JSON.stringify` from a browser
in Iteration 4. Listing the fields means adding a field to a domain type cannot silently publish it.

Reinforced in the type system rather than only in the DTO: `AnsweredQuestionView` =
`Omit<AnsweredQuestion, "trajectory">` is now the only way an answered question leaves
`questions.ts`, and the PDF exporter takes that narrower type — so it cannot print a trajectory
even by accident, because there is no field to reach for.

### Added — the analysis list, deletion, and an event stream

`GET /api/analyses`, `DELETE /api/analyses/:id`, and `GET /api/analyses/:id/events` (SSE). The
question and evidence routes gained path-scoped forms (`/api/analyses/:id/questions`) alongside the
Iteration 4 bodies, which still work. An id is pattern-checked before the store sees it, so
malformed input is a 400 with a stable message rather than a query that happens to return nothing.

Streaming is framed at one choke point in `server.ts` rather than in each route, so a route added
later cannot emit an unframed line, and a browser that navigates away runs the route's teardown
exactly once — a subscription cannot outlive its socket. `WebApi.idle()` waits for analyses that
outlived their request, which both the tests and a graceful shutdown need.

### Added — `apps/web/public/ui.js`, the dashboard's pure logic

Split out of `app.js` for one reason: the repository has no bundler and no jsdom, so anything that
touches `document` can only ever be read by a human, while anything that merely decides *what* to
show can be imported and asserted. `ui.d.ts` beside it is a hand-written declaration, which is what
lets a typechecked test call into a browser module in a project with no `allowJs` and no build step.

The UI gained a sidebar of durable analyses with relative times, a phase checklist, live progress
over SSE with reconnection, deletion with confirmation, and toasts. The PDF gained a Key Findings
page, a drawn architecture figure (with stated degradation above 30 nodes rather than an illegible
one), the questions asked, and an evidence reference section.

### Added — tests

129 new tests, 491 → **620**, all passing, offline. **No existing test was deleted or weakened.**

- `packages/app/test/store.test.ts` (39) — the list row's exact key set, proving no payload column
  reaches a list; cross-analysis evidence isolation; the same evidence id in two analyses as
  independent rows; per-analysis question eviction; a schema version from the future refused; a
  corrupt `report` column surviving as `null`; a `StorageError`'s path in its `hint` and not its
  `message`; and a `work-db` sibling directory proving the workspace check compares on the
  separator rather than on a prefix.
- `packages/app/test/lifecycle.test.ts` (21) — replay parity between a late and an early
  subscriber, both buffer bounds, a throwing subscriber tolerated, `PHASE_MESSAGES` exhaustive
  against `ANALYSIS_PHASES`, and `safeFailureMessage` asserted directly against a path, a
  credential and a hint.
- `packages/app/test/runner.test.ts` (14) — a full offline run against a real temporary repository:
  a durable record before the work completes, the workspace path absent from the *whole* record,
  ids that survive a simulated restart, a phase reaching the database mid-run and cleared on
  completion, and a store whose `update` always throws still producing a `failed` result.
- `apps/web/test/ui.test.ts` (50) — the pure UI logic, including the three checks that license its
  duplicated constants: the browser's phase list against `ANALYSIS_PHASES`, its status vocabulary
  against `ANALYSIS_STATUSES`, and its node palette against `NODE_TYPES`.
- `advanced/test/advanced.test.ts` (+3), `baseline/test/baseline.test.ts` (+2) — the phase order,
  and the byte-identity assertion both `onPhase` doc comments already claimed existed.

### Changed — the measured path, and nothing else in it

- `runAdvanced` / `runBaseline` accept an optional `onPhase` callback, with an exported
  `AdvancedPhase` (7) and `BaselinePhase` (4) vocabulary. **This is the entire footprint.** No
  control flow reads it, its return value is discarded, the evaluator passes none, and a regression
  test in each system asserts a run with it produces a byte-identical record to a run without it.
  The baseline's four names are not a subset by accident: it never scouts, never explores and never
  refines evidence, and its type says so rather than reporting phases it does not perform.
- `packages/shared/src/errors.ts` — a new `StorageError`, so "the database could not be opened" is
  distinguishable from a caller's mistake without reading message text.
- `packages/app/src/service.ts` — `AnalysisSystem` and `AnalysisRunPhase` types, and `onPhase`
  forwarded unchanged. The service adds no phase of its own because it performs none.
- `packages/app/src/questions.ts` — `RECONNAISSANCE_TYPES` exported, because it is also the rule the
  store projects by; question history narrowed to `Pick<…, "question" | "answer">`, so the replay
  path cannot see a trajectory either.
- `apps/web/src/main.ts` — `--db`, and a store opened *before* the server. A database that cannot be
  opened stops startup rather than the first request, and a failed start closes it rather than
  leaving a WAL behind.
- `packages/app/src/store.ts` was **removed**; `store/` replaces it. The in-memory implementation it
  held is superseded by `:memory:`, which exercises the same code path as a file.
- The `node:sqlite` experimental warning is **not** suppressed. It prints once on startup, because a
  suppressed warning is a promise the project cannot keep.

<a name="iteration-5-measurement"></a>
### Measurement

**No paid evaluation run was made, and no benchmark movement is claimed.** The reasons are
Iteration 4's, unchanged: nothing on the measured path behaves differently, and
`gemini-3.5-flash-lite` has been at 14/14 since Iteration 3, so the dataset has no headroom to show
a movement even if one existed. Iteration 3's figures remain the last real measurement.

This iteration *did* touch the measured path, for the first time since Iteration 3 — so the check is
a byte-identity test rather than a percentage. A hook that changed the record would have moved both
systems together, and the comparison between them would have looked untroubled.

| | Baseline `--mock` | Advanced `--mock` |
| --- | --- | --- |
| Run id | `eval-baseline-2026-09-02T01-28-27Z` | `eval-advanced-2026-09-02T01-29-00Z` |
| Evidence-backed task accuracy | 21.4 % (3/14) | 28.6 % (4/14) |
| Per case | 2/7 and 1/7 | 2/7 and 2/7 |
| Fabrications / dropped citations / unsupported answers | 0 / 0 / 0 | 0 / 0 / 0 |
| Failed cases | 0 / 2 | 0 / 2 |
| Normalized JSON diff vs Iteration 4's runs | **identical** | **identical** |

Mock figures are **not** a measurement of quality, and the harness prints its own caveat saying so.
The last row is what this table is for, and it is stronger than the headline percentages agreeing:
with run ids, timestamps and durations normalized out, every question, every score, every citation
and every dropped-citation record is the same object it was before this iteration existed.

Also checked: **0** files changed under `evaluation/`, `fixtures/`, `packages/evaluator/`,
`reports/` or `trajectories/`; no evaluation case modified; `pnpm typecheck` clean.

Recorded rather than tidied away: **the hypothesis for this iteration was written after the code**,
which breaks the ordering the first four iterations honoured. It was written before any
*measurement* — the byte-identity tests and the evaluation re-run could both have failed, and either
would have rejected the iteration — but the discipline of having to predict was lost. The full
account is in [`docs/improvement-changelog.md`](docs/improvement-changelog.md).

### Versioning

Root `0.5.0` → `0.6.0`. Per-package versions stay at `0.1.0`, and `ADVANCED_VERSION` /
`BASELINE_VERSION` stay at `0.1.0` — this time on evidence rather than judgement. `systemVersion`
names *behaviour*, and byte-identity is a proof that the behaviour is the same; bumping would assert
a difference that does not exist and make results that are still valid look stale. See item 3 of
[`## Next`](#next), which is now scoped to what it actually needs.

## [0.5.0] — 2026-09-01

Iteration 4: the Interactive Product Layer. A web application, an architecture graph, a grounded
question mode and a PDF exporter, all **downstream** of the analysis pipeline. **No benchmark
improvement is claimed and none was measured**, because nothing on the measured path changed
behaviourally — see [Measurement](#iteration-4-measurement) below for what was and was not run.

### Added — `packages/app`, the analysis core

One core, two consumers. `analyzeRepository` is now the only place outside the evaluator that
decides which system runs; the CLI's `commandAnalyze` and the web server's `POST /api/analyze`
both call it, so a briefing produced in a terminal and one produced in a browser cannot come from
two different orchestrations.

- `service.ts` — the core. Adds no phase, skips none, reorders nothing: `runBaseline` and
  `runAdvanced` still own the pipeline. It carries out one extra thing, the evidence ledger *with
  text*, which two later features need and neither may guess at.
- `report.ts` — `RunRecord` → `AnalysisReport`: citations interned as `ev-001`, `ev-002`, … in
  traversal order, claims referring to them by id, per-source origin (`reconnaissance`, `scout`,
  `model-tool`, `corroboration`), six dashboard sections, run metrics. Additive: the existing
  schemas are untouched and a report is derived from a record, never in place of one.
- `architecture.ts` — `AnalysisReport` → `ArchitectureGraph`. Eleven node types, ten
  relationships, both closed sets with `assertNodeType` / `assertRelationship` rejecting anything
  else at construction. Every node and every edge carries `evidenceIds`; layout is arithmetic
  rather than a force simulation, so the same report yields the same graph.
- `questions.ts`, `question-prompt.ts` — the grounded question loop, reusing the same scout, the
  same three read-only tools, the same boundary, the same ledger and the same grounding. Bounded
  at 4 tool calls, 3 turns, 3 scout reads, 6 replayed history turns and a 1 000-character
  question. Conversation history is context and never evidence.
- `store.ts` — `AnalysisStore` (`save` / `get` / `list`) and a bounded in-memory default: 16
  entries, oldest evicted, re-saving an id does not change its age. No database.
- `workspace.ts` — `resolveRepositoryRequest`: a client-supplied repository name resolved inside
  the workspace by the **existing** boundary, plus rejections for ignored directories, missing
  paths and non-directories.
- `metrics.ts` — `ObservabilityRecorder`, three event kinds (analysis, question, export), with
  `redactSecrets` applied on record.
- `export/` — the `ReportExporter` seam, `PdfReportExporter`, and `export/pdf/writer.ts`: a
  minimal PDF 1.4 writer, no dependency and no browser. Standard fonts only, no compression,
  tabulated metrics.

### Added — `apps/web`, transport and a UI

- `server.ts` — `node:http`, loopback-only by default (`127.0.0.1:4173`). Three refusals before
  any route runs: a non-localhost `Host` → **421** (the DNS-rebinding defence), a foreign `Origin`
  → **403**, a body over 1 MiB → **413** without buffering it. Five security headers on every
  response, `default-src 'none'` among them, `cache-control: no-store`.
- `routes.ts` — eight routes, request bodies validated with `z.strictObject`. `publicAnalysis` is
  the projection that leaves the process: the run record, the ledger text and the absolute
  repository root stay in memory.
- `static.ts` — the UI's own files, held inside their directory by `resolveInsideRepository`
  rather than by a second path check. Eight allowed extensions; every failure is a 404, so "not
  allowed" is indistinguishable from "not there".
- `main.ts` — `pnpm web`, shaped like the CLI's entry point and using the same `loadConfig`,
  `loadExplorationBudget`, `loadPrecisionPolicy` and `.env` handling, so a repository analysed
  from the browser runs under the same bounds as one analysed from the terminal.
- `public/` — one HTML shell, one stylesheet, one script. No framework, no build step, no CDN:
  partly because the iteration's rule is to prefer what is already here, and partly because a CSP
  with no `unsafe-inline` and no third-party origin is only possible if nothing needs them.

### Added — three product routes and five supporting ones

`POST /api/analyze`, `POST /api/questions`, `GET /api/analysis/:id`,
`GET /api/analysis/:id/evidence/:evidenceId`, `GET /api/analysis/:id/export/pdf`, plus
`GET /api/health`, `GET /api/repositories` and `GET /api/analyses`.

An evidence id is a key into one analysis, not a path: an id from another analysis is a 404, and
the error says so — *"Evidence ids come from a report or an answered question; they cannot be
constructed."*

### Added — tests

94 new tests, 397 → **491**, all passing, offline, with the model mocked. **No existing test was
modified, weakened or deleted** — the five new files are new, and the only edit to an existing
test file is 12 added cases in `packages/shared/test/paths.test.ts`.

- `apps/web/test/api.test.ts` (36) — the routes called as functions: valid and invalid analyse
  requests, boundary rejection, retrieval, missing analysis, question execution and grounding,
  evidence lookup and scoping, PDF metadata, error shapes.
- `apps/web/test/integration.test.ts` (9) — the whole product over a real socket on a real port:
  analyse → dashboard → question → evidence → export, plus the CSP, the `Host` and `Origin`
  checks, the body cap, static-asset traversal, the workspace boundary over HTTP, and metrics.
- `packages/app/test/questions.test.ts` (14), `architecture.test.ts` (11), `pdf.test.ts` (12) —
  the unsupported-answer path, follow-ups, budget exhaustion, node and edge generation, evidence
  association, unsupported-relationship rejection, determinism, PDF structure, metadata,
  architecture and citation inclusion, unsupported-claim labelling, and redaction.
- `packages/shared/test/paths.test.ts` (+12) — the extended redaction: seven credential shapes
  found mid-excerpt, a whole PEM block, the pinned `<redacted-api-key>` wording, and the
  deliberate non-matches (a reference like `env.JWT_SECRET`, a commit hash, a uuid, a sha256
  digest, and a bare high-entropy string, which is a documented limit rather than a bug).

`vitest.config.ts` gained one line: `"apps/*/test/**/*.test.ts"`.

### Changed — additive extensions to shared code

- `runAdvanced` / `runBaseline` accept an optional `onSources` callback, invoked once after the
  evidence ledger is final. It cannot add to the ledger, nothing reads its return value, and a run
  that passes no callback behaves exactly as before. This is the **entire** footprint of the
  iteration inside the measured pipeline. The alternative — re-collecting to recover the bytes —
  was rejected as dishonest rather than slow: a second pass can produce a different ledger, and
  then the evidence panel would show text the briefing was never checked against.
- `packages/shared/src/errors.ts` — a new `RequestError` (with a `notFound` flag), so a handler
  can distinguish a caller's mistake from an operator's misconfiguration or a model's bad tool
  call without inspecting message text.
- `packages/shared/src/grounding.ts` — `createSourceResolver`, built from the same `resolveSource`
  grounding itself uses, so the layer that *displays* a citation cannot disagree with the layer
  that *verified* it about which artefact it points at.
- `packages/shared/src/paths.ts` — `redactSecrets` extended with shape-based credential patterns
  (AWS key ids, GitHub and Slack tokens, Stripe and Anthropic keys, JWTs, PEM private-key blocks),
  because an HTTP response, a metric and a PDF now leave the process carrying excerpts from files
  nobody vetted. One mechanism, not a second: the name-based rule is unchanged and deliberately
  not widened to `secret`/`token`/`password`. Verified not to alter anything on the measured path
  — every file under `fixtures/` (146, counting the generated git objects), both evaluation cases,
  both evaluator sources and all 13 reports and 36 trajectories on disk are byte-identical through
  it: 0 of 199 altered.
- `packages/shared/src/mock-llm.ts` — the mock now answers a question contract as well as a
  briefing contract, detected by schema *shape* (`answer` + `citations`) so the mock still sees
  only what a real model sees. The briefing schema has neither property, so the briefing path is
  unchanged; every citation the mock emits is quoted out of a `read_file` output really present in
  the conversation, which is what lets the whole grounded-answer path be exercised offline.
- `apps/cli/src/index.ts` — `commandAnalyze` now calls `analyzeRepository` instead of branching on
  the system itself. Same arguments, same record, same output files; the duplicated branch is gone.
  Verified by running both commands against a fixture.

<a name="iteration-4-measurement"></a>
### Measurement

**No paid evaluation run was made for this iteration, and no benchmark improvement is claimed.**

The reason is structural. Everything added sits downstream of the pipeline; the only change inside
it is an optional observer callback the evaluator does not pass. Re-measuring the same pipeline to
report the same number would be theatre, and calling the result an improvement would be worse.
Iteration 3's figures stand as the last real measurement, unedited.

`DEFAULT_MODEL` is now `gemini-3.7-flash`, which no historical run used, so a bare
`pnpm evaluate:advanced` would produce a figure comparable to nothing. A comparable pair needs
`--model gemini-3.5-flash-lite --case-delay 20` on both systems — and it would be re-measuring
code that did not change.

What was run, for compatibility rather than for a number — both offline, on the deterministic mock
provider:

| | Baseline `--mock` | Advanced `--mock` |
| --- | --- | --- |
| Run id | `eval-baseline-2026-09-01T22-56-31Z` | `eval-advanced-2026-09-01T22-56-51Z` |
| Evidence-backed task accuracy | 21.4 % (3/14) | 28.6 % (4/14) |
| Answer accuracy | 21.4 % (3/14) | 28.6 % (4/14) |
| Fabrications / dropped citations / unsupported answers | 0 / 0 / 0 | 0 / 0 / 0 |
| Failed cases | 0 / 2 | 0 / 2 |

These are **not** a measurement of any system's quality, and the harness prints its own caveat
saying so: the mock returns canned text assembled from the context it was handed. They are
reported to show both evaluation commands still execute end to end. Both figures reproduced
exactly across two independent runs, before and after the CLI was refactored onto
`analyzeRepository`, which is the check that mattered — the refactor changed how the run is
dispatched, and a difference here would have meant it changed what the run does.

Three integrity properties, each checkable: no evaluation case was modified (question,
`expectedEvidence` or keyword); the evaluator remains question-blind, and the sentinel test that
asserts no question text reaches the model still passes; and no fixture name, expected answer,
expected keyword or fixture-derived architecture relationship appears in the product layer's code.
The question mode does aim the scout at a question — that is a reader's question at runtime, and
the evaluation path never calls it.

### Versioning

Root `0.4.0` → `0.5.0`. Per-package versions stay at `0.1.0`, and `ADVANCED_VERSION` /
`BASELINE_VERSION` stay at `0.1.0` deliberately: run records stamp the *system* version, and this
iteration did not change how either system behaves. Bumping it would assert a difference that does
not exist and would stamp a new version on results measured under the old one. Item 3 of
[`## Next`](#next) belongs to the next *measured* iteration, before its runs.

## [0.4.0] — 2026-08-31

Iteration 3: the Evidence Precision Pass. Measured, and **kept** — 100.0 % evidence-backed task
accuracy against Iteration 2's 85.7 % on the same model, seed and cases, for **zero additional
tokens**. On the stronger `gemini-3.5-flash` the advanced system ties its own baseline at 78.6 %;
both runs are reported below.

### Added — the evidence precision pass

A deterministic pass between schema validation and grounding. No model call, no embeddings, no
index, no file opened. It edits only citations the model already produced, using only artefacts
already in the evidence ledger.

- `packages/shared/src/precision/`: `score.ts` (six-signal lexical citation scoring, used to
  *order* citations, never to decide the metric), `corroborate.ts` (finds ledger sources whose
  lines share distinctive stemmed terms with a claim), `policy.ts` (three bounds), `precision.ts`
  (the pass), `index.ts`.
- **Hygiene half** — exact-duplicate removal, same-source same-location redundancy removal, stable
  score-descending order with the model's own ordering as tiebreak. Provably cannot remove a
  `(source, location)` pair from a claim, so it cannot lower a best-of metric.
- **Corroboration half** — up to `maxCorroborations` extra ledger sources per claim, each needing
  a line that shares at least `minCorroborationTerms` distinctive terms. The excerpt is a verbatim
  prefix of that line, so grounding re-verifies it like any other citation. This is the only half
  that can move the primary metric, and the only half that carries risk.
- **Content kinds only**, so existence evidence is never upgraded into content evidence. **No
  invented `location`**, because the ledger holds a raw slice whose first line is not necessarily
  line 1 of the file. **Never rescues an unsupported claim**: the gate is
  `distinct.some(isVerifiable)`, so a claim whose every citation is unverifiable stays unsupported
  rather than having real evidence attached to a fabricated statement.
- `meta.exploration.precision` on every advanced run record: claims inspected, citations before and
  after, duplicates removed, redundant removed, corroborations added, claims corroborated, and the
  sources corroborated from. The counts reconcile exactly —
  `after = before − duplicates − redundant + corroborations` — and that identity is asserted in the
  tests.

### Added — `createCitationVerifier` in the grounding layer

`packages/shared/src/grounding.ts` exports a "would this citation survive grounding?" predicate
built from the same `verify` the grounding layer itself uses, so a caller running *before*
`groundAnalysis` cannot answer the question differently. It reports; it does not act. Dropping a
citation and recording why remains `groundAnalysis`'s job alone.

This exists because an **existing test failed**: `advanced.test.ts` "marks the claim unsupported
when its only citation is dropped" went red when the first corroboration gate was
`distinct.length === 0`, which let a claim whose single citation was a hallucinated path qualify for
corroboration — laundering a hallucination into a supported claim. Fixed in the implementation, not
the test.

### Added — three precision bounds

`--max-corroborations` (2), `--min-corroboration-terms` (2), `--max-corroboration-chars` (240),
each settable by flag or `REPO_ARCHAEOLOGIST_MAX_CORROBORATIONS` /
`REPO_ARCHAEOLOGIST_MIN_CORROBORATION_TERMS` / `REPO_ARCHAEOLOGIST_MAX_CORROBORATION_CHARS`.
Thirteen bounds total. `--max-corroborations 0` is accepted, and is the experiment's control: the
same system with the hygiene half only. Zero is rejected for both thresholds, where it would mean
"any line of any file corroborates any claim".

### Added — tests

35 new tests, 362 → **397**, all passing. 27 in `packages/shared/test/precision.test.ts` covering
content-beats-existence, relevance and specificity, the four removal rules, the
never-lose-a-`(source, location)`-pair invariant, corroboration limits, the grounding contract and
the summary identity; 8 in `packages/shared/test/config.test.ts` for the policy loader. Two
existing assertions were extended, neither weakened: the advanced trajectory now expects a
`refine-evidence` action, and a new assertion pins it *before* `ground-evidence` — reversing the two
would let an unverified citation reach the briefing.

One test asserts generality directly: it reads the four precision source files, strips comments, and
fails if the code mentions `README`, `package.json`, `case-00`, `pyflow`, `expectedEvidence` or
`expectedKeywords`. No question text, expected keyword or expected-evidence list reaches the pass.

### Changed

Pipeline is now collect context → scout → reconnaissance → exploration turns → synthesis → validate
schema → **evidence precision** → grounding → briefing. Nothing before synthesis changed: no prompt
edit, no scout change, no budget change, no change to the Gemini protocol implementation. The whole
delta is attributable to one deterministic function.

### Measurement

Two paired runs, because the task's commands name `gemini-3.5-flash` while Iteration 2 was measured
on `gemini-3.5-flash-lite`. Both are reported.

Like-for-like, `gemini-3.5-flash-lite`, seed 7, thinking `low`, same unmodified cases:

| | Iteration 2 | Iteration 3 | Δ |
| --- | --- | --- | --- |
| **Evidence-backed task accuracy** | **85.7 % (12/14)** | **100.0 % (14/14)** | **+14.3 pts** |
| Answer accuracy | 100.0 % (14/14) | 100.0 % (14/14) | 0 |
| Cases fully cited | 0 / 2 | 2 / 2 | +2 |
| Fabrications / dropped / unsupported claims | 0 / 0 / 0 | 0 / 0 / 0 | 0 |
| Mean evidence relevance | 0.7321 (n=14) | 0.4105 (n=14) | −0.3216 |
| Tokens | 56 795 in / 6 400 out | 56 795 in / 6 400 out | **0** |
| Cost | $0.033038 | $0.033038 | **$0** |

The mandated commands, `gemini-3.5-flash`:

| | Baseline | Iteration 3 | Δ |
| --- | --- | --- | --- |
| **Evidence-backed task accuracy** | **78.6 % (11/14)** | **78.6 % (11/14)** | **0** |
| Answer accuracy | 85.7 % (12/14) | 92.9 % (13/14) | +7.1 pts |
| Fabrications / dropped / unsupported claims | 0 / 0 / 0 | 0 / 1 / 1 | +0 / +1 / +1 |
| Mean evidence relevance | 0.9212 | 0.4848 | −0.4364 |
| Cost | $0.051115 | $0.230209 | ×4.50 |

```sh
pnpm evaluate:baseline -- --model gemini-3.5-flash --case-delay 20
pnpm evaluate:advanced -- --model gemini-3.5-flash --case-delay 25
pnpm evaluate:advanced -- --model gemini-3.5-flash-lite --case-delay 25
```

Run ids `eval-baseline-2026-08-31T05-51-52Z`, `eval-advanced-2026-08-31T05-53-01Z`,
`eval-advanced-2026-08-31T06-18-59Z`.

The `flash-lite` token counts are identical to Iteration 2's **per case, to the digit**, as are the
pre-pass citation counts. The pass runs after synthesis, so the prompts were byte-identical and the
model produced the same output twice: the same model output scored 85.7 % with Iteration 2's
citations and 100 % with Iteration 3's. Two questions won, none lost, and one of the two was the
single question Iteration 2 regressed.

Reported honestly rather than quietly: on `flash` the advanced system ties its baseline, three
questions moving each way; all three losses scored `citedEvidence = 0`, meaning the evaluator found
no single claim answering the question, which the pass cannot fix because it edits citations rather
than writing claims. The one dropped citation and one unsupported claim on that run were the
model's own paraphrased README quote, left alone by the rule that refuses to corroborate a claim
with nothing verifiable on it — the integrity property working, showing up in the metrics as a
regression. Mean evidence relevance fell by a third: the pass multiplies citations by 2.71 and
relevance divides by the pool.

Full decomposition, the attribution argument and the decision in
[`docs/improvement-changelog.md`](docs/improvement-changelog.md).

## [0.3.0] — 2026-08-31

Iteration 2: the Evidence Scout. Measured, and **kept** — 85.7 % evidence-backed task accuracy
against the baseline's 64.3 %, the first change in this project to earn an improvement claim from
a paired run.

### Added — the Evidence Scout

A bounded, deterministic search phase that runs **before** the model gets a turn. It exists
because Iteration 1 gave the model a `search_code` tool and it used it **zero** times out of
seven calls, guessing filenames from the directory tree instead.

- `packages/shared/src/scout/`: `terms.ts` (text → weighted search terms), `lexicon.ts` (stop
  words, technical vocabulary, synonym table, concept seeds), `rank.ts` (search hits → scored
  candidates), `scout.ts` (the phase itself).
- **No model call.** Term extraction is tokenize → drop stop words → keep tokens of three
  characters or more → detect adjacent compounds → apply the synonym table → sort by weight,
  ties broken alphabetically. Adding a Gemini call to generate search terms was explicitly
  rejected: it would have bought nondeterminism and per-run cost for something a stop-word list
  does.
- **Additive, not a replacement.** The reconnaissance prompt still carries tree, README, manifest
  and metadata verbatim; scout evidence is appended as its own block. Iteration 1's one genuine
  loss came from depth crowding out breadth, so the fix could not be another substitution.
- **One door into the ledger.** The scout's reads go through the same `read_file`, the same
  `resolveInsideRepository` boundary check, the same truncation limits and the same
  `ledger.recordAll` as the model's own calls. There is no privileged path.
- **A floor, not a ceiling.** The model keeps all three tools afterwards, and the agent
  instructions now tell it to search for a symbol or concept before opening arbitrary files. In
  the measured run it read six more files in `orders-api` and two more in `pyflow` after the
  scout finished.
- `meta.exploration.scout` on every advanced run record: terms extracted, searches run, searches
  with a match, candidates ranked, files read, bytes read, candidates skipped. Reported beside
  the model's tool calls and never summed into them — the scout's cost is fixed and declared
  while the model's budget is discretionary.

### Added — `--focus`, and why evaluation does not use it

`--focus "<question>"` aims term extraction at a question the user already has. It is rejected
with a `ConfigError` on any command other than `advanced`.

Evaluation deliberately does **not** pass it. The harness never shows a system the questions it
is scored on — `evaluation/test/run.test.ts` asserts this — and feeding them to the scout would
hand the advanced system an answer key the baseline never gets. Under evaluation the scout derives
terms from the repository's own documentation instead: README emphasis, manifest vocabulary, path
components. **Every measured number below comes from that question-blind configuration.**

### Added — three scout budget bounds

`maxScoutTerms` (14), `maxScoutSearches` (14), `maxScoutFiles` (4), each settable by flag or
`REPO_ARCHAEOLOGIST_MAX_SCOUT_*`. Ten bounds total.

**Zero is accepted for these three and still rejected for the rest.** The asymmetry is the
experiment's control condition: `--max-scout-files 0` switches the search phase off, and an
experiment whose control is unreachable from the command line is not reproducible.
`--max-tool-calls 0` remains rejected because it leaves the agent unable to look at anything at
all. The two rejections carry different hints and a test asserts they stay different.

`maxScoutTerms: 14` is a measured default. At 28 terms the extra low-weight terms pulled the
ranking off the files that mattered on both fixtures — `pyflow` dropped `pyflow/cli.py` from its
top four, `orders-api` dropped `src/lib/events.js` — while runtime stayed flat across 14 / 28 / 40
terms. The bound is doing signal work, not cost work.

### Added — tests

70 new tests, **362 total across 16 files**, all offline. `packages/shared/test/scout.test.ts`
(43) covers term extraction (stop-word removal, technical terms preserved, compounds,
determinism, empty and very short input), search (search is actually invoked, every term
searched, duplicate files removed, results bounded, repository boundaries respected), ranking
(exact matches rank higher, multi-term matches rank higher, implementation files can outrank
generic documentation, deterministic order), and reading (only bounded candidates read,
truncation preserved, read evidence enters the ledger). `packages/shared/test/config.test.ts`
(12) covers the budget loader including the zero asymmetry above.

One integration test walks `question → scout → search → candidate → read → ledger → synthesis
→ grounding` end to end in the mock environment. Another reproduces the Iteration 1 failure
specifically: the question *"How is a step's declared type mapped to the function that runs
it?"*, the term `registry`, and the assertion that search discovers the file, `read_file` reads
it, and the final answer cites the actual implementation evidence.

### Fixed — two more Gemini protocol errors, both pre-existing

Neither was introduced by Iteration 2, and neither can fail against a mock. The first crashed
the first attempt at this iteration's evaluation, which is how they were found.

- **A turn's function calls must all precede their results.** Replaying them chronologically —
  call, result, call, result — earns `400 Request contains an invalid argument`. Confirmed by an
  A/B probe against the live API: interleaved → 400, grouped → OK. The exploration loop now
  collects `callSteps` and `resultSteps` within a turn and appends them grouped; tools still
  execute in the order the model asked, and the ledger and trajectory still record them that
  way. Fixed in the caller rather than the adapter, because a flat `ConversationStep[]` cannot
  distinguish one turn that made two calls from two turns that each made one.

  **This was latent, not new.** It only fires when the model asks for two files in one turn, and
  Iteration 1's measured run never did. Iteration 2 gave the model enough context to start
  batching its reads, which is what exposed it.
- **A `model_output` must carry text.** An empty one earns `400 Missing text in content of type
  text`. The new exported `toApiInput` in `packages/shared/src/llm.ts` drops blank and
  whitespace-only model steps for every caller. `generateStructured` — the baseline's path — was
  not touched, so the previously recorded baseline figures stayed valid.
- A budget-refused call was emitting a `function_result` with no matching `function_call`. The
  refused call now gets its `toolCall` step too, because a result whose call is missing is a
  malformed turn rather than a shorter one.

`packages/shared/test/llm.test.ts` (8 tests) and one advanced test now pin all of these offline.

### Measurement

Both systems, 14 questions, `gemini-3.5-flash-lite`, seed 7, thinking `low`, same unmodified
cases, 0 failed cases:

| | Baseline | Iteration 1 | Iteration 2 |
| --- | --- | --- | --- |
| **Evidence-backed task accuracy** | **64.3 % (9/14)** | 57.1 % (8/14) | **85.7 % (12/14)** |
| Answer accuracy | 85.7 % (12/14) | 85.7 % (12/14) | 100.0 % (14/14) |
| Cases passed | 0 / 2 | 0 / 2 | 2 / 2 |
| Unsupported answers | 2 | 1 | 0 |
| Mean evidence relevance | 0.85 (n=10) | 0.68 | 0.7321 (n=14) |
| Fabrications / dropped citations | 0 / 0 | 0 / 0 | 0 / 0 |
| Cost | $0.011935 | $0.024957 | $0.033038 |

```sh
pnpm evaluate:baseline -- --model gemini-3.5-flash-lite --case-delay 20
pnpm evaluate:advanced -- --model gemini-3.5-flash-lite --case-delay 25
```

Run ids `eval-baseline-2026-08-31T03-44-47Z`, `eval-advanced-2026-08-31T04-03-32Z`. The baseline
run reproduced its 0.2.0 figures exactly, token counts and cost included.

Four questions became evidence-backed, one regressed, and two previously-wrong answers became
right. `pyflow/q6-step-dispatch` — the question that motivated both iterations, and which failed
on the baseline *and* on Iteration 1 — was fixed by the term `dispatch`, drawn from the
repository's own documentation, matching `pyflow/steps/__init__.py`. Notably the
`dispatch → registry` synonym entry never fired; the win did not depend on the one part of the
lexicon written with fixture knowledge behind it.

Reported honestly rather than quietly: `pyflow/q3-execution-order` regressed on the same
citation-substitution artefact that cost Iteration 1 three questions, and mean evidence relevance
fell — a precision measure averaged over different numbers of questions for the two systems, which
also penalises a claim for citing three verified sources where the case named one. Like-for-like
the decline is 0.075, and every extra citation was grounded.

Full decomposition and the decision in
[`docs/improvement-changelog.md`](docs/improvement-changelog.md).

## [0.2.0] — 2026-08-31

Iteration 1: targeted repository exploration. Measured, and **rejected as an improvement** — it
scored 7.1 points below the baseline on the primary metric. The code ships unpromoted; the
number stands as measured.

### Added — the advanced system

- `advanced/`: `runAdvanced`, same `(repositoryPath, config) → RunRecord` contract as the
  baseline, selectable with `--system advanced`. Reconnaissance → bounded exploration loop →
  synthesis → schema validation → grounding.
- Two-phase turn structure: exploration turns carry tools and no response schema, the synthesis
  turn carries the schema and no tools. Asking for conforming JSON while tools are available
  makes "call a tool" unrepresentable as an answer.
- **Evidence ledger.** Starts as the four reconnaissance sources and grows *only* when a tool
  returns bytes. Grounding runs against the ledger, so a citation naming a file the model never
  opened is dropped and the claim is marked unsupported. There is no other path into the ledger
  — that single fact is the whole fabrication defence.
- `meta.exploration` on every advanced run record: turns, tool calls, failures, `callsByTool`,
  `filesRead`, `bytesFromTools`, `budgetExhausted`, and the full budget used.

### Added — three read-only tools

- `search_code` — literal, case-insensitive substring search with surrounding context lines.
  No regex, which keeps it deterministic and makes catastrophic backtracking impossible.
  Returns locations, never citable content.
- `read_file` — line-numbered read with optional line range. The **only** tool producing citable
  evidence. Returns two representations from one call: the numbered form for the model, the raw
  slice for the ledger, because verifying a multi-line quotation against gutter-interleaved text
  would drop truthful citations.
- `list_directory` — bounded-depth listing.
- All three resolve through `resolveInsideRepository`, which rejects absolute paths, `..`
  traversal, null bytes, and symlinks whose target escapes the root. `.git`, `node_modules` and
  vendor directories are skipped, so git history cannot be smuggled in through the file tools.

### Added — exploration budget

Seven bounds, each settable by flag or `REPO_ARCHAEOLOGIST_MAX_*` environment variable:
`maxToolCalls` (12), `maxTurns` (8), `maxSearchResults` (20), `maxFileLines` (400),
`maxFileBytes` (24 000), `maxListEntries` (200), `maxListDepth` (3). A budget of zero is
rejected with a hint. Exhausting the call budget returns an explicit error result to the model
rather than dropping the call, because an unanswered function call leaves the model waiting
forever.

### Added — trajectory

Model prose and tool output are recorded in **separate fields** — `modelText`, `toolArgs`,
`toolResult`, `ok` — never merged. That separation is what lets a reader answer "did the model
see this, or invent it?" without trusting either. `redactSecrets` runs on every write; no
credential reaches a trajectory file.

### Added — CLI and runner

- `pnpm repo:advanced` and `pnpm evaluate:advanced`, plus `--case-delay` and the seven budget
  flags.
- `latest-advanced.{json,md}` written alongside `latest-baseline.*`, never overwriting it.
- `EVALUABLE_SYSTEMS` now `["baseline", "advanced"]`. `runSystem` remains the only code that
  branches on system identity.

### Added — tests

93 new tests, 292 total across 13 files, all offline. Covering: each tool's behaviour and
output format, repository boundary enforcement, path-traversal rejection, symlink escape,
binary and lockfile refusal, line and byte truncation with truncation indicated, malformed tool
calls, invalid and missing tool arguments, budget exhaustion, trajectory recording, grounding of
tool-derived evidence, and the advanced record's compatibility with the unmodified evaluator.

One test exists specifically because its failure mode is invisible offline: a provider
continuation token must be replayed verbatim, in order, at the head of the model's turn.

### Fixed — three Gemini tool-use protocol errors

None of these could be caught offline; all three were found by running against the live API.

- **`requires_action` was treated as a failure.** It is not: when the model calls a function the
  interaction parks there, waiting for the caller to return a result. Rejecting every
  non-`completed` status made tool use impossible, and did exactly that on the first real run.
  Now accepted, with a separate guard for `requires_action` carrying no call to act on.
- **The signed `thought` step must be replayed.** Gemini rejects the turn after a function call
  with a 400 if the signature is not echoed back. `ToolTurnResponse.providerSteps` carries it as
  an opaque token — never read, never cited, never surfaced as model prose. Function calls and
  results are deliberately excluded, because the harness reconstructs those from its own record
  of what it executed.
- **The thought step must come first in the replayed turn.** Prose or a call ahead of it earns
  `Model turns with thought summaries must start with a thought block in thinking models`.

### Changed

- Retry backoff now splits by cause: a 429 waits for the quota window to roll over
  (15 s / 30 s / 60 s), everything else retries in milliseconds. Identical for both systems — a
  harness more patient with one of them would be measuring its own retry loop.

### Measurement

Both systems, 14 questions, `gemini-3.5-flash-lite`, seed 7, thinking `low`, 0 failed cases:

| | Baseline | Advanced |
| --- | --- | --- |
| **Evidence-backed task accuracy** | **64.3 % (9/14)** | **57.1 % (8/14)** |
| Answer accuracy | 85.7 % (12/14) | 85.7 % (12/14) |
| Mean evidence relevance | 0.85 | 0.68 |
| Fabrications / dropped citations | 0 / 0 | 0 / 0 |
| Cost | $0.011935 | $0.024957 |

```sh
pnpm evaluate:baseline -- --model gemini-3.5-flash-lite --case-delay 20
pnpm evaluate:advanced -- --model gemini-3.5-flash-lite --case-delay 25
```

Two questions improved exactly as hypothesised; three regressed because the agent cited the
implementation where the case expects the README; one regressed genuinely, going deep on one
flow and missing a detail the baseline caught. The agent never called `search_code` once.

Full decomposition and the decision in
[`docs/improvement-changelog.md`](docs/improvement-changelog.md). **No part of this release
claims an improvement over the baseline.**

## [0.1.0] — 2026-08-30

The foundation: project skeleton, baseline analyser, and evaluation harness. The advanced
agent is deliberately not built.

### Added — foundation

- pnpm workspace with five packages (`apps/cli`, `baseline`, `evaluation`,
  `packages/shared`, `packages/evaluator`) and no build step; `tsx` runs TypeScript
  directly and `tsc --noEmit` is the type gate.
- TypeScript strict mode plus `noUncheckedIndexedAccess`, `verbatimModuleSyntax` and
  `moduleResolution: "bundler"`.
- `.env.example` documenting every setting. `.env` is gitignored; no credential is
  committed. Environment loading uses Node's built-in `process.loadEnvFile()` rather than a
  dependency.
- Typed errors (`RepositoryError`, `ModelError`, `SchemaError`, `ConfigError`,
  `EvaluationError`), each carrying an optional hint printed under the message.
- `toPortablePath` so nothing written to disk carries an absolute path from the machine that
  produced it, and `redactSecrets` applied to every JSON and text write.
- Deterministic fixture builder (`pnpm setup`) producing two git repositories with pinned
  author, email and commit dates, so commit hashes are reproducible.

### Added — baseline

- `runBaseline`: shallow context collection → one prompt → one model call → schema
  validation → citation grounding. Five trajectory steps, recorded with timings.
- Context collection limited to four sources: directory tree, README, package manifest
  (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, …) and basic metadata. No git
  history, no source files, no test execution, no tools, no second call.
- Zod schemas as the single source of truth for `AnalysisResult`, `Evidence` and
  `RunRecord`, split so the model is asked only for what it can know: `AnalysisBodySchema`
  for the model, plus a harness-supplied `repository` block.
- Gemini client on the Interactions API (`ai.interactions.create`) with a JSON
  `response_format` and a seed for reproducibility, alongside an offline deterministic
  `mock` provider requiring no key and costing nothing.
- Evidence grounding: a citation survives only if its source was in the context supplied and
  its excerpt actually appears there. Everything else is deleted from the briefing and
  recorded in `evidenceAudit.dropped` with a reason. A claim left with no evidence is kept
  and **marked unsupported** rather than hidden.
- Markdown briefing renderer that flags unsupported claims inline.

### Added — evaluation harness

- Case format in Zod, with three separable expectations per question:
  `expectedKeywords` / `anyOfKeywords`, `expectedEvidence`, and `mustNotContain`.
- Four measures per question — correct answer, evidence-backed answer, unsupported claim,
  evidence relevance — with **evidence-backed task accuracy** as the primary metric.
- Content-versus-existence evidence strength: a `tree` citation proving a file exists earns
  `partialEvidence`, never the primary metric. This is what stops a shallow system from
  scoring like one that read the file.
- Evidence credited per claim rather than per briefing, so keywords matched across two
  separate claims earn nothing and say so in a note.
- A case that fails to load is rejected, not skipped; a case whose run crashes is scored zero
  across its questions rather than dropped. Both rules protect the denominator.
- Reports written to `evaluation/results/` as timestamped JSON plus a Markdown summary, and a
  stable `latest-baseline.{json,md}` pair. Every report carries run id, provider, model, seed,
  thinking level, timings, token usage, cost estimate and Node version.
- Cost reporting that distinguishes "unknown" from "$0.000000", and reports a lower bound when
  only some runs could be priced.
- Automatic caveats: mock-provider runs are labelled as pipeline verification and not a
  measurement; small datasets are flagged; failed cases are named.

### Added — CLI

- `pnpm repo:baseline -- <path>` and `pnpm evaluate:baseline`, plus `--mock`, `--model`,
  `--seed`, `--thinking`, `--max-output`, `--out`, `--cases`, `--case`, `--system`, `--quiet`
  and `--help`.

### Added — tests

- 199 tests across 11 files, all offline: Zod schema contracts, context collection (including
  missing README, missing manifest and empty repository), malformed model output, grounding,
  path portability and secret redaction, evaluation scoring, case loading, aggregation and
  report rendering, the baseline end to end, schema parity between the JSON schema sent to
  Gemini and the Zod shapes, and the evaluation runner end to end.
- Runner tests pin the properties that make a reported number trustworthy: the analyser never
  sees the questions it is scored on, the same inputs produce an identical report, and the
  file written to disk equals the report returned in memory.

### Fixed

- `redactSecrets` did not redact a JSON-serialised credential (`"GEMINI_API_KEY": "…"`),
  because the closing quote sits between the name and the colon — precisely the shape a key
  would take if it reached a written report. Found by a test, not by inspection. The
  replacement now emits a quoted placeholder so the surrounding JSON stays parseable, and the
  name pattern also catches the camelCase `apiKey` a config object would use.

### Not included, deliberately

Multi-tool agent, git-history analysis, source-file reading, test execution, verification
passes, authentication, web dashboard, database, Docker, Kubernetes, cloud deployment, and
vector search. The harness comes first so the agent has a number to move.

### Measurement status

**No evaluation run against a real model has been executed.** The pipeline has been verified
end to end with the offline mock provider only, and those figures measure the harness and its
canned text rather than any model's quality. There is no baseline result to report yet, and
nothing in this release claims the results are good.

> Superseded by 0.2.0: the baseline has since been measured at **64.3 %** evidence-backed task
> accuracy on `gemini-3.5-flash-lite`, seed 7. Left unedited above, because a changelog that
> revises its own history is not a record of anything.

---

## Next

Iteration 6 closed items 1 and 3 and left item 1 below as the change with evidence behind it.
**Iteration 7 made that change, measured it, and rejected it** — which closes the item as a
question rather than as a success, and rewrites what comes next.

1. ~~**Test the synthesis-granularity hypothesis.**~~ **Done, and rejected.** Challenge
   evidence-backed accuracy went 29.2 % → 25.0 % against a +8 pp threshold; exactly one question of
   38 changed outcome and it changed PASS → UNCITED; fabrications stayed at 0, so the stated risk
   was not what went wrong. The prompt is reverted. What the negative result teaches is that
   "the expected evidence was in context" is a much weaker claim than "the model had established
   the fact", and that a **question-blind** synthesis step cannot be instructed to organise itself
   around a question it never sees.

   The successor is therefore not another prompt edit, and Iteration 7's own constraints forbid
   stacking one. Two directions remain, and they are architectural rather than lexical:

   - **Give claims somewhere to put a literal.** Three of the 17 failures are unreachable by any
     prompt because `selectClaims` emits one claim per dependency entry, so a question needing two
     dependency names in a single claim cannot be answered by better writing. That is a schema and
     claim-selection question, and changing either changes what the evaluator consumes — so it needs
     its own iteration and its own frozen-baseline argument.
   - **Or accept that the briefing is not question-shaped, and measure the thing that is.** The
     product already has grounded Q&A downstream of the briefing. Whether *that* path answers the
     Challenge questions is a different measurement from whether the briefing happens to contain
     them, and it has never been run.

   Whichever is chosen: hypothesis first, one variable, and the Iteration 6 baseline stays where it
   is.
2. **Decide what mean evidence relevance is for, and then fix corroboration to respect it.** It has
   moved the wrong way twice while the primary metric moved the right way, the second time by a
   third of its value: the precision pass adds two corroborations per claim unconditionally up to
   the cap, so a claim that cited exactly the expected source drops from 1.0 to 0.3333 for being
   *better* supported. Either report it over a fixed denominator, or split precision from coverage,
   or stop treating a verified-but-unexpected citation as a miss — and make corroboration
   conditional on the claim's existing citations being weak rather than unconditional. The bounds
   already exist (`--max-corroborations`); what is missing is a rule for when to spend them.

   Iteration 6 gives this a second reason to matter: mean evidence relevance was 0.4007 across the
   expanded benchmark, and the failure analysis found citations attaching to import lines rather
   than defining lines. Whether that is the metric being wrong or the citations being wrong is
   currently unresolved, and it is the kind of question a 38-question dataset can now answer.
3. **A third fixture, in a language neither current one uses.** Carried forward from the closed
   item 1, because expanding the *questions* did not expand the *repositories*. Both fixtures are
   still JavaScript and Python, so nothing yet tests whether the scout's term extraction
   generalises past that vocabulary — and the multi-language category currently scores 0 of 2,
   which is suggestive but is two questions, not a finding.
4. **Then re-measure.** Hypothesis first, in
   [`docs/improvement-changelog.md`](docs/improvement-changelog.md), **before any code changes.**
   That ordering is the reason Iteration 1 could be rejected without argument and Iterations 2 and 3
   could be kept without special pleading — and the reason Iteration 3's stated mechanism could be
   contradicted on the evidence rather than followed off a cliff. Iteration 5 broke it and says so
   in its own entry; the compensating control (the hypothesis still preceded the measurement, and
   the measurement could have failed) is a smaller thing than the rule, not a substitute for it.
   Iteration 6 restored it in the strongest available form: it measured before writing a single
   line of analysis code, and the measurement is what stopped it from writing any.

   When reporting, report **per set**. A combined average across a saturated set and a
   discriminating one is the one number that can hide a regression, and it moves when the ratio
   between the sets changes even though nothing about the system did.

Item 5 — *"give an analysis somewhere to live"* — was **closed** by Iteration 5: a SQLite adapter
behind the `AnalysisStore` seam, exactly as the item specified, with no change to the analysis. Two
things it deliberately did not do, carried forward as the product layer's own list rather than the
metric's:

5. **The store is single-process.** WAL and `busy_timeout` make a second writer safe rather than
   fast, and nothing coordinates two servers sharing one file. That is correct for a local tool and
   would be wrong for anything shared — and "anything shared" would also open the questions of
   authentication and multi-tenancy that this project has deliberately left closed.
6. **Nothing prunes the database.** An analysis lives until someone deletes it, and a report plus a
   graph plus an evidence projection is not small. `MAX_STORED_QUESTIONS` bounds one axis; the
   number of analyses is unbounded by design, because a tool that silently discards the analysis you
   wanted is worse than one whose file grows. A retention policy is a decision for whoever has too
   many, not a default worth guessing at.
7. **No test had ever rendered the dashboard. Now one does, and it is not a browser.** `0.6.1`
   closed the cheap half: the shipped files are checked for the failures that need no DOM — does
   `app.js` parse, is every import reached, does every id have a host, does every class have a rule.
   Iteration 6 closed the next half with `apps/web/test/browser-smoke.test.ts`, which executes the
   shipped script against a jsdom document and drives the real markup the server serves.

   What remains open is what jsdom cannot see. There is no layout, no paint, no CSS cascade and no
   real network stack, so a control rendered off-screen, an element hidden by a stylesheet, a font
   that never loads, or a behaviour that only appears under a real event loop all pass. The suite
   proves the shipped script boots against the shipped markup and wires its handlers to elements
   that exist — the class of defect that shipped in `0.6.0` — and it is **not** equivalent to a
   browser test.

   **This is no longer a hypothetical, and the cost estimate was wrong.** `Unreleased` pointed a
   real headless Chrome at the page for the first time and found the drawer painting over half the
   workspace from boot — a defect that shipped in `0.6.0`, survived both suites written to catch
   exactly this, and was visible in the first screenshot. jsdom resolves `hidden` ahead of the
   cascade, so the smoke suite's `getAttribute("hidden")` reported a drawer opening and closing
   correctly while a browser showed one that never shut. That is the difference between the two
   tools, stated as a defect rather than as a caveat.

   It also cost far less than "the project's first heavyweight dev dependency" assumed. No
   dependency was added: Chrome was already on the machine, and ~140 lines of Python drove it over
   the DevTools protocol — navigate, run a setup expression, read `getBoundingClientRect` and
   `getComputedStyle`, capture a PNG. **The narrowed item is to make that a checked-in gate**, with
   the browser discovered rather than downloaded and the suite skipping cleanly when there is none,
   asserting the handful of geometric facts no other suite can reach: `[hidden]` elements measuring
   0×0, the drawer sharing the row rather than overlapping `main`, nothing overlapping the top bar,
   and the empty state landing in the workspace. A scratch script that found a shipped defect and
   was then deleted is a gate the project had for one afternoon.

8. **A cancelled run still finishes its pipeline.** `0.6.2` made a delete stop the *persistence* of
   a running analysis, which is the half that was corrupting state. The model calls already issued
   still complete, and their output is thrown away — wasted tokens and, with a slow provider, a
   worker busy for a minute on a result nobody will see. Interrupting the pipeline itself means
   threading an `AbortSignal` through `analyzeRepository` into the tool loop, which is the measured
   path; it is a real improvement and it is not a lifecycle fix, so it belongs to an iteration that
   is allowed to re-measure.

9. **The mid-run delete has never been raced against a real provider.** It is proven over a real
   socket against a real database file, and against the mock, which finishes too fast to race. The
   original log came from `gemini-3.5-flash`, and reproducing the *original* conditions needs an API
   key this environment does not have. Worth doing once, deliberately, next time a paid run happens
   anyway.

10. ~~**The delete confirmation focuses the destructive button.**~~ **Closed by `Unreleased`.**
    *Cancel* takes the focus and comes first in source order, so the tab order and the reading
    order agree with it. The condition this item set for itself — "changing focus behaviour without
    a test that renders the page is how `0.6.0` happened" — was met before the change: the page is
    rendered by `browser-smoke.test.ts`, which clicks the real Delete button and asserts
    `document.activeElement`, and the assertion was watched to fail against the old behaviour.

11. **Nothing has re-measured since the benchmark gained headroom.** `0.7.0` built a dataset that
    can disagree and then deliberately spent none of it; `Unreleased` changed only the product
    layer, so there is still no measurement against the 38-question set except the unchanged
    system's. Item 1 remains the one with evidence behind it, and it remains untouched — which is
    the right order, and is also now two iterations of not doing the thing the instrument was
    sharpened for.
