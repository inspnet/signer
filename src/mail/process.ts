import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import { convert } from "html-to-text";
import { config } from "../config.js";
import {
  getSignature,
  getUserByEmail,
  listCampaigns,
  listDisclaimers,
  listSignatures,
  listUsers,
  parseJson,
  type CampaignRecord,
  type RuleSet,
  type SignatureRecord
} from "../db/index.js";
import { emptyUser, type DirectoryUser } from "../directory/fields.js";
import type { Design } from "./design.js";
import { insertHtml, insertText, isReplyMessage, latestBodyText } from "./insert.js";
import { renderDesign, renderPlainText } from "./render.js";
import { evaluateRules, type RuleContext } from "./rules.js";
import { defaultProfessionalDesign } from "./templates.js";

export type ProcessResult = {
  raw: Buffer;
  signatureId: string | null;
  disclaimerIds: string[];
  campaignIds: string[];
  skipped: boolean;
  reason: string;
};

export type TestInput = {
  from: string;
  to: string;
  subject?: string;
  body?: string;
  now?: Date;
};

export type TestResult = {
  signature: { id: string; name: string; html: string } | null;
  disclaimers: Array<{ id: string; name: string; html: string }>;
  campaigns: Array<{ id: string; name: string }>;
  details: Array<{
    kind: "signature" | "disclaimer" | "campaign";
    id: string;
    name: string;
    applied: boolean;
    stopProcessing: boolean;
    checks: Array<{ name: string; applicable: boolean; passed: boolean; detail: string }>;
  }>;
  htmlPreview: string;
};

type MatchDetail = TestResult["details"][number];

function addressesFrom(value?: AddressObject | AddressObject[]): string[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.flatMap((item) => item.value.map((v) => (v.address || "").toLowerCase()).filter(Boolean));
}

function internalDomains(): string[] {
  const fromUsers = new Set(listUsers().map((u) => u.domain).filter(Boolean));
  for (const d of (process.env.INTERNAL_DOMAINS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    fromUsers.add(d);
  }
  return [...fromUsers];
}

function senderUser(email: string): DirectoryUser {
  return getUserByEmail(email) ?? emptyUser(email);
}

function defaultRuleSet(): RuleSet {
  return {
    senders: { everyone: true },
    senderExceptions: {},
    recipients: { any: true },
    dateTime: null,
    advanced: { bodySearch: "anywhere", ifNotApplied: "continue" }
  };
}

function signaturesWithRules(): Array<SignatureRecord & { rules: RuleSet }> {
  return listSignatures().map((s) => ({ ...s, rules: getSignature(s.id)?.rules ?? defaultRuleSet() }));
}

function buildContext(input: {
  from: string;
  to: string[];
  subject: string;
  bodyText: string;
  isReply: boolean;
  now?: Date;
}): RuleContext {
  return {
    sender: senderUser(input.from),
    senderEmail: input.from.toLowerCase(),
    recipientEmails: input.to,
    internalDomains: internalDomains(),
    subject: input.subject,
    bodyText: input.bodyText,
    latestBodyText: latestBodyText(input.bodyText),
    isReply: input.isReply,
    now: input.now
  };
}

function firstMatching<T extends { id: string; name: string; enabled: number; rules: RuleSet }>(
  items: T[],
  ctx: RuleContext,
  kind: "signature"
): { chosen: T | null; details: MatchDetail[] } {
  const details: MatchDetail[] = [];
  for (const item of items) {
    if (!item.enabled) {
      details.push({
        kind,
        id: item.id,
        name: item.name,
        applied: false,
        stopProcessing: false,
        checks: [{ name: "Enabled", applicable: true, passed: false, detail: "Disabled" }]
      });
      continue;
    }
    const evaluation = evaluateRules(item.rules, ctx);
    details.push({
      kind,
      id: item.id,
      name: item.name,
      applied: evaluation.applied,
      stopProcessing: evaluation.stopProcessing,
      checks: evaluation.checks
    });
    if (evaluation.applied) return { chosen: item, details };
    if (evaluation.stopProcessing) return { chosen: null, details };
  }
  return { chosen: null, details };
}

function matchingAll<T extends { id: string; name: string; enabled: number; rules: RuleSet }>(
  items: T[],
  ctx: RuleContext,
  kind: "disclaimer" | "campaign"
): { chosen: T[]; details: MatchDetail[] } {
  const details: MatchDetail[] = [];
  const chosen: T[] = [];
  for (const item of items) {
    if (!item.enabled) {
      details.push({
        kind,
        id: item.id,
        name: item.name,
        applied: false,
        stopProcessing: false,
        checks: [{ name: "Enabled", applicable: true, passed: false, detail: "Disabled" }]
      });
      continue;
    }
    const evaluation = evaluateRules(item.rules, ctx);
    details.push({
      kind,
      id: item.id,
      name: item.name,
      applied: evaluation.applied,
      stopProcessing: evaluation.stopProcessing,
      checks: evaluation.checks
    });
    if (evaluation.applied) chosen.push(item);
  }
  return { chosen, details };
}

export function signatureHtml(sig: SignatureRecord, user: DirectoryUser): string {
  if (sig.htmlOverride?.trim()) {
    return sig.htmlOverride.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) => {
      const value = (user as unknown as Record<string, unknown>)[key];
      return value == null ? "" : String(value);
    });
  }
  const design = parseJson<Design>(sig.designJson, defaultProfessionalDesign());
  return renderDesign(design, user);
}

/** Only http(s), mailto and tel links belong in a signature; anything else
 * (javascript:, data:) is dropped rather than rendered into outbound mail. */
function safeUrl(value: string | null | undefined): string | null {
  const url = (value || "").trim();
  if (!url) return null;
  if (/^(https?:|mailto:|tel:)/i.test(url)) return url;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return null;
  return url.startsWith("//") ? null : `https://${url}`;
}

function campaignHtml(camp: CampaignRecord): string {
  const src = safeUrl(camp.imageUrl);
  if (!src) return "";
  const alt = escapeHtmlAttr(camp.alt || camp.name);
  const img = `<img src="${escapeHtmlAttr(src)}" alt="${alt}" style="display:block;border:0;margin-top:8px;max-width:460px;" />`;
  const href = safeUrl(camp.href);
  return href ? `<a href="${escapeHtmlAttr(href)}">${img}</a>` : img;
}

function assembleSnippet(tested: TestResult, campaigns: CampaignRecord[]): string {
  const byId = new Map(campaigns.map((c) => [c.id, c]));
  return [
    tested.signature?.html,
    ...tested.campaigns.map((c) => {
      const record = byId.get(c.id);
      return record ? campaignHtml(record) : "";
    }),
    ...tested.disclaimers.map((d) => d.html)
  ]
    .filter(Boolean)
    .join("");
}

export function evaluateMessage(ctx: RuleContext, bodyPreview: string): TestResult {
  const sigEval = firstMatching(signaturesWithRules(), ctx, "signature");
  const discEval = matchingAll(listDisclaimers(), ctx, "disclaimer");
  const campEval = matchingAll(listCampaigns(), ctx, "campaign");
  const signature = sigEval.chosen
    ? { id: sigEval.chosen.id, name: sigEval.chosen.name, html: signatureHtml(sigEval.chosen, ctx.sender) }
    : null;
  const snippet = [
    signature?.html,
    ...campEval.chosen.map((c) => campaignHtml(c)),
    ...discEval.chosen.map((d) => d.html)
  ]
    .filter(Boolean)
    .join("");
  return {
    signature,
    disclaimers: discEval.chosen.map((d) => ({ id: d.id, name: d.name, html: d.html })),
    campaigns: campEval.chosen.map((c) => ({ id: c.id, name: c.name })),
    details: [...sigEval.details, ...campEval.details, ...discEval.details],
    htmlPreview: insertHtml(`<p>${escapeHtml(bodyPreview).replace(/\n/g, "<br/>")}</p>`, snippet)
  };
}

export function testSignature(input: TestInput): TestResult {
  const body = input.body || "Hello, this is a test message.";
  const ctx = buildContext({
    from: input.from,
    to: [input.to.toLowerCase()],
    subject: input.subject || "Test",
    bodyText: body,
    isReply: isReplyMessage({ subject: input.subject }, body),
    now: input.now
  });
  return evaluateMessage(ctx, body);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtmlAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * Content types this gateway must not rewrite.
 *
 * composeRfc822 rebuilds the message from the parsed text/html bodies plus the
 * attachment list, which is lossy: any part that is neither text/plain,
 * text/html nor an attachment is simply gone. For a meeting invite that means
 * the invite disappears; for signed or encrypted mail it means the signature no
 * longer verifies or the payload is destroyed. Those messages are relayed
 * untouched instead — an unsigned message is always better than a broken one.
 */
const UNSAFE_TO_REWRITE = [
  /content-type:\s*text\/calendar/i,
  /content-type:\s*multipart\/signed/i,
  /content-type:\s*multipart\/encrypted/i,
  /content-type:\s*application\/pkcs7-mime/i,
  /content-type:\s*application\/x-pkcs7-mime/i,
  /content-type:\s*application\/pgp-encrypted/i,
  /content-type:\s*multipart\/report/i
];

function unsafeToRewrite(raw: Buffer): string | null {
  const text = raw.toString("latin1");
  for (const re of UNSAFE_TO_REWRITE) {
    const match = re.exec(text);
    if (match) return match[0].replace(/\s+/g, " ").trim();
  }
  return null;
}

/**
 * Add the loop-prevention header to a message that is otherwise passed through
 * byte for byte, so the connector does not send it back to us. Prepending keeps
 * the rest of the message — and therefore any DKIM signature over it — intact.
 */
export function withProcessedHeader(raw: Buffer): Buffer {
  const headerLine = Buffer.from(`${config.processedHeader}: true\r\n`, "utf8");
  return Buffer.concat([headerLine, raw]);
}

export async function processRawMessage(raw: Buffer, envelopeFrom: string, envelopeTo: string[]): Promise<ProcessResult> {
  const unsafe = unsafeToRewrite(raw);
  if (unsafe) {
    return {
      raw: withProcessedHeader(raw),
      signatureId: null,
      disclaimerIds: [],
      campaignIds: [],
      skipped: true,
      reason: `Passed through untouched: ${unsafe} cannot be rebuilt without losing content`
    };
  }
  const parsed = await simpleParser(raw);
  const from = (addressesFrom(parsed.from)[0] || envelopeFrom || "").toLowerCase();
  const to = [...new Set([...envelopeTo.map((e) => e.toLowerCase()), ...addressesFrom(parsed.to)])];
  const html = typeof parsed.html === "string" ? parsed.html : "";
  const text = parsed.text || (html ? convert(html) : "");
  const ctx = buildContext({
    from,
    to,
    subject: parsed.subject || "",
    bodyText: text,
    isReply: isReplyMessage(
      {
        inReplyTo: parsed.inReplyTo,
        references: Array.isArray(parsed.references) ? parsed.references.join(" ") : parsed.references,
        subject: parsed.subject
      },
      text
    )
  });
  const tested = evaluateMessage(ctx, text);
  const snippetHtml = assembleSnippet(tested, listCampaigns());

  // Nothing to add: relay the original bytes rather than recomposing them.
  // Rebuilding a message we are not changing only risks losing structure.
  if (!snippetHtml) {
    return {
      raw: withProcessedHeader(raw),
      signatureId: null,
      disclaimerIds: [],
      campaignIds: [],
      skipped: true,
      reason: "No matching signature, campaign, or disclaimer"
    };
  }

  const nextHtml = insertHtml(html || `<div>${escapeHtml(text)}</div>`, snippetHtml);
  const nextText = insertText(text, renderPlainText(snippetHtml));
  const composed = await composeRfc822(parsed, nextHtml, nextText);
  return {
    raw: composed,
    signatureId: tested.signature?.id ?? null,
    disclaimerIds: tested.disclaimers.map((d) => d.id),
    campaignIds: tested.campaigns.map((c) => c.id),
    skipped: false,
    reason: "signed"
  };
}

function addressText(value?: AddressObject | AddressObject[]): string | undefined {
  if (!value) return undefined;
  return Array.isArray(value) ? value.map((item) => item.text).join(", ") : value.text;
}

/**
 * Headers MailComposer sets itself, plus the ones invalidated by rewriting the
 * body. Everything else is carried over verbatim.
 *
 * DKIM signatures are dropped deliberately: the body changed, so the original
 * signature no longer verifies. Microsoft 365 and Google re-sign the message
 * when it is returned through their connectors.
 */
const REPLACED_HEADERS = new Set([
  "content-type",
  "content-transfer-encoding",
  "content-disposition",
  "content-id",
  "content-description",
  "mime-version",
  "dkim-signature",
  "domainkey-signature",
  "from",
  "to",
  "cc",
  "bcc",
  "reply-to",
  "subject",
  "date",
  "message-id",
  "in-reply-to",
  "references"
]);

/**
 * Carry headers across using the raw header lines rather than the parsed
 * `headers` map. mailparser turns structured headers (Reply-To, Return-Path,
 * List-*, Received, ...) into objects, and a `typeof value === "string"` filter
 * silently drops every one of them.
 */
function carriedHeaders(parsed: ParsedMail): Array<{ key: string; value: string }> {
  const carried: Array<{ key: string; value: string }> = [];
  for (const line of parsed.headerLines || []) {
    const key = line.key.toLowerCase();
    if (REPLACED_HEADERS.has(key)) continue;
    if (key === config.processedHeader.toLowerCase()) continue;
    const separator = line.line.indexOf(":");
    if (separator === -1) continue;
    const value = line.line
      .slice(separator + 1)
      .replace(/\r?\n[ \t]+/g, " ")
      .trim();
    if (!value) continue;
    carried.push({ key: line.line.slice(0, separator).trim(), value });
  }
  return carried;
}

async function composeRfc822(parsed: ParsedMail, html: string, text: string): Promise<Buffer> {
  const { default: MailComposer } = await import("nodemailer/lib/mail-composer/index.js");
  const extraHeaders = carriedHeaders(parsed);
  extraHeaders.push({ key: config.processedHeader, value: "true" });
  const composer = new MailComposer({
    from: addressText(parsed.from),
    to: addressText(parsed.to),
    cc: addressText(parsed.cc),
    bcc: addressText(parsed.bcc),
    replyTo: addressText(parsed.replyTo),
    subject: parsed.subject,
    text,
    html: html || undefined,
    attachments: (parsed.attachments || []).map((a) => ({
      filename: a.filename,
      content: a.content,
      contentType: a.contentType,
      cid: a.cid,
      contentDisposition: a.contentDisposition === "inline" ? "inline" : "attachment"
    })),
    headers: extraHeaders,
    inReplyTo: parsed.inReplyTo,
    references: parsed.references,
    messageId: parsed.messageId,
    date: parsed.date
  });
  const compiled = composer.compile();
  return await new Promise((resolve, reject) => {
    compiled.build((err: Error | null, message: Buffer) => {
      if (err) reject(err);
      else resolve(message);
    });
  });
}
