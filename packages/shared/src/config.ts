import { ConfigError } from "./errors";
import { DEFAULT_EXPLORATION_BUDGET, type ExplorationBudget } from "./tools/types";

/**
 * Configuration is read from (in order of precedence):
 *   1. explicit overrides passed by the CLI
 *   2. environment variables (including a `.env` file, if present)
 *   3. defaults below
 *
 * The API key is held here and nowhere else. It is never logged, never written
 * to a report, and never included in an error message.
 */

export type LlmProvider = "gemini" | "mock";
export type ThinkingLevel = "low" | "medium" | "high";

export interface AnalysisConfig {
  provider: LlmProvider;
  model: string;
  /** Present only for provider === "gemini". */
  apiKey: string | undefined;
  /**
   * The Interactions API exposes `seed` rather than `temperature`. A fixed seed
   * is the strongest reproducibility lever the API gives us.
   */
  seed: number;
  thinkingLevel: ThinkingLevel;
  maxOutputTokens: number;
}

export const DEFAULT_MODEL = "gemini-3.7-flash";
export const DEFAULT_SEED = 7;
export const DEFAULT_MAX_OUTPUT_TOKENS = 24_000;

export interface ConfigOverrides {
  provider?: LlmProvider | undefined;
  model?: string | undefined;
  seed?: number | undefined;
  thinkingLevel?: ThinkingLevel | undefined;
  maxOutputTokens?: number | undefined;
}

/** Loads `.env` from the current working directory if it exists. Safe to call repeatedly. */
export function loadDotEnv(): void {
  try {
    // Node >= 20.12 built-in; avoids a dotenv dependency.
    process.loadEnvFile();
  } catch {
    // No .env file, or unreadable. Environment variables still apply.
  }
}

function parseNumber(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new ConfigError(`${label} must be a number, received "${raw}".`);
  }
  return value;
}

function parseThinkingLevel(raw: string | undefined): ThinkingLevel | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  if (raw === "low" || raw === "medium" || raw === "high") return raw;
  throw new ConfigError(
    `REPO_ARCHAEOLOGIST_THINKING_LEVEL must be "low", "medium" or "high", received "${raw}".`,
  );
}

function parseProvider(raw: string | undefined): LlmProvider | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  if (raw === "gemini" || raw === "mock") return raw;
  throw new ConfigError(
    `REPO_ARCHAEOLOGIST_PROVIDER must be "gemini" or "mock", received "${raw}".`,
  );
}

export function loadConfig(overrides: ConfigOverrides = {}, env: NodeJS.ProcessEnv = process.env): AnalysisConfig {
  const provider = overrides.provider ?? parseProvider(env.REPO_ARCHAEOLOGIST_PROVIDER) ?? "gemini";
  const model = overrides.model ?? env.REPO_ARCHAEOLOGIST_MODEL ?? DEFAULT_MODEL;
  const seed = overrides.seed ?? parseNumber(env.REPO_ARCHAEOLOGIST_SEED, "REPO_ARCHAEOLOGIST_SEED") ?? DEFAULT_SEED;
  const thinkingLevel =
    overrides.thinkingLevel ?? parseThinkingLevel(env.REPO_ARCHAEOLOGIST_THINKING_LEVEL) ?? "low";
  const maxOutputTokens =
    overrides.maxOutputTokens ??
    parseNumber(env.REPO_ARCHAEOLOGIST_MAX_OUTPUT_TOKENS, "REPO_ARCHAEOLOGIST_MAX_OUTPUT_TOKENS") ??
    DEFAULT_MAX_OUTPUT_TOKENS;

  const apiKey = env.GEMINI_API_KEY?.trim() || undefined;

  if (provider === "gemini" && !apiKey) {
    throw new ConfigError(
      "GEMINI_API_KEY is not set, so the Gemini provider cannot be used.",
      'Copy .env.example to .env and add your key (https://aistudio.google.com/apikey), or run with "--mock" for an offline, zero-cost run.',
    );
  }

  return {
    provider,
    model: provider === "mock" ? "mock-deterministic-v1" : model,
    apiKey: provider === "gemini" ? apiKey : undefined,
    seed,
    thinkingLevel,
    maxOutputTokens,
  };
}

/** A view of the config that is safe to print or serialise. */
export function describeConfig(config: AnalysisConfig): Record<string, unknown> {
  return {
    provider: config.provider,
    model: config.model,
    seed: config.seed,
    thinkingLevel: config.thinkingLevel,
    maxOutputTokens: config.maxOutputTokens,
    apiKey: config.apiKey ? "<set, redacted>" : "<unset>",
  };
}

// ---------------------------------------------------------------------------
// Exploration budget: how much the agent is allowed to look at.
// ---------------------------------------------------------------------------

/**
 * Kept separate from `AnalysisConfig` on purpose. That one describes the model;
 * this one describes the agent's licence to read the repository. A system that
 * does not explore never needs to construct one.
 *
 * Every limit is overridable, because the right ceiling depends on the repository
 * and because a hardcoded budget is a hidden variable in an experiment.
 */
export type ExplorationBudgetOverrides = Partial<Record<keyof ExplorationBudget, number | undefined>>;

const BUDGET_ENV_VARS: Record<keyof ExplorationBudget, string> = {
  maxToolCalls: "REPO_ARCHAEOLOGIST_MAX_TOOL_CALLS",
  maxTurns: "REPO_ARCHAEOLOGIST_MAX_TURNS",
  maxSearchResults: "REPO_ARCHAEOLOGIST_MAX_SEARCH_RESULTS",
  maxFileLines: "REPO_ARCHAEOLOGIST_MAX_FILE_LINES",
  maxFileBytes: "REPO_ARCHAEOLOGIST_MAX_FILE_BYTES",
  maxListEntries: "REPO_ARCHAEOLOGIST_MAX_LIST_ENTRIES",
  maxListDepth: "REPO_ARCHAEOLOGIST_MAX_LIST_DEPTH",
};

export function loadExplorationBudget(
  overrides: ExplorationBudgetOverrides = {},
  env: NodeJS.ProcessEnv = process.env,
): ExplorationBudget {
  const budget = { ...DEFAULT_EXPLORATION_BUDGET };

  for (const key of Object.keys(BUDGET_ENV_VARS) as Array<keyof ExplorationBudget>) {
    const variable = BUDGET_ENV_VARS[key];
    const value = overrides[key] ?? parseNumber(env[variable], variable);
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 1) {
      throw new ConfigError(
        `${variable} must be a positive whole number, received "${String(value)}".`,
        "A budget of zero would make the agent unable to look at anything.",
      );
    }
    budget[key] = value;
  }

  return budget;
}

