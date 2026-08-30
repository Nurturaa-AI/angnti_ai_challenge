import { z } from "zod";

/**
 * The evaluation case format.
 *
 * A case is a repository plus questions a new engineer would actually ask on
 * day one. Each question carries three separate expectations, because the
 * project's central claim needs all three to be measured apart:
 *
 *   - `expectedKeywords` / `anyOfKeywords` — was the conclusion right?
 *   - `expectedEvidence`                   — was it cited from the right place?
 *   - `mustNotContain`                     — did it assert something false?
 *
 * Scoring is pure string and set logic over the produced briefing. No model is
 * used as a judge, so a case scores identically on every machine and every run.
 */

export const ANSWER_FIELDS = [
  "summary",
  "architecture",
  "components",
  "flows",
  "dependencies",
  "testing",
  "risks",
  "recommendedReading",
  "openQuestions",
  "any",
] as const;

export type AnswerField = (typeof ANSWER_FIELDS)[number];

export const EvalQuestionSchema = z
  .object({
    id: z.string().min(1),
    question: z.string().min(1),
    /** Which part of the briefing must answer this. "any" searches the whole briefing. */
    field: z.enum(ANSWER_FIELDS).default("any"),
    /** Human-readable ground truth. Documentation for the reader; not matched against. */
    expectedAnswer: z.string().min(1),
    /** Every keyword must appear for the answer to count as correct. */
    expectedKeywords: z.array(z.string().min(1)).default([]),
    /** Alternative phrasings: at least one group must match in full. */
    anyOfKeywords: z.array(z.array(z.string().min(1)).min(1)).default([]),
    /** Asserting any of these makes the answer wrong. Catches confident fabrication. */
    mustNotContain: z.array(z.string().min(1)).default([]),
    /**
     * Where the answer must be cited from. A path here means the citation has to
     * carry that file's *content* — the directory tree proving the file exists is
     * scored as partial credit, not as evidence.
     */
    expectedEvidence: z.array(z.string().min(1)).default([]),
  })
  .refine(
    (question) => question.expectedKeywords.length > 0 || question.anyOfKeywords.length > 0,
    { message: "a question needs expectedKeywords or anyOfKeywords, otherwise it cannot be scored" },
  );

export type EvalQuestion = z.infer<typeof EvalQuestionSchema>;

export const EvalCaseSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  /** Repository path, relative to the project root so cases are portable. */
  repository: z.string().min(1),
  /** Why this case exists and what it is meant to discriminate. */
  notes: z.string().optional(),
  questions: z.array(EvalQuestionSchema).min(1),
});

export type EvalCase = z.infer<typeof EvalCaseSchema>;
