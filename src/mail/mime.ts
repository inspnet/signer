import iconv from "iconv-lite";

/**
 * Edits a message's body text in place and leaves every other byte alone.
 *
 * Signing used to parse the whole message, attachments included, and compose
 * a new one. For a 100 MB message that meant several copies of every
 * attachment in memory, decoded and re-encoded. Here the message is only
 * scanned for its MIME boundaries: the text/html and text/plain body parts
 * are decoded, the signature goes into them, and they are spliced back in.
 * Attachments, inline images and everything else are copied through as the
 * exact bytes Microsoft or Google sent.
 *
 * The scan works on the raw Buffer (latin1 offsets equal byte offsets), so
 * nothing larger than a header block or a body part becomes a string.
 */

export type MimePart = {
  start: number;
  /** First byte of the body; equals `start` when the part has no headers. */
  bodyStart: number;
  /** Exclusive end, before the line break that precedes the next boundary. */
  end: number;
  headerText: string;
  type: string;
  params: Record<string, string>;
  encoding: string;
  disposition: string;
  children: MimePart[];
  parent?: MimePart;
  /** For a multipart: where its closing "--boundary--" line starts. */
  closeAt?: number;
};

/** An image carried inside the message and referenced from the HTML as cid:<cid>. */
export type InlineImage = { cid: string; filename: string; contentType: string; content: Buffer };

const MAX_DEPTH = 20;

function headerEnd(buf: Buffer, start: number, end: number): { headerEnd: number; bodyStart: number } {
  if (buf[start] === 0x0d && buf[start + 1] === 0x0a) return { headerEnd: start, bodyStart: start + 2 };
  if (buf[start] === 0x0a) return { headerEnd: start, bodyStart: start + 1 };
  const crlf = buf.indexOf("\r\n\r\n", start, "latin1");
  const lf = buf.indexOf("\n\n", start, "latin1");
  const candidates = [
    crlf >= 0 && crlf < end ? { headerEnd: crlf, bodyStart: crlf + 4 } : null,
    lf >= 0 && lf < end ? { headerEnd: lf, bodyStart: lf + 2 } : null
  ].filter(Boolean) as Array<{ headerEnd: number; bodyStart: number }>;
  if (!candidates.length) return { headerEnd: end, bodyStart: end };
  return candidates.sort((a, b) => a.headerEnd - b.headerEnd)[0]!;
}

/** Logical header lines (folded continuations kept with their header). */
export function headerLines(headerText: string): string[] {
  return headerText ? headerText.split(/\r?\n(?![ \t])/).filter((l) => l.length) : [];
}

function headerValue(lines: string[], name: string): string {
  const prefix = `${name.toLowerCase()}:`;
  const line = lines.find((l) => l.toLowerCase().startsWith(prefix));
  return line ? line.slice(prefix.length).replace(/\r?\n[ \t]+/g, " ").trim() : "";
}

function parseParams(value: string): { main: string; params: Record<string, string> } {
  const [main = "", ...rest] = value.split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  const params: Record<string, string> = {};
  for (const p of rest) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    const key = p.slice(0, eq).trim().toLowerCase();
    let val = p.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1).replace(/\\(.)/g, "$1");
    params[key] = val;
  }
  return { main: main.trim().toLowerCase(), params };
}

export function parsePart(buf: Buffer, start: number, end: number, depth = 0): MimePart {
  const h = headerEnd(buf, start, end);
  const headerText = buf.toString("latin1", start, h.headerEnd);
  const lines = headerLines(headerText);
  const ct = parseParams(headerValue(lines, "Content-Type") || "text/plain");
  const part: MimePart = {
    start,
    bodyStart: Math.min(h.bodyStart, end),
    end,
    headerText,
    type: ct.main || "text/plain",
    params: ct.params,
    encoding: headerValue(lines, "Content-Transfer-Encoding").toLowerCase() || "7bit",
    disposition: parseParams(headerValue(lines, "Content-Disposition")).main,
    children: []
  };
  if (part.type.startsWith("multipart/") && part.params.boundary && depth < MAX_DEPTH) {
    const split = splitMultipart(buf, part.bodyStart, end, part.params.boundary);
    part.closeAt = split.closeAt;
    part.children = split.parts.map((c) => {
      const child = parsePart(buf, c.start, c.end, depth + 1);
      child.parent = part;
      return child;
    });
  }
  return part;
}

/** Child ranges between "--boundary" lines; stops at "--boundary--". */
function splitMultipart(
  buf: Buffer,
  start: number,
  end: number,
  boundary: string
): { parts: Array<{ start: number; end: number }>; closeAt?: number } {
  const delimiter = `--${boundary}`;
  const marks: Array<{ at: number; close: boolean; next: number }> = [];
  let pos = start;
  while (pos < end) {
    const at = buf.indexOf(delimiter, pos, "latin1");
    if (at < 0 || at >= end) break;
    const after = at + delimiter.length;
    const atLineStart = at === start || buf[at - 1] === 0x0a;
    const close = buf[after] === 0x2d && buf[after + 1] === 0x2d;
    const tail = close ? after + 2 : after;
    const endsLine = tail >= end || buf[tail] === 0x0d || buf[tail] === 0x0a || buf[tail] === 0x20 || buf[tail] === 0x09;
    if (atLineStart && endsLine) {
      const nl = buf.indexOf(0x0a, tail);
      marks.push({ at, close, next: nl < 0 || nl >= end ? end : nl + 1 });
      if (close) break;
    }
    pos = after;
  }
  const parts: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < marks.length - 1; i++) {
    const mark = marks[i]!;
    if (mark.close) break;
    let partEnd = marks[i + 1]!.at;
    if (buf[partEnd - 1] === 0x0a) partEnd -= 1;
    if (buf[partEnd - 1] === 0x0d) partEnd -= 1;
    parts.push({ start: mark.next, end: Math.max(mark.next, partEnd) });
  }
  const close = marks.find((m) => m.close);
  return { parts, closeAt: close?.at };
}

export type BodyParts = { html?: MimePart; text?: MimePart };

/**
 * The message's own body: not attachments, not attached messages. In
 * multipart/mixed and multipart/related the body is the first part (the rest
 * are attachments or the images it shows); in multipart/alternative every
 * part is a version of the body.
 */
export function findBody(part: MimePart): BodyParts {
  if (part.disposition === "attachment") return {};
  if (part.type === "text/html") return { html: part };
  if (part.type === "text/plain") return { text: part };
  if (part.type === "multipart/alternative") {
    const found: BodyParts = {};
    for (const child of part.children) {
      const inner = findBody(child);
      found.html ??= inner.html;
      found.text ??= inner.text;
    }
    return found;
  }
  if (part.type.startsWith("multipart/") && part.children.length) return findBody(part.children[0]!);
  return {};
}

function decodeTransfer(raw: Buffer, encoding: string): Buffer {
  if (encoding === "base64") return Buffer.from(raw.toString("latin1").replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
  if (encoding === "quoted-printable") {
    const s = raw
      .toString("latin1")
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    return Buffer.from(s, "latin1");
  }
  return raw;
}

export function decodeText(buf: Buffer, part: MimePart): string {
  const bytes = decodeTransfer(buf.subarray(part.bodyStart, part.end), part.encoding);
  const charset = (part.params.charset || "utf-8").toLowerCase();
  return iconv.encodingExists(charset) ? iconv.decode(bytes, charset) : bytes.toString("utf8");
}

/** Quoted-printable (RFC 2045) of UTF-8 text: readable, and 76-character lines. */
export function quotedPrintable(text: string): string {
  const out: string[] = [];
  for (const line of text.replace(/\r?\n/g, "\n").split("\n")) {
    const bytes = Buffer.from(line, "utf8");
    let encoded = "";
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i]!;
      const last = i === bytes.length - 1;
      const plain = (b >= 33 && b <= 126 && b !== 61) || ((b === 32 || b === 9) && !last);
      encoded += plain ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, "0")}`;
    }
    // Soft line breaks, never splitting an =XX escape.
    while (encoded.length > 76) {
      let cut = 75;
      const eq = encoded.lastIndexOf("=", cut);
      if (eq > cut - 3) cut = eq;
      out.push(`${encoded.slice(0, cut)}=`);
      encoded = encoded.slice(cut);
    }
    out.push(encoded);
  }
  return out.join("\r\n");
}

/** The part's headers, with its Content-Type and transfer encoding replaced. */
function rewriteHeaders(part: MimePart, contentType: string): string {
  const kept = headerLines(part.headerText).filter((l) => !/^content-(type|transfer-encoding)\s*:/i.test(l));
  return [...kept, `Content-Type: ${contentType}`, "Content-Transfer-Encoding: quoted-printable"].join("\r\n");
}

function textType(part: MimePart, type: string): string {
  const extra = Object.entries(part.params)
    .filter(([k]) => k !== "charset")
    .map(([k, v]) => `; ${k}="${v.replace(/"/g, '\\"')}"`)
    .join("");
  return `${type}; charset=utf-8${extra}`;
}

function base64Lines(data: Buffer): string {
  return (data.toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");
}

const quoteParam = (v: string) => `"${v.replace(/[\\"]/g, "\\$&").replace(/[\r\n]/g, "")}"`;

function imagePart(img: InlineImage): string {
  return [
    `Content-Type: ${img.contentType}; name=${quoteParam(img.filename)}`,
    "Content-Transfer-Encoding: base64",
    `Content-ID: <${img.cid}>`,
    `Content-Disposition: inline; filename=${quoteParam(img.filename)}`,
    "",
    base64Lines(img.content)
  ].join("\r\n");
}

const newBoundary = (kind: string) => `signer-${kind}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/** The HTML and its images as one multipart/related body (headers excluded). */
function relatedBody(boundary: string, htmlPart: string, images: InlineImage[]): string {
  return [htmlPart, ...images.map(imagePart)].map((p) => `--${boundary}\r\n${p}\r\n`).join("") + `--${boundary}--`;
}

function encodedText(type: string, text: string): string {
  return `Content-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${quotedPrintable(text)}`;
}

/**
 * The message with its body replaced. `html` goes into the HTML part; `text`
 * into the plain-text part. A message with only plain text gains an HTML
 * version next to it (multipart/alternative), as the signature needs HTML.
 * `images` are the signature's embedded images: they join the HTML's
 * multipart/related container, or the HTML part is wrapped in a new one.
 */
export function spliceBody(buf: Buffer, root: MimePart, body: BodyParts, html: string, text: string, images: InlineImage[] = []): Buffer {
  const edits: Array<{ start: number; end: number; bytes: Buffer }> = [];
  const replacePart = (part: MimePart, content: string) =>
    edits.push({ start: part.start, end: part.end, bytes: Buffer.from(content, "utf8") });
  const insertAt = (at: number, content: string) => edits.push({ start: at, end: at, bytes: Buffer.from(content, "utf8") });
  /** A part's own headers minus its content headers, for a wrapper that takes its place. */
  const outerHeaders = (part: MimePart, contentType: string) => {
    const kept = headerLines(part.headerText).filter((l) => !/^content-(type|transfer-encoding)\s*:/i.test(l));
    const headers = [...kept, `Content-Type: ${contentType}`];
    if (part === root && !kept.some((l) => /^mime-version\s*:/i.test(l))) headers.push("MIME-Version: 1.0");
    return headers.join("\r\n");
  };

  // The part is now UTF-8, so a charset in an HTML <meta> tag must say so too.
  html = html.replace(/(<meta\b[^>]*charset=["']?)[\w-]+/gi, "$1utf-8");

  if (body.html) {
    const part = body.html;
    const related = part.parent?.type === "multipart/related" && part.parent.closeAt !== undefined ? part.parent : null;
    if (!images.length || related) {
      replacePart(part, `${rewriteHeaders(part, textType(part, "text/html"))}\r\n\r\n${quotedPrintable(html)}`);
      if (images.length && related) {
        const boundary = related.params.boundary!;
        insertAt(related.closeAt!, images.map((img) => `--${boundary}\r\n${imagePart(img)}\r\n`).join(""));
      }
    } else {
      const boundary = newBoundary("rel");
      const inner = encodedText("text/html", html);
      replacePart(
        part,
        `${outerHeaders(part, `multipart/related; type="text/html"; boundary="${boundary}"`)}\r\n\r\n${relatedBody(boundary, inner, images)}`
      );
    }
  }
  if (body.text && body.html) {
    replacePart(body.text, `${rewriteHeaders(body.text, textType(body.text, "text/plain"))}\r\n\r\n${quotedPrintable(text)}`);
  }
  if (body.text && !body.html) {
    // Plain text only: the part becomes multipart/alternative with both versions.
    const boundary = newBoundary("alt");
    let htmlVersion = encodedText("text/html", html);
    if (images.length) {
      const rel = newBoundary("rel");
      htmlVersion = `Content-Type: multipart/related; type="text/html"; boundary="${rel}"\r\n\r\n${relatedBody(rel, htmlVersion, images)}`;
    }
    const alternative = `--${boundary}\r\n${encodedText("text/plain", text)}\r\n--${boundary}\r\n${htmlVersion}\r\n--${boundary}--`;
    replacePart(body.text, `${outerHeaders(body.text, `multipart/alternative; boundary="${boundary}"`)}\r\n\r\n${alternative}`);
  }

  edits.sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Buffer[] = [];
  let pos = 0;
  for (const edit of edits) {
    out.push(buf.subarray(pos, edit.start), edit.bytes);
    pos = edit.end;
  }
  out.push(buf.subarray(pos));
  return Buffer.concat(out);
}

/** The top-level header block, for parsing From, To, Subject and threading headers without the body. */
export function headerBlock(buf: Buffer): Buffer {
  const h = headerEnd(buf, 0, buf.length);
  return Buffer.concat([buf.subarray(0, h.headerEnd), Buffer.from("\r\n\r\n")]);
}
