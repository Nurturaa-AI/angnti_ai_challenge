import { GoogleGenAI } from "@google/genai";
import type { AnalysisConfig } from "./config";
import { ConfigError, ModelError } from "./errors";
import type { TokenUsage } from "./schemas";
import { createMockLlmClient } from "./mock-llm";

/**
 * One narrow interface over the model, so that the baseline, the future agent,
 * and the tests all talk to the same thing — and so an offline mock is a
 * first-class provider rather than a test-only hack.
 */

export interface StructuredRequest {
  systemInstruction: string;
  input: string;
  /** JSON Schema (Gemini's supported subset) the response must conform to. */
  schema: Record<string, unknown>;
}

export interface StructuredResponse {
  text: string;
  usage: TokenUsage;
  model: string;
}

export interface LlmClient {
  readonly provider: "gemini" | "mock";
  readonly model: string;
  generateStructured(request: StructuredRequest): Promise<StructuredResponse>;
}

const MAX_ATTEMPTS = 3;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export function createLlmClient(config: AnalysisConfig): LlmClient {
  if (config.provider === "mock") return createMockLlmClient(config);
  if (!config.apiKey) {
    throw new ConfigError(
      "The Gemini provider requires an API key.",
      'Set GEMINI_API_KEY in .env, or run with "--mock".',
    );
  }
  return new GeminiLlmClient(config, config.apiKey);
}

class GeminiLlmClient implements LlmClient {
  readonly provider = "gemini" as const;
  readonly model: string;

  private readonly ai: GoogleGenAI;
  private readonly config: AnalysisConfig;

  constructor(config: AnalysisConfig, apiKey: string) {
    this.config = config;
    this.model = config.model;
    this.ai = new GoogleGenAI({ apiKey });
  }

  async generateStructured(request: StructuredRequest): Promise<StructuredResponse> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const interaction = await this.ai.interactions.create({
          model: this.model,
          system_instruction: request.systemInstruction,
          input: request.input,
          response_format: {
            type: "text",
            mime_type: "application/json",
            schema: request.schema,
          },
          generation_config: {
            seed: this.config.seed,
            thinking_level: this.config.thinkingLevel,
            max_output_tokens: this.config.maxOutputTokens,
          },
          // Stateless: we keep our own trajectory, and nothing is retained server side.
          store: false,
        });

        if (interaction.status !== "completed") {
          const detail = interaction.errors?.map((error) => JSON.stringify(error)).join("; ") ?? "no error detail";
          throw new ModelError(
            `Gemini returned status "${String(interaction.status)}" instead of "completed". ${detail}`,
            interaction.status === "incomplete" || interaction.status === "budget_exceeded"
              ? "The response hit a limit. Raise REPO_ARCHAEOLOGIST_MAX_OUTPUT_TOKENS or lower REPO_ARCHAEOLOGIST_THINKING_LEVEL."
              : undefined,
          );
        }

        const text = interaction.output_text ?? "";
        return {
          text,
          model: interaction.model ?? this.model,
          usage: {
            inputTokens: interaction.usage?.total_input_tokens ?? 0,
            outputTokens: interaction.usage?.total_output_tokens ?? 0,
            totalTokens: interaction.usage?.total_tokens ?? 0,
          },
        };
      } catch (error) {
        lastError = error;
        if (attempt === MAX_ATTEMPTS || !isRetryable(error)) break;
        // 0.5s, 1s — enough for a transient 429 without stalling an evaluation run.
        await delay(500 * 2 ** (attempt - 1));
      }
    }

    throw wrapModelError(lastError, this.model);
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof ModelError) return false;
  const status = extractStatus(error);
  if (status !== undefined) return RETRYABLE_STATUS.has(status);
  const message = error instanceof Error ? error.message : String(error);
  return /\b(429|500|502|503|504)\b|timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(message);
}

function extractStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { status?: unknown; code?: unknown };
  if (typeof candidate.status === "number") return candidate.status;
  if (typeof candidate.code === "number") return candidate.code;
  return undefined;
}

function wrapModelError(error: unknown, model: string): ModelError {
  if (error instanceof ModelError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const status = extractStatus(error);

  if (status === 401 || status === 403 || /API key|permission|unauthenticated/i.test(message)) {
    return new ModelError(
      `Gemini rejected the credentials for model "${model}".`,
      "Check GEMINI_API_KEY in .env. The key is never printed by this tool, so verify it in https://aistudio.google.com/apikey.",
    );
  }
  if (status === 404 || /not found|unsupported model/i.test(message)) {
    return new ModelError(
      `Gemini does not recognise the model "${model}".`,
      "Set REPO_ARCHAEOLOGIST_MODEL to a current model id, e.g. gemini-3.7-flash.",
    );
  }
  if (status === 429) {
    return new ModelError(
      `Gemini rate limited the request for model "${model}" after ${MAX_ATTEMPTS} attempts.`,
      "Wait and retry, or switch to a lighter model such as gemini-3.5-flash-lite.",
    );
  }
  return new ModelError(`Gemini request failed for model "${model}": ${message}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
