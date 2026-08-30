import { z } from "zod";

/**
 * The analysis contract.
 *
 * Two schemas matter here, and the split is deliberate:
 *
 *  - `AnalysisBodySchema` is what the *model* is allowed to produce.
 *  - `AnalysisResultSchema` is the body plus `repository`, which the *harness*
 *    fills in from the filesystem.
 *
 * The model never authors repository metadata, so it cannot invent a commit
 * hash, a file count, or a branch name.
 */

/**
 * Where a piece of evidence came from.
 *
 * The first four kinds are the only ones the baseline can legitimately produce,
 * because they are the only context it receives. `file`, `git`, `test`,
 * `command` and `dependency` exist for the advanced agent, which earns them by
 * actually running a tool.
 */
export const EVIDENCE_TYPES = [
  "tree",
  "readme",
  "manifest",
  "metadata",
  "file",
  "git",
  "test",
  "command",
  "dependency",
] as const;

export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export const EvidenceSchema = z.object({
  type: z.enum(EVIDENCE_TYPES),
  /**
   * Identifier of the artefact this evidence points at. Must be one of the
   * context source ids the system actually received (e.g. `tree`,
   * `README.md`, `package.json`) or, for the advanced agent, a real repository
   * path or executed command.
   */
  source: z.string().min(1, "evidence.source must not be empty"),
  /** Line range, JSON key path, commit range — whatever locates it inside the source. */
  location: z.string().optional(),
  /** Verbatim snippet copied from the source. Checked against the source text. */
  excerpt: z.string().optional(),
  /** Which claim this evidence is offered in support of. */
  supports: z.string().optional(),

  // ---- Fields below are written by the harness during grounding, never by the model.
  /** True once the harness has confirmed the source was really in context. */
  grounded: z.boolean().optional(),
  /** Why grounding failed, when it did. */
  groundingReason: z.string().optional(),
});

export type Evidence = z.infer<typeof EvidenceSchema>;

const evidenceArray = z.array(EvidenceSchema).default([]);

export const ComponentSchema = z.object({
  name: z.string().min(1),
  path: z.string().optional(),
  responsibility: z.string().min(1),
  evidence: evidenceArray,
});
export type Component = z.infer<typeof ComponentSchema>;

export const FlowSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  steps: z.array(z.string()).default([]),
  evidence: evidenceArray,
});
export type Flow = z.infer<typeof FlowSchema>;

export const DEPENDENCY_SCOPES = ["runtime", "dev", "peer", "optional", "unknown"] as const;

export const DependencySchema = z.object({
  name: z.string().min(1),
  version: z.string().optional(),
  scope: z.enum(DEPENDENCY_SCOPES).default("unknown"),
  purpose: z.string().optional(),
  evidence: evidenceArray,
});
export type Dependency = z.infer<typeof DependencySchema>;

export const TestingSchema = z.object({
  approach: z.string().min(1),
  frameworks: z.array(z.string()).default([]),
  testPaths: z.array(z.string()).default([]),
  gaps: z.array(z.string()).default([]),
  evidence: evidenceArray,
});
export type Testing = z.infer<typeof TestingSchema>;

export const SEVERITIES = ["low", "medium", "high"] as const;

export const RiskSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  severity: z.enum(SEVERITIES),
  evidence: evidenceArray,
});
export type Risk = z.infer<typeof RiskSchema>;

export const RecommendedReadingSchema = z.object({
  path: z.string().min(1),
  reason: z.string().min(1),
  order: z.number().int().min(1),
});
export type RecommendedReading = z.infer<typeof RecommendedReadingSchema>;

/** Exactly the fields the model is asked to produce. */
export const AnalysisBodySchema = z.object({
  summary: z.string().min(1),
  architecture: z.string().min(1),
  components: z.array(ComponentSchema).default([]),
  flows: z.array(FlowSchema).default([]),
  dependencies: z.array(DependencySchema).default([]),
  testing: TestingSchema,
  risks: z.array(RiskSchema).default([]),
  recommendedReading: z.array(RecommendedReadingSchema).default([]),
  /** Self-reported calibration, 0..1. Treated as a claim, not a fact. */
  confidence: z.number().min(0).max(1),
  /** Top-level evidence pool for claims that do not belong to one section. */
  evidence: evidenceArray,
  /** What the system could not determine from the context it had. */
  openQuestions: z.array(z.string()).default([]),
});
export type AnalysisBody = z.infer<typeof AnalysisBodySchema>;

/** Filesystem facts. Collected by the harness, never authored by the model. */
export const RepositoryInfoSchema = z.object({
  name: z.string(),
  /** Path as supplied by the caller — kept relative so results stay portable. */
  path: z.string(),
  isGitRepository: z.boolean(),
  /** HEAD commit and branch. Recorded for reproducibility; not sent to the baseline model. */
  head: z
    .object({
      commit: z.string(),
      branch: z.string(),
    })
    .nullable()
    .default(null),
  fileCount: z.number().int().min(0),
  directoryCount: z.number().int().min(0),
  totalBytes: z.number().int().min(0),
  /** File-extension histogram, most frequent first. */
  languages: z.array(z.object({ extension: z.string(), files: z.number().int().min(0) })).default([]),
});
export type RepositoryInfo = z.infer<typeof RepositoryInfoSchema>;

export const AnalysisResultSchema = AnalysisBodySchema.extend({
  repository: RepositoryInfoSchema,
});
export type AnalysisResult = z.infer<typeof AnalysisResultSchema>;

// ---------------------------------------------------------------------------
// Run metadata: everything needed to reproduce or audit a run.
// ---------------------------------------------------------------------------

export const TokenUsageSchema = z.object({
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  totalTokens: z.number().int().min(0),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

/** One artefact handed to the model, and how much of it survived truncation. */
export const ContextSourceSchema = z.object({
  id: z.string(),
  type: z.enum(EVIDENCE_TYPES),
  bytes: z.number().int().min(0),
  truncated: z.boolean(),
});
export type ContextSource = z.infer<typeof ContextSourceSchema>;

export const EvidenceAuditSchema = z.object({
  /** Evidence items the model produced. */
  claimed: z.number().int().min(0),
  /** Items whose source was really in context (and whose excerpt really matched). */
  grounded: z.number().int().min(0),
  /** Items removed because they referenced something the system never saw. */
  dropped: z.array(z.object({ source: z.string(), reason: z.string() })).default([]),
  /** Claims left with no grounded evidence at all. */
  unsupportedClaims: z.number().int().min(0),
});
export type EvidenceAudit = z.infer<typeof EvidenceAuditSchema>;

export const TrajectoryStepSchema = z.object({
  step: z.number().int().min(1),
  at: z.string(),
  action: z.string(),
  detail: z.unknown().optional(),
  durationMs: z.number().min(0).optional(),
});
export type TrajectoryStep = z.infer<typeof TrajectoryStepSchema>;

export const RunMetaSchema = z.object({
  runId: z.string(),
  system: z.string(),
  systemVersion: z.string(),
  provider: z.enum(["gemini", "mock"]),
  model: z.string(),
  /** Sampling seed. The Interactions API exposes no temperature; seed is the reproducibility lever. */
  seed: z.number(),
  thinkingLevel: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  durationMs: z.number().min(0),
  usage: TokenUsageSchema,
  /** Null when the model has no price entry, rather than a fabricated zero. */
  estimatedCostUsd: z.number().nullable(),
  contextSources: z.array(ContextSourceSchema).default([]),
  evidenceAudit: EvidenceAuditSchema,
  nodeVersion: z.string(),
});
export type RunMeta = z.infer<typeof RunMetaSchema>;

export const RUN_RECORD_SCHEMA_VERSION = 1;

export const RunRecordSchema = z.object({
  schemaVersion: z.literal(RUN_RECORD_SCHEMA_VERSION),
  meta: RunMetaSchema,
  result: AnalysisResultSchema,
  trajectory: z.array(TrajectoryStepSchema).default([]),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;
