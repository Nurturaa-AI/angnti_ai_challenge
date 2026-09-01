import { renderSourceBlocks, type ContextSourceText, type ExplorationBudget } from "@repo-arch/shared";

/**
 * The question prompt, in the same two halves as the briefing prompt: an
 * exploration turn with tools and no schema, then one answer turn with a schema
 * and no tools.
 *
 * The reason is the reason it was right there. A response format makes "call a
 * tool" unrepresentable, so a model that still needs to look at something has no
 * way to say so and will answer from memory instead — which for a question about
 * a specific repository means inventing a plausible file.
 *
 * What is different here is the closed evidence set. A briefing is written from
 * everything the run gathered; an answer is written from what *this question*
 * inspected: the reconnaissance context, the files the scout found for it, and
 * whatever the model read on its own turns. Earlier answers are replayed as
 * conversation so a follow-up can be understood, and they are labelled in the
 * prompt as what they are — statements, not evidence. Nothing in them is citable,
 * because a system that lets its own previous output authorise a citation has
 * stopped checking anything.
 */

export const QUESTION_SYSTEM_INSTRUCTION = `You are a senior engineer answering a specific question about a repository you have been given access to. You answer from evidence you can point at, or you say you could not establish it.

WHAT YOU HAVE:
- Reconnaissance context: the directory tree, the README, the manifests, counted metadata. Their text is in the prompt.
- Search evidence: the repository was searched for terms derived from the question, the matching files were ranked, and the best few were read for you. Their text is in the prompt.
- Three read-only tools, within a small budget, for anything else the question needs.

HOW TO WORK — in this order:
1. Read the question and decide precisely what would settle it. "Where is X handled?" is settled by finding the code that handles it, not by finding the word X.
2. Check what the context already establishes. If it answers the question, do not spend a tool call re-confirming it.
3. Where it does not, search for the concept before guessing at a filename, then read the specific region the search points at.
4. Answer in prose, and attach a citation to every factual claim about this repository.
5. If the evidence does not settle the question, set "sufficient" to false. Say what you did establish and what is missing. This is a correct outcome, not a failure.

WHAT THE TOOLS PROVE — this is checked mechanically after you answer:
- read_file is the only tool whose output you may quote. Its result enters an evidence ledger, and an "excerpt" is verified character for character against the exact bytes it returned. The search evidence already in the prompt is in that ledger on the same terms.
- search_code shows you where to look. It proves nothing on its own. Read a file before citing it.
- list_directory proves that a path exists. Cite it as source "tree". It can never support a claim about behaviour.
- A citation naming something you did not inspect, or quoting text that was not returned to you, is deleted. If every citation on your answer is deleted, your answer is replaced with a statement that nothing could be verified — so a confident answer with invented evidence is strictly worse than an honest "I could not establish this".

CONVERSATION HISTORY IS NOT EVIDENCE:
- Earlier questions and answers in this conversation are context for understanding what is being asked. They are not evidence and must never be cited.
- If an earlier answer stated a fact and you want to rely on it, establish it again from the repository. A previous answer of yours cannot make something true.

CITATION FORM:
- For a file: "type": "file", "source" is the repository-relative path exactly as it appears in the read_file output or the "### SCOUT EVIDENCE:" heading, "location" is the line range you are pointing at (e.g. "L40-L58"), "excerpt" is a verbatim quote of the code — the code text only, never the line-number gutter.
- For the reconnaissance context: "source" is the source id from its "### SOURCE:" line ("tree", "README.md", "package.json", "metadata").
- Put your paraphrase in "supports", never inside "excerpt".

Answer the question that was asked, at the length it deserves. Where you are inferring rather than reporting, say so in the answer.`;

export interface QuestionPromptInput {
  question: string;
  repositoryName: string;
  /** Reconnaissance artefacts. Rendered in full: the model may only cite what it can read. */
  sources: readonly ContextSourceText[];
  /** The scout's findings for this question, or `""` when it found nothing. */
  scoutEvidence: string;
  budget: ExplorationBudget;
  /** Earlier turns of this conversation, oldest first. Context only. */
  history: readonly { question: string; answer: string }[];
}

/** Turn one: the question, everything already inspected for it, and the budget. */
export function buildQuestionPrompt(input: QuestionPromptInput): string {
  const ids = input.sources.map((source) => source.id);
  const lines = [`# Repository: ${input.repositoryName}`, ""];

  if (input.history.length > 0) {
    lines.push(
      "## Earlier in this conversation",
      "",
      "Context for understanding the question below. These are statements, not evidence:" +
        " nothing here is citable, and any fact you want to rely on must be established again" +
        " from the repository.",
      "",
      ...input.history.flatMap((turn, index) => [
        `${index + 1}. Q: ${turn.question}`,
        `   A: ${turn.answer}`,
        "",
      ]),
    );
  }

  lines.push(
    "## The question",
    "",
    input.question,
    "",
    "## Reconnaissance context",
    "",
    `Collected before the question was asked. These source ids are citable as-is: ${ids.join(", ")}.`,
    "",
    renderSourceBlocks(input.sources),
    "",
  );

  if (input.scoutEvidence !== "") lines.push(input.scoutEvidence, "");

  lines.push(
    "## Your exploration budget",
    "",
    `- at most ${input.budget.maxToolCalls} tool calls in total, across at most ${input.budget.maxTurns} turns`,
    `- search_code returns at most ${input.budget.maxSearchResults} rows per call`,
    `- read_file returns at most ${input.budget.maxFileLines} lines or ${input.budget.maxFileBytes} bytes per call`,
    `- list_directory returns at most ${input.budget.maxListEntries} entries, to a depth of ${input.budget.maxListDepth}`,
    "",
    "This is a question, not a survey: spend the budget on what would settle it and stop. Leaving",
    "budget unspent is a good outcome. Call a tool as soon as you know what you need; do not",
    "describe the call you are about to make in prose instead of making it.",
  );

  return lines.join("\n");
}

export interface AnswerPromptInput {
  question: string;
  /** The closed set of source ids this question inspected. */
  citableIds: readonly string[];
  /** Files whose contents reached this question's ledger. */
  filesRead: readonly string[];
  budgetExhausted: boolean;
}

/** Final turn: no tools, strict schema, and the closed set of citable ids. */
export function buildAnswerPrompt(input: AnswerPromptInput): string {
  const lines = [
    "## Answer the question",
    "",
    "Exploration is over. No further tool calls are possible.",
    "",
    `The question was: ${input.question}`,
    "",
    `You may cite exactly these ${input.citableIds.length} source ids, and no others:`,
    input.citableIds.map((id) => `  - ${id}`).join("\n"),
    "",
  ];

  if (input.filesRead.length > 0) {
    lines.push(
      `${input.filesRead.length} file(s) were read in full or in part: ${input.filesRead.join(", ")}.`,
      "Quotations are verified against exactly the regions those reads returned.",
      "",
    );
  } else {
    lines.push(
      "No file was read while answering this question. You have the reconnaissance context and",
      "nothing more, so any claim about behaviour is an inference and must be marked as one —",
      'and if the question was about behaviour, "sufficient" is false.',
      "",
    );
  }

  if (input.budgetExhausted) {
    lines.push(
      "You stopped because the budget ran out, not because you were finished. Weigh that in",
      '"sufficient" and in "confidence".',
      "",
    );
  }

  lines.push(
    "Produce the answer as JSON matching the provided schema. Attach a citation to every factual",
    'claim about this repository. If the evidence does not settle the question, set "sufficient" to',
    "false and say what is missing — an honest gap is worth more than a confident guess.",
  );

  return lines.join("\n");
}

/**
 * JSON Schema for the answer, in the subset Gemini accepts.
 *
 * The citation object is the briefing's, field for field. That is not laziness: a
 * citation is verified by the same grounding code either way, so describing it
 * differently here could only teach the model a form the verifier does not accept.
 *
 * `grounded` is deliberately absent, as it is in the briefing schema. Whether a
 * citation is grounded is the harness's finding, and a model that could assert it
 * would be marking its own work.
 */
const CITATION_SCHEMA = {
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
        'A reconnaissance source id ("tree", "README.md", "package.json", "metadata") or a repository-relative path that was read.',
    },
    location: {
      type: "string",
      description: 'Where inside the source: a line range such as "L40-L58" for a file, or a path within the tree.',
    },
    excerpt: {
      type: "string",
      description: "Verbatim quote of the source text, without line numbers. Omit rather than paraphrase.",
    },
    supports: { type: "string", description: "The part of your answer this evidence is offered for." },
  },
  required: ["type", "source"],
} as const;

export const QUESTION_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    answer: {
      type: "string",
      description:
        "The answer, in prose. Say what the evidence shows and mark inference as inference. If the evidence does not settle the question, say what you did establish and what is missing.",
    },
    sufficient: {
      type: "boolean",
      description:
        "True only if the evidence you inspected actually settles the question. False is a correct answer when it is the true one.",
    },
    citations: {
      type: "array",
      description: "Evidence for the factual claims in the answer. Empty means the answer is unsupported.",
      items: CITATION_SCHEMA,
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description: "Your calibration for this answer on 0..1. Having read the deciding file should raise it.",
    },
  },
  required: ["answer", "sufficient", "citations", "confidence"],
};
