# Production hardening — repository audit

Audit taken at commit `481d9df` ("Iteration 8 — Schema-Level Atomic Claims & Evidence
Composition completed"), before any hardening change. Its purpose is to record what the
repository actually contained at the start of the release pass, so every subsequent diff can be
justified against a written baseline rather than against memory.

Production hardening does not modify the measured analytical behaviour or benchmark contract
established by Iteration 8.

## Starting state

| Check | Result |
| --- | --- |
| `git status --short` | clean — no untracked, modified or staged file |
| `pnpm test` | 831 tests, 36 files, all passing |
| `pnpm typecheck` | clean (`tsc --noEmit`, strict) |
| `pnpm verify:measured --ref HEAD` | OK — 9 frozen files unchanged, `ADVANCED_VERSION` 0.2.0, `BASELINE_VERSION` 0.1.0 |
| Versions | root `0.7.0`, advanced `0.2.0`, baseline `0.1.0`, every other workspace `0.1.0` |

The scratch debug scripts (`scripts/tmp-dbg.ts`, `scripts/tmp-dbg2.ts`) that existed during
Iteration 8 were already deleted; `scripts/diagnose-claim-composition.ts` was already committed.

## Repository hygiene

No tracked file matches `*.db`, `*.sqlite*`, `*-wal`, `*-shm`, `*.log` or `*.pid`, and no such
file exists in the working tree outside `node_modules`. Nothing has to be untracked.

`.gitignore` does, however, name no SQLite pattern at all. The default database lives at
`~/.repo-archaeologist/analyses.db` and `resolveDatabaseLocation` refuses a database inside the
workspace, so the common case cannot produce one here — but `--db ./local.db` is accepted, and
WAL and shared-memory sidecars would land beside it. Ignoring those patterns is cheap insurance
against a database being committed on the day someone does exactly that.

What must **not** be ignored, and is not: `evaluation/`, `fixtures/` (only `fixtures/*/`, the
generated repositories, are ignored — the directory and its `.gitkeep` stay), `docs/`, `scripts/`.
The three `.gitkeep` placeholders in `reports/`, `trajectories/` and `evaluation/results/` are
deliberate and stay tracked; the run output in them is deliberately untracked, because a
committed mock-provider report is easily mistaken for a measured result.

`TODO`/`FIXME`/`HACK`/`XXX`: none in any `.ts`, `.js`, `.css` or `.html` file.

## Secrets and configuration

Every match for `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `API_KEY`, `SECRET`, `PASSWORD`,
`PRIVATE_KEY`, `Authorization` and `Bearer` across tracked files falls into one of four
categories, and none is a credential:

- **Help text and error strings** — `apps/cli/src/index.ts`, `apps/web/src/main.ts`,
  `packages/shared/src/llm.ts` name the variable so a user can set it. `llm.ts:374` says
  outright that "the key is never printed by this tool".
- **Redaction machinery** — `packages/shared/src/paths.ts` holds the pattern that rewrites
  `GEMINI_API_KEY|GOOGLE_API_KEY|API[_-]?KEY` assignments to `<redacted>` on every write.
- **Test fixtures** — `AKIAIOSFODNN7EXAMPLE`, AWS's own documentation placeholder, planted so
  the suite can assert it never reaches a report, a dashboard, a PDF or a serialised response.
- **Fixture repository content** — `scripts/build-fixtures.ts` generates an example service whose
  config reads `env.JWT_SECRET`. That is a reference to a credential, not a credential. No
  source file under `packages/*/src`, `apps/*/src`, `advanced/src` or `baseline/src` reads
  `JWT_SECRET`.

`.env` exists locally and is ignored (`.gitignore:5`). `.env.example` contains placeholders only
and an empty `GEMINI_API_KEY=`.

`.env.example` is, however, **incomplete**. Code reads 20 `REPO_ARCHAEOLOGIST_*` variables; the
example documents 12. Undocumented: `REPO_ARCHAEOLOGIST_DB`, `_PROVENANCE`, `_MAX_SCOUT_TERMS`,
`_MAX_SCOUT_SEARCHES`, `_MAX_SCOUT_FILES`, `_MAX_CORROBORATIONS`, `_MIN_CORROBORATION_TERMS`,
`_MAX_CORROBORATION_CHARS`. Host and port are flags with no environment equivalent, which is
worth stating rather than leaving a reader to infer.

## Runtime lifecycle

`apps/web/src/main.ts` installs `SIGINT`/`SIGTERM` handlers that close the server, then the
store, in that order — server first, so an in-flight request is not writing into a store that
has just closed. Measured, not assumed:

| Probe | Result |
| --- | --- |
| `SIGTERM` on an idle server | exit code 0 |
| `SIGTERM` with an analysis in flight | exit code 0 |
| `SIGTERM` mid-run against a file database, then restart | exit 0, no stderr, no `-wal`/`-shm` left behind, record readable as `completed` |

Two gaps in that handler, both real and both narrow:

1. The promise chain has no `.catch`. If `running.close()` or `store.close()` rejects, the
   rejection is unhandled — on Node 22 that terminates the process with a non-zero code and a
   stack trace, which is the right exit status reached by the wrong route, and prints a trace to
   a user's terminal on shutdown.
2. Exit status is always 0. A shutdown that failed to close the store cleanly reports success.

Neither touches the analysis pipeline, and fixing them does not require altering the Iteration 5
lifecycle contract.

## Missing artefacts

- **No `build` script.** `git grep` for `"build"`, `pnpm build`, `tsc -p` and `outDir` across
  `*.json` and `*.md` returns nothing. This is deliberate and documented: the README says "There
  is no build step. `tsx` runs the TypeScript directly." The release gate's `pnpm build` step
  therefore has nothing to run. The shipped artefacts are verified instead by the three suites
  that execute them as processes — `cli-smoke`, `entry-smoke`, `browser-smoke` — and by
  `pnpm typecheck`. Adding an emit step now would be inventing a convention the repository does
  not have, so this is reported rather than fixed.
- **No production/operations documentation.** `docs/` holds `architecture.md`, `evaluation.md`
  and `improvement-changelog.md` only. Environment contract, database location, host/port,
  startup validation, shutdown and health endpoint are documented nowhere in one place.
- **No future-work document.** The intentionally-unsolved items (cooperative cancellation
  pending `AbortSignal` propagation, the `pyflow-q04` inference gap, the 38-case benchmark's
  size, the closed set of composition rules) live scattered across changelog entries.
- **`scripts/diagnose-claim-composition.ts` is undocumented.** It is referenced once, from
  `docs/improvement-changelog.md:1747`. Reviewed: it calls no model, reads no benchmark data
  into the product pipeline, imports the evaluator only to score *after* the claim pass has run,
  writes nothing, and is not imported by any source file — so it cannot reach the production
  request path. It is a maintained developer diagnostic and should be documented as one.
- **Stale README status.** The status blurb reads "four measured iterations, one of them
  rejected" and the narrative stops at Iteration 6. Iterations 7 (rejected) and 8 (kept) are
  missing. The test count in the README's Test section reads 778; the suite is 831.

## Web application

`apps/web/public/` ships `app.js` (2399 lines), `ui.js` (516), `index.html` (113) and
`styles.css` (1550). `pnpm vitest run apps/web` passes: 7 files, 168 tests, including
`browser-smoke.test.ts` cases named "shares the row with the workspace rather than floating over
it" and "fills the architecture workspace rather than showing an empty landing page" — the two
§20 layout defects were fixed under `Unreleased` and are gated. jsdom has no layout engine, no
CSS cascade and no paint, so those gates assert stylesheet *text*, not geometry; the remaining
§20 work (responsive breakpoints, header and sidebar legibility, drawer width and scroll) is
verification against the stylesheet and the shipped markup, not repair.

## Plan

In order, and nothing outside it:

1. `.gitignore` — SQLite, WAL, shared-memory and PID patterns.
2. `.env.example` — the eight undocumented variables, plus a note on host and port.
3. `apps/web/src/main.ts` — `.catch` on the shutdown chain and a non-zero exit on a failed close.
4. Documentation — a production/operations page, a future-work page, the diagnostic script
   documented, the README status blurb and test count corrected.
5. `CHANGELOG.md` — a production-hardening entry that does not claim a benchmark improvement.
6. Verification — security, persistence, lifecycle, web, accessibility and dead-UI passes, then
   the full release gate.

Nothing in `advanced/`, `baseline/`, `evaluation/`, `fixtures/`, `prompt.ts`, `schemas.ts`,
`grounding.ts`, `scout/` or `claims/` is in that plan. If a production concern turns out to
require a change there, it will be reported rather than made.
