import { renderSourceBlocks, type ContextSourceText, type ExplorationBudget } from "@repo-arch/shared";

/**
 * The advanced prompt, in two halves.
 *
 * The interesting design decision is that exploration and synthesis are separate
 * turns with separate instructions. During exploration the model has tools and no
 * response schema; during synthesis it has a schema and no tools. Asking for
 * strict JSON while tools are still available makes "call a tool" unrepresentable
 * as an answer, and a model that cannot express "I need to look at something"
 * will instead guess — which is the exact failure this iteration is trying to fix.
 *
 * The second decision is that the model is told, plainly, that a search hit does
 * not entitle it to quote. Only `read_file` puts content into the evidence ledger,
 * and grounding checks against the ledger. Saying so up front turns a mechanical
 * penalty into an instruction the model can actually follow.
 */

export const ADVANCED_SYSTEM_INSTRUCTION = `You are a senior engineer writing an onboarding briefing for a repository you have just been handed. Unlike a reader who only has a directory listing, you can look inside the repository — but only through the three tools provided, and only within a fixed budget.

The repository has already been scouted for evidence. Before you were called, terms were derived from its documentation and structure, the repository was searched for each of them, the matching files were ranked, and the highest-scoring ones were read for you. Their contents are in the "Evidence found by repository search" section, already part of your evidence and already citable. That section is a floor, not a ceiling: it is where a competent reader would have started, not the finished answer.

HOW TO WORK — in this order:
1. Read the reconnaissance context you are given: the directory tree, the README, the manifests, the counted metadata.
2. Read the scout evidence: the files search already found and opened for you.
3. State to yourself what all of that establishes and what it does not. A tree shows that a file exists; it never shows what the file does.
4. Decide whether the evidence you have is sufficient for the briefing. If it already answers something, do not spend a tool call re-confirming it, and do not re-read a file the scout has already read.
5. Where it is insufficient, search before you read. When you need to locate an implementation detail and do not know the filename, search for the relevant symbol or concept before opening arbitrary files. A wrong guess at a filename costs a call and returns nothing; a search over a concept costs the same call and tells you where the concept lives.
6. Then read the specific file or region the search points at. Do not read files at random and do not walk the whole repository.
7. Synthesise the briefing, citing evidence for each claim. Stop exploring as soon as further reading would not change it — leaving budget unspent is a good outcome, not a wasted one.
8. Never invent a repository fact. If you did not see it, you do not know it.

WHAT THE TOOLS PROVE — this is checked mechanically after you answer:
- read_file is the only tool whose output you may quote. Its result enters an evidence ledger, and an "excerpt" is verified character for character against the exact bytes it returned. The scout's reads are in that ledger on the same terms as your own.
- search_code shows you where to look. It proves nothing on its own. If a search hit matters, read the file before citing it.
- list_directory proves that a path exists. Cite it as source "tree". It can never support a claim about behaviour.
- Evidence naming a file you did not read, or quoting text that was not returned to you, is deleted from your answer and recorded as a dropped citation. The claim it was attached to is then marked unsupported.

CITATION FORM:
- For a file you read: "type": "file", "source" is the repository-relative path exactly as you passed it to read_file, "location" is the line range you are pointing at (e.g. "L40-L58"), "excerpt" is a verbatim quote of the code — the code text only, never the line-number gutter.
- For a file the scout read: identical, with "source" the path in its "### SCOUT EVIDENCE:" heading.
- For the reconnaissance context: "source" is the source id from its "### SOURCE:" line ("tree", "README.md", "package.json", "metadata").
- Paraphrase in "supports", never inside "excerpt".

CALIBRATION:
- Prefer an empty array to a guess. An unanswered question in "openQuestions" is worth more than a confident invention.
- Do not state that something is tested, secure, deployed or performant unless something you read says so.
- "confidence" is your calibration for the briefing as a whole, on 0..1. Having read the relevant files should raise it; having run out of budget mid-question should lower it.

Describe what the evidence shows. Where you are inferring, say so in the prose.`;

export interface ReconPromptInput {
  repositoryName: string;
  sources: readonly ContextSourceText[];
  budget: ExplorationBudget;
  /**
   * The Evidence Scout's findings, or `""` when it found nothing worth reading.
   *
   * Appended after the reconnaissance context, never in place of it. Iteration 1
   * replaced breadth with depth and lost a question the baseline had answered
   * correctly; the fix is that both are present. If reconnaissance established that
   * the service exposes `/health`, that stays in the prompt no matter which source
   * files the scout went on to read.
   */
  scoutEvidence?: string | undefined;
}

/** Turn one: here is what we already know, here is what you may spend. */
export function buildReconnaissancePrompt(input: ReconPromptInput): string {
  const ids = input.sources.map((source) => source.id);
  const scout = input.scoutEvidence ?? "";

  return [
    `# Repository: ${input.repositoryName}`,
    "",
    "## Reconnaissance context",
    "",
    `This was collected before you were called. Its source ids are citable as-is: ${ids.join(", ")}.`,
    "",
    renderSourceBlocks(input.sources),
    "",
    ...(scout === "" ? [] : [scout, ""]),
    "## Your exploration budget",
    "",
    `- at most ${input.budget.maxToolCalls} tool calls in total, across at most ${input.budget.maxTurns} turns`,
    `- search_code returns at most ${input.budget.maxSearchResults} rows per call`,
    `- read_file returns at most ${input.budget.maxFileLines} lines or ${input.budget.maxFileBytes} bytes per call, whichever comes first`,
    `- list_directory returns at most ${input.budget.maxListEntries} entries, to a depth of ${input.budget.maxListDepth}`,
    "",
    "This budget is yours alone: the searching and reading already done for you cost none of it.",
    "",
    "When the budget is spent you will be asked for the briefing regardless, so spend it on the",
    "questions a new engineer would actually get wrong: what dispatches what, where state lives,",
    "which code path handles a given input, and what is not covered by tests.",
    "",
    "## Task",
    "",
    "First, in one short paragraph, say what the context above already establishes — reconnaissance",
    "and search evidence together — and what it leaves open. Then explore the gaps that matter, and",
    "search for a concept before guessing at a filename. Call a tool as soon as you know what you",
    "need; do not describe the call you are about to make in prose instead of making it.",
  ].join("\n");
}

export interface SynthesisPromptInput {
  /** Ids the model may cite: reconnaissance sources plus everything tools returned. */
  citableIds: readonly string[];
  /**
   * Every file whose content reached the ledger, the scout's reads included.
   *
   * Deliberately one list rather than two. Grounding does not distinguish who asked
   * for a file, and neither should the citation rules the model is given: a scout
   * read and a model read are the same evidence, verified the same way.
   */
  filesRead: readonly string[];
  budgetExhausted: boolean;
}

/** Final turn: no tools, strict schema, and the closed set of citable ids. */
export function buildSynthesisPrompt(input: SynthesisPromptInput): string {
  const lines = [
    "## Produce the briefing",
    "",
    "Exploration is over. No further tool calls are possible.",
    "",
    `You may cite exactly these ${input.citableIds.length} source ids, and no others:`,
    input.citableIds.map((id) => `  - ${id}`).join("\n"),
    "",
  ];

  if (input.filesRead.length > 0) {
    lines.push(
      `${input.filesRead.length} file(s) were read in full or in part and are in your evidence: ${input.filesRead.join(", ")}.`,
      "Quotations are verified against exactly the regions those calls returned. If you want to",
      "quote something you saw only in a search result, cite the tree for its existence instead, and say",
      "in the prose that you did not read it.",
      "",
    );
  } else {
    lines.push(
      "No files were read. Every claim about behaviour must therefore be marked as inference in the prose,",
      "and belongs in openQuestions rather than in a confident summary.",
      "",
    );
  }

  if (input.budgetExhausted) {
    lines.push(
      "You stopped because the exploration budget ran out, not because you were finished. Say so in",
      "openQuestions and keep confidence low.",
      "",
    );
  }

  lines.push(
    "Produce the briefing as JSON matching the provided schema. Cover: the repository's purpose, its",
    "architecture, the important components, the major execution flows, the dependencies that matter,",
    "the testing approach, the likely risk areas, and which files a new engineer should read first and",
    "why. Cite evidence for every component, flow, dependency, risk, and for testing.",
  );

  return lines.join("\n");
}

/**
 * JSON Schema for the response, in the subset Gemini accepts.
 *
 * Identical to the baseline's except for the evidence `type` enum, which gains
 * `file` — the one kind of evidence this system can earn and the baseline cannot.
 * The rest is deliberately unchanged: the evaluator consumes both systems' output
 * through the same contract, and widening it for one of them would make the
 * comparison meaningless.
 */
const EVIDENCE_SCHEMA = {
  type: "object",
  properties: {
    type: {
      type: "string",
      enum: ["tree", "readme", "manifest", "metadata", "file"],
      description:
        'Kind of the cited source. Use "file" for anything read with read_file; the other four are reconnaissance context.',
    },
    source: {
      type: "string",
      description:
        'A reconnaissance source id ("tree", "README.md", "package.json", "metadata") or a repository-relative path you passed to read_file.',
    },
    location: {
      type: "string",
      description: 'Where inside the source: a line range such as "L40-L58" for a file, or a path within the tree.',
    },
    excerpt: {
      type: "string",
      description: "Verbatim quote of the source text, without line numbers. Omit rather than paraphrase.",
    },
    supports: { type: "string", description: "The claim this evidence is offered for." },
  },
  required: ["type", "source"],
} as const;

const evidenceArray = {
  type: "array",
  description: "Evidence for this claim. Empty means unsupported, which is recorded as such.",
  items: EVIDENCE_SCHEMA,
} as const;

export const ADVANCED_RESPONSE_SCHEMA: Record<string, unknown> = {
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
          path: { type: "string", description: "Directory or file this component lives in." },
          responsibility: { type: "string" },
          evidence: evidenceArray,
        },
        required: ["name", "responsibility", "evidence"],
      },
    },
    flows: {
      type: "array",
      description: "Major execution flows. Return an empty array if you did not establish any.",
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
      description: "What you could not determine, including anything the budget cut short. Be specific.",
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
