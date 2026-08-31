import { describe, expect, it } from "vitest";
import { toApiInput, type ConversationStep } from "../src/llm";

/**
 * The translation from our conversation vocabulary to the Interactions API's `input`
 * list.
 *
 * Small surface, disproportionate consequences: every rule tested here was learned
 * from a 400 on a real run, and each one is invisible to an offline provider because
 * a mock accepts whatever it is handed. These tests are the only place the wire
 * contract is written down in a form that fails when it is broken.
 */
describe("toApiInput", () => {
  it("maps every step kind to its API shape", () => {
    const steps: ConversationStep[] = [
      { kind: "user", text: "Tell me about this repository." },
      { kind: "model", text: "Reading the dispatcher." },
      { kind: "toolCall", id: "c1", name: "read_file", arguments: { path: "src/dispatch.js" } },
      { kind: "toolResult", callId: "c1", name: "read_file", output: "1 | const REGISTRY = {};", isError: false },
    ];

    expect(toApiInput(steps)).toEqual([
      { type: "user_input", content: [{ type: "text", text: "Tell me about this repository." }] },
      { type: "model_output", content: [{ type: "text", text: "Reading the dispatcher." }] },
      { type: "function_call", id: "c1", name: "read_file", arguments: { path: "src/dispatch.js" } },
      {
        type: "function_result",
        call_id: "c1",
        name: "read_file",
        result: "1 | const REGISTRY = {};",
        is_error: false,
      },
    ]);
  });

  it("hands a provider step back untouched", () => {
    // The signed `thought` token. Its shape is the provider's business: reading it,
    // reshaping it or validating it would all be ways of breaking it.
    const payload = { type: "thought", signature: "ZmFrZS1zaWduYXR1cmU=" };

    expect(toApiInput([{ kind: "providerStep", payload }])).toEqual([payload]);
  });

  it("drops a model step with no text", () => {
    // "400 Missing text in content of type text". A turn where the model said nothing
    // and went straight to a tool has nothing to contribute to the history — the
    // function call it made is the whole of what it said.
    const steps: ConversationStep[] = [
      { kind: "user", text: "Go." },
      { kind: "model", text: "" },
      { kind: "toolCall", id: "c1", name: "list_directory", arguments: {} },
    ];

    expect(toApiInput(steps).map((step) => (step as { type: string }).type)).toEqual([
      "user_input",
      "function_call",
    ]);
  });

  it("drops a model step that is only whitespace", () => {
    // The empty string is the case the agent loop already guards; whitespace is the
    // one it does not, and the API counts both as missing text.
    expect(toApiInput([{ kind: "model", text: "  \n\t " }])).toEqual([]);
  });

  it("keeps a model step whose text is meaningful, however short", () => {
    expect(toApiInput([{ kind: "model", text: "." }])).toEqual([
      { type: "model_output", content: [{ type: "text", text: "." }] },
    ]);
  });

  it("preserves the order it is given, including calls before results", () => {
    // The parallel-call arrangement is the caller's job, because a flat list cannot
    // tell one turn with two calls from two turns with one each. What this asserts is
    // that the mapping does not quietly re-sort a history that already arrived correct.
    const steps: ConversationStep[] = [
      { kind: "toolCall", id: "c1", name: "read_file", arguments: { path: "a.js" } },
      { kind: "toolCall", id: "c2", name: "read_file", arguments: { path: "b.js" } },
      { kind: "toolResult", callId: "c1", name: "read_file", output: "a", isError: false },
      { kind: "toolResult", callId: "c2", name: "read_file", output: "b", isError: true },
    ];

    const identifiers = toApiInput(steps).map((step) => {
      const candidate = step as { id?: string; call_id?: string };
      return candidate.id ?? candidate.call_id;
    });

    expect(identifiers).toEqual(["c1", "c2", "c1", "c2"]);
  });

  it("carries the error flag on a failed result", () => {
    // The model has to be able to tell a refusal from a file that happens to say
    // "ERROR". Losing this flag would make a boundary violation look like content.
    const steps: ConversationStep[] = [
      {
        kind: "toolResult",
        callId: "c1",
        name: "read_file",
        output: "ERROR: path escapes the repository.",
        isError: true,
      },
    ];

    expect(toApiInput(steps)[0]).toMatchObject({ type: "function_result", is_error: true });
  });

  it("returns an empty list for an empty history", () => {
    expect(toApiInput([])).toEqual([]);
  });
});
