/**
 * The evaluator: case format, deterministic matching, scoring, aggregation, and
 * report rendering. It knows nothing about which system produced a briefing — it
 * scores a `RunRecord`, so the baseline and any later agent are measured by
 * exactly the same code.
 */

export * from "./aggregate";
export * from "./case-schema";
export * from "./load";
export * from "./matching";
export * from "./report";
export * from "./score";
