#!/usr/bin/env -S npx tsx
import path from "node:path";
import { BASELINE_SYSTEM_NAME, renderBriefingMarkdown, runBaseline } from "@repo-arch/baseline";
import { DEFAULT_CASES_DIR, DEFAULT_RESULTS_DIR, runEvaluation } from "@repo-arch/evaluation";
import {
  ConfigError,
  describeConfig,
  formatError,
  loadConfig,
  loadDotEnv,
  writeJsonFile,
  writeTextFile,
  type ConfigOverrides,
  type ThinkingLevel,
} from "@repo-arch/shared";

/**
 * The command line.
 *
 * Hand-rolled argument parsing, deliberately: two commands and eight flags do not
 * justify a dependency, and the parser is small enough to read in one sitting.
 *
 *   repo-arch baseline <repository> [flags]
 *   repo-arch evaluate [--system baseline] [flags]
 */

const USAGE = `repo-arch — understand an unfamiliar codebase before you change it

USAGE
  pnpm repo:baseline -- <path-to-repository> [flags]
  pnpm evaluate:baseline [flags]

COMMANDS
  baseline <path>   Produce a briefing for a local repository (one model call, shallow context).
  evaluate          Run every evaluation case and write JSON + Markdown results.

FLAGS
  --mock                 Use the offline deterministic provider. No API key, no cost.
  --model <id>           Model id (default: from REPO_ARCHAEOLOGIST_MODEL, else gemini-3.7-flash).
  --seed <n>             Sampling seed. The Interactions API takes a seed, not a temperature.
  --thinking <level>     low | medium | high.
  --max-output <n>       Output token ceiling.
  --out <dir>            Where to write output (baseline: reports/, evaluate: evaluation/results/).
  --cases <dir>          Case directory for evaluate (default: ${DEFAULT_CASES_DIR}).
  --case <id>            Evaluate only this case id. Repeatable.
  --system <name>        System to evaluate (only "${BASELINE_SYSTEM_NAME}" exists today).
  --quiet                Suppress the briefing on stdout; still writes files.
  -h, --help             Show this message.

ENVIRONMENT
  GEMINI_API_KEY         Required unless --mock. Copy .env.example to .env.
                         The key is never printed and never written to any output file.
`;

interface ParsedArgs {
  command: string | undefined;
  positional: string[];
  overrides: ConfigOverrides;
  out: string | undefined;
  casesDir: string | undefined;
  caseIds: string[];
  system: string | undefined;
  quiet: boolean;
  help: boolean;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: undefined,
    positional: [],
    overrides: {},
    out: undefined,
    casesDir: undefined,
    caseIds: [],
    system: undefined,
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

  switch (args.command) {
    case "baseline":
      return await commandBaseline(args);
    case "evaluate":
      return await commandEvaluate(args);
    default:
      throw new ConfigError(`Unknown command "${args.command}".`, 'Expected "baseline" or "evaluate".');
  }
}

async function commandBaseline(args: ParsedArgs): Promise<number> {
  const repositoryPath = args.positional[0];
  if (repositoryPath === undefined) {
    throw new ConfigError(
      "No repository path given.",
      "Usage: pnpm repo:baseline -- ./path/to/repository",
    );
  }

  const config = loadConfig(args.overrides);
  const outDir = args.out ?? "reports";

  process.stderr.write(`baseline: ${repositoryPath} via ${config.provider}/${config.model}\n`);
  const record = await runBaseline({ repositoryPath, config });
  const briefing = renderBriefingMarkdown(record);

  const jsonPath = path.join(outDir, `${record.meta.runId}.json`);
  const markdownPath = path.join(outDir, `${record.meta.runId}.md`);
  writeJsonFile(jsonPath, record);
  writeTextFile(markdownPath, briefing);
  writeJsonFile(path.join("trajectories", `${record.meta.runId}.json`), {
    runId: record.meta.runId,
    system: record.meta.system,
    config: describeConfig(config),
    contextSources: record.meta.contextSources,
    evidenceAudit: record.meta.evidenceAudit,
    steps: record.trajectory,
  });

  if (!args.quiet) process.stdout.write(`${briefing}\n`);

  const audit = record.meta.evidenceAudit;
  process.stderr.write(
    [
      "",
      `briefing:   ${markdownPath}`,
      `run record: ${jsonPath}`,
      `trajectory: ${path.join("trajectories", `${record.meta.runId}.json`)}`,
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
  const output = await runEvaluation({
    system: args.system ?? BASELINE_SYSTEM_NAME,
    casesDir: args.casesDir ?? DEFAULT_CASES_DIR,
    resultsDir: args.out ?? DEFAULT_RESULTS_DIR,
    trajectoryDir: "trajectories",
    config,
    caseIds: args.caseIds,
    logger: (message) => process.stderr.write(`${message}\n`),
  });

  const metrics = output.report.metrics;
  process.stdout.write(
    [
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
