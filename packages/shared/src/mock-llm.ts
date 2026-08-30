import type { AnalysisConfig } from "./config";
import { parseSourceBlocks, type ContextSourceText } from "./context-format";
import type { LlmClient, StructuredRequest, StructuredResponse } from "./llm";
import type { AnalysisBody, Component, Dependency, Evidence } from "./schemas";

/**
 * A deterministic, offline, zero-cost provider.
 *
 * Purpose: prove the pipeline end-to-end (context collection -> prompt ->
 * parse -> validate -> ground -> score -> report) without an API key, and give
 * the unit tests a stable model.
 *
 * It is NOT a system under evaluation. It reads only the rendered prompt — the
 * same bytes a real model receives — and reports what it can literally see, so
 * its scores are a floor, not a result. Reports label mock runs explicitly.
 */
export function createMockLlmClient(config: AnalysisConfig): LlmClient {
  return {
    provider: "mock",
    model: config.model,
    generateStructured(request: StructuredRequest): Promise<StructuredResponse> {
      const body = buildMockBody(request.input);
      const text = JSON.stringify(body);
      return Promise.resolve({
        text,
        model: config.model,
        // A mock spends no tokens. Reporting real character counts here would
        // fabricate usage, so usage stays zero and cost stays zero.
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      });
    },
  };
}

function buildMockBody(prompt: string): AnalysisBody {
  const sources = parseSourceBlocks(prompt);
  const byId = new Map(sources.map((source) => [source.id, source]));
  const tree = byId.get("tree");
  const readme = sources.find((source) => source.type === "readme");
  const manifest = sources.find((source) => source.type === "manifest");

  const topLevelDirectories = tree ? extractTopLevelDirectories(tree.text) : [];
  const treeEvidence = (location?: string): Evidence[] =>
    tree ? [{ type: "tree", source: tree.id, ...(location === undefined ? {} : { location }) }] : [];

  const components: Component[] = topLevelDirectories.map((directory) => ({
    name: directory,
    path: `${directory}/`,
    responsibility: `Top-level directory present in the repository tree. Its role was not confirmed by reading any source file.`,
    evidence: treeEvidence(directory),
  }));

  const dependencies: Dependency[] = manifest ? extractDependencies(manifest) : [];

  const testPaths = tree ? extractTestPaths(tree.text) : [];

  return {
    summary: readme
      ? `Repository with a ${readme.id} and ${topLevelDirectories.length} top-level source directories. Summary derived from directory listing and readme text only.`
      : `Repository with ${topLevelDirectories.length} top-level source directories and no readme in the root. Summary derived from the directory listing only.`,
    architecture:
      topLevelDirectories.length > 0
        ? `Directory-level structure only: ${topLevelDirectories.join(", ")}. No source file was read, so module boundaries and call direction are unverified.`
        : "No top-level source directories were visible in the collected tree.",
    components,
    // A shallow context cannot establish an execution flow. Claiming one would
    // be exactly the failure mode this project exists to measure.
    flows: [],
    dependencies,
    testing: {
      approach:
        testPaths.length > 0
          ? "Test files are present in the tree. No test was executed and no coverage was measured."
          : "No test directory or test file was visible in the collected tree.",
      frameworks: [],
      testPaths,
      gaps: ["No test was executed, so pass/fail state and coverage are unknown."],
      evidence: treeEvidence(testPaths[0]),
    },
    risks: [
      {
        title: "Briefing rests on shallow context",
        description:
          "This analysis saw a directory listing, a readme and a manifest. Behaviour, history and test outcomes were not inspected, so risk ranking is not evidence-backed.",
        severity: "medium",
        evidence: byId.has("metadata") ? [{ type: "metadata", source: "metadata" }] : [],
      },
    ],
    recommendedReading: buildRecommendedReading(readme, manifest, topLevelDirectories),
    confidence: 0.3,
    evidence: sources.map((source) => ({ type: source.type, source: source.id })),
    openQuestions: [
      "Which module handles each externally triggered request, and in what order?",
      "Which components change most often, and which changes were bug fixes?",
      "Do the existing tests pass, and what do they actually cover?",
    ],
  };
}

function extractTopLevelDirectories(tree: string): string[] {
  const directories: string[] = [];
  for (const line of tree.split("\n")) {
    // Top-level entries are unindented in the rendered tree; directories end in "/".
    if (/^\S.*\/$/.test(line)) directories.push(line.trim().replace(/\/$/, ""));
  }
  return directories.slice(0, 12);
}

function extractTestPaths(tree: string): string[] {
  const paths: string[] = [];
  for (const rawLine of tree.split("\n")) {
    const line = rawLine.trim();
    if (/^(tests?|__tests__|spec)\/$/.test(line) || /\.(test|spec)\.[a-z]+$/.test(line) || /^test_.*\.py$/.test(line)) {
      paths.push(line);
    }
  }
  return [...new Set(paths)].slice(0, 8);
}

function extractDependencies(manifest: ContextSourceText): Dependency[] {
  const names = new Map<string, "runtime" | "dev">();

  if (manifest.id.endsWith(".json")) {
    try {
      const parsed = JSON.parse(manifest.text) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      for (const name of Object.keys(parsed.dependencies ?? {})) names.set(name, "runtime");
      for (const name of Object.keys(parsed.devDependencies ?? {})) names.set(name, "dev");
    } catch {
      // Truncated manifest; fall through to zero dependencies rather than guess.
    }
  } else {
    // pyproject.toml / requirements.txt style: pick obvious `name = "..."` or bare requirement lines.
    for (const line of manifest.text.split("\n")) {
      const dependency = /^\s*"?([A-Za-z][\w.-]{1,40})"?\s*(?:[><=~^]=?|,|$)/.exec(line.trim());
      if (dependency?.[1] && !/^(name|version|description|requires|python|authors|readme|dependencies)$/i.test(dependency[1])) {
        names.set(dependency[1], "runtime");
      }
    }
  }

  return [...names.entries()].slice(0, 20).map(([name, scope]) => ({
    name,
    scope,
    evidence: [{ type: "manifest" as const, source: manifest.id }],
  }));
}

function buildRecommendedReading(
  readme: ContextSourceText | undefined,
  manifest: ContextSourceText | undefined,
  directories: readonly string[],
): AnalysisBody["recommendedReading"] {
  const reading: AnalysisBody["recommendedReading"] = [];
  let order = 1;
  if (readme) reading.push({ path: readme.id, reason: "Project-authored overview.", order: order++ });
  if (manifest) reading.push({ path: manifest.id, reason: "Declared dependencies and scripts.", order: order++ });
  for (const directory of directories.slice(0, 3)) {
    reading.push({ path: `${directory}/`, reason: "Top-level directory seen in the tree.", order: order++ });
  }
  return reading;
}
