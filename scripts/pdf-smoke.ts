import { PdfWriter } from "../packages/app/src/export/pdf/writer";

/**
 * Structural smoke check for the PDF writer, kept out of the test suite because it
 * asserts on the file format rather than on the product. Run: pnpm exec tsx scripts/pdf-smoke.ts
 */

const pdf = new PdfWriter({
  title: "Smoke (test) \\ with (parens)",
  author: "a",
  subject: "s",
  creator: "Repo Archaeologist",
  createdAt: new Date("2026-09-01T10:00:00Z"),
});

for (let page = 0; page < 3; page += 1) {
  pdf.newPage();
  pdf.text(54, 60, `Page ${page + 1} — curly “quotes”, bullet •, ellipsis…, emoji \u{1f680}`, {
    size: 12,
    font: "bold",
  });
  pdf.text(54, 90, "monospace src/index.ts:12", { size: 9, font: "mono" });
  pdf.rule(54, 110, 504);
}

const bytes = pdf.build();
const text = Buffer.from(bytes).toString("latin1");

const xrefStart = Number(/startxref\n(\d+)/.exec(text)?.[1]);
const size = Number(/\/Size (\d+)/.exec(text)?.[1]);
const rows = [...text.slice(xrefStart).matchAll(/^(\d{10}) (\d{5}) ([nf]) $/gm)];

let bad = 0;
for (const [index, row] of rows.entries()) {
  if (index === 0) continue;
  const offset = Number(row[1]);
  if (!text.startsWith(`${index} 0 obj`, offset)) {
    bad += 1;
    console.log("BAD offset for object", index, offset, JSON.stringify(text.slice(offset, offset + 20)));
  }
}

console.log({
  bytes: bytes.length,
  header: text.slice(0, 8),
  size,
  xrefRows: rows.length,
  badOffsets: bad,
  endsWithEof: text.trimEnd().endsWith("%%EOF"),
  title: /\/Title \(([^\n]*?)\) \/Author/.exec(text)?.[1],
  emojiReplaced: text.includes("emoji ?"),
  bulletMapped: text.includes(`bullet ${String.fromCharCode(0x95)}`),
  emDashMapped: text.includes(String.fromCharCode(0x97)),
});
