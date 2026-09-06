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

The product layer (Iterations 4–5) is deliberately downstream of everything measured. It reads the
pipeline's output and the pipeline's evidence ledger; it does not add a phase, skip one, or
reorder any. The only two changes it has ever required inside `runAdvanced` and `runBaseline` are
one optional callback that hands the finished ledger to whoever asked for it, and one optional
callback that says which phase the pipeline has reached. Neither is read by any control flow, and
a regression test in each system asserts that a run with the observers produces a byte-identical
record to a run without them.

That property is load-bearing — it is the only reason two iterations of product work can carry
Iteration 3's measured numbers forward — so it is checkable rather than argued:
[`scripts/verify-measured-path.ts`](../scripts/verify-measured-path.ts) (`pnpm verify:measured
--ref <ref>`) reports what differs under `advanced/src`, `baseline/src`, `evaluation/`,
`packages/evaluator/` and `fixtures/`, and exits non-zero on a deletion, on any change to a frozen
directory, or on a `systemVersion` that moved without a re-measurement. `--compare a.json b.json`
strips run ids and wall clock from two result files and diffs what the systems actually answered.

Iteration 6 moved the guard in both directions at once, which is worth stating rather than
burying. It is **stronger** in three places: the two frozen case files are now compared by content
against the ref rather than merely watched for a diff entry, untracked files are included (a new
file under a guarded directory used to be invisible), and the fixtures are checked through their
tracked generator. It is **weaker** in exactly one: two named plumbing files are exempt —
`evaluation/src/run.ts`, which has to thread the manifest and provenance through the harness, and
`packages/evaluator/src/index.ts`, whose diff is a re-export list. Every scoring module either of
them reaches is compared by content anyway.

The exemption is per-file and never per-directory — a directory-shaped exemption is how a guard
quietly stops guarding — and each exempt file carries its justification in the source and prints it
on every run, so a reviewer sees the hole rather than inheriting it. Adding a *new* case file is
allowed, since a new file cannot alter an existing one and the frozen two are content-checked
regardless.

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
| [`claims/`](../packages/shared/src/claims/) | Atomic claims addressed to an evidence ledger, structural composition, integrity checking, materialization. No model call. |
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
Iteration 3 added one more deterministic step, after the model has spoken and before grounding;
Iteration 8 added a second one beside it.

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
                                              compose-claims    (Iteration 8: atomic claims
                                                     │           + composition, no model)
                                              refine-evidence   (Iteration 3: hygiene
                                                     │           + corroboration, no model)
                                              ground-evidence
```

The order of the last three is load-bearing and pinned by a test: composition adds claims,
corroboration adds citations, and grounding is what verifies them, so moving grounding earlier
would let an unverified excerpt reach the briefing.

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

### Atomic claims and composition (Iteration 8)

The response contract at 0.2.0 has a level below "the briefing": a **claim set**, projected from the
validated body with no model call.

```ts
interface AtomicClaim   { id: string; kind: ClaimKind; text: string; evidenceIds: string[]; subject?: string }
interface ComposedClaim extends AtomicClaim { claimIds: string[] }
interface ClaimSet      { evidence: Record<string, Evidence>; claims: AtomicClaim[]; composed: ComposedClaim[] }
```

A claim addresses evidence **by id** into the set's own ledger and never carries a copy, so there is
exactly one place a citation can come from and no way for a claim to acquire evidence its parts did not
have. Ids are `sha256` over kind, text and sorted evidence ids — content-derived, so identical for
identical content and carrying no timestamp, case id or evaluator metadata.

Two composition rules, both **structural and question-blind**. The claim pass cannot see a question:
`composeClaimSet` takes one parameter, and [a test](../packages/shared/test/claims.test.ts) asserts its
arity so no channel for one can be added quietly.

| Rule | Groups | Because |
| --- | --- | --- |
| Same-list | Claims of one kind citing one artefact | The manifest lists dependencies; each claim names one; the composition names the set |
| Shared-subject | Claims of different kinds whose texts name each other's subjects | A cross-reference the model wrote itself: one mechanism seen from two sides, citing both files |

Both are capped — 8 compositions, 6 parts for cross-kind, 2 000 characters — because a composition of
everything is a paragraph, not a claim, and would make every keyword in the briefing co-occur in one
text regardless of what was established. A **list** composition is all-or-nothing and an over-long one
is dropped rather than trimmed: "taken together, these are the entries" is false if an entry was dropped
to fit a cap. A composed claim's text is its parts' own texts joined behind a `Taken together (kind):`
lead-in, so it asserts exactly what its parts assert and cannot claim more than the briefing did.

`checkClaimIntegrity` rejects unknown evidence ids, duplicate claim ids, orphaned compositions and
evidence escape. A claim with **no** evidence is reported as unsupported rather than treated as a
structural failure — that is a briefing-quality fact, and the audit already counts it.

Then `materializeComposedClaims` appends each composition into the body's own `components` / `flows` /
`dependencies` / `risks` array, marked `Composite:`, carrying only its parts' evidence. That is the
load-bearing choice. Because a composition lands in a list the rest of the system already walks,
grounding, precision, the audit, the report, the PDF, the graph and the evaluator's `selectClaims` all
need no change — a composed entry is an ordinary entry to every one of them, and in particular it faces
the same citation verification as everything else. `testing` and `overview` compositions are skipped:
neither is an appendable list, and rewriting the model's prose is not this step's job.

`meta.exploration.claims` reports counts and cited **source ids** only. Internal claim-evidence
addressing never leaves the process.

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

**Iteration 5 measured that it changed nothing, which for this iteration is the whole claim.** It
gave an analysis somewhere to live — a SQLite store behind the `AnalysisStore` seam, a runner that
creates the record before the work, and phase reporting — and touched the measured pipeline only
by adding the `onPhase` observation hook. Two things were checked rather than asserted: a
byte-identity regression test in each system, and a re-run of both offline `--mock` evaluations
whose normalized results are identical to Iteration 4's question by question, score by score,
citation by citation. Neither system's version was bumped, because `systemVersion` names
behaviour and the behaviour is provably the same.

**Iteration 6 measured the unchanged system against a bigger benchmark and changed no analysis
code.** It expanded the dataset from 14 questions to 38 — Regression Set v1 frozen, Challenge Set v2
added — and reported 100.0 % on the frozen subset (identical to Iteration 3 to four decimal places)
against 29.2 % on the new questions. Two diagnostic runs then established the finding that set up
Iteration 7: in 16 of 17 failures the expected evidence was already in the model's context,
un-truncated, with zero fabrications.

**Iteration 7 tested the hypothesis that finding produced, and rejected it.** The lever was the
synthesis prompt and nothing else: six form-level instructions asking the model to keep a fact and
its identifier in one sentence rather than splitting them across claims. Challenge evidence-backed
accuracy went 29.2 % → **25.0 %** against a +8 pp acceptance threshold; exactly one question of 38
changed outcome, and it changed PASS → UNCITED. The prompt was reverted, `ADVANCED_VERSION` stayed
at 0.1.0, and no second change was stacked on top.

The architectural reason it could not work is [above](#two-phases-because-one-turn-cannot-do-both-jobs):
synthesis is **question-blind by design**. The model writes one briefing; the scorer later asks
nineteen questions of it. A prompt cannot instruct a writer to organise a paragraph around a
question that is not in the prompt — and the alternative, passing evaluation questions into
synthesis, would measure a different system. Iteration 6's "the evidence was in context" turns out
to be a much weaker claim than "the model had established the fact".

**Iteration 8 took the constraint Iteration 7's rejection had identified, and is kept.** Iteration 7's
own entry recorded that three failures were out of reach of any prompt because `selectClaims` emits one
claim per array entry — a statement about *representation*, made while testing instructions. Iteration 8
changed the representation instead: [atomic claims and composition](#atomic-claims-and-composition-iteration-8),
one deterministic step, no model call, prompt byte-identical to the control. Challenge evidence-backed
accuracy went 29.2 % → **37.5 %** against the same +8 pp threshold; exactly two questions of 38 changed
outcome, both UNCITED → BACKED, and both the ones the hypothesis named in advance. Regression stayed at
100 %, fabrications at 0, cost identical to the control. `ADVANCED_VERSION` moved to 0.2.0.

Two caveats belong beside that number. It **equals the ceiling** measured before the run — 9 of 24 was
the maximum composition alone could reach, so the mechanism recovered everything available to it and has
no headroom left. And both recovered cases came from the same-list rule over a dependency manifest: the
cross-file shared-subject rule fires on every analysis, produces compositions citing four or five files
each, and moved no question. The general lesson is the transferable part — when a metric is bounded by
the *shape* of the structure a downstream consumer reads, instructing the producer to write better prose
cannot move it, and the diagnostic that tells you which situation you are in is whether the required
facts are present in the output but never in the same claim.

Full numbers, the regressions, and the reason mean evidence relevance moved the wrong way twice
are in [`improvement-changelog.md`](improvement-changelog.md).


---

## `packages/app` — the analysis core (Iterations 4–5)

The product layer's whole vocabulary. Nothing here starts a server, parses an argument or writes
a file; those belong to the things that have a user.

| Module | Responsibility |
| --- | --- |
| [`service.ts`](../packages/app/src/service.ts) | `analyzeRepository` — the one place that decides which system runs. |
| [`report.ts`](../packages/app/src/report.ts) | `RunRecord` → `AnalysisReport`: interned evidence, per-claim citations, origins, metrics. |
| [`architecture.ts`](../packages/app/src/architecture.ts) | `AnalysisReport` → `ArchitectureGraph`: typed nodes, typed edges, deterministic layout. |
| [`questions.ts`](../packages/app/src/questions.ts) | The grounded question loop: scout, tools, answer, citation extraction, grounding. |
| [`question-prompt.ts`](../packages/app/src/question-prompt.ts) | The question's prompt and its JSON contract. |
| [`lifecycle.ts`](../packages/app/src/lifecycle.ts) | Statuses, phases, the progress event bus, and the browser/operator failure-message pair. |
| [`runner.ts`](../packages/app/src/runner.ts) | `AnalysisRunner` — request → durable record → pipeline → terminal state. The only writer of status. |
| [`store/types.ts`](../packages/app/src/store/types.ts) | `AnalysisStore`, the record shape, and what is deliberately absent from it. |
| [`store/sqlite.ts`](../packages/app/src/store/sqlite.ts) | The durable implementation, on `node:sqlite`. |
| [`store/location.ts`](../packages/app/src/store/location.ts) | Where the database lives, and the one place it may not. |
| [`store/projection.ts`](../packages/app/src/store/projection.ts) | `RunRecord` → what is safe and sufficient to persist. |
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

### The store, and what it is allowed to remember

`AnalysisStore` is `create` / `get` / `list` / `update` / `delete`, plus `appendQuestion` and
`getEvidenceSource`. Through Iteration 4 the only implementation was a bounded map, so an analysis
lasted as long as the process and "does it survive a restart" was not a question anyone could ask.
Iteration 5 replaced the default with [`store/sqlite.ts`](../packages/app/src/store/sqlite.ts) and
left the interface as the seam: the routes depend on it and not on SQLite, so an implementation that
talks to something over a socket needs no caller to change.

SQLite via **`node:sqlite`**, which ships with Node 22, so the durable store adds no dependency at
all — the honest reading of "prefer a minimal dependency" when the alternative is a driver, a pool
and a migration tool for a single-user local file. The module is still experimental in Node 22 and
prints one warning on import; that warning is left visible rather than suppressed, because it is
true. The binding is synchronous, so every store method completes without yielding and the
`Promise` in the interface is shape rather than behaviour. That is also what makes concurrency
inside one process trivial — two callers cannot interleave inside a method — leaving only another
process on the same file, which WAL plus `busy_timeout` plus `BEGIN IMMEDIATE` handles.

**The database never lives inside the analysed workspace**, and
[`resolveDatabaseLocation`](../packages/app/src/store/location.ts) refuses to put it there. The
workspace this server is pointed at contains repositories nobody vetted; a database inside one of
them is a file that repository can see, `git status` can notice and a later `git clean` can delete.
It is also the wrong scope, so the default is one database per *user*
(`~/.repo-archaeologist/analyses.db`), which survives pointing the server at a different workspace
tomorrow. Containment is checked against the resolved workspace root, so `..` and a symlinked home
directory both land where they really point.

**What a record contains is a projection, not a dump** — the argument
[`store/projection.ts`](../packages/app/src/store/projection.ts) exists to make. A `RunRecord`
carries the model's prose, every tool call's raw result, the prompts, and an absolute repository
root. Serialising it would be the shortest path to a durable store and the shortest path to a leak,
because from then on every consumer would have to remember to strip the same four things. So the
store takes only what two questions justify: what a question asked after a restart needs (the
reconnaissance artefacts, which are all `answerQuestion` seeds its ledger from), and what the
evidence viewer needs (the sources some citation resolves to). The trajectory, the prompts, the
model text, the absolute root and any uncited artefact are dropped. An uncited scout read still
appears in `report.sources` as a row of metadata — a claim about what was inspected needs no bytes
to make it.

Two consequences worth stating, because both are load-bearing. `repositoryPath` is
**workspace-relative**, so the same database opened by a process started elsewhere still resolves
and a leaked row says nothing about the host filesystem. And redaction happens **on the way in**
rather than on the way out: if the in-memory copy were raw and the stored copy redacted, an excerpt
would render differently before and after a restart, and the line ranges the evidence viewer
computes against the text it displays would shift by every replacement. Redacting first makes those
offsets correct by construction. The ledger the pipeline *grounds* against is still the raw one —
grounding has to compare an excerpt with what the file really says — and the projection is taken
after grounding has finished.

`getEvidenceSource` takes **both** ids, which is what the evidence route's `404` rests on: an
evidence id from another analysis resolves to nothing rather than to someone else's bytes. Two
repositories legitimately contain the same path, so the primary key is the pair and neither row
wins.

A database whose `schema_version` is **newer** than the build understands is refused rather than
opened. Silently ignoring a column is how a durable store starts losing data, and an older binary
cannot know which column it is about to ignore. In the other direction a single unreadable JSON
payload costs that analysis its report, not the dashboard its list — every consumer already handles
a `null` report, because a queued analysis has none either.

That refusal is what made Iteration 6's identity columns a **migration** rather than a
reinterpretation. `SCHEMA_VERSION` moved 1 → 2, adding `system_version` and `provenance`, and an
existing database is upgraded on open. Both columns are nullable, and that nullability is the
design: a row written by version 1 genuinely does not know which build produced it or where the run
came from, so it reads back as *unrecorded* rather than being backfilled with a plausible value.
`unlabelled` is the default for a *new* run whose operator supplied no label — a different fact,
and one the row is entitled to assert.

The cheaper alternatives were all wrong in the same way: overloading `systemVersion` to also carry
provenance, keeping it only in memory so it vanishes on restart, or synthesising it at read time
from whatever the row happens to look like. Each produces a stored history that answers a question
it was never told the answer to.

One duplication is deliberate here. `CREATE TABLE IF NOT EXISTS` is a no-op on a database that
already has the table, so its DDL would never add the new columns; the schema is therefore stated
twice — once for a database being created, once for one being upgraded — and that redundancy is
what makes an existing file readable instead of quietly missing a column.

### Progress, without inventing any

[`lifecycle.ts`](../packages/app/src/lifecycle.ts) holds five statuses and eight phases, and the
distinction between them is deliberate: a **status** is a promise about what the record contains, a
**phase** is an observation about where the pipeline got to. So finer progress became phases rather
than more statuses, and there is no interpolation, no percentage and no fake progress bar — a phase
appears when the pipeline reaches it and not before.

The pipelines report phases through `onPhase`, an option with exactly the contract `onSources`
already had: a name from a closed vocabulary, nothing else, no control flow reading it, its return
value discarded. It was added to the *measured* path, so an observation hook that turned out to be a
participant would silently invalidate every number recorded against these systems. A regression test
in each system asserts a run with no observer produces a **byte-identical record** to one with it,
and Iteration 5's mock evaluation results are byte-identical to Iteration 4's for the same reason.

`AnalysisEventBus` is per-analysis publish/subscribe with a bounded replay buffer. Replay is what
makes the stream usable rather than merely correct: a browser that posts an analysis and then opens
the event stream is always a round trip late, so without it a client would reliably miss
`analysis.created` and often `analysis.started`. It is bounded twice — per analysis, and in how many
analyses it buffers at all — because it is a live-progress buffer, not a record. The record is the
database.

`safeFailureMessage` and `logFailureMessage` are deliberately adjacent, because confusing them is
the bug the module exists to prevent. One is for a browser and one is for a terminal. The rule is
that the error's *category* decides whether its text survives: our own error types were written to
be read by the person who caused them, so their message passes through redacted, while anything
unanticipated is replaced wholesale — its message is a filesystem path, a SQL fragment or a stack
frame at least as often as it is an explanation. The `hint` is dropped even for our own errors,
because hints tell an *operator* which file to look at.

### The runner: a record before the work

[`runner.ts`](../packages/app/src/runner.ts) is the only writer of analysis status. Iteration 4 ran
the pipeline inline inside a request handler, which made "the analysis succeeded" and "the client is
still connected" the same fact. Separating them costs one indirection and buys three things: a
record that exists before the work does, so a client that navigates away has not lost its analysis;
a status a second client can read; and one place where failure becomes something safe to show.

A failure is therefore a **`failed` record, not a rejected promise** — by the time the pipeline
runs, the caller that asked may be gone and there is nobody to catch. Which validation happens
before the record exists is chosen on the same principle: a system name or a focus the baseline
cannot honour is a request error the client should fix, while "that directory is not in the
workspace" is a *result* the user should find in the list on reload rather than a `400` that
vanishes. The runner does not queue, retry or schedule — one analysis per call, run immediately, on
this process. A queue would be the right answer to a problem a loopback tool for one user does not
have.

#### Who owns the record while the work runs

Detaching the run from the request created a second lifetime, and `0.6.2` fixed the place the two
were never reconciled. The **store is application-scoped**: `main.ts` opens it once, hands the same
instance to the routes and to the runner, and closes it when the process exits. A detached run
therefore never depends on a request-scoped resource. But the *record* has its own lifetime, and one
route controls it — `DELETE /api/analyses/:id` removed the row of an analysis that was still
running, and the run then failed once per remaining phase, once at its terminal write, and once more
trying to record that failure.

The invariant is now explicit: **a record's lifetime must cover its run, and whatever ends it early
must say so first.** `AnalysisRunner` tracks which ids are live and exposes `abandon(id)`;
`routeDelete` calls it *before* `store.delete(id)`, so a delete of a running analysis is a
**cancellation**, and the route reports which it was (`{ deleted, cancelled }`).

Abandonment is **cooperative, and stops persistence only**. The run checks at each of its own write
boundaries and discards its result; the pipeline underneath is not interrupted, because interrupting
it would mean reaching into the measured analysis path for a lifecycle problem. An already-issued
model call still finishes and its output is dropped. The record is never recreated — resurrecting
the row would be the runner overruling the person who deleted it.

The store's missing-record error was not weakened to make this work. `get` and `update` still throw
on an id that has no row, because a caller naming an id is asserting the row is there. What changed
is that they throw [`AnalysisNotFoundError`](../packages/app/src/store/types.ts), a `StorageError`
subclass carrying the id, so the record's owner can tell *"the row I created is gone"* from *"the
database is broken"* and stop on the first observation even when nothing announced the delete. Its
`name` stays `"StorageError"`: the HTTP layer maps on that string, and a deleted record is not a new
category of failure to an API client.

### The export seam

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
DELETE /api/analyses/:id                          → {deleted, cancelled} — cancels a running one
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

### The browser: two files, and the seam that broke

`public/` is three files and no build step: `app.js`, `ui.js`, `styles.css`. The split between the
two modules is the only architectural decision in the directory, and it is worth recording both what
it is for and how it failed.

`ui.js` holds everything that decides *what* to show — the graph layout, the filters, the outline
projection, the status and phase vocabularies, every label and every threshold. `app.js` holds
everything that needs a document: element construction, event wiring, the SVG, the event stream,
focus management. The reason for the line is that the project has no bundler and no jsdom, so a
module touching `document` can only be read by a human, while one that merely computes can be
imported by a test. `ui.d.ts` beside it is a hand-written declaration — that is what lets a
typechecked test call into a browser module in a project with no `allowJs`.

The extraction worked and then caused the worst defect in the project's history. Three functions
were moved into `ui.js`, imported back into `app.js`, and left in place at the bottom of the
original. A duplicate `const` at module scope does not warn; the module never evaluates. `ui.js` got
50 passing tests, `app.js` became a `SyntaxError`, and the whole dashboard was dead code for a
commit. The suite grew and the product stopped loading, and every signal said otherwise.

So there are two kinds of test here on purpose:

| File | Kind | Proves |
| --- | --- | --- |
| [`ui.test.ts`](../apps/web/test/ui.test.ts) | imports the module | the decisions are right |
| [`wiring.test.ts`](../apps/web/test/wiring.test.ts) | reads the shipped files as text | the product reaches them |
| [`browser-smoke.test.ts`](../apps/web/test/browser-smoke.test.ts) | executes `app.js` against a jsdom document | the script boots and its handlers run |

`wiring.test.ts` asserts what needs no DOM: both modules parse (`node --check`, which is the 40 ms
check that would have caught the failure), no imported name is also declared locally, no imported
name is unused, every `$("id")` has a host in `index.html` or is created before it is read, every
class applied has a rule, every custom property read is defined, and every evidence request is
addressed as `/api/analyses/:id/evidence/:evidenceId` rather than through a global endpoint. Each of
those corresponds to a defect that shipped — the unused-import check alone was hiding eleven working,
tested, unreachable features.

The third kind arrived with Iteration 6 and closes the interaction half: `app.js` is evaluated
against a jsdom document built from the markup the server actually serves, talking to the real
routes over a real socket, so Escape returning focus to the chip that opened the drawer is now
asserted rather than hoped for.

**What none of the three can see is the cascade, and that is where the layer's worst product defect
was hiding.** `[hidden] { display: none }` is a user-agent rule, so `.drawer { display: flex }`
outranked it and the evidence drawer painted over half the workspace on every load, from boot,
empty. jsdom resolves the `hidden` property ahead of the cascade, so `getAttribute("hidden")`
reported a drawer opening and closing correctly for as long as the defect existed. It took a real
headless Chrome — `getBoundingClientRect` and `getComputedStyle` over the DevTools protocol — and
it was visible in the first screenshot.

The structural lesson is about the shape of these gates, not about the bug. Each of the three
inspects the product through a different substitute for a browser, and the substitutes share a
blind spot: none of them resolves a stylesheet. So the layout facts this product depends on are
gated as *text* — `wiring.test.ts` asserts that the `[hidden]` reset exists and that no `display`
declaration outranks it — which catches a regression in the rule while proving nothing about the
pixels. A geometric gate is the honest fix and is item 7 of the changelog's `## Next`; what stands
in the meantime is a stylesheet grep and a documented gap.

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
| [`benchmark.ts`](../packages/evaluator/src/benchmark.ts) | The benchmark's identity, sets and categories — a metadata view over the cases. |
| [`benchmark-report.ts`](../packages/evaluator/src/benchmark-report.ts) | Splits a scored report by set, category, difficulty, repository and evidence kind. |

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

### The benchmark is a view, not a second dataset (Iteration 6)

`benchmark.ts` sits *beside* the loader rather than inside it. `loadCases` still returns exactly
what it always returned, and `scoreQuestion` still receives exactly what it always received; the
benchmark layer reads the same case files a second time to answer a different question — which
sets exist, which categories they cover, how the counts compare to what the manifest declares.

That separation is what makes the metadata safe. `EvalCaseSchema` is a `z.object` and strips
undeclared keys, so a challenge question's inline `category`, `difficulty`, `tags` and
`evidenceRationale` are provably unreachable from the scorer: the object it is handed never
contains them. A question cannot be scored more leniently for being labelled `hard`, and this is a
property of the parser rather than of anyone's discipline.

The frozen half is asymmetric on purpose. Regression Set v1's questions may not change, so they
carry no inline metadata at all and their classification lives in the manifest's `annotations` map,
keyed `caseId/questionId` — compound because ids like `q1-purpose` legitimately exist in both
frozen files.

`loadBenchmark()` accumulates every disagreement it finds — a case in no set, a declared fixture
that no case uses, a question classified twice, an undeclared category, a count that does not
match, a difficulty missing from the distribution — and throws them in one `EvaluationError` rather
than one at a time. The manifest is a declaration; the case files are the dataset; a mismatch is a
bug in whichever is wrong, and never a reason to edit a count.

`evidenceKind()` classifies a question's expected evidence as `documentation`, `source`, `mixed` or
`none`. It is the grouping that turned out to carry Iteration 6's signal, and it exists because a
system that passes the documentation group and fails the source group has a *looking* problem
rather than a *thinking* problem — two failures that look identical in a single accuracy number.

`readReportIdentity()` returns `null` for a v1 report instead of a default. An Iteration 3 run
predates this benchmark, and labelling it `v2` at read time would be inventing a fact about
history in order to fill a column.

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

### Three identities (Iteration 6)

A report now carries three separate labels, and the separation is the design:

| Field | Answers | Owned by |
| --- | --- | --- |
| `systemVersion` | Which code ran? | the system under measurement |
| `provenance` | Where did this run come from? | the operator, via `--provenance` |
| `benchmark.version` | Which dataset was it measured against? | the manifest |

None may stand in for another. Overloading `systemVersion` to also mean "this was the Iteration 6
baseline run" is the cheap version of this, and it produces a table whose rows silently compare
different things — two runs of the same code against different datasets look like a regression.

Provenance is a real schema change rather than a reinterpretation: reports are `schemaVersion` 2,
`SCHEMA_VERSION` in the analysis store is 2, and existing databases migrate. It is resolved by
[`resolveProvenance`](../packages/shared/src/provenance.ts) — explicit flag, then
`REPO_ARCHAEOLOGIST_PROVENANCE`, then `unlabelled` — and validated against
`/^[a-z0-9][a-z0-9._/-]{0,63}$/` before anything binds a port or opens a store, so a shell
expansion that produced `$(whoami) run` fails as a sentence rather than landing in a row and an
HTTP body.

`resolveBenchmark()` returns `null` when no manifest sits beside the case directory, and the report
then declares no benchmark rather than claiming one it did not use. This is the same refusal as
`readReportIdentity()`: a missing fact stays missing.

---

## Smoke gates — the entry points, executed (Iteration 6)

`tsc --noEmit` and `node --check` both pass on an entry point that throws on line one. Three suites
exist because that gap is where a broken start actually lives:

| Suite | What it proves |
| --- | --- |
| [`apps/cli/test/cli-smoke.test.ts`](../apps/cli/test/cli-smoke.test.ts) | The real binary, spawned as a child process: help, every parse refusal, and one full `--mock` analysis that writes the files it says it wrote. |
| [`apps/web/test/entry-smoke.test.ts`](../apps/web/test/entry-smoke.test.ts) | `main.ts` spawned with real flags — `.env` load, config and budget resolution, database location, store construction, bind order — then answered over TCP. |
| [`apps/web/test/browser-smoke.test.ts`](../apps/web/test/browser-smoke.test.ts) | `public/app.js` executed against a jsdom document, driving the real DOM the server serves. |

Both process suites run entirely on the offline mock provider and blank `GEMINI_API_KEY` in the
child's environment: a developer machine that happens to have a key must never turn `pnpm test`
into a paid run, and a smoke gate that costs money is a smoke gate people switch off.

They assert wiring invariants rather than appearance — a URL that is answered, a flag that is
refused, a label that reaches a stored row — so rewording a message or restyling a page does not
break them. Two drift checks are included for the same reason: each entry point's `--help` output
is compared against the flags its parser actually accepts, in both directions.

### What the browser gate does not prove

jsdom is not a browser. It has no layout, no paint, no real network stack and no CSS cascade, so
this suite cannot see a control rendered off-screen, a stylesheet that hides an element, a font
that never loads, or a behaviour that only appears under a real event loop. **It is not equivalent
to a browser test and is not claimed to be.** What it does prove is that the shipped `app.js`
parses, boots against the shipped markup, and wires its handlers to elements that exist — which is
the class of failure that had actually shipped here before.

A note worth keeping, because it cost time to find: `@types/jsdom` cannot be installed in this
repository. `tsconfig.json` deliberately omits the DOM lib so that server code cannot reach for
`document` by accident, and those types reintroduce DOM globals project-wide, silently undoing that
boundary. The suite declares the handful of globals it needs in
[`apps/web/test/jsdom.d.ts`](../apps/web/test/jsdom.d.ts) instead.

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
