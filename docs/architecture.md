# Architecture

Three commands, six packages, no build step. The shape is driven by one constraint: the
evaluation harness must be able to score every system with *identical* code, so that a change
in the number means a change in the system rather than a change in how it was graded.

```
                         apps/cli
                            │
          ┌─────────────┬───┴───────────┐
          ▼             ▼               ▼
      baseline      advanced        evaluation
          │             │               │
          └──────┬──────┘          ┌────┴─────────────┐
                 ▼                 ▼                  ▼
          packages/shared  ◄──  packages/evaluator   (cases/, results/)
```

`baseline` and `advanced` each produce a `RunRecord`. `evaluator` consumes a `RunRecord` and
knows nothing about where it came from — it cannot tell which system produced one, which is
the property that makes the two comparable. `evaluation` is the runner that joins them. Every
arrow points one way; there are no cycles and no back-channels.

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
| [`json.ts`](../packages/shared/src/json.ts) | Extracts JSON from whatever the model actually returned; validates against a schema. |
| [`llm.ts`](../packages/shared/src/llm.ts) | The `LlmClient` interface and the Gemini implementation. |
| [`mock-llm.ts`](../packages/shared/src/mock-llm.ts) | An offline, deterministic, zero-cost provider. |
| [`config.ts`](../packages/shared/src/config.ts) | Environment and flag resolution; `.env` loading; config description for logs. |
| [`cost.ts`](../packages/shared/src/cost.ts) | Token usage → dollars, for the models whose prices are published. |
| [`trajectory.ts`](../packages/shared/src/trajectory.ts) | Records what a run did, step by step, with timings. |
| [`paths.ts`](../packages/shared/src/paths.ts) | Portable paths and secret redaction on every write. |
| [`errors.ts`](../packages/shared/src/errors.ts) | Typed errors carrying a hint: `RepositoryError`, `ModelError`, `SchemaError`, `ConfigError`, `EvaluationError`. |

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

### Three things about Gemini tool use that only a real call reveals

All three of these were found by running against the live API, and none of them can fail
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

## `advanced/` — targeted exploration (Iteration 1)

[`runAdvanced`](../advanced/src/index.ts) keeps the baseline's five steps and inserts a bounded
exploration loop between step 2 and step 3.

```
collect-context ─► build-recon-prompt ─► ┌─ model turn ──┐ ─► build-synthesis-prompt
                                         │      ▲        │        │
                                         │      └─ tool ─┘        ▼
                                         └── ≤ maxTurns ──┘   synthesis-call
                                                                  │
                                              validate-schema ◄───┘
                                                     │
                                              ground-evidence
```

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

Seven bounds, each settable by flag or environment variable, defaults in
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

Environment variables use the `REPO_ARCHAEOLOGIST_MAX_*` prefix. A budget of zero is rejected
with a hint, since it would leave the agent unable to look at anything.

Exhausting the call budget does not silently drop the call. The loop returns an explicit error
result to the model — `exploration budget exhausted … answer with what you have` — because an
unanswered function call leaves the model waiting for a result that will never arrive.

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
`callsByTool`, `filesRead`, `bytesFromTools`, `budgetExhausted`, and the full budget the run
used.

### What Iteration 1 measured

It regressed the primary metric: **64.3 % → 57.1 %**. The mechanism works — the grounding layer
held with zero fabrications and zero dropped citations — but the agent used only `read_file`,
never `search_code`, and traded several documentation citations for one implementation citation.
Full numbers and diagnosis in [`improvement-changelog.md`](improvement-changelog.md).

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

**Where the next system plugs in.** A new system implements the same
`(repositoryPath, config) → RunRecord` contract and registers a system name in
`EVALUABLE_SYSTEMS`. `runEvaluation` already takes `system` and already rejects an unknown one.
Nothing in `packages/evaluator` needed to change to score Iteration 1 — no new evidence type, no
new matching rule, no scoring exemption — which is the whole reason the harness was built first,
and the reason its 57.1 % is worth believing.
