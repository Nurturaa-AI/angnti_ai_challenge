import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ConfigError,
  ModelError,
  createLlmClient,
  type AnalysisConfig,
  type ConversationStep,
  type ExplorationBudget,
  type LlmClient,
  type StructuredRequest,
  type ToolCall,
  type ToolTurnRequest,
  type ToolTurnResponse,
} from "@repo-arch/shared";
import { scoreCase } from "@repo-arch/evaluator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ADVANCED_RESPONSE_SCHEMA,
  ADVANCED_SYSTEM_NAME,
  buildRunId,
  runAdvanced,
  type AdvancedPhase,
} from "../src/index";

/**
 * The advanced system, end to end, with the model replaced by a script.
 *
 * The claims worth pinning down are the ones a real run cannot demonstrate on
 * demand: that the exploration budget is a hard stop rather than a request; that
 * tool results are recorded separately from model prose; and — the central one —
 * that a citation the model invents is dropped, no matter how plausible it looks,
 * because the evidence ledger only ever grew from bytes a tool actually returned.
 */

let root: string;

function write(relativePath: string, contents: string): void {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents, "utf8");
}

const config: AnalysisConfig = {
  provider: "mock",
  model: "scripted-test-model",
  seed: 7,
  thinkingLevel: "low",
  maxOutputTokens: 4096,
  apiKey: undefined,
};

/** A run at a fixed clock, so run ids and durations are deterministic. */
const fixedClock = (): (() => Date) => {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 0, 2, 3, 4, 5) + tick++ * 1000);
};

/** A minimal analysis body. Only the fields a test asserts on are interesting. */
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    summary: "A small demo repository.",
    architecture: "One module and a dispatcher.",
    components: [],
    flows: [],
    dependencies: [],
    testing: { approach: "No test suite is visible.", frameworks: [], testPaths: [], gaps: [], evidence: [] },
    risks: [],
    recommendedReading: [],
    confidence: 0.5,
    evidence: [],
    openQuestions: [],
    ...overrides,
  };
}

interface ScriptedTurn {
  text?: string;
  toolCalls?: ToolCall[];
  /** Opaque provider continuation tokens, as Gemini's signed `thought` step arrives. */
  providerSteps?: unknown[];
}

/**
 * A client that replays a fixed list of exploration turns, then answers with a
 * fixed body. Every request it received is kept so a test can assert on what the
 * agent actually sent — including that no tools were offered on the final turn.
 */
class ScriptedClient implements LlmClient {
  readonly provider = "mock" as const;
  readonly model = "scripted-test-model";
  readonly requests: ToolTurnRequest[] = [];

  private turnIndex = 0;

  constructor(
    private readonly turns: readonly ScriptedTurn[],
    private readonly finalBody: unknown,
  ) {}

  async generateStructured(_request: StructuredRequest): Promise<never> {
    throw new Error("The advanced system must not call generateStructured.");
  }

  async generateWithTools(request: ToolTurnRequest): Promise<ToolTurnResponse> {
    this.requests.push({ ...request, steps: [...request.steps] });
    const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

    if (request.schema) {
      const text = typeof this.finalBody === "string" ? this.finalBody : JSON.stringify(this.finalBody);
      return { text, toolCalls: [], providerSteps: [], usage, model: this.model };
    }

    const turn = this.turns[this.turnIndex++];
    return {
      text: turn?.text ?? "",
      toolCalls: turn?.toolCalls ?? [],
      providerSteps: turn?.providerSteps ?? [],
      usage,
      model: this.model,
    };
  }
}

function call(id: string, name: string, args: unknown): ToolCall {
  return { id, name, arguments: args };
}

function run(client: LlmClient, budget?: Partial<ExplorationBudget>) {
  return runAdvanced({
    repositoryPath: root,
    config,
    client,
    now: fixedClock(),
    ...(budget ? { budget: { ...defaultBudget, ...budget } } : {}),
  });
}

const defaultBudget: ExplorationBudget = {
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

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "repo-arch-advanced-"));
  write("README.md", "# demo\n\nA demo pipeline.\n");
  write("package.json", '{ "name": "demo", "dependencies": { "express": "^4.19.2" } }\n');
  write("src/dispatch.js", "const REGISTRY = { extract, load };\n\nfunction dispatch(step) {\n  return REGISTRY[step.type];\n}\n");
  write("src/extract.js", "export function extract() {}\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("runAdvanced — the exploration loop", () => {
  it("explores, then synthesises, and reports what it did", async () => {
    const client = new ScriptedClient(
      [
        { text: "The tree shows src/ but not what dispatches a step.", toolCalls: [call("c1", "search_code", { query: "REGISTRY" })] },
        { text: "Found it in src/dispatch.js.", toolCalls: [call("c2", "read_file", { path: "src/dispatch.js" })] },
        { text: "That answers it." },
      ],
      body(),
    );

    const record = await run(client);

    expect(record.meta.system).toBe(ADVANCED_SYSTEM_NAME);
    expect(record.meta.exploration).toMatchObject({
      toolCalls: 2,
      failedToolCalls: 0,
      callsByTool: { search_code: 1, read_file: 1 },
      filesRead: ["src/dispatch.js"],
      budgetExhausted: false,
    });
    // Three exploration turns plus the synthesis turn.
    expect(record.meta.exploration?.turns).toBe(4);
    expect(record.meta.exploration?.bytesFromTools).toBeGreaterThan(0);
  });

  it("stops as soon as the model asks for nothing, leaving budget unspent", async () => {
    const client = new ScriptedClient([{ text: "The context already answers this." }], body());

    const record = await run(client);

    expect(record.meta.exploration?.toolCalls).toBe(0);
    expect(record.meta.exploration?.turns).toBe(2);
    expect(record.meta.exploration?.budgetExhausted).toBe(false);
    // Four exploration requests were available; only one was used.
    expect(client.requests).toHaveLength(2);
  });

  it("offers tools while exploring and none on the synthesis turn", async () => {
    const client = new ScriptedClient([{ toolCalls: [call("c1", "list_directory", {})] }, { text: "Done." }], body());

    await run(client);

    const exploration = client.requests.slice(0, -1);
    const synthesis = client.requests.at(-1);
    for (const request of exploration) {
      expect(request.tools.map((tool) => tool.name)).toEqual(["search_code", "read_file", "list_directory"]);
      expect(request.schema).toBeUndefined();
    }
    // A schema-constrained turn cannot express "call a tool", so the two are split.
    expect(synthesis?.tools).toEqual([]);
    expect(synthesis?.schema).toBe(ADVANCED_RESPONSE_SCHEMA);
  });

  it("replays the tool call and its real result into the next request", async () => {
    const client = new ScriptedClient(
      [{ toolCalls: [call("c1", "read_file", { path: "src/extract.js" })] }, { text: "Done." }],
      body(),
    );

    await run(client);

    const steps = client.requests[1]?.steps ?? [];
    const toolCall = steps.find((step): step is ConversationStep & { kind: "toolCall" } => step.kind === "toolCall");
    const toolResult = steps.find((step): step is ConversationStep & { kind: "toolResult" } => step.kind === "toolResult");

    expect(toolCall).toMatchObject({ id: "c1", name: "read_file", arguments: { path: "src/extract.js" } });
    expect(toolResult?.callId).toBe("c1");
    expect(toolResult?.isError).toBe(false);
    // The model sees the filesystem's answer, not a paraphrase of it.
    expect(toolResult?.output).toContain("1 | export function extract() {}");
  });

  it("replays a provider continuation token verbatim, in order, without reading it", async () => {
    // Gemini answers a tool call with a signed `thought` step and rejects the next
    // request outright if that signature is missing. This test exists because the
    // first real run failed exactly there, and the failure is invisible offline.
    const signature = { type: "thought", signature: "ZmFrZS1zaWduYXR1cmU=" };
    const client = new ScriptedClient(
      [
        {
          text: "Checking the dispatcher.",
          providerSteps: [signature],
          toolCalls: [call("c1", "read_file", { path: "src/extract.js" })],
        },
        { text: "Done." },
      ],
      body(),
    );

    const record = await run(client);

    const steps = client.requests[1]?.steps ?? [];
    // The token opens the model's turn, ahead of its prose and its call — the
    // order Gemini requires of a replayed thinking turn.
    expect(steps.map((step) => step.kind)).toEqual(["user", "providerStep", "model", "toolCall", "toolResult"]);
    const replayed = steps.find(
      (step): step is ConversationStep & { kind: "providerStep" } => step.kind === "providerStep",
    );
    expect(replayed?.payload).toEqual(signature);
    // A transport detail: it never becomes a citable source, and the ledger is
    // unchanged by it.
    expect(record.meta.contextSources.map((source) => source.id)).not.toContain("thought");
    expect(record.meta.exploration?.bytesFromTools).toBeGreaterThan(0);
  });

  it("replays several calls from one turn as calls-then-results, not interleaved", async () => {
    // The other failure a real run found and an offline one cannot: Gemini models a
    // turn as all of its function calls followed by all of their results, and rejects
    // the chronological arrangement — call, result, call, result — with "400 Request
    // contains an invalid argument". It cost a whole evaluation case, and it appeared
    // only once the model had enough context to ask for two files at once.
    const client = new ScriptedClient(
      [
        {
          text: "Both files are relevant.",
          toolCalls: [
            call("c1", "read_file", { path: "src/extract.js" }),
            call("c2", "read_file", { path: "src/dispatch.js" }),
          ],
        },
        { text: "Done." },
      ],
      body(),
    );

    await run(client);

    const steps = client.requests[1]?.steps ?? [];
    expect(steps.map((step) => step.kind)).toEqual([
      "user",
      "model",
      "toolCall",
      "toolCall",
      "toolResult",
      "toolResult",
    ]);
    // Reordering the replay must not reorder anything else: each result still pairs
    // with its own call, and the pairs are still in the order the model asked.
    const calls = steps.filter((step): step is ConversationStep & { kind: "toolCall" } => step.kind === "toolCall");
    const results = steps.filter(
      (step): step is ConversationStep & { kind: "toolResult" } => step.kind === "toolResult",
    );
    expect(calls.map((step) => step.id)).toEqual(["c1", "c2"]);
    expect(results.map((step) => step.callId)).toEqual(["c1", "c2"]);
    expect(results[0]?.output).toContain("export function extract() {}");
    expect(results[1]?.output).toContain("const REGISTRY");
  });

  it("feeds a failed tool call back as an error the model can act on", async () => {
    const client = new ScriptedClient(
      [
        { toolCalls: [call("c1", "read_file", { path: "../../etc/passwd" })] },
        { toolCalls: [call("c2", "read_file", { path: "src/extract.js" })] },
        { text: "Recovered." },
      ],
      body(),
    );

    const record = await run(client);

    expect(record.meta.exploration).toMatchObject({ toolCalls: 2, failedToolCalls: 1 });
    // The recovery read landed; the escape attempt contributed nothing. `filesRead` is
    // the union of the scout's reads and the model's, so it is asserted by membership
    // rather than as an exact list — what matters is which files the refusal did and
    // did not put in the ledger.
    expect(record.meta.exploration?.filesRead).toContain("src/extract.js");
    expect(record.meta.exploration?.filesRead.join(" ")).not.toContain("passwd");
    const failed = client.requests[1]?.steps.find(
      (step): step is ConversationStep & { kind: "toolResult" } => step.kind === "toolResult",
    );
    expect(failed?.isError).toBe(true);
    expect(failed?.output).toContain("Path escapes the repository");
  });

  it("survives a model that asks for a tool that does not exist", async () => {
    const client = new ScriptedClient(
      [{ toolCalls: [call("c1", "run_tests", { suite: "all" })] }, { text: "Understood." }],
      body(),
    );

    const record = await run(client);

    expect(record.meta.exploration).toMatchObject({ toolCalls: 1, failedToolCalls: 1, callsByTool: { run_tests: 1 } });
    expect(record.result.summary).toBe("A small demo repository.");
  });

  it("survives malformed tool arguments", async () => {
    const client = new ScriptedClient(
      [{ toolCalls: [call("c1", "read_file", "not json")] }, { text: "Understood." }],
      body(),
    );

    const record = await run(client);

    expect(record.meta.exploration?.failedToolCalls).toBe(1);
    const step = record.trajectory.find((entry) => entry.action === "tool-call");
    expect(step?.ok).toBe(false);
    expect(String(step?.toolResult)).toContain("not a JSON object");
  });

  it("requires a provider that can use tools, instead of quietly running a baseline", async () => {
    const withoutTools: LlmClient = {
      provider: "mock",
      model: "no-tools",
      generateStructured: async () => {
        throw new Error("unused");
      },
    };

    await expect(runAdvanced({ repositoryPath: root, config, client: withoutTools })).rejects.toThrow(ConfigError);
    await expect(runAdvanced({ repositoryPath: root, config, client: withoutTools })).rejects.toThrow(
      /does not support tool use/,
    );
  });

  it("fails loudly when the synthesis turn returns nothing", async () => {
    const client = new ScriptedClient([{ text: "Done." }], "");
    await expect(run(client)).rejects.toThrow(ModelError);
  });

  it("builds a run id that names the system, the repository and the time", () => {
    expect(buildRunId("Orders API", new Date(Date.UTC(2026, 0, 2, 3, 4, 5)))).toBe(
      "advanced-orders-api-2026-01-02T03-04-05Z",
    );
  });
});

describe("runAdvanced — the exploration budget", () => {
  it("stops at maxToolCalls and tells the model why", async () => {
    const client = new ScriptedClient(
      [
        { toolCalls: [call("c1", "list_directory", {}), call("c2", "list_directory", { path: "src" })] },
        { toolCalls: [call("c3", "read_file", { path: "src/extract.js" })] },
        { text: "Answering with what I have." },
      ],
      body(),
    );

    const record = await run(client, { maxToolCalls: 2 });

    expect(record.meta.exploration).toMatchObject({ toolCalls: 2, budgetExhausted: true });
    // The third call was never executed, and never reached the filesystem: the file it
    // named is absent from the ledger even though the scout read a different one.
    expect(record.meta.exploration?.filesRead).not.toContain("src/extract.js");
    const refusal = client.requests[2]?.steps.find(
      (step): step is ConversationStep & { kind: "toolResult" } =>
        step.kind === "toolResult" && step.callId === "c3",
    );
    expect(refusal?.isError).toBe(true);
    expect(refusal?.output).toContain("exploration budget exhausted");
    expect(record.trajectory.some((entry) => entry.action === "budget-exhausted")).toBe(true);
  });

  it("forces synthesis at maxTurns even when the model would keep going", async () => {
    const eager: ScriptedTurn[] = Array.from({ length: 10 }, (_, index) => ({
      toolCalls: [call(`c${index}`, "list_directory", {})],
    }));
    const client = new ScriptedClient(eager, body());

    const record = await run(client, { maxTurns: 3 });

    expect(record.meta.exploration).toMatchObject({ toolCalls: 3, budgetExhausted: true });
    // Three exploration turns plus synthesis, and no more.
    expect(client.requests).toHaveLength(4);
  });

  it("records the budget it ran under, so a result can be reproduced", async () => {
    const client = new ScriptedClient([{ text: "Done." }], body());
    const record = await run(client, { maxToolCalls: 4, maxFileLines: 25 });

    expect(record.meta.exploration?.budget).toMatchObject({ maxToolCalls: 4, maxFileLines: 25, maxTurns: 8 });
  });

  it("passes the per-call budget through to the tools themselves", async () => {
    write("src/long.js", Array.from({ length: 40 }, (_, index) => `// line ${index + 1}`).join("\n"));
    const client = new ScriptedClient(
      [{ toolCalls: [call("c1", "read_file", { path: "src/long.js" })] }, { text: "Done." }],
      body(),
    );

    await run(client, { maxFileLines: 5 });

    const result = client.requests[1]?.steps.find(
      (step): step is ConversationStep & { kind: "toolResult" } => step.kind === "toolResult",
    );
    expect(result?.output).toContain("lines 1-5 of 40");
    expect(result?.output).toContain("truncated: line budget reached");
  });
});

describe("runAdvanced — the evidence scout", () => {
  /** The reconnaissance prompt, as the model received it on its first turn. */
  function firstPrompt(client: ScriptedClient): string {
    const opening = client.requests[0]?.steps[0];
    return opening?.kind === "user" ? opening.text : "";
  }

  it("adds search evidence to the reconnaissance context instead of replacing it", async () => {
    // Iteration 1's second failure mode, pinned as a test. It traded breadth for depth
    // and lost a question the baseline had answered from the README alone, so the rule
    // is that the shallow context survives verbatim whatever the scout goes on to read.
    const client = new ScriptedClient([{ text: "Done." }], body());

    await run(client);
    const prompt = firstPrompt(client);

    for (const id of ["tree", "README.md", "package.json", "metadata"]) {
      expect(prompt).toContain(`### SOURCE: ${id}`);
    }
    expect(prompt).toContain("A demo pipeline.");
    expect(prompt).toContain("## Evidence found by repository search");
    expect(prompt).toContain("### SCOUT EVIDENCE: src/dispatch.js");
    // Order matters as much as presence: reconnaissance first, search evidence after it.
    expect(prompt.indexOf("### SOURCE: tree")).toBeLessThan(prompt.indexOf("## Evidence found by repository search"));
  });

  it("searches before the model's first turn, with no model call to choose the terms", async () => {
    const client = new ScriptedClient([{ text: "The search evidence already covers this." }], body());

    const record = await run(client);

    // Two requests: one exploration turn and the synthesis turn. Extracting terms with
    // another model call would show up here as a third, and would cost tokens and
    // determinism both.
    expect(client.requests).toHaveLength(2);
    expect(record.meta.exploration?.scout?.searches).toBeGreaterThan(0);
    expect(record.meta.exploration?.scout?.filesRead).toBe(1);
    expect(firstPrompt(client)).toContain("const REGISTRY");
  });

  it("records the scout's work separately from the model's tool budget", async () => {
    const client = new ScriptedClient(
      [{ toolCalls: [call("c1", "list_directory", {})] }, { text: "Done." }],
      body(),
    );

    const record = await run(client);
    const exploration = record.meta.exploration;

    // The scout's cost is fixed and declared; the model's is discretionary. Summing them
    // would make "the agent explored more this iteration" unreadable from the numbers.
    expect(exploration?.toolCalls).toBe(1);
    expect(exploration?.callsByTool).toEqual({ list_directory: 1 });
    expect(exploration?.scout).toMatchObject({ searches: 6, searchesWithMatches: 3, candidates: 1, filesRead: 1 });
    // What the ledger holds is the union, because grounding does not distinguish them.
    expect(exploration?.filesRead).toEqual(["src/dispatch.js"]);
    expect(exploration?.bytesFromTools).toBeGreaterThan(record.meta.exploration?.scout?.bytesRead ?? 0);
  });

  it("puts the scout's reads in the ledger and in the closed list of citable ids", async () => {
    const client = new ScriptedClient([{ text: "Done." }], body());

    const record = await run(client);
    const citable = record.meta.contextSources.map((source) => source.id);

    expect(citable).toContain("src/dispatch.js");
    expect(record.meta.contextSources.find((source) => source.id === "src/dispatch.js")?.type).toBe("file");
    const synthesis = record.trajectory.find((step) => step.action === "build-synthesis-prompt");
    expect(synthesis?.detail).toMatchObject({ filesRead: ["src/dispatch.js"] });
  });

  it("can be switched off entirely, leaving the iteration 1 pipeline behind", async () => {
    // The experiment needs its own control: with a zero scout budget the run is
    // iteration 1 again, which is what makes the measured delta attributable.
    const client = new ScriptedClient([{ text: "Done." }], body());

    const record = await run(client, { maxScoutSearches: 0, maxScoutFiles: 0 });

    expect(record.meta.exploration?.scout).toMatchObject({ searches: 0, filesRead: 0, candidates: 0 });
    expect(record.meta.exploration?.filesRead).toEqual([]);
    expect(firstPrompt(client)).not.toContain("## Evidence found by repository search");
    expect(firstPrompt(client)).toContain("### SOURCE: tree");
  });
});

describe("runAdvanced — the trajectory", () => {
  it("records the instruction, each model response, each tool call and result, and the outcome", async () => {
    const client = new ScriptedClient(
      [
        { text: "I need to see the dispatcher.", toolCalls: [call("c1", "read_file", { path: "src/dispatch.js" })] },
        { text: "That is enough." },
      ],
      body(),
    );

    const record = await run(client);
    const actions = record.trajectory.map((step) => step.action);

    expect(actions).toEqual([
      "collect-context",
      "scout-search",
      "scout-read",
      "build-recon-prompt",
      "model-turn",
      "tool-call",
      "model-turn",
      "build-synthesis-prompt",
      "synthesis-call",
      "validate-schema",
      "refine-evidence",
      "ground-evidence",
    ]);
    // The ordering is the point of iteration 2, not an accident of this list: the
    // deterministic search runs to completion before the model gets a turn, so the
    // model is reasoning about evidence rather than about which filename to guess.
    expect(actions.indexOf("scout-search")).toBeLessThan(actions.indexOf("model-turn"));
    expect(actions.indexOf("scout-read")).toBeLessThan(actions.indexOf("build-recon-prompt"));
    // Iteration 3's ordering, for the same reason: precision edits citations, then
    // grounding judges them. Reversing the two would let the pass put a citation into
    // the briefing that nothing had verified.
    expect(actions.indexOf("refine-evidence")).toBeLessThan(actions.indexOf("ground-evidence"));
    for (const step of record.trajectory) {
      expect(typeof step.at).toBe("string");
      expect(step.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("keeps model prose and tool output in separate fields", async () => {
    const client = new ScriptedClient(
      [
        { text: "I believe dispatch uses a registry.", toolCalls: [call("c1", "read_file", { path: "src/dispatch.js" })] },
        { text: "Confirmed." },
      ],
      body(),
    );

    const record = await run(client);
    const modelTurn = record.trajectory.find((step) => step.action === "model-turn");
    const toolStep = record.trajectory.find((step) => step.action === "tool-call");

    // What the model said lives in the model step and nowhere else.
    expect(modelTurn?.detail).toMatchObject({ modelText: "I believe dispatch uses a registry." });
    expect(modelTurn?.toolResult).toBeUndefined();
    // What the filesystem returned lives in the tool step, written by the harness.
    expect(toolStep?.tool).toBe("read_file");
    expect(toolStep?.toolArgs).toEqual({ path: "src/dispatch.js" });
    expect(String(toolStep?.toolResult)).toContain("const REGISTRY");
    expect(toolStep?.ok).toBe(true);
  });

  it("records token usage per turn and totals it on the record", async () => {
    const client = new ScriptedClient(
      [{ toolCalls: [call("c1", "list_directory", {})] }, { text: "Done." }],
      body(),
    );

    const record = await run(client);

    const withUsage = record.trajectory.filter((step) => step.usage !== undefined);
    expect(withUsage).toHaveLength(3); // two exploration turns plus synthesis
    expect(record.meta.usage).toEqual({ inputTokens: 30, outputTokens: 15, totalTokens: 45 });
  });

  it("redacts a secret that appears in tool output", async () => {
    write("src/config.js", 'export const key = "AIzaSyA1234567890abcdefghijklmnopqrstuvw";\n');
    const client = new ScriptedClient(
      [{ toolCalls: [call("c1", "read_file", { path: "src/config.js" })] }, { text: "Done." }],
      body(),
    );

    const record = await run(client);
    const toolStep = record.trajectory.find((step) => step.action === "tool-call");

    expect(String(toolStep?.toolResult)).not.toContain("AIzaSyA1234567890abcdefghijklmnopqrstuvw");
    expect(String(toolStep?.toolResult)).toContain("<redacted-api-key>");
  });

  it("names every source the model was allowed to cite, tool-earned ones included", async () => {
    const client = new ScriptedClient(
      [{ toolCalls: [call("c1", "read_file", { path: "src/dispatch.js" })] }, { text: "Done." }],
      body(),
    );

    const record = await run(client);

    expect(record.meta.contextSources.map((source) => source.id)).toEqual([
      "tree",
      "README.md",
      "package.json",
      "metadata",
      "src/dispatch.js",
    ]);
    expect(record.meta.contextSources.at(-1)?.type).toBe("file");
  });
});

describe("runAdvanced — grounding of tool-derived evidence", () => {
  const fileEvidence = (source: string, excerpt: string, location = "L1-L5") => ({
    type: "file" as const,
    source,
    location,
    excerpt,
    supports: "Dispatch is table-driven.",
  });

  function explore(finalBody: unknown): ScriptedClient {
    return new ScriptedClient(
      [{ toolCalls: [call("c1", "read_file", { path: "src/dispatch.js" })] }, { text: "Done." }],
      finalBody,
    );
  }

  it("keeps a citation quoting text a tool really returned", async () => {
    const record = await run(
      explore(
        body({
          evidence: [fileEvidence("src/dispatch.js", "const REGISTRY = { extract, load };")],
        }),
      ),
    );

    expect(record.result.evidence[0]?.grounded).toBe(true);
    expect(record.meta.evidenceAudit).toMatchObject({ claimed: 1, grounded: 1, dropped: [] });
  });

  it("drops a citation naming a file the agent never read", async () => {
    const record = await run(
      explore(
        body({
          evidence: [fileEvidence("src/never-opened.js", "function secretHandler() {}")],
        }),
      ),
    );

    // The model wrote a plausible path and a plausible quote. Neither is in the ledger.
    expect(record.result.evidence).toEqual([]);
    expect(record.meta.evidenceAudit.claimed).toBe(1);
    expect(record.meta.evidenceAudit.grounded).toBe(0);
    expect(record.meta.evidenceAudit.dropped).toHaveLength(1);
    expect(record.meta.evidenceAudit.dropped[0]?.source).toBe("src/never-opened.js");
    expect(record.meta.evidenceAudit.dropped[0]?.reason).toMatch(/never received/i);
  });

  it("drops a citation whose excerpt was never in the returned bytes", async () => {
    const record = await run(
      explore(
        body({
          evidence: [fileEvidence("src/dispatch.js", "const REGISTRY = { transform, publish };")],
        }),
      ),
    );

    expect(record.result.evidence).toEqual([]);
    expect(record.meta.evidenceAudit.dropped[0]?.source).toBe("src/dispatch.js");
    expect(record.meta.evidenceAudit.dropped[0]?.reason).toMatch(/excerpt/i);
  });

  it("marks the claim unsupported when its only citation is dropped", async () => {
    const record = await run(
      explore(
        body({
          components: [
            {
              name: "dispatcher",
              path: "src/dispatch.js",
              responsibility: "Routes a step to its handler.",
              evidence: [fileEvidence("src/imaginary.js", "imaginary code")],
            },
          ],
          // Grounded, so the dispatcher component is the only unsupported claim.
          testing: {
            approach: "No test suite is visible.",
            frameworks: [],
            testPaths: [],
            gaps: [],
            evidence: [{ type: "readme", source: "README.md" }],
          },
        }),
      ),
    );

    expect(record.result.components[0]?.evidence).toEqual([]);
    expect(record.meta.evidenceAudit.unsupportedClaims).toBe(1);
    expect(record.trajectory.find((step) => step.action === "ground-evidence")?.detail).toMatchObject({
      claimed: 2,
      grounded: 1,
      unsupportedClaims: 1,
    });
  });

  it("does not let a search hit authorise a quote", async () => {
    const client = new ScriptedClient(
      [
        // The model searched, saw the line, and quoted it without reading the file.
        { toolCalls: [call("c1", "search_code", { query: "REGISTRY" })] },
        { text: "Done." },
      ],
      body({ evidence: [fileEvidence("src/dispatch.js", "const REGISTRY = { extract, load };")] }),
    );

    // The scout is switched off for this one so that a search is the *only* thing that
    // touched the file. With it on, the scout would have read src/dispatch.js legitimately
    // and the citation would be verifiable — which is correct behaviour, but a different
    // claim from the one under test here.
    const record = await run(client, { maxScoutFiles: 0 });

    expect(record.meta.exploration?.filesRead).toEqual([]);
    expect(record.result.evidence).toEqual([]);
    expect(record.meta.evidenceAudit.dropped).toHaveLength(1);
  });

  it("keeps a citation of what the scout read, and still drops one of what nobody read", async () => {
    // The risk a pre-read phase introduces: a fuller ledger becoming a looser one. The
    // scout reads src/dispatch.js before the first turn, so quoting it is legitimate
    // even though the model never called read_file itself — and src/extract.js, which
    // no tool opened, is refused exactly as before.
    const client = new ScriptedClient(
      [{ text: "The search evidence already covers this." }],
      body({
        evidence: [
          fileEvidence("src/dispatch.js", "const REGISTRY = { extract, load };"),
          fileEvidence("src/extract.js", "export function extract() {}"),
        ],
      }),
    );

    const record = await run(client);

    expect(record.meta.exploration?.toolCalls).toBe(0);
    expect(record.meta.exploration?.filesRead).toEqual(["src/dispatch.js"]);
    expect(record.result.evidence.map((evidence) => evidence.source)).toEqual(["src/dispatch.js"]);
    expect(record.result.evidence[0]?.grounded).toBe(true);
    expect(record.meta.evidenceAudit.dropped).toHaveLength(1);
    expect(record.meta.evidenceAudit.dropped[0]?.source).toBe("src/extract.js");
  });

  it("lets a directory listing prove existence, under the tree source", async () => {
    const client = new ScriptedClient(
      [{ toolCalls: [call("c1", "list_directory", { path: "src" })] }, { text: "Done." }],
      body({ evidence: [{ type: "tree", source: "tree", location: "src/extract.js" }] }),
    );

    const record = await run(client);

    expect(record.result.evidence[0]?.grounded).toBe(true);
    expect(record.meta.contextSources.filter((source) => source.id === "tree")).toHaveLength(1);
  });
});

describe("advanced results are consumable by the evaluator unchanged", () => {
  it("scores like any other run record, with a file citation counting as content", async () => {
    const client = new ScriptedClient(
      [{ toolCalls: [call("c1", "read_file", { path: "src/dispatch.js" })] }, { text: "Done." }],
      body({
        summary: "A demo pipeline whose dispatcher maps a step type to a handler through REGISTRY.",
        components: [
          {
            name: "dispatcher",
            path: "src/dispatch.js",
            responsibility: "Maps a step type to its handler function through the REGISTRY table.",
            evidence: [
              {
                type: "file",
                source: "src/dispatch.js",
                location: "L1-L5",
                excerpt: "const REGISTRY = { extract, load };",
                supports: "Dispatch is table-driven.",
              },
            ],
          },
        ],
      }),
    );

    const record = await run(client);
    const score = scoreCase(
      {
        id: "case-demo",
        title: "Demo pipeline",
        repository: "fixtures/demo",
        questions: [
          {
            id: "q1-dispatch",
            question: "How is a step type mapped to the function that runs it?",
            field: "components",
            expectedAnswer: "A REGISTRY table maps a step type to its handler.",
            expectedKeywords: ["REGISTRY"],
            anyOfKeywords: [],
            mustNotContain: [],
            expectedEvidence: ["src/dispatch.js"],
          },
        ],
      },
      record,
    );

    expect(score.questions[0]?.answerCorrect).toBe(true);
    // A tool-earned file citation is content-strength evidence to the existing
    // evaluator: nothing in the scoring rules was widened for this system.
    expect(score.questions[0]?.evidenceBacked).toBe(true);
    expect(score.questions[0]?.evidenceStrength).toBe("content");
    expect(score.error).toBeUndefined();
  });
});

describe("the mock provider exercises a real tool trajectory offline", () => {
  it("lists, searches, reads a source file, and grounds the file it read", async () => {
    const record = await runAdvanced({
      repositoryPath: root,
      config,
      client: createLlmClient(config),
      now: fixedClock(),
    });

    const exploration = record.meta.exploration;
    expect(exploration?.callsByTool).toEqual({ list_directory: 1, search_code: 1, read_file: 1 });
    expect(exploration?.filesRead).toHaveLength(1);
    // Whatever it chose to read must have been a real file, cited from real bytes.
    const fileSource = record.meta.contextSources.find((source) => source.type === "file");
    expect(fileSource?.id).toBe(exploration?.filesRead[0]);
    expect(record.meta.evidenceAudit.dropped).toEqual([]);
    expect(record.result.evidence.some((entry) => entry.type === "file")).toBe(true);
  });
});

/**
 * The claim `onPhase`'s own doc comment makes, asserted.
 *
 * The comment on `RunAdvancedOptions.onPhase` says a run with no callback produces
 * a byte-identical record to one with it, and names a regression test as the thing
 * that holds it to that. This is that test. It matters because the option was added
 * to the *measured* path: an observation hook that turned out to be a participant
 * would silently invalidate every number recorded against this system.
 */
describe("runAdvanced — phase reporting is an observation, not a participant", () => {
  const script = (): ScriptedClient =>
    new ScriptedClient(
      [
        { text: "Looking for the dispatcher.", toolCalls: [call("c1", "read_file", { path: "src/dispatch.js" })] },
        { text: "That answers it." },
      ],
      body(),
    );

  it("reports each phase once, in the order the pipeline reaches them", async () => {
    const seen: AdvancedPhase[] = [];

    await runAdvanced({
      repositoryPath: root,
      config,
      client: script(),
      now: fixedClock(),
      onPhase: (phase) => seen.push(phase),
    });

    // Every phase in the declared vocabulary, exactly once, in pipeline order.
    // `exploring` appears once for the whole loop rather than once per turn: it
    // names the phase, not the iteration.
    expect(seen).toEqual([
      "collecting-context",
      "scouting",
      "exploring",
      "synthesizing",
      "validating-schema",
      "refining-evidence",
      "grounding",
    ]);
  });

  it("produces a byte-identical record with and without an observer", async () => {
    const observed = await runAdvanced({
      repositoryPath: root,
      config,
      client: script(),
      now: fixedClock(),
      onPhase: () => {
        // Deliberately does work and returns a value. Neither may reach the run.
        return "ignored" as unknown as void;
      },
    });

    const unobserved = await runAdvanced({
      repositoryPath: root,
      config,
      client: script(),
      now: fixedClock(),
    });

    // Byte-identical, not merely equivalent: the run id, every trajectory
    // timestamp, the ledger and the grounding audit all have to match.
    expect(JSON.stringify(observed)).toBe(JSON.stringify(unobserved));
  });

  it("hands over a phase name and nothing else", async () => {
    const seen: unknown[] = [];

    await runAdvanced({
      repositoryPath: root,
      config,
      client: script(),
      now: fixedClock(),
      // Typed as one parameter; called with one. A second argument would be a
      // channel for prompts or tool results, which is what this forbids.
      onPhase: (...args: unknown[]) => seen.push(args),
    });

    expect(seen.every((args) => Array.isArray(args) && args.length === 1)).toBe(true);
    expect(seen.every((args) => typeof (args as unknown[])[0] === "string")).toBe(true);
  });
});
