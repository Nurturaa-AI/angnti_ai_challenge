import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ModelError,
  RequestError,
  collectRepositoryContext,
  type ContextSourceText,
  type ExplorationBudget,
  type LlmClient,
  type StructuredRequest,
  type StructuredResponse,
  type ToolCall,
  type ToolTurnRequest,
  type ToolTurnResponse,
} from "@repo-arch/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_QUESTION_BUDGET,
  MAX_QUESTION_CHARS,
  UNSUPPORTED_ANSWER,
  answerQuestion,
  type AnsweredQuestion,
} from "../src/questions";

/**
 * Question answering, with the model replaced by a script.
 *
 * The properties worth pinning down are the ones that make an answer trustworthy
 * rather than merely fluent: that a citation the model invented is dropped even when
 * it names a real file; that the fallback wording is produced by the harness, verbatim;
 * that a follow-up can see the previous answer's words but cannot cite them; and that
 * exploration has a ceiling the model cannot talk its way past.
 */

let root: string;
let sources: ContextSourceText[];

function write(relativePath: string, contents: string): void {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents, "utf8");
}

const fixedClock = (): (() => Date) => {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 0, 2, 3, 4, 5) + tick++ * 1000);
};

/** A minimal answer body. Only the fields a test asserts on are interesting. */
function answerBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    answer: "The record store writes to the database.",
    sufficient: true,
    citations: [],
    confidence: 0.7,
    ...overrides,
  };
}

interface ScriptedTurn {
  text?: string;
  toolCalls?: ToolCall[];
}

class ScriptedClient implements LlmClient {
  readonly provider = "mock" as const;
  readonly model = "scripted-test-model";
  readonly requests: ToolTurnRequest[] = [];

  private turnIndex = 0;

  constructor(
    private readonly turns: readonly ScriptedTurn[],
    private readonly finalBody: unknown,
  ) {}

  async generateStructured(_request: StructuredRequest): Promise<StructuredResponse> {
    throw new Error("Question answering must not call generateStructured.");
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
      providerSteps: [],
      usage,
      model: this.model,
    };
  }
}

function call(id: string, name: string, args: unknown): ToolCall {
  return { id, name, arguments: args };
}

function ask(client: LlmClient, overrides: Partial<Parameters<typeof answerQuestion>[0]> = {}) {
  return answerQuestion({
    question: "Which module writes records to the database?",
    questionId: "q-1",
    repositoryRoot: root,
    repositoryName: "widget",
    sources,
    client,
    now: fixedClock(),
    ...overrides,
  });
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "repo-arch-questions-"));
  write("README.md", "# widget\n\nA small service that stores records.\n");
  write("package.json", '{ "name": "widget", "dependencies": { "pg": "^8.11.3" } }\n');
  write("src/router.ts", "export function route(request) {\n  return store.write(request.body);\n}\n");
  write(
    "src/store.ts",
    "import { Pool } from 'pg';\n\nexport async function write(record) {\n  await pool.query('insert into records values ($1)', [record]);\n}\n",
  );
  write("test/router.test.ts", "test('routes', () => {});\n");
  sources = collectRepositoryContext(root).sources;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("question answering", () => {
  it("runs question → scout → model → grounding and returns a verified answer", async () => {
    const client = new ScriptedClient(
      [{ text: "Reading the store." }],
      answerBody({
        citations: [
          {
            type: "file",
            source: "src/store.ts",
            location: "src/store.ts",
            excerpt: "insert into records",
            supports: "The store writes records.",
            grounded: false,
          },
        ],
      }),
    );

    const { answered } = await ask(client);

    expect(answered.id).toBe("q-1");
    expect(answered.supported).toBe(true);
    expect(answered.answer).toBe("The record store writes to the database.");
    expect(answered.citations).toHaveLength(1);
    expect(answered.citations[0]?.id).toBe("q-1-ev-001");
    expect(answered.citations[0]?.sourceId).toBe("src/store.ts");
    expect(answered.audit).toEqual({ claimed: 1, grounded: 1, dropped: [] });
    expect(answered.confidence).toBeCloseTo(0.7);

    // The scout ran, and the file it found is offered back to the caller for the ledger.
    expect(answered.metrics.scoutFilesRead).toBeGreaterThan(0);
    const trajectory = answered.trajectory.map((step) => step.action);
    expect(trajectory).toEqual([
      "question-received",
      "scout-search",
      "scout-read",
      "build-question-prompt",
      "model-turn",
      "answer-call",
      "validate-answer",
      "ground-answer",
    ]);
  });

  it("retrieves repository evidence for the question and hands the new sources back", async () => {
    const client = new ScriptedClient(
      [{ toolCalls: [call("c1", "read_file", { path: "src/router.ts" })] }],
      answerBody({
        citations: [
          { type: "file", source: "src/router.ts", location: undefined, excerpt: "store.write", supports: undefined, grounded: false },
        ],
      }),
    );

    const { answered, newSources } = await ask(client);

    expect(answered.metrics.toolCalls).toBe(1);
    expect(answered.metrics.failedToolCalls).toBe(0);
    expect(answered.metrics.bytesFromTools).toBeGreaterThan(0);
    // The model's read and the scout's reads all become citable, and all come back.
    expect(newSources.map((source) => source.id)).toContain("src/router.ts");
    expect(answered.inspectedSources).toContain("src/router.ts");
    expect(answered.citations[0]?.sourceId).toBe("src/router.ts");

    // The final turn is offered no tools and a strict schema.
    const last = client.requests.at(-1);
    expect(last?.tools).toEqual([]);
    expect(last?.schema).toBeDefined();
  });

  it("only makes a citation citable when the artefact was actually inspected", async () => {
    // `src/store.ts` exists on disk and the scout may not have reached it; the model is
    // told which ids are citable, and the ledger is the only thing that decides.
    const client = new ScriptedClient([{}], answerBody());
    const { answered } = await ask(client);

    for (const id of answered.inspectedSources) {
      expect(sources.some((source) => source.id === id) || id.startsWith("src/") || id.startsWith("test/")).toBe(true);
    }
    // Reconnaissance artefacts are seeded because their text is in the prompt.
    expect(answered.inspectedSources).toContain("tree");
    expect(answered.inspectedSources).toContain("README.md");
  });

  it("drops an ungrounded citation and falls back with the exact required wording", async () => {
    const client = new ScriptedClient(
      [{}],
      answerBody({
        citations: [
          // A real file, quoted with something it does not contain.
          {
            type: "file",
            source: "src/store.ts",
            location: "src/store.ts:2",
            excerpt: "await mongoClient.insertOne(record)",
            supports: "invented",
            grounded: true,
          },
        ],
      }),
    );

    const { answered } = await ask(client);

    expect(answered.answer).toBe("I couldn't verify this from the repository evidence I inspected.");
    expect(answered.answer).toBe(UNSUPPORTED_ANSWER);
    expect(answered.supported).toBe(false);
    expect(answered.confidence).toBe(0);
    expect(answered.audit.grounded).toBe(0);
    expect(answered.audit.dropped).toHaveLength(1);
    expect(answered.audit.dropped[0]?.reason).toMatch(/excerpt/i);
    // The attempt is kept, so a reader can see what the model tried to cite.
    expect(answered.citations).toEqual([]);
  });

  it("drops a citation naming an artefact this question never inspected", async () => {
    const client = new ScriptedClient(
      [{}],
      answerBody({
        citations: [
          { type: "file", source: "src/does-not-exist.ts", location: undefined, excerpt: undefined, supports: undefined, grounded: true },
        ],
      }),
    );

    const { answered } = await ask(client);

    expect(answered.supported).toBe(false);
    expect(answered.answer).toBe(UNSUPPORTED_ANSWER);
    expect(answered.audit.dropped[0]?.source).toBe("src/does-not-exist.ts");
  });

  it("respects a model that reports the evidence as insufficient, even with a surviving citation", async () => {
    const client = new ScriptedClient(
      [{}],
      answerBody({
        sufficient: false,
        answer: "It might be the store, but I am not sure.",
        citations: [
          { type: "file", source: "README.md", location: undefined, excerpt: "stores records", supports: undefined, grounded: false },
        ],
      }),
    );

    const { answered } = await ask(client);

    expect(answered.audit.grounded).toBe(1);
    expect(answered.supported).toBe(false);
    expect(answered.answer).toBe(UNSUPPORTED_ANSWER);
    expect(answered.modelReportedSufficient).toBe(false);
    // The surviving citation is still shown; only the prose is withheld.
    expect(answered.citations).toHaveLength(1);
  });

  it("replays a follow-up's history as words, and never as citable evidence", async () => {
    const first = new ScriptedClient(
      [{}],
      answerBody({
        answer: "src/store.ts writes the records.",
        citations: [
          { type: "file", source: "README.md", location: undefined, excerpt: "stores records", supports: undefined, grounded: false },
        ],
      }),
    );
    const { answered: previous } = await ask(first);
    expect(previous.supported).toBe(true);

    const followUp = new ScriptedClient(
      [{}],
      answerBody({
        // Citing the previous answer, which is not a repository artefact.
        citations: [
          { type: "file", source: "src/store.ts writes the records.", location: undefined, excerpt: undefined, supports: undefined, grounded: true },
          { type: "file", source: "q-1", location: undefined, excerpt: undefined, supports: undefined, grounded: true },
        ],
      }),
    );
    const { answered } = await ask(followUp, {
      question: "And what does it insert?",
      questionId: "q-2",
      history: [previous],
    });

    // The words reached the prompt.
    const prompt = String(followUp.requests[0]?.steps[0] && (followUp.requests[0]?.steps[0] as { text?: string }).text);
    expect(prompt).toContain("src/store.ts writes the records.");
    // But nothing from the history became citable.
    expect(answered.audit.dropped).toHaveLength(2);
    expect(answered.supported).toBe(false);
    expect(answered.inspectedSources).not.toContain("q-1");

    // A previous answer's citations are not replayed into the prompt either.
    expect(prompt).not.toContain("q-1-ev-001");
  });

  it("stops exploring at the budget and tells the model it has stopped", async () => {
    const budget: ExplorationBudget = { ...DEFAULT_QUESTION_BUDGET, maxToolCalls: 1, maxTurns: 2 };
    const client = new ScriptedClient(
      [
        { toolCalls: [call("c1", "read_file", { path: "src/router.ts" })] },
        { toolCalls: [call("c2", "read_file", { path: "src/store.ts" })] },
      ],
      answerBody(),
    );

    const { answered } = await ask(client, { budget });

    expect(answered.metrics.toolCalls).toBe(1);
    expect(answered.metrics.budgetExhausted).toBe(true);
    expect(answered.trajectory.some((step) => step.action === "budget-exhausted")).toBe(true);
    // Exactly one tool call was executed. The second was refused before reaching a tool,
    // so it is a `budget-exhausted` step rather than a `tool-call` one.
    const executed = answered.trajectory.filter((step) => step.action === "tool-call");
    expect(executed).toHaveLength(1);
    expect(executed[0]?.tool).toBe("read_file");

    const refusal = client.requests
      .flatMap((request) => request.steps)
      .find((step) => step.kind === "toolResult" && step.isError);
    expect(refusal?.kind === "toolResult" ? refusal.output : "").toMatch(/exploration budget is spent/);
  });

  it("records a failed tool call without letting it become evidence", async () => {
    const client = new ScriptedClient(
      [{ toolCalls: [call("c1", "read_file", { path: "../../../etc/passwd" })] }],
      answerBody({
        citations: [
          { type: "file", source: "../../../etc/passwd", location: undefined, excerpt: undefined, supports: undefined, grounded: true },
        ],
      }),
    );

    const { answered } = await ask(client);

    expect(answered.metrics.toolCalls).toBe(1);
    expect(answered.metrics.failedToolCalls).toBe(1);
    expect(answered.inspectedSources).not.toContain("../../../etc/passwd");
    expect(answered.supported).toBe(false);
  });

  it("rejects an empty question and one longer than the cap", async () => {
    const client = new ScriptedClient([{}], answerBody());

    await expect(ask(client, { question: "   " })).rejects.toBeInstanceOf(RequestError);
    await expect(ask(client, { question: "x".repeat(MAX_QUESTION_CHARS + 1) })).rejects.toThrow(
      new RegExp(String(MAX_QUESTION_CHARS)),
    );
  });

  it("refuses a provider that cannot use tools rather than degrading silently", async () => {
    const toolless: LlmClient = {
      provider: "mock",
      model: "no-tools",
      async generateStructured(): Promise<StructuredResponse> {
        throw new Error("unused");
      },
    };

    await expect(ask(toolless)).rejects.toBeInstanceOf(ModelError);
  });

  it("keeps the default budget bounded well below the briefing's", () => {
    expect(DEFAULT_QUESTION_BUDGET.maxToolCalls).toBe(4);
    expect(DEFAULT_QUESTION_BUDGET.maxTurns).toBe(3);
    expect(DEFAULT_QUESTION_BUDGET.maxScoutFiles).toBe(3);
  });

  it("gives each question its own citation namespace", async () => {
    const script = (): ScriptedClient =>
      new ScriptedClient(
        [{}],
        answerBody({
          citations: [
            { type: "file", source: "README.md", location: undefined, excerpt: "stores records", supports: undefined, grounded: false },
          ],
        }),
      );

    const first = await ask(script());
    const second = await ask(script(), { questionId: "q-2" });

    expect(first.answered.citations[0]?.id).toBe("q-1-ev-001");
    expect(second.answered.citations[0]?.id).toBe("q-2-ev-001");
  });

  it("returns plain data, so the analysis store can hold an answer as-is", async () => {
    const client = new ScriptedClient([{}], answerBody());
    const { answered } = await ask(client);
    const roundTripped: AnsweredQuestion = JSON.parse(JSON.stringify(answered)) as AnsweredQuestion;
    expect(roundTripped.id).toBe(answered.id);
    expect(roundTripped.metrics.turns).toBe(answered.metrics.turns);
  });
});
