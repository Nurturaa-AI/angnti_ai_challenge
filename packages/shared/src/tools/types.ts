import type { ContextSourceText } from "../context-format";

/**
 * Tool protocol types.
 *
 * The important invariant lives here: a tool returns `output` (text the model
 * will read) *and* `artifacts` (the repository content that was actually
 * obtained). The two are recorded separately, and only `artifacts` may be cited.
 * Nothing the model writes can add to the artifact ledger.
 */

export interface ToolCall {
  /** Provider-assigned id, echoed back on the result so the pair can be matched. */
  id: string;
  name: string;
  /**
   * Untyped on purpose. Providers hand arguments back as an object, a JSON
   * string, or occasionally something else entirely; `executeTool` normalises and
   * rejects, so a malformed call becomes a message rather than a crash.
   */
  arguments: unknown;
}

export interface ToolOutcome {
  /** Rendered text handed back to the model as the function result. */
  output: string;
  /**
   * Repository content this call actually returned, ready to enter the evidence
   * ledger. Empty for discovery-only tools.
   */
  artifacts: ContextSourceText[];
  /** True when the call was rejected. The model sees the reason and may retry. */
  isError: boolean;
  /** Compact, non-content summary for the trajectory: counts, flags, paths. */
  summary: Record<string, unknown>;
}

/** JSON Schema (Gemini's supported subset) for one tool's arguments. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Every limit the agent operates under. All of these are configurable — via
 * environment variables or CLI flags — because the right ceiling depends on the
 * repository, and a hardcoded budget would be a hidden experiment variable.
 */
export interface ExplorationBudget {
  /** Hard cap on tool calls per run, across all tools. */
  maxToolCalls: number;
  /** Hard cap on model round trips, so a loop cannot spin without calling tools. */
  maxTurns: number;
  /** Cap on rows returned by one `search_code` call. */
  maxSearchResults: number;
  /** Cap on lines returned by one `read_file` call. */
  maxFileLines: number;
  /** Cap on bytes returned by one `read_file` call. */
  maxFileBytes: number;
  /** Cap on entries returned by one `list_directory` call. */
  maxListEntries: number;
  /** Cap on `depth` accepted by `list_directory`, whatever the model asks for. */
  maxListDepth: number;

  /*
   * The Evidence Scout's own bounds.
   *
   * Kept separate from `maxToolCalls` on purpose. That budget is the *model's*
   * licence to explore, and spending it on the scout would mean the advanced system
   * measured in Iteration 2 had less room to explore than the one measured in
   * Iteration 1 — a second change riding along with the one under test. The scout's
   * cost is fixed, declared up front, and reported separately.
   *
   * The asymmetry between the three is deliberate: a search costs a filesystem walk
   * and no tokens, so searching widely is nearly free. A read costs prompt bytes on
   * every subsequent turn, so reads are what must stay scarce.
   */

  /** Cap on search terms extracted from the question and the repository. */
  maxScoutTerms: number;
  /** Cap on `search_code` calls the scout may make. */
  maxScoutSearches: number;
  /** Cap on files the scout may read. Worst case adds `maxScoutFiles × maxFileBytes` to the prompt. */
  maxScoutFiles: number;
}

export const DEFAULT_EXPLORATION_BUDGET: ExplorationBudget = {
  maxToolCalls: 12,
  maxTurns: 8,
  maxSearchResults: 20,
  maxFileLines: 400,
  maxFileBytes: 24_000,
  maxListEntries: 200,
  maxListDepth: 3,
  maxScoutTerms: 14,
  maxScoutSearches: 14,
  maxScoutFiles: 4,
};

export interface ToolContext {
  /** Absolute path to the repository under analysis. The boundary of every tool. */
  repositoryRoot: string;
  budget: ExplorationBudget;
}
