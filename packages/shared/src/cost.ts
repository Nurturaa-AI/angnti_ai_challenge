import type { TokenUsage } from "./schemas";

/**
 * Gemini API list prices, USD per 1M tokens, standard paid tier.
 * Source: https://ai.google.dev/gemini-api/docs/pricing (checked 2026-08-30).
 *
 * Deliberately a lookup table rather than a default: an unknown model yields
 * `null`, so a report never shows a confidently wrong cost.
 */
export interface ModelPrice {
  inputPer1M: number;
  outputPer1M: number;
  /** Caveats that affect the accuracy of the estimate. */
  note?: string;
}

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "gemini-3.7-flash": { inputPer1M: 0.75, outputPer1M: 3.75, note: "list price doubles 2027-01-01" },
  "gemini-3.6-flash": { inputPer1M: 0.75, outputPer1M: 3.75, note: "list price doubles 2027-01-01" },
  "gemini-3.5-flash": { inputPer1M: 1.5, outputPer1M: 9.0 },
  "gemini-3-flash-preview": { inputPer1M: 0.5, outputPer1M: 3.0 },
  "gemini-2.5-flash": { inputPer1M: 0.3, outputPer1M: 2.5 },
  "gemini-3.5-flash-lite": { inputPer1M: 0.3, outputPer1M: 2.5 },
  "gemini-3.1-flash-lite": { inputPer1M: 0.25, outputPer1M: 1.5 },
  "gemini-2.5-flash-lite": { inputPer1M: 0.1, outputPer1M: 0.4 },
  "gemini-3.1-pro-preview": { inputPer1M: 2.0, outputPer1M: 12.0, note: "higher tier above 200k input tokens" },
  "gemini-2.5-pro": { inputPer1M: 1.25, outputPer1M: 10.0, note: "higher tier above 200k input tokens" },
  "mock-deterministic-v1": { inputPer1M: 0, outputPer1M: 0 },
};

export const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

/** Estimated USD cost, or null when the model has no published price entry. */
export function estimateCostUsd(model: string, usage: TokenUsage): number | null {
  const price = MODEL_PRICES[model];
  if (!price) return null;
  const cost = (usage.inputTokens / 1_000_000) * price.inputPer1M + (usage.outputTokens / 1_000_000) * price.outputPer1M;
  // Sub-cent precision matters here: a single baseline run costs fractions of a cent.
  return Math.round(cost * 1_000_000) / 1_000_000;
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}
