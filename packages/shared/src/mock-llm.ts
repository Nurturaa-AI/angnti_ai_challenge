import type { AnalysisConfig } from "./config";
import { parseSourceBlocks, type ContextSourceText } from "./context-format";
import type {
  ConversationStep,
  LlmClient,
  StructuredRequest,
  StructuredResponse,
  ToolTurnRequest,
  ToolTurnResponse,
} from "./llm";
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
  const noUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

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

    generateWithTools(request: ToolTurnRequest): Promise<ToolTurnResponse> {
      // A schema on the request means exploration is over and a briefing is due.
      if (request.schema) {
        const body = buildMockBodyFromConversation(request.steps);
        return Promise.resolve({
          text: JSON.stringify(body),
          toolCalls: [],
          providerSteps: [],
          model: config.model,
          usage: noUsage,
        });
      }

      const next = nextMockToolCall(request.steps);
      return Promise.resolve({
        text: next ? "" : "Exploration complete: I have read enough to answer.",
        toolCalls: next ? [next] : [],
        // A mock has no provider-side continuation token to echo back.
        providerSteps: [],
        model: config.model,
        usage: noUsage,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Offline tool trajectory
// ---------------------------------------------------------------------------

/**
 * A fixed three-call itinerary: list the tree, search it, then read a file it
 * found. It exercises every tool, the argument path, the ledger and the grounding
 * of tool-derived evidence — the whole orchestration — with no API key.
 *
 * The plan is driven by the conversation history rather than by a counter held in
 * a closure, so the agent loop and the mock cannot fall out of step, and a replay
 * of the same history always produces the same next call.
 */
function nextMockToolCall(
  steps: readonly ConversationStep[],
): { id: string; name: string; arguments: Record<string, unknown> } | null {
  const results = steps.filter((step) => step.kind === "toolResult");
  const id = `mock-call-${results.length + 1}`;

  if (results.length === 0) return { id, name: "list_directory", arguments: { path: "", depth: 2 } };
  // "import" appears in essentially every codebase, so the search returns real
  // hits without the mock needing to understand the repository.
  if (results.length === 1) return { id, name: "search_code", arguments: { query: "import", maxResults: 10 } };
  if (results.length === 2) {
    const path = pickFileToRead(steps);
    if (path) return { id, name: "read_file", arguments: { path, endLine: 60 } };
  }
  return null;
}

const CODE_EXTENSIONS = [".ts", ".js", ".py", ".go", ".rb", ".java", ".rs"];
const READABLE_EXTENSIONS = [...CODE_EXTENSIONS, ".md", ".json", ".toml", ".yaml"];

/** Picks a file from the `list_directory` output already in the conversation. */
function pickFileToRead(steps: readonly ConversationStep[]): string | null {
  const listing = steps.find((step) => step.kind === "toolResult" && step.name === "list_directory");
  if (listing?.kind !== "toolResult") return null;

  // The listing is indented; reconstruct each entry's full path from the indent depth.
  const stack: string[] = [];
  const candidates: string[] = [];

  for (const line of listing.output.split("\n").slice(1)) {
    const indentMatch = /^(\s*)(\S.*)$/.exec(line);
    if (!indentMatch?.[1] || indentMatch[2] === undefined) {
      // Depth-zero entry, or a blank/header line.
      const flat = /^(\S.*)$/.exec(line);
      if (!flat?.[1]) continue;
      stack.length = 0;
      recordEntry(flat[1], stack, candidates);
      continue;
    }
    const depth = Math.floor(indentMatch[1].length / 2);
    stack.length = depth;
    recordEntry(indentMatch[2], stack, candidates);
  }

  // Preference order matters for what the mock trajectory actually proves. A nested
  // source file is not part of the reconnaissance context, so reading one exercises
  // the case the real system exists for: the evidence ledger growing to hold
  // something the shallow pass could not have seen. Falling back to a top-level
  // README would only re-cite what was already in the prompt.
  const hasExtension = (candidate: string, extensions: readonly string[]): boolean =>
    extensions.some((extension) => candidate.endsWith(extension));

  return (
    candidates.find((candidate) => candidate.includes("/") && hasExtension(candidate, CODE_EXTENSIONS)) ??
    candidates.find((candidate) => hasExtension(candidate, CODE_EXTENSIONS)) ??
    candidates.find((candidate) => hasExtension(candidate, READABLE_EXTENSIONS)) ??
    candidates[0] ??
    null
  );
}

function recordEntry(entry: string, stack: string[], candidates: string[]): void {
  if (entry.endsWith("/")) {
    stack.push(entry.slice(0, -1));
    return;
  }
  const fileMatch = /^(.+?) \(\d+ bytes\)$/.exec(entry);
  if (!fileMatch?.[1]) return;
  candidates.push([...stack, fileMatch[1]].join("/"));
}

/**
 * Builds a briefing from the exploration transcript.
 *
 * Two kinds of file evidence are cited, because there are two ways a file reaches
 * the ledger and both need exercising offline: what the scout read before the first
 * turn, and what the model read during exploration. The excerpt in each case is
 * taken from the `read_file` output with the line-number gutter stripped, which is
 * exactly what a real model does when it quotes code — and it is what the ledger can
 * verify, because the ledger holds the raw slice without the gutter.
 */
function buildMockBodyFromConversation(steps: readonly ConversationStep[]): AnalysisBody {
  const firstUser = steps.find((step) => step.kind === "user");
  const promptText = firstUser?.kind === "user" ? firstUser.text : "";
  const body = buildMockBody(promptText);

  const cited: Evidence[] = [];
  const components: Component[] = [];

  // The scout's reads, quoted from the prompt section they arrived in. A real model
  // sees them exactly here, so citing them from here is the same act — and if the
  // section were ever rendered in a form grounding could not verify, this is the
  // test that would fail.
  for (const block of parseScoutEvidenceBlocks(promptText)) {
    const parsed = parseReadFileOutput(block.output);
    if (!parsed) continue;
    const evidence: Evidence = {
      type: "file",
      source: parsed.path,
      location: parsed.location,
      excerpt: parsed.excerpt,
      supports: `Content of ${parsed.path}, found by searching for ${block.matched} and read before the first turn.`,
    };
    cited.push(evidence);
    components.push({
      name: parsed.path,
      path: parsed.path,
      responsibility: `Located by repository search on ${block.matched}, then read. Its contents were returned by read_file, not inferred.`,
      evidence: [evidence],
    });
  }

  const read = steps.filter((step) => step.kind === "toolResult" && step.name === "read_file" && !step.isError);
  const latest = read.at(-1);
  if (latest?.kind === "toolResult") {
    const parsed = parseReadFileOutput(latest.output);
    if (parsed) {
      const evidence: Evidence = {
        type: "file",
        source: parsed.path,
        location: parsed.location,
        excerpt: parsed.excerpt,
        supports: `Content of ${parsed.path}, read during exploration.`,
      };
      cited.push(evidence);
      components.push({
        name: parsed.path,
        path: parsed.path,
        responsibility: "File read during exploration. Its contents were returned by read_file, not inferred.",
        evidence: [evidence],
      });
    }
  }

  if (cited.length === 0) return body;

  const paths = [...new Set(components.map((component) => component.path ?? component.name))];
  return {
    ...body,
    summary: `${body.summary} ${paths.length} file(s) were read directly: ${paths.join(", ")}.`,
    components: [...body.components, ...components],
    evidence: [...body.evidence, ...cited],
    confidence: 0.4,
  };
}

/** One `### SCOUT EVIDENCE:` block from the reconnaissance prompt. */
interface ScoutEvidenceBlock {
  path: string;
  matched: string;
  /** The `read_file` output the block wraps, verbatim. */
  output: string;
}

/**
 * Reads the scout's prompt section back into blocks.
 *
 * The mock parses the rendered text rather than being handed the scout's structured
 * result, deliberately: it must only be able to see what a real model sees. If the
 * heading format and this parser ever disagree, that is a real defect — the model
 * would have no way to name the file it is citing — and the mock is where it shows up.
 */
function parseScoutEvidenceBlocks(prompt: string): ScoutEvidenceBlock[] {
  const blocks: ScoutEvidenceBlock[] = [];
  const lines = prompt.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const header = /^### SCOUT EVIDENCE: (\S+) \(matched: (.*)\)$/.exec(lines[index] ?? "");
    if (!header?.[1]) continue;
    const body: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (line === undefined || line === "### END SCOUT EVIDENCE") break;
      body.push(line);
    }
    blocks.push({ path: header[1], matched: header[2] ?? "", output: body.join("\n") });
  }

  return blocks;
}

interface ParsedReadFile {
  path: string;
  location: string;
  excerpt: string;
}

function parseReadFileOutput(output: string): ParsedReadFile | null {
  const lines = output.split("\n");
  const header = /^(\S+) — lines (\d+)-(\d+) of \d+/.exec(lines[0] ?? "");
  if (!header?.[1] || !header[2] || !header[3]) return null;

  // Pick the first substantial numbered line: grounding needs 8+ characters to
  // treat an excerpt as verifiable, so a lone brace would prove nothing.
  for (const line of lines.slice(1)) {
    const gutter = /^\s*(\d+) \| (.*)$/.exec(line);
    const text = gutter?.[2]?.trim();
    if (!gutter?.[1] || text === undefined || text.length < 12) continue;
    return { path: header[1], location: `L${gutter[1]}`, excerpt: text };
  }
  return null;
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
