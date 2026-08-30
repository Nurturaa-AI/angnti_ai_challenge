# Architecture

Two commands, five packages, no build step. The shape is driven by one constraint: the
evaluation harness must be able to score the baseline and the future agent with *identical*
code, so that a change in the number means a change in the system rather than a change in
how it was graded.

```
                    apps/cli
                       │
          ┌────────────┴────────────┐
          ▼                         ▼
      baseline                 evaluation
          │                         │
          │                    ┌────┴─────────────┐
          ▼                    ▼                  ▼
   packages/shared  ◄──  packages/evaluator   (cases/, results/)
```

`baseline` produces a `RunRecord`. `evaluator` consumes a `RunRecord` and knows nothing
about where it came from. `evaluation` is the runner that joins them. Every arrow points one
way; there are no cycles and no back-channels.

---

## `packages/shared` — the contract

Everything both sides must agree on, and nothing else.

| Module | Responsibility |
| --- | --- |
| [`schemas.ts`](../packages/shared/src/schemas.ts) | Zod schemas for `AnalysisResult`, `Evidence`, `RunRecord`. The single source of truth for shape. |
| [`repo.ts`](../packages/shared/src/repo.ts) | Shallow context collection: tree, README, manifest, metadata. |
| [`context-format.ts`](../packages/shared/src/context-format.ts) | Renders collected sources into the prompt block, with per-source truncation. |
| [`grounding.ts`](../packages/shared/src/grounding.ts) | Verifies citations against the supplied context. The fabrication defence. |
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
}
```

One interface, two implementations, injectable everywhere. This is why the entire test suite
runs offline: `runBaseline` and `runEvaluation` both accept a `client`, so a test can supply
a stub that returns exactly the malformed JSON, the fabricated citation, or the missing field
under examination. No network, no key, no cost, no flakiness.

The Gemini client uses the **Interactions API** (`ai.interactions.create`) with
`response_format.mime_type = "application/json"` and a supplied schema. `generation_config`
takes a `seed` rather than a temperature, so the seed is the reproducibility lever and is
recorded in every run's metadata.

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
  `runBaseline`. A test plants sentinel strings in every question and expected answer and
  asserts neither reaches the model's input or system instruction. Without this the harness
  would be measuring the model's ability to read the answer key.
- **The same inputs produce the same report.** With a fixed clock and a stubbed client, two
  runs deep-equal each other.
- **The written file is the report.** The JSON on disk deep-equals the returned report
  object, and the Markdown on disk is byte-identical to the returned string — so nothing can
  be true in the process and false in the artefact.

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

**Where the next system plugs in.** An advanced agent implements the same
`(repositoryPath, config) → RunRecord` contract and registers a system name. `runEvaluation`
already takes `system` and already rejects an unknown one. Nothing in `packages/evaluator`
needs to change — which is the whole reason the harness was built first.
