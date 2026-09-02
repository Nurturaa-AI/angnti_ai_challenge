/**
 * The application layer.
 *
 * One analysis core, one report shape, one architecture graph, one question answerer,
 * one export seam and one store. The CLI and the web server are both consumers of this
 * package; neither owns any of it, and neither reaches past it into the pipeline.
 *
 * Nothing here starts a server, parses an argument or writes a file. That belongs to the
 * things that have a user.
 */

export {
  ANALYSIS_SYSTEMS,
  DEFAULT_ANALYSIS_SYSTEM,
  analyzeRepository,
  systemSupportsFocus,
  type AnalysisRun,
  type AnalysisRunPhase,
  type AnalysisSystem,
  type AnalyzeRepositoryOptions,
} from "./service";

export {
  ANALYSIS_REPORT_SCHEMA_VERSION,
  EVIDENCE_ORIGINS,
  REPORT_SECTIONS,
  buildAnalysisReport,
  findReportEvidence,
  reportClaims,
  type AnalysisReport,
  type EvidenceOrigin,
  type ReportComponent,
  type ReportDependency,
  type ReportEvidence,
  type ReportFlow,
  type ReportMetrics,
  type ReportRisk,
  type ReportSection,
  type ReportSource,
  type ReportTesting,
} from "./report";

export {
  NODE_TYPES,
  RELATIONSHIPS,
  assertNodeType,
  assertRelationship,
  buildArchitectureGraph,
  type ArchitectureEdge,
  type ArchitectureGraph,
  type ArchitectureNode,
  type ArchitectureSummary,
  type NodeType,
  type Relationship,
} from "./architecture";

export {
  DEFAULT_QUESTION_BUDGET,
  MAX_HISTORY_TURNS,
  MAX_QUESTION_CHARS,
  RECONNAISSANCE_TYPES,
  UNSUPPORTED_ANSWER,
  answerQuestion,
  questionView,
  type AnsweredQuestion,
  type AnsweredQuestionView,
  type AnswerQuestionOptions,
  type QuestionCitation,
  type QuestionMetricsRecord,
  type QuestionRun,
} from "./questions";

export {
  ANALYSIS_PHASES,
  ANALYSIS_STATUSES,
  MAX_STORED_QUESTIONS,
  TERMINAL_STATUSES,
  isTerminal,
  type AnalysisMetadata,
  type AnalysisPatch,
  type AnalysisPhase,
  type AnalysisRecord,
  type AnalysisStatus,
  type AnalysisStore,
  type AnalysisSummary,
  type NewAnalysis,
  type StoredEvidenceSource,
} from "./store/types";

export {
  MEMORY_DATABASE,
  SCHEMA_VERSION,
  SqliteAnalysisStore,
  type SqliteAnalysisStoreOptions,
} from "./store/sqlite";

export {
  DATABASE_ENV_VAR,
  DEFAULT_DATABASE_DIRECTORY,
  DEFAULT_DATABASE_FILE,
  resolveDatabaseLocation,
  type ResolveDatabaseLocationOptions,
} from "./store/location";

export { mergeQuestionEvidence, projectEvidence, toContextSources } from "./store/projection";

export {
  AnalysisEventBus,
  PHASE_MESSAGES,
  canTransition,
  logFailureMessage,
  safeFailureMessage,
  type AnalysisEvent,
  type AnalysisEventType,
} from "./lifecycle";

export {
  AnalysisRunner,
  type AnalysisRunnerDependencies,
  type StartAnalysisRequest,
  type StartedAnalysis,
} from "./runner";

export { resolveRepositoryRequest, type ResolvedRepository } from "./workspace";

export {
  ObservabilityRecorder,
  type AnalysisMetrics,
  type ExportMetrics,
  type MetricEvent,
  type MetricsSink,
  type QuestionMetrics,
} from "./metrics";

export { PdfReportExporter, type PdfExporterOptions } from "./export/pdf-exporter";
export { PDF_LETTER, PdfWriter, type PdfFont, type PdfMetadata, type PdfPageSize } from "./export/pdf/writer";
export type { ExportInput, ReportExporter } from "./export/types";
