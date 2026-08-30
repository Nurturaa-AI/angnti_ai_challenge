import type { EvidenceType } from "./schemas";

/**
 * The wire format for context handed to a model.
 *
 * Every artefact is wrapped in a delimited block with an explicit `id`. That id
 * is the only thing a model is permitted to name in `evidence.source`, which is
 * what makes grounding checkable rather than aspirational.
 *
 * The mock provider parses the same format, so the offline provider sees exactly
 * what a real model sees — no privileged side channel.
 */

export interface ContextSourceText {
  id: string;
  type: EvidenceType;
  text: string;
  bytes: number;
  truncated: boolean;
}

const BLOCK_PATTERN = /^### SOURCE: (\S+) \(type=([a-z]+)\)\n([\s\S]*?)\n### END SOURCE$/gm;

export function renderSourceBlock(source: ContextSourceText): string {
  const suffix = source.truncated ? "\n[... truncated ...]" : "";
  return `### SOURCE: ${source.id} (type=${source.type})\n${source.text}${suffix}\n### END SOURCE`;
}

export function renderSourceBlocks(sources: readonly ContextSourceText[]): string {
  return sources.map(renderSourceBlock).join("\n\n");
}

/** Inverse of `renderSourceBlock`, used by the mock provider. */
export function parseSourceBlocks(prompt: string): ContextSourceText[] {
  const sources: ContextSourceText[] = [];
  for (const match of prompt.matchAll(BLOCK_PATTERN)) {
    const [, id, type, body] = match;
    if (id === undefined || type === undefined || body === undefined) continue;
    const truncated = body.endsWith("[... truncated ...]");
    const text = truncated ? body.slice(0, -"\n[... truncated ...]".length) : body;
    sources.push({
      id,
      type: type as EvidenceType,
      text,
      bytes: Buffer.byteLength(text, "utf8"),
      truncated,
    });
  }
  return sources;
}

/** Collapses whitespace and case so excerpt checks survive reformatting. */
export function normalizeForMatch(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}
