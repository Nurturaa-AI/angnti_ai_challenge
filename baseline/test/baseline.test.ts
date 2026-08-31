import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ModelError,
  RepositoryError,
  SchemaError,
  renderBriefingMarkdown,
  type AnalysisConfig,
  type LlmClient,
  type StructuredRequest,
} from "@repo-arch/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BASELINE_SYSTEM_NAME, buildRunId, runBaseline } from "../src/index";

/**
 * The baseline, end to end, with the model replaced by a stub.
 *
 * Two things are being pinned down here. First, the prohibitions: the baseline
 * must not read source files, run anything, or put git history in the prompt.
 * Second, the fabrication defence: a citation to something the system never
 * received has to disappear from the briefing and show up in the audit.
 */

const config: AnalysisConfig = {
  provider: "mock",
  model: "stub-v1",
  apiKey: undefined,
  seed: 7,
  thinkingLevel: "low",
  maxOutputTokens: 4096,
};

/** A model that returns exactly what a test tells it to, and records what it was asked. */
function stubClient(reply: string | ((request: StructuredRequest) => string)): LlmClient & {
  readonly requests: StructuredRequest[];
} {
  const requests: StructuredRequest[] = [];
  return {
    provider: "mock",
    model: "stub-v1",
    requests,
    generateStructured(request) {
      requests.push(request);
      return Promise.resolve({
        text: typeof reply === "string" ? reply : reply(request),
        model: "stub-v1",
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      });
    },
  };
}

function briefing(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    summary: "A demo HTTP service.",
    architecture: "A single Express process.",
    components: [],
    flows: [],
    dependencies: [],
    testing: { approach: "No test suite is visible.", frameworks: [], testPaths: [], gaps: [], evidence: [] },
    risks: [],
    recommendedReading: [],
    confidence: 0.3,
    evidence: [],
    openQuestions: [],
    ...overrides,
  });
}

let root: string;
let clock: number;

function write(relativePath: string, contents: string): void {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents, "utf8");
}

/** A fixed clock, so run ids and durations are reproducible. */
function now(): Date {
  clock += 1000;
  return new Date(clock);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "repo-arch-baseline-"));
  clock = Date.parse("2026-01-01T00:00:00.000Z");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("runBaseline", () => {
  it("produces a validated run record from a shallow pass over the repository", async () => {
    write("README.md", "# demo\n\nA demo HTTP service.\n");
    write("package.json", '{ "name": "demo", "dependencies": { "express": "^4.19.2" } }\n');
    write("src/server.js", "// server\n");

    const client = stubClient(
      briefing({
        dependencies: [
          {
            name: "express",
            version: "^4.19.2",
            scope: "runtime",
            evidence: [{ type: "manifest", source: "package.json", excerpt: '"express": "^4.19.2"' }],
          },
        ],
      }),
    );

    const record = await runBaseline({ repositoryPath: root, config, client, now });

    expect(record.schemaVersion).toBe(1);
    expect(record.meta.system).toBe(BASELINE_SYSTEM_NAME);
    expect(record.meta.provider).toBe("mock");
    expect(record.meta.seed).toBe(7);
    expect(record.result.repository.fileCount).toBe(3);
    expect(record.result.dependencies[0]?.evidence[0]?.grounded).toBe(true);
    expect(record.meta.evidenceAudit).toMatchObject({ claimed: 1, grounded: 1, dropped: [] });
  });

  it("makes exactly one model call, with no tools and no follow-up turn", async () => {
    write("README.md", "# demo\n");
    const client = stubClient(briefing());

    await runBaseline({ repositoryPath: root, config, client, now });

    expect(client.requests).toHaveLength(1);
    expect(Object.keys(client.requests[0] ?? {}).sort()).toEqual(["input", "schema", "systemInstruction"]);
  });

  it("records a trajectory covering every stage, so a run can be audited", async () => {
    write("README.md", "# demo\n");
    const record = await runBaseline({ repositoryPath: root, config, client: stubClient(briefing()), now });

    expect(record.trajectory.map((step) => step.action)).toEqual([
      "collect-context",
      "build-prompt",
      "model-call",
      "validate-schema",
      "ground-evidence",
    ]);
  });

  it("sends only the shallow context, never source file contents or git history", async () => {
    write("README.md", "# demo\n");
    write("src/secret-logic.js", "const MAGIC_CONSTANT = 'do-not-leak';\n");
    const client = stubClient(briefing());

    await runBaseline({ repositoryPath: root, config, client, now });
    const prompt = client.requests[0]?.input ?? "";

    // The tree names the file; the file's contents are never read.
    expect(prompt).toContain("secret-logic.js");
    expect(prompt).not.toContain("MAGIC_CONSTANT");
    expect(prompt).not.toContain("do-not-leak");
    expect(prompt).not.toMatch(/commit|branch|HEAD/i);
  });

  it("tells the model the closed set of source ids it may cite", async () => {
    write("README.md", "# demo\n");
    write("package.json", '{ "name": "demo" }\n');
    const client = stubClient(briefing());

    await runBaseline({ repositoryPath: root, config, client, now });
    const prompt = client.requests[0]?.input ?? "";

    expect(prompt).toContain("You may cite exactly these 4 source ids");
    expect(prompt).toContain("  - README.md");
    expect(prompt).toContain("  - package.json");
  });

  it("works on a repository with no README and no package manifest", async () => {
    write("src/main.rb", "puts 'hello'\n");
    const client = stubClient(briefing());

    const record = await runBaseline({ repositoryPath: root, config, client, now });

    expect(record.meta.contextSources.map((source) => source.id)).toEqual(["tree", "metadata"]);
    expect(record.result.summary).toBe("A demo HTTP service.");
  });

  it("works on an empty repository without inventing a repository", async () => {
    const client = stubClient(briefing({ summary: "The repository is empty.", confidence: 0.05 }));

    const record = await runBaseline({ repositoryPath: root, config, client, now });

    expect(record.result.repository.fileCount).toBe(0);
    expect(client.requests[0]?.input).toContain("(no files or directories found)");
    expect(record.result.confidence).toBe(0.05);
  });

  it("fails with a usable message when the path is not a repository", async () => {
    await expect(
      runBaseline({ repositoryPath: path.join(root, "absent"), config, client: stubClient(briefing()), now }),
    ).rejects.toThrow(RepositoryError);
  });

  it("fails loudly on malformed model output rather than degrading into a partial briefing", async () => {
    write("README.md", "# demo\n");

    await expect(
      runBaseline({ repositoryPath: root, config, client: stubClient("I could not analyse this repository."), now }),
    ).rejects.toThrow(ModelError);
  });

  it("fails on well-formed JSON that breaks the analysis contract", async () => {
    write("README.md", "# demo\n");
    const client = stubClient(JSON.stringify({ summary: "A service.", confidence: 4 }));

    await expect(runBaseline({ repositoryPath: root, config, client, now })).rejects.toThrow(SchemaError);
  });

  it("names the offending fields when the model breaks the contract", async () => {
    write("README.md", "# demo\n");
    const client = stubClient(JSON.stringify({ summary: "A service.", confidence: 4 }));

    try {
      await runBaseline({ repositoryPath: root, config, client, now });
      expect.unreachable("should have thrown");
    } catch (error) {
      const issues = (error as SchemaError).issues.join("\n");
      expect(issues).toContain("confidence");
      expect(issues).toContain("architecture");
    }
  });
});

describe("runBaseline — fabrication defence", () => {
  it("drops a citation to a file the model was never given, and audits it", async () => {
    write("README.md", "# demo\n");
    write("src/server.js", "// never read\n");

    const client = stubClient(
      briefing({
        components: [
          {
            name: "server",
            path: "src/server.js",
            responsibility: "Boots the HTTP listener.",
            // The model saw this path in the tree but never received the file.
            evidence: [{ type: "manifest", source: "src/server.js", excerpt: "app.listen(3000)" }],
          },
        ],
      }),
    );

    const record = await runBaseline({ repositoryPath: root, config, client, now });

    expect(record.result.components[0]?.evidence).toEqual([]);
    expect(record.meta.evidenceAudit.claimed).toBe(1);
    expect(record.meta.evidenceAudit.grounded).toBe(0);
    expect(record.meta.evidenceAudit.dropped[0]).toMatchObject({ source: "src/server.js" });
    expect(record.meta.evidenceAudit.dropped[0]?.reason).toContain("source-not-in-context");
  });

  it("drops a citation whose excerpt was never in the source it names", async () => {
    write("README.md", "# demo\n\nA demo HTTP service.\n");

    const client = stubClient(
      briefing({
        evidence: [{ type: "readme", source: "README.md", excerpt: "deployed to Kubernetes nightly" }],
      }),
    );

    const record = await runBaseline({ repositoryPath: root, config, client, now });

    expect(record.result.evidence).toEqual([]);
    expect(record.meta.evidenceAudit.dropped[0]?.reason).toContain("excerpt-not-found");
  });

  it("keeps the claim but counts it as unsupported, so the reader sees the hole", async () => {
    write("README.md", "# demo\n");

    const client = stubClient(
      briefing({
        risks: [
          {
            title: "No tests",
            description: "There is no visible test suite.",
            severity: "medium",
            evidence: [{ type: "test", source: "test/nothing.test.js" }],
          },
        ],
      }),
    );

    const record = await runBaseline({ repositoryPath: root, config, client, now });

    expect(record.result.risks).toHaveLength(1);
    expect(record.result.risks[0]?.evidence).toEqual([]);
    // The risk and the testing section both end up with nothing behind them.
    expect(record.meta.evidenceAudit.unsupportedClaims).toBe(2);
  });
});

describe("buildRunId", () => {
  it("is deterministic for the same repository and instant", () => {
    const at = new Date("2026-01-01T12:34:56.000Z");
    expect(buildRunId("Orders API", at)).toBe(buildRunId("Orders API", at));
  });

  it("is filesystem-safe and identifies the system, repository and time", () => {
    const id = buildRunId("Orders API", new Date("2026-01-01T12:34:56.000Z"));

    expect(id).toMatch(/^baseline-orders-api-[\dTZ-]+$/);
    expect(id).not.toMatch(/[/\\:]/);
  });
});

describe("renderBriefingMarkdown", () => {
  it("marks an unsupported claim in the reader-facing briefing", async () => {
    write("README.md", "# demo\n");
    const client = stubClient(
      briefing({
        risks: [{ title: "No tests", description: "Nothing visible.", severity: "medium", evidence: [] }],
      }),
    );

    const record = await runBaseline({ repositoryPath: root, config, client, now });
    const markdown = renderBriefingMarkdown(record);

    expect(markdown).toContain("No tests");
    expect(markdown.toLowerCase()).toContain("unsupported");
  });

  it("never prints an API key, even when one is configured", async () => {
    write("README.md", "# demo\n");
    const record = await runBaseline({
      repositoryPath: root,
      config: { ...config, provider: "gemini", apiKey: "AIzaFAKEKEYFAKEKEYFAKEKEY" },
      client: stubClient(briefing()),
      now,
    });

    const markdown = renderBriefingMarkdown(record);
    expect(markdown).not.toContain("AIzaFAKEKEYFAKEKEYFAKEKEY");
    expect(JSON.stringify(record)).not.toContain("AIzaFAKEKEYFAKEKEYFAKEKEY");
  });
});
