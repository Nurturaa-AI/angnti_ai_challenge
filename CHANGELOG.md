# Changelog

All notable changes to Repo Archaeologist. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

Nothing yet. See [`## Next`](#next) for what the following iteration has to address.

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

`0.6.1` added item 7 and closed the narrowest part of it. Iteration 5 closed item 5 and sharpened
item 3. Items 1, 2 and 4 are carried forward unchanged in substance, because nothing in Iteration 5
addressed them — it was a durability iteration, measured against the claim that it left the pipeline
alone.

1. **Grow the dataset. This is blocking, and has been for two iterations.**
   `gemini-3.5-flash-lite` is at 14/14, so the primary metric has no headroom left on this dataset
   and the next iteration cannot be measured on it at all — any change would score 100 % or worse,
   and a tie tells you nothing. `gemini-3.5-flash` sits at 11/14 and is a harder test, but its three
   remaining failures are all `citedEvidence = 0`, which is a synthesis problem rather than a
   citation one. A third fixture in a language neither current one uses would also test whether the
   scout's term extraction generalises past JavaScript and Python vocabulary. **Nothing else on this
   list is worth doing first.** The default model is now `gemini-3.7-flash`, so the next measured run
   needs an explicit `--model` on both systems to compare with anything recorded above.
2. **Decide what mean evidence relevance is for, and then fix corroboration to respect it.** It has
   moved the wrong way twice while the primary metric moved the right way, the second time by a
   third of its value: the precision pass adds two corroborations per claim unconditionally up to
   the cap, so a claim that cited exactly the expected source drops from 1.0 to 0.3333 for being
   *better* supported. Either report it over a fixed denominator, or split precision from coverage,
   or stop treating a verified-but-unexpected citation as a miss — and make corroboration
   conditional on the claim's existing citations being weak rather than unconditional. The bounds
   already exist (`--max-corroborations`); what is missing is a rule for when to spend them.
3. **Give a run record a provenance field, distinct from `systemVersion`.** Sharpened, because two
   iterations of deferral have shown the original wording asked for the wrong thing. The real
   problem is unchanged: every result record reports `systemVersion` `0.1.0` for the advanced system
   across five iterations, so the artefacts on disk cannot tell you which iteration produced them.
   But bumping `ADVANCED_VERSION` is not the fix — it names *behaviour*, and Iterations 4 and 5
   changed none, so a bump would assert a difference that does not exist and stamp a new version on
   results still valid under the old one. What is needed is a separate field — a commit sha, or an
   iteration number — that answers "which code produced this?" without claiming "this behaves
   differently". **Do it at the very start of the next measured iteration, before any run.** It
   changes the run record's shape, which is exactly the kind of change that has to be paid for by a
   real measurement rather than slipped in beside one: adding it today would break the byte-identity
   property Iteration 5 just established, and that property is currently the only proof that two
   iterations of product work left the pipeline alone.
4. **Then re-measure.** Hypothesis first, in
   [`docs/improvement-changelog.md`](docs/improvement-changelog.md), **before any code changes.**
   That ordering is the reason Iteration 1 could be rejected without argument and Iterations 2 and 3
   could be kept without special pleading — and the reason Iteration 3's stated mechanism could be
   contradicted on the evidence rather than followed off a cliff. Iteration 5 broke it and says so
   in its own entry; the compensating control (the hypothesis still preceded the measurement, and
   the measurement could have failed) is a smaller thing than the rule, not a substitute for it.

Item 5 — *"give an analysis somewhere to live"* — is **closed** by Iteration 5: a SQLite adapter
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
7. **No test has ever rendered the dashboard.** `0.6.1` closed the cheap half of this: the shipped
   files are now checked for the failures that need no DOM — does `app.js` parse, is every import
   reached, does every id have a host, does every class have a rule. That is enough to catch the
   whole class of defect that shipped in `0.6.0`, and it is not enough to catch the next one. Nothing
   verifies that clicking a node opens the panel, that Escape returns focus to the chip that opened
   the drawer, or that a phase event repaints the checklist — the interactions the last two
   iterations were mostly *about*. The reason is a real trade: the project has no bundler and no
   jsdom, and `ui.js` exists precisely so the decisions can be tested without a document. But
   "testable in principle" was exactly the state eleven unreachable helpers were in. A single
   headless-browser smoke test that loads the page, runs one analysis against a fixture and clicks
   three things would be worth more than another fifty unit tests, and it is the first product-layer
   item the next iteration should weigh — against the fact that it is the project's first
   heavyweight dev dependency, which is not a small thing to spend.

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

10. **The delete confirmation focuses the destructive button.** `app.js` swaps the delete control for
    a two-step confirm and moves focus to *"Delete for good"*, so a stray Enter after clicking
    Delete destroys the analysis. Correct for a keyboard user reaching the confirm deliberately,
    wrong as a default. Left alone in `0.6.2` because it is unrelated to the lifecycle bug and
    changing focus behaviour without a test that renders the page is how `0.6.0` happened.
