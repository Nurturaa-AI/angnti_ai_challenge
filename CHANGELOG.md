# Changelog

All notable changes to Repo Archaeologist. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

Nothing yet. See [`## Next`](#next) for what the following iteration has to address.

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

Iteration 4 closed none of these, and did not try to: it was a productization iteration, measured
against the claim that it left the pipeline alone rather than against the benchmark. The list below
is unchanged in substance from Iteration 3's, because nothing in Iteration 4 addressed it.

1. **Grow the dataset. This is now blocking.** `gemini-3.5-flash-lite` is at 14/14, so the primary
   metric has no headroom left on this dataset and the next iteration cannot be measured on it at
   all — any change would score 100 % or worse, and a tie tells you nothing. `gemini-3.5-flash` sits
   at 11/14 and is a harder test, but its three remaining failures are all `citedEvidence = 0`,
   which is a synthesis problem rather than a citation one. A third fixture in a language neither
   current one uses would also test whether the scout's term extraction generalises past JavaScript
   and Python vocabulary. Nothing else on this list is worth doing first. Iteration 4 raised the
   stakes on it slightly: the default model is now `gemini-3.7-flash`, so the next measured run
   needs an explicit `--model` on both systems to compare with anything recorded above.
2. **Decide what mean evidence relevance is for, and then fix corroboration to respect it.** It has
   now moved the wrong way twice while the primary metric moved the right way, and this time by a
   third of its value: the pass adds two corroborations per claim unconditionally up to the cap, so
   a claim that cited exactly the expected source drops from 1.0 to 0.3333 for being *better*
   supported. Either report it over a fixed denominator, or split precision from coverage, or stop
   treating a verified-but-unexpected citation as a miss — and make corroboration conditional on the
   claim's existing citations being weak rather than unconditional. The bounds already exist
   (`--max-corroborations`); what is missing is a rule for when to spend them.
3. **Give the advanced system a version of its own.** Still open. Every result record reports
   `systemVersion` `0.1.0` for the advanced system, unchanged across four iterations, so the run
   artefacts cannot tell you which iteration produced them. Iteration 4 deliberately left it alone
   for a different reason than Iteration 3 did: Iteration 3 had already taken its measurements and
   bumping afterwards would have stamped a new version on old results, whereas Iteration 4 changed
   no system behaviour at all, so a bump would assert a difference that does not exist. Bump
   `ADVANCED_VERSION` at the *start* of the next iteration that actually changes the pipeline,
   before any measurement, so the code and the evidence agree.
4. **Then re-measure.** Hypothesis first, in
   [`docs/improvement-changelog.md`](docs/improvement-changelog.md), before any code changes. That
   ordering is the reason Iteration 1 could be rejected without argument and Iterations 2 and 3
   could be kept without special pleading — and the reason Iteration 3's stated mechanism could be
   contradicted on the evidence rather than followed off a cliff.

One item is new, and belongs to the product layer rather than the metric:

5. **Give an analysis somewhere to live.** The in-memory store holds sixteen entries and does not
   survive a restart, which is the deliberate consequence of "no database" and is fine for a local
   tool. If the dashboard is ever to be more than that, the `AnalysisStore` interface is the seam —
   `save` / `get` / `list`, already the only thing the routes depend on — and the honest version of
   this work is a persistence adapter behind it, not a change to the analysis.

