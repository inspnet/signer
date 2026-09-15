/**
 * Place the signature under the latest reply, not at the bottom of the thread.
 *
 * Business clients top-post: new text first, then a quoted history. We find the
 * earliest quote/thread boundary in document order (across every client we know)
 * and insert immediately before it. Taking the first *pattern* in a list is wrong:
 * a later-listed marker that appears deeper in the thread would be skipped, and a
 * miss falls through to </body> — signatures then stack at the end of the conversation.
 *
 * Markers by client (HTML class names are also matched with Outlook's `x_` prefix):
 * - Gmail / Google: gmail_quote, gmail_quote_container, gmail_attr; "On … wrote:"
 * - Outlook / Exchange / M365: #appendonsend, #divRplyFwdMsg, OutlookMessageHeader,
 *   -----Original Message-----, From:/Sent: headers
 * - Apple Mail / iOS: <blockquote type="cite">, Begin forwarded message
 * - Thunderbird: moz-cite-prefix
 * - Yahoo / Proton: yahoo_quoted, protonmail_quote
 */

const STRONG_HTML_QUOTE: RegExp[] = [
  htmlClassRe("gmail_quote_container"),
  htmlClassRe("gmail_quote"),
  htmlClassRe("gmail_attr"),
  htmlClassRe("gmail_extra"),
  /<blockquote\b[^>]*\btype\s*=\s*["']?cite\b/i,
  htmlIdRe("divRplyFwdMsg"),
  htmlIdRe("divRplyFwdHeader"),
  htmlNameRe("divRplyFwdMsg"),
  htmlClassRe("OutlookMessageHeader"),
  htmlIdRe("mail-editor-reference-message-container"),
  htmlClassRe("moz-cite-prefix"),
  htmlClassRe("moz-forward-container"),
  htmlClassRe("yahoo_quoted"),
  htmlClassRe("protonmail_quote"),
  /<hr\b[^>]*\bid\s*=\s*["']?(?:x_)?replySplit\b/i,
  /(?:-{5,}|_{5,})\s*Original Message\s*(?:-{5,}|_{5,})/i,
  /(?:-{5,}|_{5,})\s*Forwarded [Mm]essage\s*(?:-{5,}|_{5,})/i,
  /Begin forwarded message:/i
];

/** Placeholders that can sit at the top of a compose body; only use if reply text precedes them. */
const WEAK_HTML_QUOTE: RegExp[] = [
  htmlIdRe("appendonsend"),
  /(?:<b>|<strong>|<span\b[^>]*>)\s*From:\s*(?:<\/b>|<\/strong>|<\/span>)[\s\S]{0,240}Sent:/i,
  /<b>\s*From:\s*<\/b>/i
];

const STRONG_TEXT_QUOTE: RegExp[] = [
  /^On\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\d).{0,160}wrote:\s*$/im,
  /^-{2,}\s*Original Message\s*-{2,}/im,
  /^-{2,}\s*Forwarded [Mm]essage\s*-{2,}/im,
  /^Begin forwarded message:\s*$/im,
  /^From: .+\nSent: /m
];

const WEAK_TEXT_QUOTE: RegExp[] = [/^_{5,}\s*$/m];

function htmlClassRe(className: string): RegExp {
  const name = `(?:x_)?${className}`;
  return new RegExp(
    `<[^>]+\\bclass\\s*=\\s*(?:(["'])[^"']*\\b${name}\\b[^"']*\\1|${name}(?=[\\s>]))`,
    "i"
  );
}

function htmlIdRe(id: string): RegExp {
  const name = `(?:x_)?${id}`;
  return new RegExp(`<[^>]+\\bid\\s*=\\s*(?:(["'])${name}\\1|${name}(?=[\\s>]))`, "i");
}

function htmlNameRe(name: string): RegExp {
  return new RegExp(`<[^>]+\\bname\\s*=\\s*(?:(["'])${name}\\1|${name}(?=[\\s>]))`, "i");
}

function firstIndex(haystack: string, re: RegExp): number {
  const copy = new RegExp(re.source, re.flags.replaceAll("g", ""));
  const match = copy.exec(haystack);
  return match ? match.index : -1;
}

function earliestIndex(haystack: string, regexes: RegExp[]): number {
  let min = -1;
  for (const re of regexes) {
    const index = firstIndex(haystack, re);
    if (index >= 0 && (min < 0 || index < min)) min = index;
  }
  return min;
}

function visibleText(html: string): string {
  return html
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(?:160|8203);/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function endOfElement(html: string, start: number): number {
  const tag = /^<([a-zA-Z][\w:-]*)\b/.exec(html.slice(start));
  if (!tag) return -1;
  const name = tag[1];
  const firstGt = html.indexOf(">", start);
  if (firstGt === -1) return -1;
  if (html[firstGt - 1] === "/" || /^(hr|br|img|input|meta|link)$/i.test(name)) {
    return firstGt + 1;
  }
  const open = new RegExp(`<${name}\\b`, "gi");
  const close = new RegExp(`</${name}\\s*>`, "gi");
  let depth = 1;
  let cursor = firstGt + 1;
  while (cursor < html.length && depth > 0) {
    open.lastIndex = cursor;
    close.lastIndex = cursor;
    const nextOpen = open.exec(html);
    const nextClose = close.exec(html);
    if (!nextClose) return -1;
    if (nextOpen && nextOpen.index < nextClose.index) {
      depth += 1;
      cursor = nextOpen.index + nextOpen[0].length;
    } else {
      depth -= 1;
      cursor = nextClose.index + nextClose[0].length;
    }
  }
  return depth === 0 ? cursor : -1;
}

function looksLikeBottomPost(html: string, quoteAt: number): boolean {
  if (visibleText(html.slice(0, quoteAt)).length >= 2) return false;
  if (html.charAt(quoteAt) !== "<") return false;
  const end = endOfElement(html, quoteAt);
  if (end < 0) return false;
  return visibleText(html.slice(end)).length >= 2;
}

function existingSignatureIndex(html: string): number {
  const index = firstIndex(html, htmlClassRe("signer-signature"));
  if (index < 0) return -1;
  if (visibleText(html.slice(0, index)).length < 2) return -1;
  return index;
}

function endOfBodyIndex(html: string): number {
  const bodyClose = html.lastIndexOf("</body>");
  return bodyClose === -1 ? html.length : bodyClose;
}

function htmlQuoteBoundary(html: string): number {
  const strong = earliestIndex(html, STRONG_HTML_QUOTE);
  const weak = earliestIndex(html, WEAK_HTML_QUOTE);
  const weakUsable = weak >= 0 && visibleText(html.slice(0, weak)).length >= 1 ? weak : -1;
  let boundary = -1;
  for (const index of [strong, weakUsable]) {
    if (index >= 0 && (boundary < 0 || index < boundary)) boundary = index;
  }
  return boundary;
}

export function findHtmlInsertIndex(html: string): number {
  const boundary = htmlQuoteBoundary(html);
  if (boundary >= 0 && !looksLikeBottomPost(html, boundary)) return boundary;
  const prior = existingSignatureIndex(html);
  if (prior >= 0) return prior;
  return endOfBodyIndex(html);
}

function quotedLineIndex(text: string): number {
  let pos = 0;
  let seenUnquoted = false;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const quoted = /^[ \t]*>/.test(line);
    const blank = line.trim() === "";
    const header = STRONG_TEXT_QUOTE.some((re) => new RegExp(re.source, re.flags.replaceAll("g", "")).test(line));
    if (!blank && !quoted && !header) seenUnquoted = true;
    if (seenUnquoted && quoted) return pos;
    pos += line.length + (i === lines.length - 1 ? 0 : 1);
  }
  return -1;
}

export function findTextInsertIndex(text: string): number {
  const strong = earliestIndex(text, STRONG_TEXT_QUOTE);
  const weak = earliestIndex(text, WEAK_TEXT_QUOTE);
  const quoted = quotedLineIndex(text);
  const candidates = [strong, weak, quoted].filter((index) => index > 0);
  if (!candidates.length) return text.length;
  return Math.min(...candidates);
}

export function isReplyMessage(
  headers: { inReplyTo?: string; references?: string; subject?: string },
  text: string
): boolean {
  if (headers.inReplyTo || headers.references) return true;
  const subject = headers.subject || "";
  if (/^(re|fw|fwd)\s*:/i.test(subject)) return true;
  if (earliestIndex(text, STRONG_TEXT_QUOTE) >= 0) return true;
  if (quotedLineIndex(text) >= 0) return true;
  return WEAK_TEXT_QUOTE.some((re) => re.test(text));
}

export function insertHtml(original: string, snippet: string): string {
  const injection = `<div class="signer-signature" style="margin-top:12px;">${snippet}</div>`;
  if (!original) {
    return `<!DOCTYPE html><html><body>${injection}</body></html>`;
  }
  const at = findHtmlInsertIndex(original);
  return `${original.slice(0, at)}${injection}${original.slice(at)}`;
}

export function insertText(original: string, snippet: string): string {
  const injection = `\n\n${snippet}\n`;
  if (!original) return snippet;
  const at = findTextInsertIndex(original);
  return `${original.slice(0, at)}${injection}${original.slice(at)}`;
}

export function latestBodyText(full: string): string {
  const at = findTextInsertIndex(full);
  if (at <= 0 || at >= full.length) return full;
  return full.slice(0, at);
}
