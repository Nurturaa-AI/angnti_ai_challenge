/**
 * The evaluator: case format, deterministic matching, scoring, aggregation, and
 * report rendering. It knows nothing about which system produced a briefing — it
 * scores a `RunRecord`, so the baseline and any later agent are measured by
 * exactly the same code.
 *
 * `benchmark` and `benchmark-report` are the metadata and reporting layers added
 * in Iteration 6. Both are additive: they read the same case files and wrap the
 * same aggregator, so the scoring path above is byte-for-byte the code that
 * produced every earlier measurement.
 */

export * from "./aggregate";
export * from "./benchmark";
export * from "./benchmark-report";
export * from "./case-schema";
export * from "./load";
export * from "./matching";
export * from "./report";
export * from "./score";
