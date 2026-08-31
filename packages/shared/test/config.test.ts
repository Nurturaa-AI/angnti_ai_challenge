import { describe, expect, it } from "vitest";
import { DEFAULT_EXPLORATION_BUDGET, DEFAULT_PRECISION_POLICY, loadExplorationBudget, loadPrecisionPolicy } from "../src/index";
import { ConfigError } from "../src/errors";

/**
 * The exploration budget loader.
 *
 * It decides how much of a repository the agent may look at, which makes it a
 * variable in every measurement the project reports. Two properties matter enough to
 * pin down: a budget of zero is legitimate for the scout and only for the scout, and a
 * rejection names the thing the caller would actually have to change.
 */
describe("loadExplorationBudget", () => {
  it("returns the defaults when nothing is set", () => {
    expect(loadExplorationBudget({}, {})).toEqual(DEFAULT_EXPLORATION_BUDGET);
  });

  it("prefers an explicit override to the environment", () => {
    const budget = loadExplorationBudget(
      { maxToolCalls: 3 },
      { REPO_ARCHAEOLOGIST_MAX_TOOL_CALLS: "99" },
    );

    expect(budget.maxToolCalls).toBe(3);
  });

  it("reads every limit from the environment, scout limits included", () => {
    const budget = loadExplorationBudget(
      {},
      {
        REPO_ARCHAEOLOGIST_MAX_TOOL_CALLS: "5",
        REPO_ARCHAEOLOGIST_MAX_TURNS: "4",
        REPO_ARCHAEOLOGIST_MAX_SEARCH_RESULTS: "7",
        REPO_ARCHAEOLOGIST_MAX_FILE_LINES: "80",
        REPO_ARCHAEOLOGIST_MAX_FILE_BYTES: "9000",
        REPO_ARCHAEOLOGIST_MAX_LIST_ENTRIES: "40",
        REPO_ARCHAEOLOGIST_MAX_LIST_DEPTH: "2",
        REPO_ARCHAEOLOGIST_MAX_SCOUT_TERMS: "6",
        REPO_ARCHAEOLOGIST_MAX_SCOUT_SEARCHES: "6",
        REPO_ARCHAEOLOGIST_MAX_SCOUT_FILES: "2",
      },
    );

    expect(budget).toEqual({
      maxToolCalls: 5,
      maxTurns: 4,
      maxSearchResults: 7,
      maxFileLines: 80,
      maxFileBytes: 9000,
      maxListEntries: 40,
      maxListDepth: 2,
      maxScoutTerms: 6,
      maxScoutSearches: 6,
      maxScoutFiles: 2,
    });
  });

  it("accepts zero for each scout limit, because that is the experiment's control", () => {
    // Iteration 2 is only measurable against the same system with the search phase
    // switched off. An experiment whose control condition is unreachable from the
    // command line is not a reproducible one.
    const budget = loadExplorationBudget({
      maxScoutTerms: 0,
      maxScoutSearches: 0,
      maxScoutFiles: 0,
    });

    expect(budget).toMatchObject({ maxScoutTerms: 0, maxScoutSearches: 0, maxScoutFiles: 0 });
    // Switching the scout off must not touch what the model itself is allowed to do,
    // or the control would be testing two changes at once.
    expect(budget.maxToolCalls).toBe(DEFAULT_EXPLORATION_BUDGET.maxToolCalls);
    expect(budget.maxTurns).toBe(DEFAULT_EXPLORATION_BUDGET.maxTurns);
  });

  it("rejects zero for the model's own limits", () => {
    // No tool calls and no turns are different in kind from no scout: they leave the
    // agent unable to look at anything at all, which is not a control condition.
    expect(() => loadExplorationBudget({ maxToolCalls: 0 })).toThrow(ConfigError);
    expect(() => loadExplorationBudget({ maxTurns: 0 })).toThrow(ConfigError);
    expect(() => loadExplorationBudget({ maxFileLines: 0 })).toThrow(ConfigError);
  });

  it("rejects a negative scout limit", () => {
    expect(() => loadExplorationBudget({ maxScoutFiles: -1 })).toThrow(/whole number of 0 or more/);
  });

  it("rejects a fractional limit", () => {
    expect(() => loadExplorationBudget({ maxScoutSearches: 2.5 })).toThrow(/whole number/);
  });

  it("names the flag when the value came from a flag", () => {
    // The message has to point at the thing the caller typed. Naming an environment
    // variable they never set sends them to the wrong file.
    expect(() => loadExplorationBudget({ maxScoutFiles: -1 })).toThrow(/--max-scout-files/);
    expect(() => loadExplorationBudget({ maxToolCalls: 0 })).toThrow(/--max-tool-calls/);
  });

  it("names the environment variable when the value came from the environment", () => {
    expect(() =>
      loadExplorationBudget({}, { REPO_ARCHAEOLOGIST_MAX_SCOUT_FILES: "-3" }),
    ).toThrow(/REPO_ARCHAEOLOGIST_MAX_SCOUT_FILES/);
  });

  it("explains what zero means, differently for the scout and for the model", () => {
    const scout = captureError(() => loadExplorationBudget({ maxScoutFiles: -1 }));
    const model = captureError(() => loadExplorationBudget({ maxToolCalls: 0 }));

    expect(scout?.hint).toContain("valid experiment control");
    expect(model?.hint).toContain("unable to look at anything");
  });

  it("ignores an empty environment value rather than reading it as zero", () => {
    const budget = loadExplorationBudget({}, { REPO_ARCHAEOLOGIST_MAX_SCOUT_FILES: "  " });

    expect(budget.maxScoutFiles).toBe(DEFAULT_EXPLORATION_BUDGET.maxScoutFiles);
  });

  it("rejects a value that is not a number at all", () => {
    expect(() => loadExplorationBudget({}, { REPO_ARCHAEOLOGIST_MAX_TURNS: "many" })).toThrow(
      /must be a number/,
    );
  });
});

function captureError(run: () => unknown): ConfigError | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof ConfigError ? error : undefined;
  }
  return undefined;
}

/**
 * The precision policy loader.
 *
 * Same shape as the budget above and the same reason for existing: iteration 3's
 * control condition is the same system with corroboration switched off, so zero has to
 * be reachable for exactly that one setting and rejected for the thresholds, where it
 * would mean "any line of any file corroborates any claim".
 */
describe("loadPrecisionPolicy", () => {
  it("returns the defaults when nothing is set", () => {
    expect(loadPrecisionPolicy({}, {})).toEqual(DEFAULT_PRECISION_POLICY);
  });

  it("prefers an explicit override to the environment", () => {
    const policy = loadPrecisionPolicy({ maxCorroborations: 1 }, { REPO_ARCHAEOLOGIST_MAX_CORROBORATIONS: "9" });
    expect(policy.maxCorroborations).toBe(1);
  });

  it("reads every setting from the environment", () => {
    expect(
      loadPrecisionPolicy(
        {},
        {
          REPO_ARCHAEOLOGIST_MAX_CORROBORATIONS: "3",
          REPO_ARCHAEOLOGIST_MIN_CORROBORATION_TERMS: "4",
          REPO_ARCHAEOLOGIST_MAX_CORROBORATION_CHARS: "120",
        },
      ),
    ).toEqual({ maxCorroborations: 3, minCorroborationTerms: 4, maxCorroborationChars: 120 });
  });

  it("accepts zero corroborations, because that is the experiment's control", () => {
    const policy = loadPrecisionPolicy({ maxCorroborations: 0 });

    expect(policy.maxCorroborations).toBe(0);
    // Switching corroboration off must leave the thresholds alone, or the control
    // would be testing two changes at once.
    expect(policy.minCorroborationTerms).toBe(DEFAULT_PRECISION_POLICY.minCorroborationTerms);
  });

  it("rejects zero for the thresholds", () => {
    // A term floor of zero would let any line corroborate any claim, and a character
    // ceiling of zero would quote nothing while still adding a citation.
    expect(() => loadPrecisionPolicy({ minCorroborationTerms: 0 })).toThrow(ConfigError);
    expect(() => loadPrecisionPolicy({ maxCorroborationChars: 0 })).toThrow(ConfigError);
  });

  it("explains what zero means, differently for the ceiling and for the thresholds", () => {
    const ceiling = captureError(() => loadPrecisionPolicy({ maxCorroborations: -1 }));
    const threshold = captureError(() => loadPrecisionPolicy({ minCorroborationTerms: 0 }));

    expect(ceiling?.hint).toContain("valid experiment control");
    expect(threshold?.hint).toContain("any line of any file");
  });

  it("names the flag when the value came from a flag, and the variable when it came from the environment", () => {
    expect(() => loadPrecisionPolicy({ maxCorroborations: -1 })).toThrow(/--max-corroborations/);
    expect(() => loadPrecisionPolicy({}, { REPO_ARCHAEOLOGIST_MIN_CORROBORATION_TERMS: "0" })).toThrow(
      /REPO_ARCHAEOLOGIST_MIN_CORROBORATION_TERMS/,
    );
  });

  it("rejects a fractional value and a non-numeric one", () => {
    expect(() => loadPrecisionPolicy({ maxCorroborations: 1.5 })).toThrow(/whole number/);
    expect(() => loadPrecisionPolicy({}, { REPO_ARCHAEOLOGIST_MAX_CORROBORATIONS: "lots" })).toThrow(
      /must be a number/,
    );
  });
});
