import { renderSourceBlocks, type ContextSourceText } from "@repo-arch/shared";

/**
 * The baseline prompt.
 *
 * Two properties matter, and both are constraints rather than encouragements:
 *
 *  1. The model is told the exact, closed set of source ids it may cite. Anything
 *     else is dropped by grounding, so inventing a path costs the run evidence
 *     rather than earning it.
 *  2. The model is told to leave sections empty when the context does not support
 *     them. A shallow-context system that admits it cannot see execution flows is
 *     more useful than one that guesses at them.
 */

export const BASELINE_SYSTEM_INSTRUCTION = `You are a senior engineer writing an onboarding briefing for a repository you have just been handed.

You will receive a small, fixed set of context sources: a directory tree, a README (if the repository has one), root package manifests (if present), and counted metadata. That is all you get. You cannot read source files, run commands, or inspect git history.

EVIDENCE RULES — these are checked mechanically after you answer:
- Every evidence item's "source" MUST be exactly one of the source ids listed in the context. Ids are given on each "### SOURCE:" line.
- Never cite a file you were not given, even if you are confident it exists. Citing "src/server.js" when you only saw it in the tree is wrong; cite "tree" and put the path in "location".
- "excerpt" must be text copied verbatim from that source. Do not paraphrase inside an excerpt. Omit it if you have nothing to quote.
- Evidence with an unrecognised source, or an excerpt that does not appear in the source, is deleted from your answer and recorded as a fabrication.

CALIBRATION RULES:
- Prefer an empty array to a guess. If the context does not show execution flows, return "flows": [].
- Do not state that something is tested, secure, deployed, or performant unless a source says so.
- Put everything you could not determine into "openQuestions". This is a valued field, not a failure.
- "confidence" is your own calibration for the briefing as a whole, on 0..1. Shallow context should produce a low number.

Describe what the evidence shows. Where you are inferring, say so in the prose.`;

export interface BaselinePromptInput {
  repositoryName: string;
  sources: readonly ContextSourceText[];
}

export function buildBaselinePrompt(input: BaselinePromptInput): string {
  const ids = input.sources.map((source) => source.id);

  return [
    `# Repository: ${input.repositoryName}`,
    "",
    `You may cite exactly these ${ids.length} source ids, and no others:`,
    ids.map((id) => `  - ${id}`).join("\n"),
    "",
    "## Context",
    "",
    renderSourceBlocks(input.sources),
    "",
    "## Task",
    "",
    "Produce the briefing as JSON matching the provided schema. Cover: the repository's purpose,",
    "its architecture, the important components, the major execution flows, the dependencies that",
    "matter, the testing approach, the likely risk areas, and which files a new engineer should read",
    "first and why. Cite evidence for every component, flow, dependency, risk, and for testing.",
  ].join("\n");
}

/**
 * JSON Schema for the response, in the subset Gemini accepts.
 *
 * Written by hand and kept beside the prompt rather than generated from Zod: the
 * two dialects drift, and a silent schema mismatch is much harder to debug than
 * a duplicated field list. `test/schema-parity.test.ts` asserts the two agree.
 */
const EVIDENCE_SCHEMA = {
  type: "object",
  properties: {
    type: {
      type: "string",
      enum: ["tree", "readme", "manifest", "metadata"],
      description: "Kind of the cited source. Only these four exist in this system's context.",
    },
    source: {
      type: "string",
      description: 'One of the listed source ids, verbatim (e.g. "tree", "README.md", "package.json").',
    },
    location: {
      type: "string",
      description: 'Where inside the source (e.g. "src/routes/orders.js" within the tree, or a JSON key path).',
    },
    excerpt: { type: "string", description: "Verbatim quote from the source. Omit rather than paraphrase." },
    supports: { type: "string", description: "The claim this evidence is offered for." },
  },
  required: ["type", "source"],
} as const;

const evidenceArray = {
  type: "array",
  description: "Evidence for this claim. Empty means unsupported, which is recorded as such.",
  items: EVIDENCE_SCHEMA,
} as const;

export const ANALYSIS_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    summary: { type: "string", description: "What this repository is and what it does, in 2-4 sentences." },
    architecture: { type: "string", description: "How the pieces fit together, and the style of the system." },
    components: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          path: { type: "string", description: "Directory or file, if the tree shows one." },
          responsibility: { type: "string" },
          evidence: evidenceArray,
        },
        required: ["name", "responsibility", "evidence"],
      },
    },
    flows: {
      type: "array",
      description: "Major execution flows. Return an empty array if the context does not show any.",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          steps: { type: "array", items: { type: "string" } },
          evidence: evidenceArray,
        },
        required: ["name", "description", "evidence"],
      },
    },
    dependencies: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          version: { type: "string" },
          scope: { type: "string", enum: ["runtime", "dev", "peer", "optional", "unknown"] },
          purpose: { type: "string", description: "What this project uses it for." },
          evidence: evidenceArray,
        },
        required: ["name", "scope", "evidence"],
      },
    },
    testing: {
      type: "object",
      properties: {
        approach: { type: "string", description: 'What testing exists. "No test suite is visible" is a valid answer.' },
        frameworks: { type: "array", items: { type: "string" } },
        testPaths: { type: "array", items: { type: "string" } },
        gaps: { type: "array", items: { type: "string" } },
        evidence: evidenceArray,
      },
      required: ["approach", "evidence"],
    },
    risks: {
      type: "array",
      description: "Areas where a change is most likely to break something.",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          severity: { type: "string", enum: ["low", "medium", "high"] },
          evidence: evidenceArray,
        },
        required: ["title", "description", "severity", "evidence"],
      },
    },
    recommendedReading: {
      type: "array",
      description: "Files to read first, in order.",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          reason: { type: "string" },
          order: { type: "integer", minimum: 1 },
        },
        required: ["path", "reason", "order"],
      },
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    evidence: {
      type: "array",
      description: "Evidence for claims in summary or architecture that do not belong to one section.",
      items: EVIDENCE_SCHEMA,
    },
    openQuestions: {
      type: "array",
      description: "What you could not determine from this context. Be specific.",
      items: { type: "string" },
    },
  },
  required: [
    "summary",
    "architecture",
    "components",
    "flows",
    "dependencies",
    "testing",
    "risks",
    "recommendedReading",
    "confidence",
    "evidence",
    "openQuestions",
  ],
};
