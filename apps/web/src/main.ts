#!/usr/bin/env -S npx tsx
import os from "node:os";
import path from "node:path";
import {
  ANALYSIS_SYSTEMS,
  DATABASE_ENV_VAR,
  DEFAULT_ANALYSIS_SYSTEM,
  MEMORY_DATABASE,
  SqliteAnalysisStore,
  resolveDatabaseLocation,
  type AnalysisStore,
} from "@repo-arch/app";
import {
  DEFAULT_PROVENANCE,
  PROVENANCE_ENV_VAR,
  formatError,
  loadConfig,
  loadDotEnv,
  loadExplorationBudget,
  loadPrecisionPolicy,
  describeConfig,
  resolveProvenance,
  type ConfigOverrides,
  type ExplorationBudgetOverrides,
  type PrecisionPolicyOverrides,
  type ThinkingLevel,
} from "@repo-arch/shared";
import { startWebServer } from "./server";

/**
 * The web application's entry point.
 *
 * Deliberately thin, and deliberately shaped like the CLI's: the same hand-rolled flag
 * parsing, the same `loadConfig` / `loadExplorationBudget` / `loadPrecisionPolicy`, the
 * same `.env` handling. A second configuration mechanism for the web would mean a
 * repository could be analysed under one budget from the terminal and another from the
 * browser, and nobody would notice until the two disagreed.
 *
 *   pnpm web -- [--root <dir>] [--port <n>] [--mock]
 *
 * `--root` is the workspace: the only directory tree a request may name a repository
 * inside. It defaults to the current working directory, which for the common case ("look
 * at the repositories next to this one") is what someone means.
 *
 * `--db` is where analyses are kept. It defaults to a per-user database outside the
 * workspace, never inside it — see `resolveDatabaseLocation`. A store that cannot be
 * opened stops the server here rather than at the first request, because a dashboard
 * that lists analyses is not worth starting if nothing can be saved.
 */

const USAGE = `repo-arch web — analyse a repository in the browser, with its evidence

USAGE
  pnpm web -- [flags]

FLAGS
  --root <dir>        Workspace root. Only repositories inside it can be analysed.
                      Default: the current directory.
  --port <n>          Port to listen on (default 4173). 0 asks the OS for a free one.
  --host <name>       Interface to bind (default 127.0.0.1 — loopback only).
  --db <path>         Analysis database file. Default: ~/.repo-archaeologist/analyses.db.
                      ":memory:" keeps analyses only for the life of the process.
                      It may not be inside the workspace named by --root.
  --mock              Use the offline deterministic provider. No API key, no cost.
  --provenance <label>
                      Where this run came from, e.g. iteration-6-baseline. Recorded on
                      every analysis started from the browser and shown on its report.
                      Default: ${PROVENANCE_ENV_VAR}, then "${DEFAULT_PROVENANCE}".
  --model <id>        Model id (default: from REPO_ARCHAEOLOGIST_MODEL).
  --seed <n>          Sampling seed.
  --thinking <level>  low | medium | high.
  --max-output <n>    Output token ceiling.
  --system <name>     Default system for the UI: ${ANALYSIS_SYSTEMS.join(" | ")}.
  -h, --help          Show this message.

  Exploration, scout and precision budgets accept the same flags as the CLI:
  --max-tool-calls, --max-turns, --max-search-results, --max-file-lines,
  --max-file-bytes, --max-list-entries, --max-list-depth, --max-scout-terms,
  --max-scout-searches, --max-scout-files, --max-corroborations,
  --min-corroboration-terms, --max-corroboration-chars.

ENVIRONMENT
  GEMINI_API_KEY      Required unless --mock. Copy .env.example to .env.
                      The key is never printed, never written to a file, and never
                      sent to the browser.
  ${DATABASE_ENV_VAR}  Default analysis database path. --db overrides it.

NOTES
  The server binds loopback only and refuses requests whose Host is not localhost.
  It never writes to an analysed repository: every read goes through the same
  repository boundary the CLI uses, and the database lives outside the workspace.
`;

interface ParsedArgs {
  root: string | undefined;
  port: number | undefined;
  host: string | undefined;
  system: string | undefined;
  db: string | undefined;
  provenance: string | undefined;
  overrides: ConfigOverrides;
  budget: ExplorationBudgetOverrides;
  precision: PrecisionPolicyOverrides;
  help: boolean;
}

export function parseWebArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    root: undefined,
    port: undefined,
    host: undefined,
    system: undefined,
    db: undefined,
    provenance: undefined,
    overrides: {},
    budget: {},
    precision: {},
    help: false,
  };

  const numeric = (flag: string, raw: string | undefined): number => {
    const value = Number(raw);
    if (raw === undefined || !Number.isFinite(value)) {
      throw new Error(`${flag} needs a number.`);
    }
    return value;
  };
  const text = (flag: string, raw: string | undefined): string => {
    if (raw === undefined || raw.startsWith("--")) throw new Error(`${flag} needs a value.`);
    return raw;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    const next = argv[index + 1];
    const take = (): string => {
      const value = text(argument, next);
      index += 1;
      return value;
    };
    const takeNumber = (): number => {
      const value = numeric(argument, next);
      index += 1;
      return value;
    };

    switch (argument) {
      // `pnpm web -- --port 4200` forwards the separator itself. Ignore it.
      case "--":
        break;
      case "-h":
      case "--help":
        parsed.help = true;
        break;
      case "--root":
        parsed.root = take();
        break;
      case "--port":
        parsed.port = takeNumber();
        break;
      case "--host":
        parsed.host = take();
        break;
      case "--system":
        parsed.system = take();
        break;
      case "--db":
        parsed.db = take();
        break;
      case "--provenance":
        parsed.provenance = take();
        break;
      case "--mock":
        parsed.overrides.provider = "mock";
        break;
      case "--model":
        parsed.overrides.model = take();
        break;
      case "--seed":
        parsed.overrides.seed = takeNumber();
        break;
      case "--thinking":
        parsed.overrides.thinkingLevel = take() as ThinkingLevel;
        break;
      case "--max-output":
        parsed.overrides.maxOutputTokens = takeNumber();
        break;
      case "--max-tool-calls":
        parsed.budget.maxToolCalls = takeNumber();
        break;
      case "--max-turns":
        parsed.budget.maxTurns = takeNumber();
        break;
      case "--max-search-results":
        parsed.budget.maxSearchResults = takeNumber();
        break;
      case "--max-file-lines":
        parsed.budget.maxFileLines = takeNumber();
        break;
      case "--max-file-bytes":
        parsed.budget.maxFileBytes = takeNumber();
        break;
      case "--max-list-entries":
        parsed.budget.maxListEntries = takeNumber();
        break;
      case "--max-list-depth":
        parsed.budget.maxListDepth = takeNumber();
        break;
      case "--max-scout-terms":
        parsed.budget.maxScoutTerms = takeNumber();
        break;
      case "--max-scout-searches":
        parsed.budget.maxScoutSearches = takeNumber();
        break;
      case "--max-scout-files":
        parsed.budget.maxScoutFiles = takeNumber();
        break;
      case "--max-corroborations":
        parsed.precision.maxCorroborations = takeNumber();
        break;
      case "--min-corroboration-terms":
        parsed.precision.minCorroborationTerms = takeNumber();
        break;
      case "--max-corroboration-chars":
        parsed.precision.maxCorroborationChars = takeNumber();
        break;
      default:
        throw new Error(`Unknown flag: ${argument}`);
    }
  }

  return parsed;
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseWebArgs(argv);
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (args.system !== undefined && !ANALYSIS_SYSTEMS.includes(args.system)) {
    throw new Error(`Unknown --system "${args.system}". Expected one of: ${ANALYSIS_SYSTEMS.join(", ")}.`);
  }

  loadDotEnv();
  const config = loadConfig(args.overrides);
  // Resolved here rather than left to the runner so that a malformed label stops the
  // process before anything binds a port, and so the banner below prints the label
  // that will actually be stored rather than the one that was typed.
  const provenance = resolveProvenance(args.provenance);
  const workspaceRoot = path.resolve(args.root ?? process.cwd());

  const databaseLocation = resolveDatabaseLocation({
    explicit: args.db,
    workspaceRoot,
    env: process.env,
    homeDirectory: os.homedir(),
  });
  const store: AnalysisStore = new SqliteAnalysisStore({ location: databaseLocation });

  let running: Awaited<ReturnType<typeof startWebServer>>;
  try {
    running = await startWebServer({
      workspaceRoot,
      config,
      budget: loadExplorationBudget(args.budget),
      precisionPolicy: loadPrecisionPolicy(args.precision),
      host: args.host,
      port: args.port,
      store,
      provenance,
    });
  } catch (error) {
    // The database is open by now. Closing it before rethrowing keeps a failed start
    // from leaving a WAL behind for the next run to recover.
    await store.close();
    throw error;
  }

  const described = describeConfig(config);
  process.stdout.write(
    [
      "",
      `repo-arch web  ${running.url}`,
      "",
      `workspace:  ${workspaceRoot}`,
      `database:   ${databaseLocation === MEMORY_DATABASE ? "in memory (analyses are not kept)" : databaseLocation}`,
      `provider:   ${String(described.provider)} / ${String(described.model)}`,
      `api key:    ${String(described.apiKey)}`,
      `default:    ${args.system ?? DEFAULT_ANALYSIS_SYSTEM} system`,
      `provenance: ${provenance}`,
      "",
      "Open the URL above. Ctrl-C to stop.",
      "",
    ].join("\n"),
  );

  /**
   * Ordered shutdown, and the reason the order is what it is.
   *
   * The server closes first: it stops accepting connections immediately, and `close()`
   * resolves once the ones already open have finished. Only then does the store close,
   * because a store closed underneath an in-flight write turns a clean shutdown into a
   * `StorageError` in a log — a request that was about to succeed instead reports a
   * database failure, which is a lie about what happened.
   *
   * A close that fails is reported and exits non-zero. Silently exiting 0 after failing
   * to close a database is the shape of bug that a supervisor reads as "stopped cleanly"
   * and restarts into a recovering WAL. The failure is printed through `formatError`
   * rather than as a rejection, both because a stack trace on Ctrl-C is noise and because
   * `formatError` is where redaction lives.
   *
   * `once` per signal, and `stopping` besides. `once` is deliberate and is what makes a
   * second Ctrl-C work the way Ctrl-C is supposed to: the handler has already been removed,
   * so the second signal reaches Node's default disposition and the process dies at 130
   * without draining. A user who presses it twice has asked for that. `stopping` covers the
   * mixed case — SIGINT then SIGTERM — where a second handler is still registered and
   * would otherwise call `close()` on an already-closing server.
   */
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void running
      .close()
      .then(() => store.close())
      .then(() => {
        process.exitCode = 0;
      })
      .catch((error: unknown) => {
        process.stderr.write(`\nShutdown did not complete cleanly: ${formatError(error)}\n`);
        process.exitCode = 1;
      });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  // Resolves when the server closes; until then the process stays up on its handles.
  return await new Promise<number>(() => {
    /* Intentionally never resolved: the signal handlers end the process. */
  });
}

export { startWebServer } from "./server";

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`\n${formatError(error)}\n`);
    process.exitCode = 1;
  });
