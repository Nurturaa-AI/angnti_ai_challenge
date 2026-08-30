import type { EvaluationReport } from "./aggregate";
import type { QuestionScore } from "./score";

/**
 * The human-readable evaluation summary.
 *
 * Written to be readable against its own interest: the primary metric leads, the
 * gap between "right" and "right for the right reason" is shown explicitly, and
 * caveats sit above the numbers rather than in a footnote.
 */

export function renderEvaluationMarkdown(report: EvaluationReport): string {
  const m = report.metrics;
  const lines: string[] = [];

  lines.push(`# Evaluation — ${report.system} v${report.systemVersion}`, "");
  lines.push(
    `\`${report.runId}\` · ${report.provider}/${report.model} · seed ${report.seed} · ` +
      `thinking ${report.thinkingLevel} · node ${report.environment.nodeVersion} on ${report.environment.platform}`,
    "",
    `Started ${report.startedAt}, finished ${report.finishedAt} (${formatDuration(report.durationMs)}).`,
    "",
  );

  if (report.caveats.length > 0) {
    lines.push("> **Read these before the numbers**", ">");
    for (const caveat of report.caveats) lines.push(`> - ${caveat}`);
    lines.push("");
  }

  lines.push("## Primary metric", "");
  lines.push(
    `### Evidence-backed task accuracy: **${percent(m.evidenceBackedTaskAccuracy)}**`,
    "",
    `${m.evidenceBackedAnswers} of ${m.totalQuestions} questions were answered correctly *and* cited from`,
    "something that can actually support the answer.",
    "",
  );

  lines.push("## Headline figures", "");
  lines.push("| Measure | Value |", "| --- | --- |");
  lines.push(`| Total cases | ${m.totalCases} |`);
  lines.push(`| Passed cases (all answers correct) | ${m.passedCases} |`);
  lines.push(`| Evidence-backed cases (all answers cited) | ${m.evidenceBackedCases} |`);
  lines.push(`| Failed cases (no briefing produced) | ${m.failedCases} |`);
  lines.push(`| Total questions | ${m.totalQuestions} |`);
  lines.push(`| Answer accuracy | ${percent(m.answerAccuracy)} (${m.correctAnswers}/${m.totalQuestions}) |`);
  lines.push(
    `| **Evidence-backed task accuracy** | **${percent(m.evidenceBackedTaskAccuracy)}** ` +
      `(${m.evidenceBackedAnswers}/${m.totalQuestions}) |`,
  );
  lines.push(`| Correct but only existence-level evidence | ${m.partialEvidenceAnswers} |`);
  lines.push(`| Correct but uncited | ${m.unsupportedAnswers} |`);
  lines.push(`| Forbidden assertions (fabrication checks tripped) | ${m.fabrications} |`);
  lines.push(`| Unsupported claims across all briefings | ${m.briefingUnsupportedClaims} |`);
  lines.push(`| Citations dropped as unverifiable | ${m.droppedCitations} |`);
  lines.push(
    `| Mean evidence relevance | ${m.meanEvidenceRelevance === null ? "not measurable" : percent(m.meanEvidenceRelevance)} |`,
  );
  lines.push(`| Runtime | ${formatDuration(report.durationMs)} |`);
  lines.push(`| Tokens (in / out / total) | ${report.usage.inputTokens} / ${report.usage.outputTokens} / ${report.usage.totalTokens} |`);
  lines.push(`| Estimated API cost | ${formatCost(report)} |`);
  lines.push("");

  const gap = m.answerAccuracy - m.evidenceBackedTaskAccuracy;
  lines.push("## The gap", "");
  if (gap > 0) {
    lines.push(
      `Answer accuracy exceeds evidence-backed accuracy by **${percent(gap)}** — ` +
        `${m.correctAnswers - m.evidenceBackedAnswers} answer(s) that happened to be right without the system`,
      "being able to show why. Closing that distance is what this project measures.",
      "",
    );
  } else {
    lines.push(
      "Answer accuracy and evidence-backed accuracy are equal: every answer this system got right, it also",
      "cited from something that can support it. The remaining headroom is in the questions it got wrong",
      `(${m.totalQuestions - m.correctAnswers} of ${m.totalQuestions}), not in uncited guessing.`,
      "",
    );
  }

  lines.push("## Per case", "");
  lines.push("| Case | Repository | Questions | Correct | Evidence-backed | Partial | Uncited | Runtime |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const caseScore of report.cases) {
    lines.push(
      `| ${caseScore.caseId} | \`${caseScore.repository}\` | ${caseScore.totals.questions} | ` +
        `${caseScore.totals.correct} | ${caseScore.totals.evidenceBacked} | ` +
        `${caseScore.totals.partialEvidence} | ${caseScore.totals.unsupportedAnswers} | ` +
        `${formatDuration(caseScore.durationMs)} |`,
    );
  }
  lines.push("");

  lines.push("## Question detail", "");
  for (const caseScore of report.cases) {
    lines.push(`### ${caseScore.caseId} — ${caseScore.title}`, "");
    if (caseScore.error !== undefined) {
      lines.push(`**Run failed:** ${caseScore.error}`, "");
      continue;
    }
    for (const question of caseScore.questions) {
      lines.push(`- ${verdict(question)} **${question.questionId}** — ${question.question}`);
      for (const detail of questionDetails(question)) lines.push(`  - ${detail}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function verdict(question: QuestionScore): string {
  if (question.evidenceBacked) return "`PASS`";
  if (question.partialEvidence) return "`PARTIAL`";
  if (question.answerCorrect) return "`UNCITED`";
  return "`FAIL`";
}

function questionDetails(question: QuestionScore): string[] {
  const details: string[] = [];
  details.push(
    `answer ${question.answerCorrect ? "correct" : "incorrect"}` +
      (question.matchedIn === null ? "" : `, matched in \`${question.matchedIn}\``) +
      `, ${question.citedEvidence} citation(s)` +
      (question.evidenceStrength === null ? "" : `, strength \`${question.evidenceStrength}\``),
  );
  if (question.missingKeywords.length > 0) {
    details.push(`missing keywords: ${backtickList(question.missingKeywords)}`);
  }
  if (question.forbiddenHits.length > 0) {
    details.push(`asserted forbidden: ${backtickList(question.forbiddenHits)}`);
  }
  if (question.evidenceRelevance !== null) {
    details.push(`evidence relevance: ${percent(question.evidenceRelevance)} (${question.relevantEvidence}/${question.citedEvidence})`);
  }
  for (const note of question.notes) details.push(note);
  return details;
}

function backtickList(values: readonly string[]): string {
  return values.map((value) => `\`${value}\``).join(", ");
}

function formatCost(report: EvaluationReport): string {
  if (report.estimatedCostUsd === null) return "unknown (no published price for this model)";
  const prefix = report.costEstimateComplete ? "" : "at least ";
  return `${prefix}$${report.estimatedCostUsd.toFixed(6)}`;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${((ms % 60_000) / 1_000).toFixed(0)}s`;
}
