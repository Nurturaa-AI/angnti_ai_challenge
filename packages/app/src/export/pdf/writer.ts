/**
 * A minimal PDF 1.4 writer.
 *
 * This exists because the repository had no PDF dependency and the iteration's rule is
 * to prefer what is already here over what is convenient. A general PDF library is
 * megabytes of code for embedded fonts, compression, images, transparency and forms —
 * none of which a text report needs. What it does need is text, rules, a page break and
 * correct byte offsets, which is what this file is.
 *
 * Three deliberate simplifications, each with a real consequence:
 *
 *   1. **Standard fonts only.** Helvetica, Helvetica-Bold and Courier are the 14 fonts
 *      every conforming reader already has, so nothing is embedded and the file stays
 *      small. The consequence is WinAnsi's character repertoire: text outside cp1252 is
 *      transliterated where there is an obvious equivalent and otherwise replaced,
 *      rather than silently producing a corrupt glyph.
 *   2. **No compression.** A streams-uncompressed PDF is larger and diffable, and it
 *      removes zlib from the trust surface of a document built from untrusted
 *      repository text.
 *   3. **Metrics are tabulated, not measured.** Helvetica's advance widths are known
 *      constants; bold reuses them with a small upward factor, so a bold line wraps
 *      slightly early rather than overflowing the margin.
 *
 * The writer knows nothing about reports. Layout — what goes where, when to break a
 * page — belongs to the exporter that drives it.
 */

export type PdfFont = "regular" | "bold" | "mono";

export interface PdfMetadata {
  title: string;
  author: string;
  subject: string;
  creator: string;
  createdAt: Date;
}

export interface PdfPageSize {
  width: number;
  height: number;
}

/** US Letter at 72 dpi, the default a reader will print without resizing. */
export const PDF_LETTER: PdfPageSize = { width: 612, height: 792 };

export interface PdfTextOptions {
  font?: PdfFont;
  size?: number;
  /** RGB in 0..1. Defaults to black. */
  color?: readonly [number, number, number];
}

export class PdfWriter {
  readonly pageWidth: number;
  readonly pageHeight: number;

  private readonly metadata: PdfMetadata;
  private readonly pages: string[][] = [];

  constructor(metadata: PdfMetadata, pageSize: PdfPageSize = PDF_LETTER) {
    this.metadata = metadata;
    this.pageWidth = pageSize.width;
    this.pageHeight = pageSize.height;
  }

  get pageCount(): number {
    return this.pages.length;
  }

  /** Starts a new page. Returns its 1-based number. */
  newPage(): number {
    this.pages.push([]);
    return this.pages.length;
  }

  /**
   * Draws one line of text. `y` is measured from the top of the page, because every
   * caller thinks in "how far down", and PDF's bottom-left origin is an implementation
   * detail that belongs here rather than in layout code.
   */
  text(x: number, y: number, value: string, options: PdfTextOptions = {}): void {
    if (value === "") return;
    const font = options.font ?? "regular";
    const size = options.size ?? 10;
    const [r, g, b] = options.color ?? [0, 0, 0];
    const baseline = this.pageHeight - y - size;

    this.current().push(
      "BT",
      `${format(r)} ${format(g)} ${format(b)} rg`,
      `/${fontResource(font)} ${format(size)} Tf`,
      `1 0 0 1 ${format(x)} ${format(baseline)} Tm`,
      `${pdfString(value)} Tj`,
      "ET",
    );
  }

  /** A filled rectangle. `y` is the top edge. */
  rect(x: number, y: number, width: number, height: number, color: readonly [number, number, number]): void {
    const [r, g, b] = color;
    this.current().push(
      `${format(r)} ${format(g)} ${format(b)} rg`,
      `${format(x)} ${format(this.pageHeight - y - height)} ${format(width)} ${format(height)} re`,
      "f",
    );
  }

  /** A horizontal rule, the only line this report needs. */
  rule(x: number, y: number, width: number, thickness = 0.5, color: readonly [number, number, number] = [0.8, 0.8, 0.8]): void {
    this.rect(x, y, width, thickness, color);
  }

  /** Advance width of `value` in points. */
  static measure(value: string, font: PdfFont, size: number): number {
    let units = 0;
    for (const character of value) units += advanceWidth(character, font);
    return (units * size) / 1000;
  }

  /**
   * Greedy word wrap.
   *
   * A single word longer than the line — a long path, a minified identifier — is
   * broken by character rather than allowed to run into the margin. Truncating it
   * instead would lose exactly the part of a path that identifies the file.
   */
  static wrap(value: string, font: PdfFont, size: number, maxWidth: number): string[] {
    const lines: string[] = [];
    for (const paragraph of value.split("\n")) {
      const words = paragraph.split(/\s+/).filter((word) => word !== "");
      if (words.length === 0) {
        lines.push("");
        continue;
      }
      let line = "";
      for (const word of words) {
        const candidate = line === "" ? word : `${line} ${word}`;
        if (PdfWriter.measure(candidate, font, size) <= maxWidth) {
          line = candidate;
          continue;
        }
        if (line !== "") lines.push(line);
        if (PdfWriter.measure(word, font, size) <= maxWidth) {
          line = word;
          continue;
        }
        const pieces = breakLongWord(word, font, size, maxWidth);
        lines.push(...pieces.slice(0, -1));
        line = pieces.at(-1) ?? "";
      }
      if (line !== "") lines.push(line);
    }
    return lines;
  }

  /**
   * Serialises the document.
   *
   * The cross-reference table records each object's byte offset, so the file is
   * assembled as a list of chunks whose lengths are tracked as they are appended.
   * Computing offsets from a finished string would mean encoding everything twice and
   * getting a different answer for any non-ASCII byte.
   */
  build(): Uint8Array {
    if (this.pages.length === 0) this.newPage();

    const chunks: Buffer[] = [];
    const offsets: number[] = [];
    let cursor = 0;

    const append = (value: string | Buffer): void => {
      const buffer = typeof value === "string" ? Buffer.from(value, "latin1") : value;
      chunks.push(buffer);
      cursor += buffer.length;
    };

    /** Records where an object starts, then writes it. Object ids are 1-based. */
    const object = (id: number, body: string | Buffer): void => {
      offsets[id] = cursor;
      append(`${id} 0 obj\n`);
      append(body);
      append("\nendobj\n");
    };

    const pageIds = this.pages.map((_, index) => FIRST_PAGE_OBJECT + index * 2);
    const contentIds = pageIds.map((id) => id + 1);

    append("%PDF-1.4\n");
    // A binary comment marks the file as binary for tools that sniff the first bytes.
    append(Buffer.from([0x25, 0xc2, 0xb5, 0xc2, 0xb6, 0x0a]));

    object(CATALOG, `<< /Type /Catalog /Pages ${PAGES} 0 R >>`);
    object(
      PAGES,
      `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`,
    );
    object(FONT_REGULAR, standardFont("Helvetica"));
    object(FONT_BOLD, standardFont("Helvetica-Bold"));
    object(FONT_MONO, standardFont("Courier"));
    object(INFO, this.infoDictionary());

    for (const [index, pageId] of pageIds.entries()) {
      const contentId = contentIds[index] ?? pageId + 1;
      object(
        pageId,
        [
          "<< /Type /Page",
          `/Parent ${PAGES} 0 R`,
          `/MediaBox [0 0 ${format(this.pageWidth)} ${format(this.pageHeight)}]`,
          `/Resources << /Font << /F1 ${FONT_REGULAR} 0 R /F2 ${FONT_BOLD} 0 R /F3 ${FONT_MONO} 0 R >> >>`,
          `/Contents ${contentId} 0 R`,
          ">>",
        ].join(" "),
      );

      const stream = Buffer.from((this.pages[index] ?? []).join("\n"), "latin1");
      object(
        contentId,
        Buffer.concat([
          Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, "latin1"),
          stream,
          Buffer.from("\nendstream", "latin1"),
        ]),
      );
    }

    const maxId = contentIds.at(-1) ?? INFO;
    const xrefOffset = cursor;
    append(`xref\n0 ${maxId + 1}\n`);
    append("0000000000 65535 f \n");
    for (let id = 1; id <= maxId; id += 1) {
      append(`${String(offsets[id] ?? 0).padStart(10, "0")} 00000 n \n`);
    }
    append(`trailer\n<< /Size ${maxId + 1} /Root ${CATALOG} 0 R /Info ${INFO} 0 R >>\n`);
    append(`startxref\n${xrefOffset}\n%%EOF\n`);

    return Buffer.concat(chunks);
  }

  private infoDictionary(): string {
    return [
      "<<",
      `/Title ${pdfMetadataString(this.metadata.title)}`,
      `/Author ${pdfMetadataString(this.metadata.author)}`,
      `/Subject ${pdfMetadataString(this.metadata.subject)}`,
      `/Creator ${pdfMetadataString(this.metadata.creator)}`,
      `/Producer ${pdfMetadataString(this.metadata.creator)}`,
      `/CreationDate (${pdfDate(this.metadata.createdAt)})`,
      `/ModDate (${pdfDate(this.metadata.createdAt)})`,
      ">>",
    ].join(" ");
  }

  private current(): string[] {
    const page = this.pages.at(-1);
    if (page) return page;
    this.newPage();
    return this.pages[this.pages.length - 1] as string[];
  }
}

const CATALOG = 1;
const PAGES = 2;
const FONT_REGULAR = 3;
const FONT_BOLD = 4;
const FONT_MONO = 5;
const INFO = 6;
const FIRST_PAGE_OBJECT = 7;

function standardFont(baseFont: string): string {
  return `<< /Type /Font /Subtype /Type1 /BaseFont /${baseFont} /Encoding /WinAnsiEncoding >>`;
}

function fontResource(font: PdfFont): string {
  return font === "bold" ? "F2" : font === "mono" ? "F3" : "F1";
}

/** At most 4 decimals: enough for 72 dpi, and it keeps the streams readable. */
function format(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return String(Math.round(value * 10_000) / 10_000);
}

/** `D:YYYYMMDDHHmmSSZ` — the one date form every reader parses. */
function pdfDate(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `D:${String(at.getUTCFullYear()).padStart(4, "0")}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}` +
    `${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}Z`
  );
}

/**
 * A PDF literal string.
 *
 * Two things happen here and both are security-relevant, because every string in this
 * document originates in a repository or a model: the text is transliterated into
 * WinAnsi so no byte can be misread as a structural character, and `(`, `)` and `\`
 * are escaped so text can never close the string and inject operators. Control
 * characters are dropped for the same reason.
 */
function pdfString(value: string): string {
  let out = "";
  for (const character of value) {
    const byte = winAnsiByte(character);
    if (byte === null) continue;
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out += `\\${String.fromCharCode(byte)}`;
    else out += String.fromCharCode(byte);
  }
  return `(${out})`;
}

/**
 * A PDF *text* string, for the document information dictionary.
 *
 * Not the same encoding as the page content, and the difference is visible: a string in
 * `/Info` is read as PDFDocEncoding unless it opens with a UTF-16BE byte-order mark,
 * while the text drawn on a page is read through the font's WinAnsiEncoding. The two
 * disagree above 0x7f — an em dash written as the WinAnsi 0x97 is decoded by a reader as
 * `Š`, which is what a viewer would have shown in its title bar.
 *
 * So: plain ASCII goes out as a literal string, and anything else as a UTF-16BE hex
 * string, which every character can survive rather than being transliterated. Escaping
 * is not a concern in the hex form — there is no delimiter inside it to close.
 */
function pdfMetadataString(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return pdfString(value);

  let hex = "FEFF";
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0x3f;
    if (point > 0xffff) {
      // Surrogate pair: UTF-16BE stores it as two code units.
      const offset = point - 0x10000;
      hex += hex4(0xd800 + (offset >> 10)) + hex4(0xdc00 + (offset & 0x3ff));
    } else {
      hex += hex4(point);
    }
  }
  return `<${hex}>`;
}

function hex4(unit: number): string {
  return unit.toString(16).toUpperCase().padStart(4, "0");
}

/**
 * Unicode code point → WinAnsi byte, or `null` to drop it.
 *
 * The explicit map covers the punctuation that actually shows up in code comments and
 * model prose — curly quotes, dashes, ellipsis, bullet — because those arriving as `?`
 * is the difference between a readable quotation and a defaced one. Everything outside
 * cp1252 becomes `?`, which is visibly wrong rather than quietly wrong.
 */
const WIN_ANSI_SPECIALS = new Map<number, number>([
  [0x20ac, 0x80], // €
  [0x201a, 0x82],
  [0x0192, 0x83],
  [0x201e, 0x84],
  [0x2026, 0x85], // …
  [0x2020, 0x86],
  [0x2021, 0x87],
  [0x02c6, 0x88],
  [0x2030, 0x89],
  [0x0160, 0x8a],
  [0x2039, 0x8b],
  [0x0152, 0x8c],
  [0x017d, 0x8e],
  [0x2018, 0x91], // ‘
  [0x2019, 0x92], // ’
  [0x201c, 0x93], // “
  [0x201d, 0x94], // ”
  [0x2022, 0x95], // •
  [0x2013, 0x96], // –
  [0x2014, 0x97], // —
  [0x02dc, 0x98],
  [0x2122, 0x99], // ™
  [0x0161, 0x9a],
  [0x203a, 0x9b],
  [0x0153, 0x9c],
  [0x017e, 0x9e],
  [0x0178, 0x9f],
]);

function winAnsiByte(character: string): number | null {
  const code = character.codePointAt(0);
  if (code === undefined) return null;
  if (code === 0x09) return 0x20; // Tab → space; PDF text has no tab stops.
  if (code < 0x20) return null; // Newlines are the caller's business, not a glyph.
  if (code <= 0x7e) return code;
  const special = WIN_ANSI_SPECIALS.get(code);
  if (special !== undefined) return special;
  if (code >= 0xa0 && code <= 0xff) return code;
  return 0x3f; // "?"
}

/*
 * Helvetica advance widths, in 1/1000 em, for code points 32..126.
 *
 * The values are the font's own metrics, so a measured line is the width a reader will
 * actually see. Outside this range a conservative default is used: over-estimating a
 * width wraps early, which is a cosmetic flaw, while under-estimating overflows the
 * margin, which loses text.
 */
const HELVETICA_WIDTHS: readonly number[] = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

const FALLBACK_WIDTH = 556;
const COURIER_WIDTH = 600;
/** Helvetica-Bold runs a little wider; this over-estimates rather than overflowing. */
const BOLD_FACTOR = 1.05;

function advanceWidth(character: string, font: PdfFont): number {
  if (font === "mono") return COURIER_WIDTH;
  const code = character.codePointAt(0) ?? 32;
  const base = code >= 32 && code <= 126 ? (HELVETICA_WIDTHS[code - 32] ?? FALLBACK_WIDTH) : FALLBACK_WIDTH;
  return font === "bold" ? base * BOLD_FACTOR : base;
}

function breakLongWord(word: string, font: PdfFont, size: number, maxWidth: number): string[] {
  const pieces: string[] = [];
  let piece = "";
  for (const character of word) {
    const candidate = piece + character;
    if (piece !== "" && PdfWriter.measure(candidate, font, size) > maxWidth) {
      pieces.push(piece);
      piece = character;
      continue;
    }
    piece = candidate;
  }
  if (piece !== "") pieces.push(piece);
  return pieces.length > 0 ? pieces : [""];
}
