# Architecture

Four commands, eight workspace packages, no build step. The shape is driven by one constraint:
the evaluation harness must be able to score every system with *identical* code, so that a change
in the number means a change in the system rather than a change in how it was graded.

```
      apps/cli                          apps/web  ◄── browser (public/: UI, graph, Q&A)
     baseline │ advanced │ evaluate       server, routes, static assets
         │         │          │                     │
         │         └────┬─────┼─────────────────────┘
         │              ▼     │
         └────────► packages/app  ── report · architecture graph · questions
                        │            store · metrics · PDF export
          ┌─────────────┴───────┐                  │
          ▼                     ▼                  ▼
      baseline              advanced          evaluation
          │                     │                  │
          └──────────┬──────────┘             ┌────┴─────────────┐
                     ▼                        ▼                  ▼
              packages/shared  ◄──────── packages/evaluator   (cases/, results/)
```

`baseline` and `advanced` each produce a `RunRecord`. `evaluator` consumes a `RunRecord` and
knows nothing about where it came from — it cannot tell which system produced one, which is
the property that makes the two comparable. `evaluation` is the runner that joins them.
`packages/app` is the analysis core the two *user-facing* consumers share, and `apps/web` is
transport around it. Every arrow points one way; there are no cycles and no back-channels.

The product layer (Iteration 4) is deliberately downstream of everything measured. It reads the
pipeline's output and the pipeline's evidence ledger; it does not add a phase, skip one, or
reorder any. The only change it required inside `runAdvanced` and `runBaseline` was one optional
callback that hands the finished ledger to whoever asked for it.

---

## `packages/shared` — the contract

Everything both sides must agree on, and nothing else.

| Module | Responsibility |
| --- | --- |
| [`schemas.ts`](../packages/shared/src/schemas.ts) | Zod schemas for `AnalysisResult`, `Evidence`, `RunRecord`. The single source of truth for shape. |
| [`repo.ts`](../packages/shared/src/repo.ts) | Shallow context collection: tree, README, manifest, metadata. |
| [`context-format.ts`](../packages/shared/src/context-format.ts) | Renders collected sources into the prompt block, with per-source truncation. |
| [`grounding.ts`](../packages/shared/src/grounding.ts) | Verifies citations against the supplied context. The fabrication defence. |
| [`tools/`](../packages/shared/src/tools/) | The three read-only tools, the repository boundary, and the dispatcher. |
| [`scout/`](../packages/shared/src/scout/) | The Evidence Scout: term extraction, lexicon, candidate ranking, the search-and-read phase. No model call. |
| [`json.ts`](../packages/shared/src/json.ts) | Extracts JSON from whatever the model actually returned; validates against a schema. |
| [`llm.ts`](../packages/shared/src/llm.ts) | The `LlmClient` interface and the Gemini implementation. |
| [`mock-llm.ts`](../packages/shared/src/mock-llm.ts) | An offline, deterministic, zero-cost provider. |
| [`config.ts`](../packages/shared/src/config.ts) | Environment and flag resolution; `.env` loading; config description for logs. |
| [`cost.ts`](../packages/shared/src/cost.ts) | Token usage → dollars, for the models whose prices are published. |
| [`trajectory.ts`](../packages/shared/src/trajectory.ts) | Records what a run did, step by step, with timings. |
| [`paths.ts`](../packages/shared/src/paths.ts) | Portable paths and secret redaction on every write. |
| [`errors.ts`](../packages/shared/src/errors.ts) | Typed errors carrying a hint: `RepositoryError`, `ModelError`, `SchemaError`, `ConfigError`, `EvaluationError`, `ToolError`, `RequestError`. |

### Two schemas, not one

`AnalysisBodySchema` is what the **model** is asked for. `AnalysisResultSchema` is
`AnalysisBodySchema` plus the `repository` block, which the **harness** fills in from what it
measured on disk.

The model is never asked to report the repository's file count, and so cannot get it wrong.
The same reasoning applies within `Evidence`: `source`, `type`, `location` and `excerpt` come
from the model; `grounded` and `groundingReason` are written by the grounding step
afterwards. [`baseline/test/schema-parity.test.ts`](../baseline/test/schema-parity.test.ts)
asserts the hand-written JSON schema sent to Gemini matches the Zod shapes field for field,
because those two drifting apart is the failure that would be hardest to notice.

### The `LlmClient` seam

```ts
interface LlmClient {
  readonly provider: "gemini" | "mock";
  readonly model: string;
  generateStructured(request: StructuredRequest): Promise<StructuredResponse>;
  /** Optional: a provider that cannot use tools simply omits this. */
  generateWithTools?(request: ToolTurnRequest): Promise<ToolTurnResponse>;
}
```

One interface, two implementations, injectable everywhere. This is why the entire test suite
runs offline: `runBaseline`, `runAdvanced` and `runEvaluation` all accept a `client`, so a test
can supply a stub that returns exactly the malformed JSON, the fabricated citation, the invalid
tool arguments, or the missing field under examination. No network, no key, no cost, no
flakiness.

`generateWithTools` is **optional** on purpose. A provider without it fails the advanced run
with a `ConfigError` naming the provider, rather than silently degrading to a single-shot
analysis — which would be a baseline run wearing the advanced system's label, and the worst
possible failure for a comparison.

The Gemini client uses the **Interactions API** (`ai.interactions.create`) with
`response_format.mime_type = "application/json"` and a supplied schema. `generation_config`
takes a `seed` rather than a temperature, so the seed is the reproducibility lever and is
recorded in every run's metadata.

### Five things about Gemini tool use that only a real call reveals

All five of these were found by running against the live API, and none of them can fail
offline. They are recorded here because the code that handles them looks arbitrary otherwise.

1. **`requires_action` is a success, not a failure.** When the model decides to call a
   function, the interaction does not reach `completed` — it parks at `requires_action`,
   waiting for the caller to run the tool and send the result back. Treating any non-`completed`
   status as an error makes tool use impossible; that is exactly what it did on the first real
   run. The client accepts `requires_action`, and separately guards the genuinely stuck case of
   `requires_action` with no function call to act on.
2. **The signed `thought` step must be replayed verbatim.** Gemini returns a signed thinking
   step alongside a function call and rejects the *next* request with a 400 if that signature is
   not echoed back. So `ToolTurnResponse` carries `providerSteps`, an opaque list the caller
   replays untouched. It is never read, never treated as evidence, and never surfaced as model
   prose — it is a continuation token that happens to travel as a step.
3. **The thought step must come *first* in the replayed turn.** Putting prose or a function
   call ahead of it earns `Model turns with thought summaries must start with a thought block in
   thinking models`. The exploration loop therefore pushes `providerSteps` before the model's
   own text.
4. **A turn's function calls all come before any of their results.** Replaying them in the order
   they actually happened — call, result, call, result — earns `400 Request contains an invalid
   argument`. The loop therefore collects `callSteps` and `resultSteps` within a turn and appends
   them grouped. Tools still *execute* in the order the model asked, and the ledger and
   trajectory still record them that way; only the replay is rearranged. This one is enforced in
   the caller rather than in the adapter, because a flat `ConversationStep[]` cannot distinguish
   one turn that made two calls from two turns that each made one — only the code that knows
   where its turns begin can arrange them correctly.
5. **A `model_output` must carry text.** An empty one earns `400 Missing text in content of type
   text`, which is what a turn where the model said nothing and went straight to a tool would
   produce. [`toApiInput`](../packages/shared/src/llm.ts) drops blank and whitespace-only model
   steps for every caller; such a turn contributes nothing to the history, since the function
   call it made says everything it had to say.

Rules 4 and 5 were found during Iteration 2 but were **pre-existing latent bugs**, not
regressions: rule 4 only fires when the model asks for two files in one turn, which Iteration 1's
measured run never did. [`packages/shared/test/llm.test.ts`](../packages/shared/test/llm.test.ts)
and one advanced test now pin all of them offline, which is the only way they stay fixed.

Function calls and results are deliberately *excluded* from `providerSteps`: the harness
reconstructs those from its own record of what it actually executed. That is what keeps a tool
result something the model cannot forge — see below.

---

## `baseline/` — one pass, five steps

[`runBaseline`](../baseline/src/index.ts) is a straight line, and each step appends to the
trajectory:

1. **`collect-context`** — tree, README, manifest, metadata. Nothing else is read.
2. **`build-prompt`** — render the sources, name their ids, state the citation rule.
3. **`model-call`** — exactly one call. Asserted by test.
4. **`validate-schema`** — parse the JSON out of the reply, validate, fail loudly with the
   offending field paths.
5. **`ground-evidence`** — verify every citation; drop what cannot be verified; count what
   is left unsupported.

Step 5 is the only step that can *remove* content, and the only one that writes to the audit.

### Grounding, concretely

A citation survives if its `source` resolves to one of the context source ids — with `./`
prefixes and case differences tolerated, since models write `./README.md` and `readme.md`
interchangeably — and, when it carries an `excerpt` long enough to be distinctive, if that
excerpt actually appears in that source's text (whitespace-collapsed, case-insensitive).

Anything else is deleted from the briefing and appended to `evidenceAudit.dropped` with a
reason: `source-not-in-context`, `excerpt-not-found`, or a variant noting that the source was
truncated and the excerpt may have been cut off. A claim whose evidence array empties out is
**kept** and counted in `unsupportedClaims`.

The audit travels in the run record, so a reader can always ask "what did this system try to
claim that it could not back up?" — and get a number.

---

## `advanced/` — search, then targeted exploration (Iterations 1–3)

[`runAdvanced`](../advanced/src/index.ts) keeps the baseline's five steps and inserts two things
between step 2 and step 3: a deterministic **Evidence Scout**, then a bounded exploration loop.
Iteration 3 added one more deterministic step, after the model has spoken and before grounding.

```
collect-context ─► scout-search ─► scout-read ─► build-recon-prompt
                   (deterministic, no model)              │
                                                          ▼
                                         ┌─ model turn ──┐ ─► build-synthesis-prompt
                                         │      ▲        │        │
                                         │      └─ tool ─┘        ▼
                                         └── ≤ maxTurns ──┘   synthesis-call
                                                                  │
                                              validate-schema ◄───┘
                                                     │
                                              refine-evidence   (Iteration 3: hygiene
                                                     │           + corroboration, no model)
                                              ground-evidence
```

The order of the last two is load-bearing and pinned by a test: corroboration adds citations, and
grounding is what verifies them, so reversing the pair would let an unverified excerpt reach the
briefing.

### The Evidence Scout (Iteration 2)

Iteration 1 gave the model a search tool and it used it **zero** times out of seven calls,
picking filenames out of the directory tree instead. So search stopped being an option the model
declines and became a phase that happens before the model gets a turn.

Four modules in [`packages/shared/src/scout/`](../packages/shared/src/scout/), no model call in
any of them:

| Module | Responsibility |
| --- | --- |
| [`terms.ts`](../packages/shared/src/scout/terms.ts) | Text → a weighted, bounded, ordered list of search terms. |
| [`lexicon.ts`](../packages/shared/src/scout/lexicon.ts) | Stop words, technical vocabulary, a small synonym table, concept seeds. |
| [`rank.ts`](../packages/shared/src/scout/rank.ts) | Search hits → scored, ordered candidate files. |
| [`scout.ts`](../packages/shared/src/scout/scout.ts) | The phase: search each term, dedupe, rank, read the top few, hand back artefacts. |

**Term extraction** is a six-step pipeline — tokenize, drop stop words, keep tokens of three
characters or more, detect adjacent compounds, apply the synonym table, sort by weight and break
ties alphabetically. Weights encode where a term came from (`focusTechnical` 100 down to `seed`
10), so the bound cuts the least-supported terms rather than an arbitrary tail. When nothing
survives, `CONCEPT_SEEDS` supplies a fallback so the phase never silently no-ops.

Adding a model call to generate search terms was explicitly rejected: it would have bought
nondeterminism and per-run cost for something a stop-word list does.

**Ranking** is additive and deterministic — extra matched terms, path-component matches, a
source-file extension bonus, proximity of two terms within 20 lines, and a rarity bonus for
matching a term few files matched. Ties break on path, so the same repository always yields the
same order.

**Reading** goes through the same `read_file` as the model's own calls: same boundary check, same
line and byte limits, same `ledger.recordAll`. There is no privileged path into the ledger and
no second door.

Two properties are load-bearing and easy to lose:

- **The scout is additive.** The reconnaissance prompt still carries tree, README, manifest and
  metadata verbatim; scout evidence is appended as its own block. Iteration 1's one genuine loss
  came from depth crowding out breadth, so the fix could not be another substitution.
- **The scout sets a floor, not a ceiling.** The model keeps all three tools afterwards and is
  told to search before guessing filenames. In the measured run it went on to read six more
  files in `orders-api` and two more in `pyflow`.

**Where terms come from depends on the caller.** With `--focus "<question>"` they are extracted
from the question. Under evaluation there is no question — the harness never shows a system the
questions it is scored on, and passing them would hand the advanced system an answer key the
baseline never gets — so terms come from the repository's own documentation instead: README
emphasis, manifest vocabulary, path components. Every measured number comes from that
question-blind configuration, and the CLI rejects `--focus` on any command other than
`advanced`.

### Two phases, because one turn cannot do both jobs

Exploration turns carry `tools` and **no** response schema. The synthesis turn carries the
schema and **no** tools. This is not stylistic: asking for strict conforming JSON while tools
are still available makes "call a tool" unrepresentable as an answer, so the model must choose
between obeying the schema and using the tools it was given.

The synthesis prompt closes the loop by naming the exact set of ids the model may now cite —
reconnaissance sources plus every file a tool actually returned — along with which files were
read and whether the budget ran out.

### The evidence ledger

The one structure the whole design rests on.

```ts
const ledger = new EvidenceLedger(context.sources);   // starts as reconnaissance
// ...
ledger.recordAll(outcome.artifacts);                  // the only way in
```

There is no other path into the ledger. It grows when — and only when — a tool execution
returns bytes. Grounding at step 5 runs against the ledger rather than against the initial
context, so:

- A file the agent read becomes citable, with content strength.
- A file the agent *claims* to have read but never opened is not in the ledger, so the citation
  is dropped with reason `source-not-in-context` and the claim is marked unsupported.
- The model's own prose is never an input to this decision. It cannot talk its way into a
  citation.

`read_file` is the only tool that contributes citable artefacts. `search_code` and
`list_directory` return *locations*, which tell the agent where to look but prove nothing about
content — the same distinction the scorer draws between a `tree` citation and a `file` citation.

### One call, two representations

`read_file` returns two different strings from one call, and conflating them would break
grounding:

| | Goes to | Why |
| --- | --- | --- |
| `output` | The model | Line-numbered, so the model can cite `L28-L40` |
| `artifacts[0].text` | The ledger | The raw slice, so a multi-line quotation verifies character for character |

If the ledger held the numbered form, a two-line quotation from the model would be compared
against text with gutter markers interleaved, and a perfectly truthful citation would be
dropped. Keeping them separate is what makes grounding strict without making it wrong.

### The repository boundary

Every tool resolves its path through
[`resolveInsideRepository`](../packages/shared/src/tools/boundary.ts), which rejects absolute
paths, `..` traversal, null bytes, and symlinks whose target escapes the root — the last one
checked after resolution, because a symlink is the case a string check misses. `.git`,
`node_modules` and vendor directories are skipped by the walkers, so the agent cannot read git
history through the file tools and thereby smuggle in a capability this iteration explicitly
excludes.

`search_code` matches literal, case-insensitive substrings. No regex — which keeps it
deterministic and makes a catastrophic-backtracking input impossible.

### The exploration budget

Ten bounds, each settable by flag or environment variable, defaults in
[`tools/types.ts`](../packages/shared/src/tools/types.ts):

| Bound | Default | Flag |
| --- | --- | --- |
| `maxToolCalls` | 12 | `--max-tool-calls` |
| `maxTurns` | 8 | `--max-turns` |
| `maxSearchResults` | 20 | `--max-search-results` |
| `maxFileLines` | 400 | `--max-file-lines` |
| `maxFileBytes` | 24 000 | `--max-file-bytes` |
| `maxListEntries` | 200 | `--max-list-entries` |
| `maxListDepth` | 3 | `--max-list-depth` |
| `maxScoutTerms` | 14 | `--max-scout-terms` |
| `maxScoutSearches` | 14 | `--max-scout-searches` |
| `maxScoutFiles` | 4 | `--max-scout-files` |

Environment variables use the `REPO_ARCHAEOLOGIST_MAX_*` prefix.

**Zero is accepted for the three scout bounds and rejected for the rest**, and the asymmetry is
deliberate: `--max-scout-files 0` switches the search phase off, which is the control condition
Iteration 2 has to be measurable against, and an experiment whose control is unreachable from the
command line is not reproducible. `--max-tool-calls 0` is a different thing — it leaves the agent
unable to look at anything at all. The two rejections carry different hints, and
[a test](../packages/shared/test/config.test.ts) asserts they stay different.

`maxScoutTerms: 14` is a measured default, not a taste. At 28 terms the extra low-weight terms
pulled the ranking off the files that mattered on both fixtures, while runtime stayed flat across
14 / 28 / 40 terms — so the bound is doing signal work, not cost work. The measurement is in
[`improvement-changelog.md`](improvement-changelog.md).

Exhausting the call budget does not silently drop the call. The loop returns an explicit error
result to the model — `exploration budget exhausted … answer with what you have` — because an
unanswered function call leaves the model waiting for a result that will never arrive. The
refused call is still recorded as a `toolCall` step, because a `function_result` whose
`function_call` is missing is a malformed turn rather than a shorter one.

### The trajectory

Every step is recorded, and the fields that matter are kept **separate**:

| Field | Contains |
| --- | --- |
| `modelText` | The model's own words, verbatim |
| `toolArgs` | What the model asked for |
| `toolResult` | What the filesystem actually returned |
| `ok` | Whether the tool succeeded |

Model prose and tool output never share a field. That separation is what lets a reader answer
"did the model see this, or did it invent it?" without trusting either. `redactSecrets` runs on
every write, so a credential in a tool result cannot reach a trajectory file, and no API key is
ever recorded.

`meta.exploration` carries the summary a reproduction needs: turns, tool calls, failures,
`callsByTool`, `filesRead`, `bytesFromTools`, `budgetExhausted`, the full budget the run used,
and `scout` — the phase's own counters (terms extracted, searches run, searches with a match,
candidates ranked, files read, bytes read, candidates skipped).

`toolCalls` counts the **model's** calls only. The scout's are reported beside them rather than
added in: its cost is fixed and declared while the model's budget is discretionary, and mixing
the two would make "the agent explored more this iteration" unreadable from the numbers.
`filesRead` and `bytesFromTools` do cover both, because the ledger does not distinguish them and
neither does grounding — that count answers "how much of the repository was this briefing
actually written from?"

One known gap: the `scout-search` step records every candidate with its score, matched terms and
reasons, but `truncateDetail` caps a serialized detail at 2 000 characters and both fixtures land
just over it. The terms and top candidates survive, and everything reproducibility-critical is
intact in `meta.exploration.scout` and the `scout-read` step, but a full audit of why a *losing*
candidate lost is not always recoverable from the trajectory file. Documented as
[limitation 11](evaluation.md#limitations) rather than fixed by raising a shared recorder's cap.

### What the iterations measured

**Iteration 1 regressed the primary metric: 64.3 % → 57.1 %, and was rejected.** The mechanism
worked — grounding held with zero fabrications — but the agent used only `read_file`, never
`search_code`, and traded several documentation citations for one implementation citation.

**Iteration 2 raised it to 85.7 %, and is kept.** Making search a deterministic phase rather than
an option fixed the question that motivated both iterations: the term `dispatch`, drawn from the
repository's own documentation, found `pyflow/steps/__init__.py`, the scout read it, and an answer
that had failed twice became correct and cited. Answer accuracy reached 100 %, grounding held
again at 31 of 31 citations, and cost rose 2.77×.

**Iteration 3 raised it to 100 % (14/14) for zero additional tokens, and is kept.** The precision
pass runs after synthesis, so the prompts were byte-identical to Iteration 2's and the model
produced the same output twice: the same output scored 85.7 % with Iteration 2's citations and
100 % with Iteration 3's. On the stronger `gemini-3.5-flash` it ties its own baseline at 78.6 %,
and mean evidence relevance fell by a third — both reported rather than buried.

**Iteration 4 measured nothing, and claims nothing.** It is the product layer: a browser, a
graph, grounded Q&A and a PDF, all downstream of a pipeline it did not modify. The only
evaluation runs made for it were offline `--mock` runs, which measure the harness and its canned
text rather than a model.

Full numbers, the regressions, and the reason mean evidence relevance moved the wrong way twice
are in [`improvement-changelog.md`](improvement-changelog.md).


---

## `packages/app` — the analysis core (Iteration 4)

The product layer's whole vocabulary. Nothing here starts a server, parses an argument or writes
a file; those belong to the things that have a user.

| Module | Responsibility |
| --- | --- |
| [`service.ts`](../packages/app/src/service.ts) | `analyzeRepository` — the one place that decides which system runs. |
| [`report.ts`](../packages/app/src/report.ts) | `RunRecord` → `AnalysisReport`: interned evidence, per-claim citations, origins, metrics. |
| [`architecture.ts`](../packages/app/src/architecture.ts) | `AnalysisReport` → `ArchitectureGraph`: typed nodes, typed edges, deterministic layout. |
| [`questions.ts`](../packages/app/src/questions.ts) | The grounded question loop: scout, tools, answer, citation extraction, grounding. |
| [`question-prompt.ts`](../packages/app/src/question-prompt.ts) | The question's prompt and its JSON contract. |
| [`store.ts`](../packages/app/src/store.ts) | `AnalysisStore` and the bounded in-memory default. |
| [`workspace.ts`](../packages/app/src/workspace.ts) | `resolveRepositoryRequest` — a client-supplied name → a directory inside the workspace. |
| [`metrics.ts`](../packages/app/src/metrics.ts) | `ObservabilityRecorder`: analysis, question and export events. |
| [`export/`](../packages/app/src/export/) | The `ReportExporter` seam, the PDF exporter, and a minimal PDF 1.4 writer. |

### One core, two consumers

`analyzeRepository` is the only code outside the evaluator that branches on system identity. The
CLI's `commandAnalyze` and the web server's `POST /api/analyze` both call it, so a briefing
produced in a terminal and one produced in a browser cannot come from two slightly different
orchestrations. It adds no phase and skips none: `runBaseline` and `runAdvanced` still own the
pipeline. The one thing it adds is the ledger — `AnalysisRun.sources`, the artefacts *with their
text*, captured through the `onSources` callback.

That callback is the entire footprint of Iteration 4 inside the measured pipeline. It is called
after the ledger is final, it cannot add to it, and nothing reads its return value. A run that
passes no callback behaves exactly as it did before the option existed, which is what makes the
product layer unable to move a benchmark number.

The alternative — re-collecting the repository to recover the bytes — was rejected as *dishonest*
rather than merely slow: a second pass under a different budget can produce a different ledger,
and then the evidence panel would be showing a reader text that the briefing was never checked
against.

### The evidence model, end to end

The chain the whole product exists to preserve:

```
file on disk ──► tool call ──► ledger (raw text) ──► model citation ──► grounding ──► ReportEvidence
   boundary        recorded       the only citable      source+excerpt     verified      ev-001, origin,
   checked         bytes          artefacts             as written         or dropped    offsets on demand
```

`buildAnalysisReport` **interns** each surviving citation as `ev-001`, `ev-002`, … in traversal
order, and every claim then refers to its evidence by id. That is what makes a citation a thing
the UI can address: a node in the graph, a row in the evidence table and a claim in the briefing
all point at the same `ev-013` rather than each carrying its own copy of a quotation.

Each evidence item records how its artefact reached the ledger — `reconnaissance`, `scout`,
`model-tool` or `corroboration` — which is per *source* rather than per citation, and is
documented as a limitation in the code where it is defined. An evidence id is a key into one
analysis: `GET /api/analysis/:id/evidence/:evidenceId` resolves it against the analysis that
issued it and 404s otherwise, so an id cannot be constructed, guessed, or carried across
analyses.

A claim that lost its last citation is **kept and labelled unsupported** in the report, the graph
and the PDF. Hiding it would flatter the system; showing it tells a reader which sentences to
distrust.

### The architecture graph

Eleven node types (`application`, `package`, `module`, `api`, `database`, `queue`, `worker`,
`external-service`, `cli`, `configuration`, `test-suite`) and ten relationships (`imports`,
`calls`, `depends-on`, `reads-from`, `writes-to`, `publishes`, `consumes`, `tests`, `exposes`,
`configures`). `assertNodeType` and `assertRelationship` reject anything else at construction
rather than letting an unrecognised string reach the renderer, where it would draw as an
unlabelled arrow.

Two properties are enforced by test. **Every node and every edge carries `evidenceIds`** — the
graph is derived from claims that already have citations, so an element with no evidence is a
drawing rather than a finding, and `buildArchitectureGraph` cannot emit one. And **the same
report produces the same graph**: ids are derived from the report's own content, ordering is
stable, and layout is computed arithmetically from the node list rather than by a force
simulation, so a screenshot is reproducible and a diff is meaningful.

### Questions, answered the same way claims are

`answerQuestion` reuses the pipeline's parts rather than re-implementing them: the same evidence
scout, the same three read-only tools, the same repository boundary, the same ledger, the same
grounding.

```
question ─► scout (deterministic) ─► ≤ 4 tool calls over ≤ 3 turns ─► answer + citations
                                                                          │
                                              grounded against the ledger ◄┘
                                                     │
                                     verified answer │ or the unsupported sentence
```

Four bounds, each smaller than the briefing's, because a question has to settle one thing rather
than cover a repository: `maxToolCalls: 4`, `maxTurns: 3`, `maxScoutFiles: 3`, and a 1 000-character
limit on the question itself. There is no unbounded loop and no way to ask for one.

Two rules matter more than the loop. A citation the ledger cannot resolve is dropped, and an
answer left with nothing verified is replaced — not softened — with exactly *"I couldn't verify
this from the repository evidence I inspected."* And **conversation history never becomes
evidence**: earlier turns are replayed as context, capped at six, and the only thing that can be
cited is repository bytes. A model that quotes its own previous answer has cited nothing.

### The store, and the export seam

`AnalysisStore` is two methods plus a listing. The default is a bounded map — sixteen entries,
oldest evicted, re-saving an existing id does not change its age — which is the right failure for
a tool someone runs locally against one repository at a time, and the wrong one for a shared
service. That is a reason to write a persistent implementation, not to raise the cap; nothing in
the interface knows about a database.

`ReportExporter` is `{ format, contentType, filename(report), export(input) }`. The one
implementation renders a PDF. It has no dependency and starts no browser:
[`export/pdf/writer.ts`](../packages/app/src/export/pdf/writer.ts) is a minimal PDF 1.4 writer —
standard fonts only, no compression, tabulated font metrics — and the exporter above it owns
layout. `redactSecrets` runs inside the exporter, because a PDF is a file that leaves the machine.

The spec's `export(report)` was widened to `export({ report, graph, questions })`. A document that
omitted the architecture and the answered questions would not be an export of what the reader is
looking at.

The writer's unit tests assert on the *document* — that a claim, its citation and the unsupported
label all appear, and that a secret-shaped excerpt appears redacted. They deliberately do not assert
on the file format, because a test that encodes the byte offsets of an xref table breaks whenever a
line of layout changes and tells you nothing about the product. That check lives separately in
[`scripts/pdf-smoke.ts`](../scripts/pdf-smoke.ts), run by hand
(`pnpm exec tsx scripts/pdf-smoke.ts`), and it verifies the things only the format can be wrong
about: every xref offset points at the object it claims, `/Size` matches the table, the file ends in
`%%EOF`, parentheses and backslashes in metadata are escaped, and characters outside WinAnsi are
substituted rather than emitted raw.

---

## `apps/web` — transport, and nothing else

| Module | Responsibility |
| --- | --- |
| [`server.ts`](../apps/web/src/server.ts) | `node:http`, the three refusals at the door, security headers, JSON and byte responses. |
| [`routes.ts`](../apps/web/src/routes.ts) | The eight routes, request validation in Zod, and the public projection of an analysis. |
| [`static.ts`](../apps/web/src/static.ts) | The UI's own files, held inside their directory by the repository boundary. |
| [`main.ts`](../apps/web/src/main.ts) | Flag parsing, `.env`, config and budget loading — deliberately shaped like the CLI's. |
| [`public/`](../apps/web/public/) | The UI: one HTML shell, one stylesheet, one script. No framework, no build, no CDN. |

```
GET  /api/health                                  provider, model, systems, limits
GET  /api/repositories                            analysable directories in the workspace
POST /api/analyze                    {repository, system?, focus?}   → 201 report + graph
GET  /api/analyses                                what has been analysed this session
GET  /api/analysis/:id                            report + graph + answered questions
POST /api/questions                  {analysisId, question}          → 201 answered question
GET  /api/analysis/:id/evidence/:evidenceId       one citation, its source text, its offsets
GET  /api/analysis/:id/export/pdf                 the document
```

### The three refusals at the door

A local web server that reads files is a capability a page on the internet would like to borrow,
so three checks run before any route does:

- **`Host` must be localhost** → `421 Misdirected Request`. This is the DNS-rebinding defence: a
  name that resolves to `127.0.0.1` still arrives with its own `Host`.
- **`Origin`, if present, must be our own** → `403`. A navigation sends none, which is why the PDF
  download works and a cross-site `fetch` does not.
- **A body over 1 MiB** → `413`, refused while it arrives rather than after it is buffered.

Then `default-src 'none'` and four more headers on every response, including
`cache-control: no-store`. The dashboard renders names, paths and excerpts taken from a repository
nobody vetted; the CSP is what makes a successful injection inert. The UI has no framework
partly for that reason — there is no `unsafe-inline` to grant and no CDN to trust.

`publicAnalysis` is the projection that leaves the process: `{ id, createdAt, report, graph,
questions }`. The run record, the ledger text and the absolute repository root stay in memory. The
repository path a report carries is the workspace-relative one the client named, not the server's
own path to it.

### Security boundaries, in one place

| Boundary | Mechanism | Where |
| --- | --- | --- |
| A path inside a repository | `resolveInsideRepository` | [`tools/boundary.ts`](../packages/shared/src/tools/boundary.ts) |
| A repository inside the workspace | `resolveRepositoryRequest`, which calls it and additionally rejects ignored directories, missing paths and non-directories | [`workspace.ts`](../packages/app/src/workspace.ts) |
| A static asset inside `public/` | the same function again | [`static.ts`](../apps/web/src/static.ts) |
| A citation | must resolve to a ledger artefact | [`grounding.ts`](../packages/shared/src/grounding.ts) |
| An evidence id | a key into one analysis, scoped to it | [`routes.ts`](../apps/web/src/routes.ts) |
| Text leaving the process | `redactSecrets` on responses, metrics, files and the PDF | [`paths.ts`](../packages/shared/src/paths.ts) |

There is **one** path-security mechanism, used three times. A second one written for "just the
static files" is how a traversal bug reaches production: nobody audits the asset server. The
consequence of reuse is that the asset checks are stricter than a static server needs, which is
the right direction to be wrong in.

Everything is read-only. No shell, no command execution, no write to an analysed repository, and
no filesystem access outside a resolved boundary.

---

## `packages/evaluator` — scoring, deterministically

| Module | Responsibility |
| --- | --- |
| [`case-schema.ts`](../packages/evaluator/src/case-schema.ts) | The evaluation case format, in Zod. |
| [`load.ts`](../packages/evaluator/src/load.ts) | Reads and validates a case directory; refuses a case it cannot score. |
| [`matching.ts`](../packages/evaluator/src/matching.ts) | Keyword and location matching. Pure functions, no model. |
| [`score.ts`](../packages/evaluator/src/score.ts) | The four measures, per question, then per case. |
| [`aggregate.ts`](../packages/evaluator/src/aggregate.ts) | Case scores → report metrics, usage, cost, caveats. |
| [`report.ts`](../packages/evaluator/src/report.ts) | The Markdown summary. |

No model is involved in scoring. Matching is substring comparison over normalised text, which
is a real limitation ([documented](evaluation.md#limitations)) and a deliberate trade: the
same briefing always earns the same score, so a metric change is a system change.

`load.ts` **refuses** a malformed or unscorable case rather than skipping it. Skipping would
quietly shrink the denominator of the primary metric — the one way this harness could flatter
the system it measures without anyone noticing.

For the same reason, a case whose run *crashes* is scored zero across all its questions
rather than dropped: [`failedCase`](../packages/evaluator/src/score.ts) keeps the question
count as the denominator, records the error, and the report carries a caveat naming the
failure.

---

## `evaluation/` — the runner

[`runEvaluation`](../evaluation/src/run.ts) loads the cases, runs the system once per case,
scores each result, aggregates, and writes two artefacts plus a stable `latest-<system>` pair.

Three properties are enforced by test:

- **The analyser never sees the questions.** Only the repository path crosses into
  `runBaseline` or `runAdvanced`. A test plants sentinel strings in every question and expected
  answer and asserts neither reaches the model's input, its system instruction, or — for the
  advanced system — any step of the replayed conversation. Without this the harness would be
  measuring the model's ability to read the answer key.
- **The same inputs produce the same report.** With a fixed clock and a stubbed client, two
  runs deep-equal each other.
- **The written file is the report.** The JSON on disk deep-equals the returned report
  object, and the Markdown on disk is byte-identical to the returned string — so nothing can
  be true in the process and false in the artefact.

`runSystem` is the **only** place in the codebase that branches on system identity. Everything
downstream — scoring, matching, aggregation, reporting — receives a `RunRecord` with no way to
tell which system produced it. That is deliberate and load-bearing: the evaluator cannot favour
a system it cannot identify.

`--case-delay` inserts a wait between cases. It exists because free-tier request quotas are a
real operational constraint, and it applies identically to both systems — a harness more patient
with one of them would be measuring its own retry loop rather than the systems. The same
reasoning governs the retry backoff in [`llm.ts`](../packages/shared/src/llm.ts), which
distinguishes a rate limit (wait for the quota window to roll over) from a transient 5xx (retry
in milliseconds), identically for both.

Reproducibility metadata on every report: run id, system, system version, provider, model,
seed, thinking level, timestamps, duration, token usage, estimated cost where the price is
known, Node version, and the case ids that ran.

---

## Cross-cutting decisions

**No build step.** Each package exports `./src/index.ts` directly and `tsx` runs it.
`tsc --noEmit` is the type gate. For a project this size a `dist/` would be pure ceremony.

**Strict TypeScript, plus `noUncheckedIndexedAccess`.** Array access yields
`T | undefined`, which is why the code reads `sources[0]?.id`. It catches exactly the class
of bug that shows up when a model returns fewer array entries than expected.

**Errors carry hints.** Every typed error takes an optional second argument printed under
the message: `ConfigError("No repository path given.", "Usage: pnpm repo:baseline -- ./path")`.
A stack trace tells you where; a hint tells you what to type next.

**Nothing written carries an absolute path or a credential.** `toPortablePath` relativises
against the working directory — preferring `../sibling` over leaking a home directory — and
`redactSecrets` runs on every `writeJsonFile` and `writeTextFile`. The redaction handles the
JSON-serialised form (`"GEMINI_API_KEY": "…"`) specifically, because that is how a key would
most plausibly reach a report, and it replaces the value with a *quoted* placeholder so the
surrounding JSON stays parseable. That case was found by a test, not by inspection.

Iteration 4 extended it **additively**, because a report is no longer the only thing that leaves:
an HTTP response, a metric event and a PDF do too, and each may carry an excerpt from a file that
committed a token. A second rule now matches credential *shapes* anywhere in the text — AWS key
ids, GitHub and Slack tokens, Stripe and Anthropic keys, JWTs and whole PEM private-key blocks.
Shape-based rather than name-based, because nobody writes `AKIA` plus sixteen uppercase
alphanumerics by accident; the name-based rule is deliberately *not* widened to
`secret`/`token`/`password`, since `jwtSecret: env.JWT_SECRET` is a reference to a credential
rather than a credential, and redacting it would make evidence less readable while protecting
nothing. The `<redacted-api-key>` wording an existing test pins is unchanged.

Two consequences worth stating. It cannot recognise a bare high-entropy string with no prefix and
no label — a heuristic wide enough for that would redact hashes, UUIDs and minified code. And
redaction runs at *exit* boundaries only: the evidence ledger holds raw bytes, because grounding
has to verify an excerpt against what the file actually says. Evaluation scores the in-memory
record, so no change to redaction can move a benchmark number.

**Where the next system plugs in.** A new system implements the same
`(repositoryPath, config) → RunRecord` contract and registers a system name in
`EVALUABLE_SYSTEMS`. `runEvaluation` already takes `system` and already rejects an unknown one.
Nothing in `packages/evaluator` needed to change to score Iterations 1, 2 or 3 — no new
evidence type, no new matching rule, no scoring exemption — which is the whole reason the harness
was built first, and the reason both the rejected 57.1 % and the kept 100 % are worth believing.

**Where a product feature plugs in.** Downstream of `packages/app`, reading an `AnalysisReport`
and an `ArchitectureGraph`, never reaching past them into the pipeline. That is the rule that lets
a UI, a graph, a question mode and an exporter be added without touching a measured code path —
and the reason Iteration 4 can be honest about having measured nothing.
