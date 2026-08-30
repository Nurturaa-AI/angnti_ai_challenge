import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EvaluationError, type AnalysisConfig, type LlmClient, type StructuredRequest } from "@repo-arch/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runEvaluation } from "../src/run";

/**
 * The evaluation runner, end to end, with the model stubbed.
 *
 * The properties under test are the ones that decide whether a reported number
 * can be trusted: the same inputs produce the same report, a case that crashes
 * still counts against the denominator, and the analyzer never sees the questions
 * it is being scored on.
 */

const config: AnalysisConfig = {
  provider: "mock",
  model: "stub-v1",
  apiKey: undefined,
  seed: 7,
  thinkingLevel: "low",
  maxOutputTokens: 4096,
};

/** Distinctive strings that must never reach the model. */
const QUESTION_SENTINEL = "ZZQUESTIONSENTINEL";
const ANSWER_SENTINEL = "ZZANSWERSENTINEL";

let workspace: string;
let repoRelative: string;
let casesDir: string;
let resultsDir: string;
let clock: number;

function now(): Date {
  clock += 1000;
  return new Date(clock);
}

function stubClient(): LlmClient & { readonly requests: StructuredRequest[] } {
  const requests: StructuredRequest[] = [];
  return {
    provider: "mock",
    model: "stub-v1",
    requests,
    generateStructured(request) {
      requests.push(request);
      return Promise.resolve({
        text: JSON.stringify({
          summary: "A demo HTTP service built on express.",
          architecture: "A single express process.",
          components: [],
          flows: [],
          dependencies: [
            {
              name: "express",
              version: "^4.19.2",
              scope: "runtime",
              evidence: [{ type: "manifest", source: "package.json", excerpt: '"express"' }],
            },
          ],
          testing: { approach: "No test suite is visible.", frameworks: [], testPaths: [], gaps: [], evidence: [] },
          risks: [],
          recommendedReading: [],
          confidence: 0.3,
          evidence: [{ type: "readme", source: "README.md", excerpt: "demo" }],
          openQuestions: [],
        }),
        model: "stub-v1",
        usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 },
      });
    },
  };
}

function writeCase(name: string, value: unknown): void {
  writeFileSync(path.join(casesDir, name), JSON.stringify(value, null, 2), "utf8");
}

function demoCase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "case-001",
    title: "Demo",
    repository: repoRelative,
    questions: [
      {
        id: "q1",
        question: `Which HTTP framework does this use? ${QUESTION_SENTINEL}`,
        field: "dependencies",
        expectedAnswer: `Express. ${ANSWER_SENTINEL}`,
        expectedKeywords: ["express"],
        expectedEvidence: ["package.json"],
      },
      {
        id: "q2",
        question: "Does it use Kafka?",
        field: "any",
        expectedAnswer: "No.",
        expectedKeywords: ["kafka"],
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  // Inside the working directory, because case files carry repository paths
  // relative to the project root.
  workspace = mkdtempSync(path.join(process.cwd(), "repo-arch-eval-"));
  const repo = path.join(workspace, "repo");
  casesDir = path.join(workspace, "cases");
  resultsDir = path.join(workspace, "results");
  mkdirSync(repo, { recursive: true });
  mkdirSync(casesDir, { recursive: true });
  repoRelative = path.relative(process.cwd(), repo).split(path.sep).join("/");

  writeFileSync(path.join(repo, "README.md"), "# demo\n\nA demo HTTP service.\n", "utf8");
  writeFileSync(path.join(repo, "package.json"), '{ "name": "demo", "dependencies": { "express": "^4.19.2" } }\n', "utf8");

  clock = Date.parse("2026-01-01T00:00:00.000Z");
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("runEvaluation", () => {
  it("scores every case and reports the primary metric", async () => {
    writeCase("case-001.json", demoCase());

    const { report } = await runEvaluation({ config, client: stubClient(), casesDir, resultsDir, now });

    expect(report.metrics.totalCases).toBe(1);
    expect(report.metrics.totalQuestions).toBe(2);
    expect(report.metrics.correctAnswers).toBe(1);
    expect(report.metrics.evidenceBackedAnswers).toBe(1);
    expect(report.metrics.evidenceBackedTaskAccuracy).toBeCloseTo(0.5, 4);
    expect(report.metrics.failedCases).toBe(0);
  });

  it("writes a machine-readable result and a human-readable summary", async () => {
    writeCase("case-001.json", demoCase());

    const output = await runEvaluation({ config, client: stubClient(), casesDir, resultsDir, now });

    expect(existsSync(output.jsonPath)).toBe(true);
    expect(existsSync(output.markdownPath)).toBe(true);
    // The written artefact must be the report, not a lossy rendering of it.
    expect(JSON.parse(readFileSync(output.jsonPath, "utf8"))).toEqual(output.report);
    expect(readFileSync(output.markdownPath, "utf8")).toBe(output.markdown);
    expect(output.markdown).toContain("Evidence-backed task accuracy");
  });

  it("also writes a stable latest-<system> pair, so tooling has one path to read", async () => {
    writeCase("case-001.json", demoCase());
    await runEvaluation({ config, client: stubClient(), casesDir, resultsDir, now });

    expect(existsSync(path.join(resultsDir, "latest-baseline.json"))).toBe(true);
    expect(existsSync(path.join(resultsDir, "latest-baseline.md"))).toBe(true);
  });

  it("is deterministic: the same inputs produce an identical report", async () => {
    writeCase("case-001.json", demoCase());

    const first = await runEvaluation({ config, client: stubClient(), casesDir, resultsDir, now });
    clock = Date.parse("2026-01-01T00:00:00.000Z");
    const second = await runEvaluation({ config, client: stubClient(), casesDir, resultsDir, now });

    expect(second.report).toEqual(first.report);
    expect(second.markdown).toBe(first.markdown);
  });

  it("never shows the analyzer the questions it is being scored on", async () => {
    writeCase("case-001.json", demoCase());
    const client = stubClient();

    await runEvaluation({ config, client, casesDir, resultsDir, now });

    expect(client.requests).toHaveLength(1);
    for (const request of client.requests) {
      expect(request.input).not.toContain(QUESTION_SENTINEL);
      expect(request.input).not.toContain(ANSWER_SENTINEL);
      expect(request.systemInstruction).not.toContain(QUESTION_SENTINEL);
    }
  });

  it("counts a case whose repository is missing as a failure, keeping the denominator", async () => {
    writeCase("case-001.json", demoCase());
    writeCase("case-002.json", demoCase({ id: "case-002", repository: "does/not/exist" }));

    const { report } = await runEvaluation({ config, client: stubClient(), casesDir, resultsDir, now });

    expect(report.metrics.failedCases).toBe(1);
    expect(report.metrics.totalCases).toBe(2);
    // Both cases' questions still count: 2 answered, 2 scored as zero.
    expect(report.metrics.totalQuestions).toBe(4);
    expect(report.metrics.evidenceBackedTaskAccuracy).toBeCloseTo(0.25, 4);
    expect(report.cases.find((entry) => entry.caseId === "case-002")?.error).toContain("does/not/exist");
    expect(report.caveats.join(" ")).toContain("failed to produce a briefing");
  });

  it("labels a mock run as pipeline verification rather than a measurement", async () => {
    writeCase("case-001.json", demoCase());

    const { report } = await runEvaluation({ config, client: stubClient(), casesDir, resultsDir, now });

    expect(report.caveats[0]).toContain("mock");
    expect(report.caveats[0]).toContain("not a measurement");
  });

  it("warns that a small dataset moves in large steps", async () => {
    writeCase("case-001.json", demoCase());

    const { report } = await runEvaluation({ config, client: stubClient(), casesDir, resultsDir, now });

    expect(report.caveats.join(" ")).toContain("dataset is small");
  });

  it("runs only the requested case ids", async () => {
    writeCase("case-001.json", demoCase());
    writeCase("case-002.json", demoCase({ id: "case-002" }));

    const { report } = await runEvaluation({
      config,
      client: stubClient(),
      casesDir,
      resultsDir,
      caseIds: ["case-002"],
      now,
    });

    expect(report.cases.map((entry) => entry.caseId)).toEqual(["case-002"]);
  });

  it("writes one run record per case when a trajectory directory is given", async () => {
    writeCase("case-001.json", demoCase());
    const trajectoryDir = path.join(workspace, "trajectories");

    const { report } = await runEvaluation({ config, client: stubClient(), casesDir, resultsDir, trajectoryDir, now });

    const runId = report.cases[0]?.runId ?? "";
    const record = JSON.parse(readFileSync(path.join(trajectoryDir, `${runId}.json`), "utf8"));
    expect(record.trajectory.map((step: { action: string }) => step.action)).toContain("ground-evidence");
  });

  it("records the metadata needed to reproduce the run", async () => {
    writeCase("case-001.json", demoCase());

    const { report } = await runEvaluation({ config, client: stubClient(), casesDir, resultsDir, now });

    expect(report.runId).toMatch(/^eval-baseline-/);
    expect(report.system).toBe("baseline");
    expect(report.provider).toBe("mock");
    expect(report.model).toBe("stub-v1");
    expect(report.seed).toBe(7);
    expect(report.thinkingLevel).toBe("low");
    expect(report.environment.nodeVersion).toBe(process.version);
  });

  it("reports progress through the supplied logger and nowhere else by default", async () => {
    writeCase("case-001.json", demoCase());
    const lines: string[] = [];

    await runEvaluation({ config, client: stubClient(), casesDir, resultsDir, now, logger: (line) => lines.push(line) });

    expect(lines[0]).toContain("1 case(s)");
    expect(lines.join("\n")).toContain("case-001");
    expect(lines.join("\n")).toContain("evidence-backed");
  });

  it("refuses to evaluate a system that does not exist yet", async () => {
    writeCase("case-001.json", demoCase());

    await expect(
      runEvaluation({ config, client: stubClient(), casesDir, resultsDir, now, system: "agent" }),
    ).rejects.toThrow(EvaluationError);
  });

  it("refuses to report a run with no cases", async () => {
    await expect(runEvaluation({ config, client: stubClient(), casesDir, resultsDir, now })).rejects.toThrow(
      /No evaluation cases found/,
    );
  });
});
