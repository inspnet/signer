const HTML_SPLITTERS = [
  /<div[^>]*class="gmail_quote"/i,
  /<blockquote[^>]*type="cite"/i,
  /<div[^>]*id="appendonsend"/i,
  /<hr[^>]*id="replySplit"/i,
  /<div[^>]*name="divRplyFwdMsg"/i,
  /<div[^>]*id="divRplyFwdMsg"/i,
  /<p[^>]*>\s*[-_]{2,}Original Message[-_]{2,}/i,
  /<b>From:<\/b>/i
];

const TEXT_SPLITTERS = [
  /^On .{10,120} wrote:$/m,
  /^-{2,} ?Original Message ?-{2,}/m,
  /^From: .+\nSent: /m,
  /^_{5,}$/m
];

export function isReplyMessage(headers: { inReplyTo?: string; references?: string; subject?: string }, text: string): boolean {
  if (headers.inReplyTo || headers.references) return true;
  const subject = headers.subject || "";
  if (/^(re|fw|fwd)\s*:/i.test(subject)) return true;
  return TEXT_SPLITTERS.some((re) => re.test(text));
}

export function insertHtml(original: string, snippet: string): string {
  const injection = `<div class="signer-signature" style="margin-top:12px;">${snippet}</div>`;
  if (!original) {
    return `<!DOCTYPE html><html><body>${injection}</body></html>`;
  }
  for (const re of HTML_SPLITTERS) {
    const match = re.exec(original);
    if (match && match.index > 0) {
      return `${original.slice(0, match.index)}${injection}${original.slice(match.index)}`;
    }
  }
  const bodyClose = original.lastIndexOf("</body>");
  if (bodyClose !== -1) {
    return `${original.slice(0, bodyClose)}${injection}${original.slice(bodyClose)}`;
  }
  return `${original}${injection}`;
}

export function insertText(original: string, snippet: string): string {
  const injection = `\n\n${snippet}\n`;
  if (!original) return snippet;
  for (const re of TEXT_SPLITTERS) {
    const match = re.exec(original);
    if (match && match.index > 0) {
      return `${original.slice(0, match.index)}${injection}${original.slice(match.index)}`;
    }
  }
  return `${original}${injection}`;
}

export function latestBodyText(full: string): string {
  for (const re of TEXT_SPLITTERS) {
    const match = re.exec(full);
    if (match && match.index > 0) return full.slice(0, match.index);
  }
  return full;
}
