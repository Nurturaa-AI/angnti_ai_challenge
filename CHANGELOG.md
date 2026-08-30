# Changelog

All notable changes to Repo Archaeologist. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

Nothing yet. The next change is the first real evaluation run — see
_Next_ at the bottom of this file.

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

---

## Next

1. Set `GEMINI_API_KEY` and run `pnpm evaluate:baseline`. Record the resulting
   evidence-backed task accuracy here, with the model id and seed that produced it. That
   number is the baseline.
2. Then, and only then, start the agent.
