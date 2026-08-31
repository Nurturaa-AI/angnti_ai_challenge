# Changelog

All notable changes to Repo Archaeologist. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

Nothing yet. See [`docs/improvement-changelog.md`](docs/improvement-changelog.md) for what
Iteration 2 has to address.

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

1. Fix `expectedEvidence`. Every question's expected-evidence list names only files the baseline
   could see, so a system citing the implementation instead of the README describing it is
   scored down for citing better evidence. Widen the lists **and re-run both systems** — the
   dataset change has to be measured against the baseline too, or it is indistinguishable from
   moving the goalposts.
2. Make the agent search. It made 7 tool calls across both cases and every one was `read_file`;
   `search_code` was never used, and the question that motivated Iteration 1 still fails because
   the agent guessed a filename instead of searching for the concept. Until that changes, the
   exploration mechanism has not been tested at full strength.
3. Keep breadth while adding depth. The one genuine regression came from a briefing that went
   deep on a single flow and dropped a detail the baseline caught.
4. Then re-measure. Hypothesis first, in
   [`docs/improvement-changelog.md`](docs/improvement-changelog.md), before any code changes.
