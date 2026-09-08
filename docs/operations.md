# Running this in production

Everything needed to install, configure, run, verify and stop the web application, plus the
security posture it assumes. The analysis pipeline itself is documented in
[`architecture.md`](architecture.md); the measurement method in [`evaluation.md`](evaluation.md).

This document describes the accepted Iteration 8 system — advanced `0.2.0`, baseline `0.1.0` — as
released in `0.8.0`. Production hardening changed operational behaviour only; no number in
[`../CHANGELOG.md`](../CHANGELOG.md) was re-measured for it.

---

## Requirements

| | |
| --- | --- |
| **Node.js** | **≥ 22.0.0**, and not optional. The store is `node:sqlite` from Node's own standard library, which does not exist before 22. |
| **pnpm** | **10.33.0**, declared in `packageManager`. Corepack will select it. |
| **git** | Only to read `HEAD` of an analysed repository, through `execFileSync("git", …)` with a 5 s timeout. Absent or failing git means the briefing reports no commit, not a failed run. |
| **Network** | Outbound HTTPS to the Gemini API. Nothing else. `--mock` needs none. |
| **Disk** | The repository plus `node_modules`, and the analysis database, which grows per stored analysis. Nothing prunes it — see [`future-work.md`](future-work.md#nothing-prunes-the-database). |
| **Native toolchain** | None. There is no build step and no compiled dependency. |

Node emits an `ExperimentalWarning` for `node:sqlite` on startup. It comes from the runtime, not
from this application, and it is the only warning either entry point is expected to produce.

## Installation

```sh
pnpm install --frozen-lockfile
```

`--frozen-lockfile` is the production form: it fails rather than resolving a dependency the
lockfile does not name.

There is **no build step**. Each package exports `./src/index.ts` and `tsx` runs the TypeScript
directly; `pnpm typecheck` (`tsc --noEmit`, strict) is the type gate. The shipped artefacts are
verified by executing them — see [Verifying a release](#verifying-a-release).

`pnpm setup` builds the two local git fixtures. Those are for the evaluation cases only and are not
needed to run the server.

## Configuration

Configuration is read from flags first, then the environment, then a `.env` file in the repository
root, then defaults. [`../.env.example`](../.env.example) documents every variable with its default
and contains **placeholders only** — copy it, never edit it in place with real values:

```sh
cp .env.example .env      # then set GEMINI_API_KEY
```

`.env` is gitignored. The key is never printed to stdout, never written to a file in `reports/`,
`trajectories/` or `evaluation/results/`, and never sent to the browser.

**The two that matter:**

| Variable | Meaning |
| --- | --- |
| `GEMINI_API_KEY` | Required unless `--mock`. Get one at `https://aistudio.google.com/apikey`. |
| `REPO_ARCHAEOLOGIST_PROVIDER` | `gemini` for real calls, `mock` for offline deterministic zero-cost runs. |

**The rest**, all with working defaults: `REPO_ARCHAEOLOGIST_MODEL`, `_SEED`, `_THINKING_LEVEL`,
`_MAX_OUTPUT_TOKENS`; ten exploration and scout budgets; three evidence-precision bounds;
`_PROVENANCE`; `_DB`. Every budget is a hard ceiling enforced in code rather than requested in the
prompt, so a run has a known worst case.

**Host and port have no environment variable.** They are flags, deliberately: a server that moves
its own socket based on ambient environment is a server nobody can find.

Two values are validated **before anything binds a port or opens a database**, so a malformed one
fails as a sentence rather than landing in a stored row and an HTTP body:

- `--provenance` / `REPO_ARCHAEOLOGIST_PROVENANCE` against `/^[a-z0-9][a-z0-9._/-]{0,63}$/`. Never
  put a path or a secret in it — the label is persisted, printed in reports and returned over HTTP.
- `--system`, against the systems that exist.

## Running

```sh
pnpm web -- --root /srv/repositories --port 4173 --host 127.0.0.1
pnpm web -- --root /srv/repositories --mock          # offline, no key, no cost
pnpm web -- --help                                   # every flag
```

`--root` is the **workspace**: the only directory tree a request may name a repository inside. It
defaults to the current directory, which is convenient for development and worth setting explicitly
anywhere else.

The banner on startup prints where the server is, the workspace, the database, the provider and
model, whether a key is set — as `<set>` or `<unset>`, never as a value — the default system, and the
provenance label that will actually be stored.

```
repo-arch web  http://127.0.0.1:4173

workspace:  /srv/repositories
database:   /home/svc/.repo-archaeologist/analyses.db
provider:   gemini / gemini-3.7-flash
api key:    <set>
default:    advanced system
provenance: unlabelled
```

`POST /api/analyses` returns `202` as soon as the record is durable and the analysis continues in
the background, so a client is never holding a connection open for the length of a model run. A
reverse proxy in front of this needs no long read timeout for analyses; it does need to leave
`GET /api/analyses/:id/events` (Server-Sent Events) unbuffered.

## The database

One SQLite file, via `node:sqlite`.

- **Location**, in precedence order: `--db`, then `REPO_ARCHAEOLOGIST_DB`, then
  `~/.repo-archaeologist/analyses.db`. `:memory:` opts out of persistence entirely.
- **It refuses to live inside the analysed workspace.** Checked by containment against the
  *resolved* workspace root, so `..` and a symlinked home both land where they really point. A
  database inside an analysed repository would be a file the analysis can read, `git status` reports
  and `git clean` deletes.
- **Created on first open**, directory included (`mkdir -p`). Nothing to provision.
- **Migrations run on open**, one version at a time, each inside the same transaction as its version
  bump — so a file is never left claiming a version whose migration did not finish. Current schema
  version **2**. A file from a *newer* build is **refused** rather than opened: silently ignoring a
  column is how a durable store starts losing data. Plan a rollback accordingly — downgrading the
  application below the schema version its database carries will not start.
- **WAL, `foreign_keys = ON`, `busy_timeout = 5000`, `synchronous = NORMAL`.** WAL sidecars
  (`-wal`, `-shm`) exist while the process runs and are checkpointed away by a clean shutdown.
- **Restart durability is a tested property, not an aspiration.** `pnpm smoke` stops the server with
  `SIGTERM` mid-life and reads the record back **from a second process**, then asserts no `-wal` or
  `-shm` file was left behind.
- **It stores a projection, not a dump**: the reconnaissance artefacts a question still needs after a
  restart, plus the sources some citation actually resolves to. Excerpts are redacted on the way
  **in**, so a restart cannot change what the viewer shows. `MAX_STORED_QUESTIONS = 50` bounds one
  axis; the number of analyses is unbounded by design.

**Back it up by copying the file while the server is stopped.** A clean shutdown leaves a single
self-contained `.db`. Copying it live means copying the WAL sidecars in the same instant, which is
not something this application coordinates.

**One process per database file.** WAL and `busy_timeout` make a second writer *safe* rather than
fast, and nothing coordinates two servers sharing one file. Do not run a second instance against the
same path — see [`future-work.md`](future-work.md#the-store-is-single-process).

## Health and readiness

```sh
curl -s http://127.0.0.1:4173/api/health
```

`200` with `status: "ok"` means the process is up, the store is open and the routes are mounted —
the server binds only after config resolution, provenance validation, database resolution and store
construction have all succeeded, so a bound port is itself a readiness signal. The body reports the
provider and model it **actually started with**, the available systems, the question length limit,
the export formats, and `durableAnalyses`. It names the workspace by **basename only**, never by
path.

It is a liveness *and* readiness check; there is no separate readiness route, because there is no
state between "bound" and "ready". It does not call the model, so it does not prove the provider is
reachable or the key is valid — the first analysis is what proves that.

## Shutdown

`SIGINT` and `SIGTERM` both stop the server in a fixed order: **HTTP server first, then the store.**
The server stops accepting connections immediately and resolves once open requests finish; only then
does the store close, because a store closed underneath an in-flight write turns a clean shutdown
into a database error in a log — a request that was about to succeed instead reports a failure, which
is a lie about what happened.

| Outcome | Exit code |
| --- | --- |
| Clean close | `0` |
| A close that failed | `1`, with the reason printed through `formatError` (where redaction lives) rather than as a stack trace |
| A second `SIGINT` | `130` — the handler is `once`, so the second signal reaches Node's default disposition and the process dies without draining. A user who presses Ctrl-C twice has asked for that. |

Exiting `0` after failing to close a database is the shape of bug a supervisor reads as "stopped
cleanly" and restarts into a recovering WAL, so it does not do that.

**A running analysis is not waited for.** Its already-issued model call may still be in flight when
the process ends; the record stays in whatever state it last persisted, and a `running` record found
after a restart is a record whose process died. Related, and deliberate: deleting a running analysis
cancels it cooperatively — the run is told, stops writing at its next boundary and discards its
result. See [`future-work.md`](future-work.md#a-cancelled-run-still-finishes-its-pipeline).

## Verifying a release

In this order. Each is an existing script; none of them needs an API key or the network.

```sh
pnpm install --frozen-lockfile
pnpm typecheck                      # tsc --noEmit, strict
pnpm test                           # the whole suite, offline
pnpm smoke                          # the shipped entry point, end to end
pnpm verify:measured --ref HEAD      # did anything under the measured path move?
```

`pnpm smoke` ([`../scripts/production-smoke.ts`](../scripts/production-smoke.ts)) is the one that
answers *"does the thing we ship actually work?"* — 50 checks over 15 steps against the real entry
point, over a real socket, against a real file database, stopped with a real signal and read back
from a second process. It covers the seams no unit test can: a store that does not survive a
restart, a shutdown that corrupts a WAL, a route the browser needs that answers only in a harness.
It runs on `--mock` with `GEMINI_API_KEY` blanked in the child, so a machine that happens to have a
key cannot turn a smoke test into a paid run.

**There is deliberately no `pnpm build`, and running it fails.** It reports
`ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command "build" not found`, because no workspace package
defines that script. **That failure is the expected result, not a broken release process.**

This project produces **no compiled production artifact**. There is nothing to compile: every
package exports `./src/index.ts`, and `tsx` executes those TypeScript entry points directly — in
development, in the test suite, in `pnpm smoke` and in production. The two entry points shipped are
[`apps/web/src/main.ts`](../apps/web/src/main.ts) and
[`apps/cli/src/index.ts`](../apps/cli/src/index.ts), run as written.

So the usual `build` step is split between two checks that already exist, and neither is optional:

- **`pnpm typecheck`** is the *static* gate — `tsc --noEmit`, strict, no emit because nothing is
  emitted.
- **`pnpm smoke` is the release-level executable validation.** It is what a build-and-boot step
  would be for: proof that the thing being shipped actually runs. Nothing else in the sequence
  above executes the real entry point end to end.

Do not add a `build` script to make this sequence look conventional. A script that compiled to
`dist/` would create a second copy of the application, and then the artefact under test and the
artefact that ships could disagree — which is the failure mode this arrangement avoids by having
only one.

## Security posture

The input is a repository nobody vetted, so the threat model is *the analysed code is hostile* and
*the browser page may be pointed at something it should not reach*.

- **One path mechanism.** `resolveInsideRepository` — the boundary the CLI already used — holds every
  read inside its root. Absolute paths, `..` traversal, null bytes and symlink escapes are all
  refused. The workspace check and the static-asset server reuse it rather than reimplementing it.
- **Loopback by default.** Binds `127.0.0.1`. A request whose `Host` is not localhost gets `421`, so
  a rebound DNS name cannot drive a local file reader; a foreign `Origin` gets `403`. **There is no
  authentication and none is planned** — this is a single-user local tool. Exposing it on a routable
  interface means putting an authenticating proxy in front of it and accepting that every user of
  that proxy shares one analysis database.
- **Request bodies over 1 MiB are refused `413` unread.**
- **`default-src 'none'`.** The dashboard renders names, paths and excerpts taken from untrusted
  code, so the CSP makes a successful injection inert. No `unsafe-inline`, no CDN, no framework.
- **Evidence ids are keys, not paths.** A citation can only name an artefact the ledger already
  holds, and an id is scoped to the analysis that issued it. An id from another analysis is a `404`,
  including the case where both analyses happen to have issued the same positional id — each
  resolves to its own artefact.
- **Read-only, and no shell.** Nothing is ever written into an analysed repository. The only child
  process anywhere is `git rev-parse`, invoked through `execFileSync` with a fixed binary, constant
  argument arrays, no `shell: true` and a timeout. No user input reaches an argument vector.
- **Redaction at every exit.** `redactSecrets` runs on HTTP responses — success *and* error bodies —
  on reports, trajectories, metrics, the PDF, and on the operator log. It recognises a credential by
  its shape or by the name of the variable holding it, which cannot catch a bare high-entropy string
  with neither; a heuristic wide enough for that would redact hashes, UUIDs and minified code. The
  evidence ledger keeps raw bytes, because grounding has to verify an excerpt against what the file
  actually says.
- **Errors do not describe the machine.** A client gets the failure and, where one helps, a hint. It
  does not get database paths, filesystem layout, environment values or stack traces; an unexpected
  failure is one sentence and a `500`. The **operator's log** does carry the stack, because that is
  the only place the detail exists and it is what an operator has to debug from — redacted, because a
  log is a file too. Server logs are therefore diagnostic and should be treated as such: readable by
  whoever operates the service, not shipped somewhere with weaker access than the database.
- **The conversation is never evidence.** A follow-up question sees earlier turns as context, and
  only repository bytes can be cited. A question whose evidence does not support an answer gets one
  sentence saying so.

**What this does not do**, stated because a posture with silent gaps is worse than a short one: no
authentication, no authorization, no multi-tenancy, no rate limiting, no audit log of who asked
what, no encryption at rest beyond the filesystem's own. Each is a consequence of "local
single-user tool", and each would need to be reconsidered before this served more than one person.
