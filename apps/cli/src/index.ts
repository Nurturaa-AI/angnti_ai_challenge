#!/usr/bin/env -S npx tsx
import path from "node:path";
import { ADVANCED_SYSTEM_NAME, runAdvanced } from "@repo-arch/advanced";
import { BASELINE_SYSTEM_NAME, runBaseline } from "@repo-arch/baseline";
import { DEFAULT_CASES_DIR, DEFAULT_RESULTS_DIR, runEvaluation } from "@repo-arch/evaluation";
import {
  ConfigError,
  describeConfig,
  formatError,
  loadConfig,
  loadDotEnv,
  loadExplorationBudget,
  renderBriefingMarkdown,
  writeJsonFile,
  writeTextFile,
  type ConfigOverrides,
  type ExplorationBudgetOverrides,
  type RunRecord,
  type ThinkingLevel,
} from "@repo-arch/shared";

/**
 * The command line.
 *
 * Hand-rolled argument parsing, deliberately: three commands and a flat list of
 * flags do not justify a dependency, and the parser is small enough to read in
 * one sitting.
 *
 *   repo-arch baseline <repository> [flags]
 *   repo-arch advanced <repository> [flags]
 *   repo-arch evaluate [--system baseline|advanced] [flags]
 *
 * `baseline` and `advanced` share every output path below. Whichever produced the
 * run record, it is written, rendered and summarised identically — so the two can
 * be diffed directly, and so nothing in the reporting layer can flatter one of
 * them.
 */

const USAGE = `repo-arch — understand an unfamiliar codebase before you change it

USAGE
  pnpm repo:baseline -- <path-to-repository> [flags]
  pnpm repo:advanced -- <path-to-repository> [flags]
  pnpm evaluate:baseline [flags]
  pnpm evaluate:advanced [flags]

COMMANDS
  baseline <path>   Briefing from one model call over shallow context. No file reading.
  advanced <path>   Briefing from bounded, targeted exploration: search, read, list.
  evaluate          Run every evaluation case and write JSON + Markdown results.

FLAGS
  --mock                 Use the offline deterministic provider. No API key, no cost.
  --model <id>           Model id (default: from REPO_ARCHAEOLOGIST_MODEL, else gemini-3.7-flash).
  --seed <n>             Sampling seed. The Interactions API takes a seed, not a temperature.
  --thinking <level>     low | medium | high.
  --max-output <n>       Output token ceiling.
  --focus "<question>"   Aim the evidence scout's search at a question (advanced only).
                         Rejected by "evaluate": a system must not see the questions it is scored on.
  --out <dir>            Where to write output (analysis: reports/, evaluate: evaluation/results/).
  --cases <dir>          Case directory for evaluate (default: ${DEFAULT_CASES_DIR}).
  --case <id>            Evaluate only this case id. Repeatable.
  --system <name>        System to evaluate: "${BASELINE_SYSTEM_NAME}" or "${ADVANCED_SYSTEM_NAME}".
  --case-delay <s>       Seconds to wait between cases. Use it to stay under a rate limit.
  --quiet                Suppress the briefing on stdout; still writes files.
  -h, --help             Show this message.

EXPLORATION BUDGET (advanced only; each also settable from the environment)
  --max-tool-calls <n>     Total tool calls allowed across the run.
  --max-turns <n>          Model turns allowed before synthesis is forced.
  --max-search-results <n> Rows returned by one search_code call.
  --max-file-lines <n>     Lines returned by one read_file call.
  --max-file-bytes <n>     Bytes returned by one read_file call.
  --max-list-entries <n>   Entries returned by one list_directory call.
  --max-list-depth <n>     Depth walked by one list_directory call.

EVIDENCE SCOUT BUDGET (advanced only; separate from the model's tool budget above)
  --max-scout-terms <n>    Search terms extracted before the model's first turn.
  --max-scout-searches <n> search_code calls the scout may make. Cheap: no tokens, a filesystem walk.
  --max-scout-files <n>    Files the scout may read. Expensive: each one enters every later prompt.

ENVIRONMENT
  GEMINI_API_KEY         Required unless --mock. Copy .env.example to .env.
                         The key is never printed and never written to any output file.
`;

interface ParsedArgs {
  command: string | undefined;
  positional: string[];
  overrides: ConfigOverrides;
  budget: ExplorationBudgetOverrides;
  out: string | undefined;
  casesDir: string | undefined;
  caseIds: string[];
  system: string | undefined;
  caseDelaySeconds: number | undefined;
  focus: string | undefined;
  quiet: boolean;
  help: boolean;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: undefined,
    positional: [],
    overrides: {},
    budget: {},
    out: undefined,
    casesDir: undefined,
    caseIds: [],
    system: undefined,
    caseDelaySeconds: undefined,
    focus: undefined,
    quiet: false,
    help: false,
  };

  const requireValue = (flag: string, value: string | undefined): string => {
    if (value === undefined || value.startsWith("--")) {
      throw new ConfigError(`${flag} needs a value.`, `Example: ${flag} <value>`);
    }
    return value;
  };

  const requireNumber = (flag: string, value: string | undefined): number => {
    const raw = requireValue(flag, value);
    const numeric = Number(raw);
    if (!Number.isFinite(numeric)) throw new ConfigError(`${flag} must be a number, received "${raw}".`);
    return numeric;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;

    switch (argument) {
      // `pnpm repo:baseline -- ./repo` forwards the separator itself. Ignore it.
      case "--":
        break;
      case "-h":
      case "--help":
        parsed.help = true;
        break;
      case "--mock":
        parsed.overrides.provider = "mock";
        break;
      case "--quiet":
        parsed.quiet = true;
        break;
      case "--model":
        parsed.overrides.model = requireValue("--model", argv[++index]);
        break;
      case "--seed":
        parsed.overrides.seed = requireNumber("--seed", argv[++index]);
        break;
      case "--max-output":
        parsed.overrides.maxOutputTokens = requireNumber("--max-output", argv[++index]);
        break;
      case "--thinking": {
        const level = requireValue("--thinking", argv[++index]);
        if (level !== "low" && level !== "medium" && level !== "high") {
          throw new ConfigError(`--thinking must be low, medium or high, received "${level}".`);
        }
        parsed.overrides.thinkingLevel = level satisfies ThinkingLevel;
        break;
      }
      case "--out":
        parsed.out = requireValue("--out", argv[++index]);
        break;
      case "--cases":
        parsed.casesDir = requireValue("--cases", argv[++index]);
        break;
      case "--case":
        parsed.caseIds.push(requireValue("--case", argv[++index]));
        break;
      case "--system":
        parsed.system = requireValue("--system", argv[++index]);
        break;
      case "--case-delay":
        parsed.caseDelaySeconds = requireNumber("--case-delay", argv[++index]);
        break;
      case "--focus":
        parsed.focus = requireValue("--focus", argv[++index]);
        break;
      case "--max-tool-calls":
        parsed.budget.maxToolCalls = requireNumber("--max-tool-calls", argv[++index]);
        break;
      case "--max-turns":
        parsed.budget.maxTurns = requireNumber("--max-turns", argv[++index]);
        break;
      case "--max-search-results":
        parsed.budget.maxSearchResults = requireNumber("--max-search-results", argv[++index]);
        break;
      case "--max-file-lines":
        parsed.budget.maxFileLines = requireNumber("--max-file-lines", argv[++index]);
        break;
      case "--max-file-bytes":
        parsed.budget.maxFileBytes = requireNumber("--max-file-bytes", argv[++index]);
        break;
      case "--max-list-entries":
        parsed.budget.maxListEntries = requireNumber("--max-list-entries", argv[++index]);
        break;
      case "--max-list-depth":
        parsed.budget.maxListDepth = requireNumber("--max-list-depth", argv[++index]);
        break;
      case "--max-scout-terms":
        parsed.budget.maxScoutTerms = requireNumber("--max-scout-terms", argv[++index]);
        break;
      case "--max-scout-searches":
        parsed.budget.maxScoutSearches = requireNumber("--max-scout-searches", argv[++index]);
        break;
      case "--max-scout-files":
        parsed.budget.maxScoutFiles = requireNumber("--max-scout-files", argv[++index]);
        break;
      default:
        if (argument.startsWith("-")) {
          throw new ConfigError(`Unknown flag "${argument}".`, "Run with --help to see the supported flags.");
        }
        if (parsed.command === undefined) parsed.command = argument;
        else parsed.positional.push(argument);
    }
  }

  return parsed;
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);

  if (args.help || args.command === undefined) {
    process.stdout.write(USAGE);
    return args.command === undefined && !args.help ? 1 : 0;
  }

  loadDotEnv();

  // `--focus` aims the evidence scout at a question, which only the advanced system
  // has. Refused elsewhere rather than ignored — and the refusal on `evaluate` is the
  // point: a system that could see the questions it is scored on would be measuring
  // the answer key, and the baseline it is compared against answers blind.
  if (args.focus !== undefined && args.command !== ADVANCED_SYSTEM_NAME) {
    throw new ConfigError(
      `--focus is only available to the "${ADVANCED_SYSTEM_NAME}" command, not "${args.command}".`,
      args.command === "evaluate"
        ? "Evaluation deliberately withholds the questions from both systems, so that the comparison " +
          "measures repository understanding rather than question-answering. Use " +
          `"pnpm repo:${ADVANCED_SYSTEM_NAME} -- <path> --focus ..." to scout for a specific question.`
        : `The baseline makes one call over shallow context and does not search. Try "repo-arch ${ADVANCED_SYSTEM_NAME}".`,
    );
  }

  switch (args.command) {
    case "baseline":
      return await commandAnalyze(args, BASELINE_SYSTEM_NAME);
    case "advanced":
      return await commandAnalyze(args, ADVANCED_SYSTEM_NAME);
    case "evaluate":
      return await commandEvaluate(args);
    default:
      throw new ConfigError(
        `Unknown command "${args.command}".`,
        'Expected "baseline", "advanced" or "evaluate".',
      );
  }
}

async function commandAnalyze(args: ParsedArgs, system: string): Promise<number> {
  const repositoryPath = args.positional[0];
  if (repositoryPath === undefined) {
    throw new ConfigError(
      "No repository path given.",
      `Usage: pnpm repo:${system} -- ./path/to/repository`,
    );
  }

  const config = loadConfig(args.overrides);
  const outDir = args.out ?? "reports";

  let record: RunRecord;
  if (system === ADVANCED_SYSTEM_NAME) {
    const budget = loadExplorationBudget(args.budget);
    process.stderr.write(
      `advanced: ${repositoryPath} via ${config.provider}/${config.model}, ` +
        `budget ${budget.maxToolCalls} calls / ${budget.maxTurns} turns, ` +
        `scout ${budget.maxScoutSearches} searches / ${budget.maxScoutFiles} reads` +
        `${args.focus === undefined ? "" : `, focus "${args.focus}"`}\n`,
    );
    record = await runAdvanced({ repositoryPath, config, budget, focus: args.focus });
  } else {
    process.stderr.write(`baseline: ${repositoryPath} via ${config.provider}/${config.model}\n`);
    record = await runBaseline({ repositoryPath, config });
  }

  const briefing = renderBriefingMarkdown(record);

  const jsonPath = path.join(outDir, `${record.meta.runId}.json`);
  const markdownPath = path.join(outDir, `${record.meta.runId}.md`);
  writeJsonFile(jsonPath, record);
  writeTextFile(markdownPath, briefing);
  const trajectoryPath = path.join("trajectories", `${record.meta.runId}.json`);
  writeJsonFile(trajectoryPath, {
    runId: record.meta.runId,
    system: record.meta.system,
    config: describeConfig(config),
    contextSources: record.meta.contextSources,
    evidenceAudit: record.meta.evidenceAudit,
    exploration: record.meta.exploration ?? null,
    steps: record.trajectory,
  });

  if (!args.quiet) process.stdout.write(`${briefing}\n`);

  const audit = record.meta.evidenceAudit;
  const exploration = record.meta.exploration;
  process.stderr.write(
    [
      "",
      `briefing:   ${markdownPath}`,
      `run record: ${jsonPath}`,
      `trajectory: ${trajectoryPath}`,
      ...(exploration === undefined
        ? []
        : [
            ...(exploration.scout === undefined
              ? []
              : [
                  `scout:      ${exploration.scout.searchesWithMatches}/${exploration.scout.searches} search(es) hit, ` +
                    `${exploration.scout.candidates} candidate(s) ranked, ` +
                    `${exploration.scout.filesRead} read (${exploration.scout.bytesRead} bytes)`,
                ]),
            `exploration:${exploration.toolCalls} model tool call(s) over ${exploration.turns} turn(s), ` +
              `${exploration.failedToolCalls} failed, ${exploration.filesRead.length} file(s) read in total, ` +
              `${exploration.bytesFromTools} byte(s) collected` +
              `${exploration.budgetExhausted ? ", budget exhausted" : ""}`,
          ]),
      `citations:  ${audit.grounded}/${audit.claimed} verified, ${audit.dropped.length} dropped, ` +
        `${audit.unsupportedClaims} unsupported claim(s)`,
      `tokens:     ${record.meta.usage.inputTokens} in / ${record.meta.usage.outputTokens} out`,
      `cost:       ${record.meta.estimatedCostUsd === null ? "unknown (unpriced model)" : `$${record.meta.estimatedCostUsd.toFixed(6)}`}`,
      "",
    ].join("\n"),
  );

  return 0;
}

async function commandEvaluate(args: ParsedArgs): Promise<number> {
  const config = loadConfig(args.overrides);
  const system = args.system ?? BASELINE_SYSTEM_NAME;
  const output = await runEvaluation({
    system,
    casesDir: args.casesDir ?? DEFAULT_CASES_DIR,
    resultsDir: args.out ?? DEFAULT_RESULTS_DIR,
    trajectoryDir: "trajectories",
    config,
    caseIds: args.caseIds,
    // Only the advanced system reads a budget; passing it unconditionally would be
    // harmless but misleading in the run record.
    budget: system === ADVANCED_SYSTEM_NAME ? loadExplorationBudget(args.budget) : undefined,
    caseDelaySeconds: args.caseDelaySeconds,
    logger: (message) => process.stderr.write(`${message}\n`),
  });

  const metrics = output.report.metrics;
  process.stdout.write(
    [
      "",
      `System: ${output.report.system} v${output.report.systemVersion} ` +
        `(${output.report.provider}/${output.report.model}, seed ${output.report.seed}, ` +
        `thinking ${output.report.thinkingLevel})`,
      "",
      `Evidence-backed task accuracy: ${(metrics.evidenceBackedTaskAccuracy * 100).toFixed(1)}% ` +
        `(${metrics.evidenceBackedAnswers}/${metrics.totalQuestions})`,
      `Answer accuracy:               ${(metrics.answerAccuracy * 100).toFixed(1)}% ` +
        `(${metrics.correctAnswers}/${metrics.totalQuestions})`,
      `Cases: ${metrics.totalCases} total, ${metrics.passedCases} fully correct, ` +
        `${metrics.evidenceBackedCases} fully cited, ${metrics.failedCases} failed`,
      "",
      `results:  ${output.jsonPath}`,
      `summary:  ${output.markdownPath}`,
      "",
    ].join("\n"),
  );

  for (const caveat of output.report.caveats) process.stderr.write(`note: ${caveat}\n`);

  return 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`\n${formatError(error)}\n`);
    process.exitCode = 1;
  });
