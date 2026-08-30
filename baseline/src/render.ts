import type { Evidence, RunRecord } from "@repo-arch/shared";

/**
 * The briefing, rendered for a human.
 *
 * Evidence is inline rather than in an appendix: the claim and its citation
 * should be impossible to read apart. The audit block sits near the top, so a
 * reader learns how much of the briefing is grounded before reading any of it.
 */

export function renderBriefingMarkdown(record: RunRecord): string {
  const { meta, result } = record;
  const lines: string[] = [];

  lines.push(`# ${result.repository.name} — engineering briefing`, "");
  lines.push(
    `> Produced by \`${meta.system}\` v${meta.systemVersion} using ${meta.provider}/${meta.model}.`,
    `> Self-reported confidence: **${result.confidence.toFixed(2)}**.`,
    "",
  );

  lines.push("## Evidence audit", "");
  lines.push(
    `- Citations offered: **${meta.evidenceAudit.claimed}**`,
    `- Verified against context: **${meta.evidenceAudit.grounded}**`,
    `- Dropped as unverifiable: **${meta.evidenceAudit.dropped.length}**`,
    `- Claims left unsupported: **${meta.evidenceAudit.unsupportedClaims}**`,
    "",
  );
  if (meta.evidenceAudit.dropped.length > 0) {
    lines.push("Dropped citations (the system never received these):", "");
    for (const dropped of meta.evidenceAudit.dropped) {
      lines.push(`- \`${dropped.source}\` — ${dropped.reason}`);
    }
    lines.push("");
  }
  lines.push(
    `Context the system actually saw: ${meta.contextSources
      .map((source) => `\`${source.id}\`${source.truncated ? " (truncated)" : ""}`)
      .join(", ")}`,
    "",
  );

  lines.push("## Summary", "", result.summary, "");
  lines.push("## Architecture", "", result.architecture, "");
  lines.push(...renderEvidenceList("Supporting evidence", result.evidence));

  lines.push("## Components", "");
  if (result.components.length === 0) {
    lines.push("_None identified from the available context._", "");
  } else {
    for (const component of result.components) {
      const path = component.path ? ` — \`${component.path}\`` : "";
      lines.push(`### ${component.name}${path}`, "", component.responsibility, "");
      lines.push(...renderEvidenceList("Evidence", component.evidence));
    }
  }

  lines.push("## Execution flows", "");
  if (result.flows.length === 0) {
    lines.push("_None identified from the available context._", "");
  } else {
    for (const flow of result.flows) {
      lines.push(`### ${flow.name}`, "", flow.description, "");
      if (flow.steps.length > 0) {
        flow.steps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
        lines.push("");
      }
      lines.push(...renderEvidenceList("Evidence", flow.evidence));
    }
  }

  lines.push("## Dependencies", "");
  if (result.dependencies.length === 0) {
    lines.push("_None identified from the available context._", "");
  } else {
    lines.push("| Name | Version | Scope | Purpose | Evidence |", "| --- | --- | --- | --- | --- |");
    for (const dependency of result.dependencies) {
      lines.push(
        `| \`${dependency.name}\` | ${dependency.version ?? "—"} | ${dependency.scope} | ` +
          `${dependency.purpose ?? "—"} | ${dependency.evidence.map(formatEvidenceInline).join("; ") || "**none**"} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Testing", "", result.testing.approach, "");
  if (result.testing.frameworks.length > 0) {
    lines.push(`- Frameworks: ${result.testing.frameworks.map((name) => `\`${name}\``).join(", ")}`);
  }
  if (result.testing.testPaths.length > 0) {
    lines.push(`- Test paths: ${result.testing.testPaths.map((path) => `\`${path}\``).join(", ")}`);
  }
  for (const gap of result.testing.gaps) lines.push(`- Gap: ${gap}`);
  lines.push("");
  lines.push(...renderEvidenceList("Evidence", result.testing.evidence));

  lines.push("## Risk areas", "");
  if (result.risks.length === 0) {
    lines.push("_None identified from the available context._", "");
  } else {
    for (const risk of result.risks) {
      lines.push(`### ${risk.title} (${risk.severity})`, "", risk.description, "");
      lines.push(...renderEvidenceList("Evidence", risk.evidence));
    }
  }

  lines.push("## Read these first", "");
  if (result.recommendedReading.length === 0) {
    lines.push("_No reading order proposed._", "");
  } else {
    for (const item of [...result.recommendedReading].sort((a, b) => a.order - b.order)) {
      lines.push(`${item.order}. \`${item.path}\` — ${item.reason}`);
    }
    lines.push("");
  }

  lines.push("## Open questions", "");
  if (result.openQuestions.length === 0) {
    lines.push("_None recorded. Treat that as a warning, not a reassurance._", "");
  } else {
    for (const question of result.openQuestions) lines.push(`- ${question}`);
    lines.push("");
  }

  lines.push("---", "");
  lines.push(
    `Run \`${meta.runId}\` · ${meta.durationMs} ms · ` +
      `${meta.usage.totalTokens} tokens · ` +
      `${meta.estimatedCostUsd === null ? "cost unknown (unpriced model)" : `est. $${meta.estimatedCostUsd.toFixed(6)}`}`,
    "",
  );

  return lines.join("\n");
}

function renderEvidenceList(label: string, evidence: readonly Evidence[]): string[] {
  if (evidence.length === 0) {
    return [`_${label}: none — this claim is unsupported._`, ""];
  }
  const lines = [`${label}:`, ""];
  for (const item of evidence) lines.push(`- ${formatEvidenceInline(item)}`);
  lines.push("");
  return lines;
}

function formatEvidenceInline(item: Evidence): string {
  const location = item.location ? ` → \`${item.location}\`` : "";
  const excerpt = item.excerpt ? ` — "${collapse(item.excerpt)}"` : "";
  return `\`${item.source}\`${location} (${item.type})${excerpt}`;
}

function collapse(value: string): string {
  const single = value.replace(/\s+/g, " ").trim();
  return single.length > 160 ? `${single.slice(0, 157)}...` : single;
}
