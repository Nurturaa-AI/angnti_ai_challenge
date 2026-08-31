import { GoogleGenAI, type Interactions } from "@google/genai";
import type { AnalysisConfig } from "./config";
import { ConfigError, ModelError } from "./errors";
import type { TokenUsage } from "./schemas";
import { createMockLlmClient } from "./mock-llm";
import type { ToolCall, ToolDefinition } from "./tools/types";

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

/**
 * One turn of a tool-using conversation.
 *
 * `input` is the running list of steps — user input, model output, function calls
 * and their results — exactly as the Interactions API models a conversation. The
 * caller owns that history, so the harness (not the provider, and not the model)
 * decides what a function result says.
 */
export interface ToolTurnRequest {
  systemInstruction: string;
  steps: readonly ConversationStep[];
  tools: readonly ToolDefinition[];
  /**
   * When set, the model is asked for a final JSON answer conforming to this
   * schema. Omitted while exploration is still open, because a response format
   * and a function call cannot both be the answer to the same turn.
   */
  schema?: Record<string, unknown> | undefined;
}

export interface ToolTurnResponse {
  /** Model prose for this turn. Empty when the model went straight to a tool. */
  text: string;
  /** Tool calls the model asked for, in order. Empty when it answered instead. */
  toolCalls: ToolCall[];
  /**
   * Provider-native steps the caller must replay verbatim on the next turn.
   *
   * Gemini returns a signed `thought` step alongside a function call, and rejects
   * the follow-up request with a 400 if that signature is not echoed back. We do
   * not interpret it, never treat it as evidence, and never surface it as model
   * prose — it is an opaque continuation token that happens to travel as a step.
   */
  providerSteps: unknown[];
  usage: TokenUsage;
  model: string;
}

/** The conversation history the caller maintains and replays each turn. */
export type ConversationStep =
  | { kind: "user"; text: string }
  | { kind: "model"; text: string }
  | { kind: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
  | { kind: "toolResult"; callId: string; name: string; output: string; isError: boolean }
  /** Opaque provider step, replayed exactly as it was received. See `providerSteps`. */
  | { kind: "providerStep"; payload: unknown };

export interface LlmClient {
  readonly provider: "gemini" | "mock";
  readonly model: string;
  generateStructured(request: StructuredRequest): Promise<StructuredResponse>;
  /**
   * Optional: a provider that cannot use tools simply omits this, and the agent
   * fails with a clear message rather than silently degrading to a baseline run.
   */
  generateWithTools?(request: ToolTurnRequest): Promise<ToolTurnResponse>;
}

const MAX_ATTEMPTS = 4;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Backoff, split by cause.
 *
 * A transient 5xx clears in milliseconds, but a 429 is a *quota window* — usually
 * per minute — and retrying inside that window just spends another attempt. So a
 * rate limit waits long enough for the window to roll over, while everything else
 * stays fast.
 *
 * This matters more for the exploring agent than for a single-shot analysis: it
 * makes several calls per repository, so a run has several chances to be throttled.
 * The policy is deliberately identical for both systems — a harness that were more
 * patient with one of them would be measuring its own retry loop.
 */
function backoffMs(attempt: number, rateLimited: boolean): number {
  if (rateLimited) return [15_000, 30_000, 60_000][attempt - 1] ?? 60_000;
  return 500 * 2 ** (attempt - 1);
}

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
        await delay(backoffMs(attempt, isRateLimited(error)));
      }
    }

    throw wrapModelError(lastError, this.model);
  }

  async generateWithTools(request: ToolTurnRequest): Promise<ToolTurnResponse> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const interaction = await this.ai.interactions.create({
          model: this.model,
          system_instruction: request.systemInstruction,
          input: request.steps.map(toApiStep),
          // Omitted entirely on the synthesis turn: an empty tool list and no tool
          // list are the same intent, and the latter is what the API expects.
          ...(request.tools.length > 0
            ? {
                tools: request.tools.map((tool) => ({
                  type: "function" as const,
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                })),
              }
            : {}),
          // A response format is set only on the final turn. Asking for strict JSON
          // while tools are still available makes "call a tool" unrepresentable.
          ...(request.schema
            ? { response_format: { type: "text" as const, mime_type: "application/json", schema: request.schema } }
            : {}),
          generation_config: {
            seed: this.config.seed,
            thinking_level: this.config.thinkingLevel,
            max_output_tokens: this.config.maxOutputTokens,
          },
          store: false,
        });

        // A tool-using turn has two legitimate outcomes, and only one of them is
        // "completed". When the model decides to call a function, the interaction
        // parks at "requires_action": it is waiting for us to run the tool and send
        // the result back. Treating that as a failure would make tool use
        // impossible — which is exactly what it did on the first real run.
        const toolCalls = extractToolCalls(interaction.steps);
        const awaitingTools = interaction.status === "requires_action";

        if (interaction.status !== "completed" && !awaitingTools) {
          const detail = interaction.errors?.map((error) => JSON.stringify(error)).join("; ") ?? "no error detail";
          throw new ModelError(
            `Gemini returned status "${String(interaction.status)}" instead of "completed" or "requires_action". ${detail}`,
            interaction.status === "incomplete" || interaction.status === "budget_exceeded"
              ? "The response hit a limit. Raise REPO_ARCHAEOLOGIST_MAX_OUTPUT_TOKENS or lower REPO_ARCHAEOLOGIST_THINKING_LEVEL."
              : undefined,
          );
        }
        // "requires_action" with nothing to act on is a genuinely stuck turn: the
        // agent would otherwise loop, sending the same history back forever.
        if (awaitingTools && toolCalls.length === 0) {
          throw new ModelError(
            `Gemini reported "requires_action" for model "${this.model}" but returned no function call to act on.`,
            "This usually means the tool declarations were rejected. Check the tool parameter schemas.",
          );
        }

        return {
          text: interaction.output_text ?? "",
          toolCalls,
          providerSteps: extractProviderSteps(interaction.steps),
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
        await delay(backoffMs(attempt, isRateLimited(error)));
      }
    }

    throw wrapModelError(lastError, this.model);
  }
}

/** Our conversation vocabulary -> the Interactions API's `Step` union. */
function toApiStep(step: ConversationStep): Interactions.Step {
  switch (step.kind) {
    case "user":
      return { type: "user_input", content: [{ type: "text", text: step.text }] };
    case "model":
      return { type: "model_output", content: [{ type: "text", text: step.text }] };
    case "toolCall":
      return { type: "function_call", id: step.id, name: step.name, arguments: step.arguments };
    case "toolResult":
      return {
        type: "function_result",
        call_id: step.callId,
        name: step.name,
        result: step.output,
        is_error: step.isError,
      };
    case "providerStep":
      // Handed back untouched. Its shape is the provider's business, not ours.
      return step.payload as Interactions.Step;
  }
}

/**
 * Steps that must be replayed but that we do not model ourselves.
 *
 * Only `thought` qualifies today: it carries the signature Gemini requires on the
 * turn after a function call. Function calls and results are excluded because the
 * harness reconstructs those itself from its own record of what it executed —
 * which is what keeps a tool result something the model cannot forge.
 */
function extractProviderSteps(steps: unknown): unknown[] {
  if (!Array.isArray(steps)) return [];
  return steps.filter((step): step is Record<string, unknown> => {
    if (typeof step !== "object" || step === null) return false;
    return (step as { type?: unknown }).type === "thought";
  });
}

function extractToolCalls(steps: unknown): ToolCall[] {
  if (!Array.isArray(steps)) return [];
  const calls: ToolCall[] = [];
  for (const step of steps) {
    if (typeof step !== "object" || step === null) continue;
    const candidate = step as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
    if (candidate.type !== "function_call" || typeof candidate.name !== "string") continue;
    calls.push({
      // An id is required to pair the result back; synthesise one if a provider omits it.
      id: typeof candidate.id === "string" && candidate.id !== "" ? candidate.id : `call-${calls.length + 1}`,
      name: candidate.name,
      // Passed through untouched. The tool layer normalises and rejects, so a
      // provider quirk surfaces as a message the model can act on.
      arguments: candidate.arguments,
    });
  }
  return calls;
}

function isRateLimited(error: unknown): boolean {
  if (extractStatus(error) === 429) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /\b429\b|rate limit|resource_?exhausted|quota/i.test(message);
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
