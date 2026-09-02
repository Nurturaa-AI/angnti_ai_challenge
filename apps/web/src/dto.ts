import { PHASE_MESSAGES } from "@repo-arch/app";
import type {
  AnalysisRecord,
  AnalysisReport,
  AnalysisSummary,
  AnsweredQuestionView,
  ArchitectureGraph,
  QuestionCitation,
  ReportEvidence,
  StoredEvidenceSource,
} from "@repo-arch/app";

/**
 * Every shape the API returns, constructed field by field.
 *
 * The rule this module exists to enforce is that no internal object is ever
 * handed to a serialiser. That sounds like ceremony until you notice what it
 * catches: `AnsweredQuestion` carries a `trajectory` of model prose and raw tool
 * results, `AnalysisRun` carries an absolute `repositoryRoot`, and both were one
 * `JSON.stringify` away from a browser in the previous iteration. Listing the
 * fields means adding a field to a domain type cannot silently publish it — the
 * DTO has to be edited too, and editing it is where someone asks whether it
 * should be public.
 *
 * The absent fields, for the record: `repositoryRoot`, the run record, the
 * trajectory, prompts, model text, tool arguments, tool results, the database
 * file, the schema version, and any path that is not relative to the workspace.
 */

/** The largest text the evidence viewer will return for one artefact. */
const MAX_SOURCE_TEXT_CHARS = 60_000;
/** Above this, the whitespace-tolerant excerpt search is skipped. */
const MAX_EXCERPT_SEARCH_CHARS = 200_000;

export interface AnalysisSummaryDto {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  phase: string | null;
  phaseMessage: string | null;
  repository: { path: string; name: string };
  system: string;
  model: string;
  summary: string;
  error: string | null;
  questionCount: number;
}

export interface AnalysisDetailDto extends AnalysisSummaryDto {
  provider: string;
  focus: string | null;
  durationMs: number | null;
  /** `null` until the analysis completes. */
  report: AnalysisReport | null;
  graph: ArchitectureGraph | null;
  questions: AnsweredQuestionView[];
  /** Artefact metadata only — no text. Text is served one citation at a time. */
  evidenceSources: { id: string; type: string; bytes: number; truncated: boolean }[];
}

export function analysisSummaryDto(summary: AnalysisSummary): AnalysisSummaryDto {
  return {
    id: summary.id,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    status: summary.status,
    phase: summary.phase,
    phaseMessage: summary.phase === null ? null : PHASE_MESSAGES[summary.phase],
    repository: { path: summary.repositoryPath === "" ? "." : summary.repositoryPath, name: summary.repositoryName },
    system: summary.system,
    model: summary.model,
    summary: summary.summary,
    error: summary.error,
    questionCount: summary.questionCount,
  };
}

export function analysisDetailDto(record: AnalysisRecord): AnalysisDetailDto {
  return {
    id: record.id,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    status: record.status,
    phase: record.phase,
    phaseMessage: record.phase === null ? null : PHASE_MESSAGES[record.phase],
    repository: {
      path: record.repositoryPath === "" ? "." : record.repositoryPath,
      name: record.repositoryName,
    },
    system: record.metadata.system,
    provider: record.metadata.provider,
    model: record.metadata.model,
    focus: record.metadata.focus,
    durationMs: record.metadata.durationMs,
    summary: record.summary,
    error: record.error,
    questionCount: record.questions.length,
    report: record.report,
    graph: record.graph,
    questions: [...record.questions],
    evidenceSources: record.evidence.map((source) => ({
      id: source.id,
      type: source.type,
      bytes: source.bytes,
      truncated: source.truncated,
    })),
  };
}

/** A citation, wherever in the analysis it was issued. */
export interface FoundCitation {
  citation: ReportEvidence | QuestionCitation;
  origin: { kind: "report" } | { kind: "question"; questionId: string; question: string };
}

/**
 * Resolves an evidence id inside one analysis.
 *
 * Scoped by construction: the only citations searched are the ones this record
 * holds. An id issued by another analysis is not "denied" so much as absent,
 * which is the stronger property — there is no code path that could compare the
 * wrong record.
 */
export function findCitation(record: AnalysisRecord, evidenceId: string): FoundCitation | undefined {
  const fromReport = record.report?.evidence.find((item) => item.id === evidenceId);
  if (fromReport) return { citation: fromReport, origin: { kind: "report" } };
  for (const answered of record.questions) {
    const citation = answered.citations.find((item) => item.id === evidenceId);
    if (citation) {
      return {
        citation,
        origin: { kind: "question", questionId: answered.id, question: answered.question },
      };
    }
  }
  return undefined;
}

export interface EvidenceViewDto {
  analysisId: string;
  origin: FoundCitation["origin"];
  evidence: ReportEvidence | QuestionCitation;
  source: {
    id: string;
    type: string;
    bytes: number;
    truncated: boolean;
    origins: readonly string[];
    citationCount: number;
    text: string;
    textTruncatedForDisplay: boolean;
    lineNumbersKnown: boolean;
    reportedLocation: string | null;
    lineCount: number;
    excerptMatch: { start: number; end: number; line: number | null; endLine: number | null } | null;
  } | null;
  note?: string;
}

/**
 * The evidence viewer's payload.
 *
 * The text comes from the stored evidence projection, never from a fresh read of
 * the file. That is a correctness decision before it is a security one: the store
 * holds what was actually verified, and a file edited since the analysis would
 * make a grounded citation look fabricated. It is also the strongest available
 * form of "the browser never reads the repository" — this path touches no
 * filesystem at all, so there is no path parameter to abuse and nothing for
 * `resolveInsideRepository` to guard.
 *
 * `lineNumbersKnown` is false for a truncated artefact. A partial `read_file`
 * view carries no record of which line it started at, so numbering its first line
 * `1` would be a fabrication. The model's own `location` is passed through,
 * labelled as its claim rather than as a fact.
 */
export function evidenceViewDto(
  analysisId: string,
  citation: ReportEvidence | QuestionCitation,
  origin: FoundCitation["origin"],
  source: StoredEvidenceSource | undefined,
  reportSource: { origins: readonly string[]; citationCount: number } | undefined,
): EvidenceViewDto {
  if (source === undefined) {
    return {
      analysisId,
      origin,
      evidence: citation,
      source: null,
      note: "This citation names no artefact in the evidence ledger.",
    };
  }

  const full = source.text;
  const text = full.length > MAX_SOURCE_TEXT_CHARS ? full.slice(0, MAX_SOURCE_TEXT_CHARS) : full;
  const located = citation.excerpt === undefined ? null : locateExcerpt(text, citation.excerpt);

  return {
    analysisId,
    origin,
    evidence: citation,
    source: {
      id: source.id,
      type: source.type,
      bytes: source.bytes,
      truncated: source.truncated,
      origins: reportSource?.origins ?? [],
      citationCount: reportSource?.citationCount ?? 0,
      text,
      textTruncatedForDisplay: full.length > text.length,
      lineNumbersKnown: !source.truncated,
      reportedLocation: citation.location ?? null,
      lineCount: countLines(text),
      excerptMatch:
        located === null
          ? null
          : {
              start: located.start,
              end: located.end,
              // A range, not a point: an excerpt spanning six lines is a
              // different thing to check than one on a single line, and the
              // viewer's header says which.
              line: source.truncated ? null : lineOf(text, located.start),
              endLine: source.truncated ? null : lineOf(text, Math.max(located.start, located.end - 1)),
            },
    },
  };
}

function countLines(text: string): number {
  if (text === "") return 0;
  let lines = 1;
  for (const character of text) if (character === "\n") lines += 1;
  return lines;
}

export function lineOf(text: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index && cursor < text.length; cursor += 1) {
    if (text[cursor] === "\n") line += 1;
  }
  return line;
}

/**
 * Finds a verified excerpt in its artefact so the viewer can highlight it.
 *
 * Grounding compares whitespace-collapsed, lowercased text, so an excerpt that
 * passed verification need not appear verbatim: a model may have normalised
 * indentation or a line break. An exact match is tried first, then a scan that
 * tolerates any run of whitespace wherever the excerpt has one. Returning `null`
 * costs only a highlight.
 */
export function locateExcerpt(text: string, excerpt: string): { start: number; end: number } | null {
  const direct = text.indexOf(excerpt);
  if (direct >= 0) return { start: direct, end: direct + excerpt.length };
  if (text.length > MAX_EXCERPT_SEARCH_CHARS) return null;

  const needle = excerpt.replace(/\s+/g, " ").trim().toLowerCase();
  if (needle === "") return null;

  for (let start = 0; start < text.length; start += 1) {
    if (isSpace(text[start])) continue;
    let needleIndex = 0;
    let cursor = start;
    let end = start;
    while (needleIndex < needle.length && cursor < text.length) {
      const wanted = needle[needleIndex] as string;
      const actual = (text[cursor] as string).toLowerCase();
      if (wanted === " ") {
        if (!isSpace(actual)) break;
        while (cursor < text.length && isSpace(text[cursor])) cursor += 1;
        needleIndex += 1;
        continue;
      }
      if (isSpace(actual) || actual !== wanted) break;
      cursor += 1;
      needleIndex += 1;
      end = cursor;
    }
    if (needleIndex === needle.length) return { start, end };
  }
  return null;
}

function isSpace(character: string | undefined): boolean {
  return character !== undefined && /\s/.test(character);
}
