import { entraConfigured } from "../config.js";
import { domainNames, getSetting, getUserByEmail, setSetting } from "../db/index.js";
import { entraToken } from "../directory/sync.js";
import type { InlineImage } from "./mime.js";

/**
 * Sent Items update (Microsoft 365): after Signer returns a signed message,
 * the copy in the sender's Sent Items is swapped for the signed version, so
 * people see what recipients saw.
 *
 * Outlook saves the unsigned original to Sent Items when the user presses
 * Send, before the transport rule routes it through Signer. Microsoft Graph
 * cannot change the body of a sent message, so Signer:
 *
 *   1. finds the original in the sender's Sent Items by its Message-ID,
 *      retrying while Outlook saves it;
 *   2. creates the signed copy in Sent Items, with the original's sender,
 *      recipients, sent time and conversation index (so it stays in its
 *      thread and in date order), flagged as sent rather than a draft;
 *   3. copies the original's attachments onto it, server to server, using
 *      upload sessions for files of 3 MB and more (up to Graph's 150 MB);
 *   4. permanently deletes the original.
 *
 * If any step after 2 fails, the signed copy is deleted again and the
 * original is left as it was, so a failure never loses anything.
 *
 * Signer keeps only the signed body and its signature images per message
 * (kilobytes, not the attachments), in memory, until the swap is done or
 * given up (about a quarter of an hour). Nothing is written to disk.
 *
 * Exchange can split one message into several deliveries (for example,
 * internal and external recipients get different disclaimers), each signed
 * separately with the same Message-ID. Signer waits briefly to collect them
 * and keeps the version that went to outside recipients, which is what most
 * people received.
 *
 * Needs the Mail.ReadWrite Application permission on the Entra app.
 */

export type SentItemsSettings = { enabled: boolean; groupIds: string[] };
export type SentItemsResult = {
  at: string;
  sender: string;
  result: "updated" | "not-found" | "skipped" | "failed";
  detail: string;
};
/** What the Sent Items copy should show: the signed body and the images it embeds. */
export type SignedCopy = { html: string; text: string; inline: InlineImage[] };

const KEY = "sent_items";
const GRAPH = "https://graph.microsoft.com/v1.0";
/** Graph takes attachments under 3 MB in one request; larger ones need an upload session. */
export const UPLOAD_SESSION_FROM = 3 * 1024 * 1024;
const MAX_ATTACHMENT = 150 * 1024 * 1024;
/** Upload chunks must be multiples of 320 KiB. */
export const CHUNK = 320 * 1024 * 12;
const MAX_QUEUED_BYTES = 50 * 1024 * 1024;
/** Waits before each search: the first collects split deliveries, later ones give Outlook time to save. */
export const SEARCH_DELAYS_MS = [20_000, 30_000, 60_000, 120_000, 240_000, 480_000];

export const SENT_ITEMS_PERMISSION_HINT =
  "Signer's Entra app needs the Microsoft Graph Application permission Mail.ReadWrite, with admin consent " +
  "(Entra admin center → App registrations → the Signer app → API permissions). To limit it to the people " +
  "in scope, use RBAC for Applications in Exchange Online instead (see Settings → Sent Items).";

export function sentItemsSettings(): SentItemsSettings {
  try {
    const stored = JSON.parse(getSetting(KEY, "{}")) as Partial<SentItemsSettings>;
    return { enabled: Boolean(stored.enabled), groupIds: Array.isArray(stored.groupIds) ? stored.groupIds.map(String) : [] };
  } catch {
    return { enabled: false, groupIds: [] };
  }
}

export function saveSentItemsSettings(next: SentItemsSettings): void {
  setSetting(KEY, JSON.stringify(next));
}

/** Whether this sender's Sent Items should be updated. */
export function inScope(sender: string, settings: SentItemsSettings = sentItemsSettings()): boolean {
  if (!settings.enabled || !entraConfigured()) return false;
  const user = getUserByEmail(sender);
  if (!user || user.source !== "entra" || user.enabled === 0) return false;
  return !settings.groupIds.length || user.groupIds.some((g) => settings.groupIds.includes(g));
}

type Version = { copy: SignedCopy; recipients: string[]; bytes: number };
type Job = { sender: string; messageId: string; versions: Version[]; attempt: number; timer: NodeJS.Timeout | null };

const jobs = new Map<string, Job>();
let queuedBytes = 0;
const results: SentItemsResult[] = [];

export function recentSentItemsResults(): SentItemsResult[] {
  return [...results].reverse();
}

export function pendingSentItems(): number {
  return jobs.size;
}

/** For tests. */
export function resetSentItems(): void {
  for (const job of jobs.values()) if (job.timer) clearTimeout(job.timer);
  jobs.clear();
  queuedBytes = 0;
  results.length = 0;
}

function note(sender: string, result: SentItemsResult["result"], detail: string): void {
  results.push({ at: new Date().toISOString(), sender, result, detail });
  if (results.length > 50) results.shift();
  if (result === "failed") console.warn(`[signer] Sent Items update for ${sender} failed: ${detail}`);
}

/** The Message-ID from the header block, angle brackets included, as Graph stores it. */
export function messageIdOf(raw: Buffer): string {
  const end = raw.indexOf("\r\n\r\n", 0, "latin1");
  const lfEnd = raw.indexOf("\n\n", 0, "latin1");
  const stop = [end, lfEnd].filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? raw.length;
  const headers = raw.toString("latin1", 0, stop).replace(/\r?\n[ \t]+/g, " ");
  const match = /^Message-ID:[ \t]*(<[^>\r\n]+>)/im.exec(headers);
  return match ? match[1]! : "";
}

/** Called after a signed message was handed back. Never throws. */
export function queueSentItemsUpdate(sender: string, recipients: string[], messageId: string, copy: SignedCopy): void {
  try {
    if (!inScope(sender)) return;
    if (!messageId) return note(sender, "skipped", "The message has no Message-ID to find it by.");
    const bytes = copy.html.length + copy.text.length + copy.inline.reduce((n, i) => n + i.content.length, 0);
    if (queuedBytes + bytes > MAX_QUEUED_BYTES) {
      return note(sender, "skipped", "Too many messages waiting; this one was left as sent.");
    }
    queuedBytes += bytes;
    const key = `${sender.toLowerCase()}|${messageId}`;
    const existing = jobs.get(key);
    if (existing) {
      existing.versions.push({ copy, recipients, bytes });
      return;
    }
    const job: Job = { sender, messageId, versions: [{ copy, recipients, bytes }], attempt: 0, timer: null };
    jobs.set(key, job);
    schedule(key, job);
  } catch (err) {
    console.error("[signer] Could not queue a Sent Items update", err);
  }
}

function schedule(key: string, job: Job): void {
  const delay = SEARCH_DELAYS_MS[job.attempt];
  if (delay === undefined) {
    finish(key, job);
    return note(job.sender, "not-found", "The original never appeared in Sent Items (sent by an app, or from a shared mailbox?).");
  }
  job.timer = setTimeout(() => void attempt(key, job), delay);
  job.timer.unref?.();
}

function finish(key: string, job: Job): void {
  if (job.timer) clearTimeout(job.timer);
  jobs.delete(key);
  for (const v of job.versions) queuedBytes -= v.bytes;
}

/** The version most recipients saw: the one that went outside the organisation, if any. */
function chooseVersion(versions: Version[]): Version {
  const internal = new Set(domainNames());
  return versions.find((v) => v.recipients.some((r) => !internal.has(r.split("@")[1]?.toLowerCase() ?? ""))) ?? versions[0]!;
}

class GraphError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

async function graphError(res: Response, what: string): Promise<GraphError> {
  const text = await res.text().catch(() => "");
  let message = text.slice(0, 300);
  try {
    message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
  } catch {
    /* not JSON */
  }
  return new GraphError(res.status, `Microsoft Graph ${what} answered ${res.status}: ${message}`);
}

async function graph<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${GRAPH}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000)
  });
  if (!res.ok) throw await graphError(res, method);
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

type Recipient = { emailAddress: { name?: string; address: string } };
type Original = {
  id: string;
  subject?: string;
  importance?: string;
  sentDateTime?: string;
  from?: Recipient;
  sender?: Recipient;
  toRecipients?: Recipient[];
  ccRecipients?: Recipient[];
  bccRecipients?: Recipient[];
  replyTo?: Recipient[];
  singleValueExtendedProperties?: Array<{ id: string; value: string }>;
};
type AttachmentInfo = { "@odata.type"?: string; id: string; name: string; contentType?: string; size: number; isInline?: boolean };

const CONVERSATION_INDEX = "Binary 0x71";
const mailbox = (sender: string) => `/users/${encodeURIComponent(sender)}`;

export async function findOriginal(token: string, sender: string, messageId: string): Promise<Original | null> {
  const filter = `internetMessageId eq '${messageId.replace(/'/g, "''")}'`;
  const select = "id,subject,importance,sentDateTime,from,sender,toRecipients,ccRecipients,bccRecipients,replyTo";
  const expand = `singleValueExtendedProperties($filter=id eq '${CONVERSATION_INDEX}')`;
  const page = await graph<{ value: Original[] }>(
    token,
    "GET",
    `${mailbox(sender)}/mailFolders/SentItems/messages?$filter=${encodeURIComponent(filter)}` +
      `&$select=${select}&$expand=${encodeURIComponent(expand)}`
  );
  return page.value[0] ?? null;
}

/** The signed copy: the new body and signature images, with the original's envelope and metadata. */
export function replacementFor(original: Original, copy: SignedCopy, messageId: string): Record<string, unknown> {
  const when = original.sentDateTime ?? new Date().toISOString();
  const conversationIndex = original.singleValueExtendedProperties?.find((p) => p.id.toLowerCase() === CONVERSATION_INDEX.toLowerCase());
  return {
    subject: original.subject ?? "",
    importance: original.importance ?? "normal",
    body: copy.html ? { contentType: "html", content: copy.html } : { contentType: "text", content: copy.text },
    from: original.from,
    sender: original.sender ?? original.from,
    toRecipients: original.toRecipients ?? [],
    ccRecipients: original.ccRecipients ?? [],
    bccRecipients: original.bccRecipients ?? [],
    replyTo: original.replyTo ?? [],
    isRead: true,
    attachments: copy.inline.map((img) => ({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: img.filename,
      contentType: img.contentType,
      contentBytes: img.content.toString("base64"),
      isInline: true,
      contentId: img.cid
    })),
    singleValueExtendedProperties: [
      // PR_MESSAGE_FLAGS = read, without "unsent": shown as sent, not as a draft.
      { id: "Integer 0x0E07", value: "1" },
      // Sent and delivery time, so it keeps its place in date order.
      { id: "SystemTime 0x0039", value: when },
      { id: "SystemTime 0x0E06", value: when },
      // The Message-ID, so replies and later searches still match it.
      { id: "String 0x1035", value: messageId },
      ...(conversationIndex ? [{ id: CONVERSATION_INDEX, value: conversationIndex.value }] : [])
    ]
  };
}

async function listAttachments(token: string, sender: string, messageId: string): Promise<AttachmentInfo[]> {
  const page = await graph<{ value: AttachmentInfo[] }>(
    token,
    "GET",
    `${mailbox(sender)}/messages/${encodeURIComponent(messageId)}/attachments?$select=id,name,contentType,size,isInline`
  );
  return page.value;
}

/** Streams one file from `source` into an upload session on `targetMessage`, a chunk at a time. */
async function uploadLarge(token: string, sender: string, targetMessage: string, att: AttachmentInfo, source: Response): Promise<void> {
  const size = Number(source.headers.get("content-length"));
  if (!size) throw new Error(`Could not read the size of ${att.name}`);
  const session = await graph<{ uploadUrl: string }>(
    token,
    "POST",
    `${mailbox(sender)}/messages/${encodeURIComponent(targetMessage)}/attachments/createUploadSession`,
    { AttachmentItem: { attachmentType: "file", name: att.name, size, contentType: att.contentType, isInline: Boolean(att.isInline) } }
  );
  const reader = source.body!.getReader();
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let offset = 0;
  const put = async (chunk: Buffer) => {
    // The upload URL carries its own authorisation; an Authorization header is refused.
    const res = await fetch(session.uploadUrl, {
      method: "PUT",
      headers: { "Content-Length": String(chunk.length), "Content-Range": `bytes ${offset}-${offset + chunk.length - 1}/${size}` },
      body: new Uint8Array(chunk),
      signal: AbortSignal.timeout(120_000)
    });
    if (!res.ok) throw await graphError(res, `upload of ${att.name}`);
    offset += chunk.length;
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (value) {
      pending.push(Buffer.from(value));
      pendingBytes += value.length;
    }
    while (pendingBytes >= CHUNK || (done && pendingBytes > 0)) {
      const all = Buffer.concat(pending, pendingBytes);
      const take = Math.min(CHUNK, all.length);
      await put(all.subarray(0, take));
      pending = take < all.length ? [all.subarray(take)] : [];
      pendingBytes = all.length - take;
    }
    if (done) break;
  }
  if (offset !== size) throw new Error(`Uploaded ${offset} of ${size} bytes of ${att.name}`);
}

/** Copies every attachment of `from` onto `to`, both in the sender's mailbox. */
async function copyAttachments(token: string, sender: string, from: string, to: string, attachments: AttachmentInfo[]): Promise<void> {
  const base = `${mailbox(sender)}/messages`;
  for (const att of attachments) {
    if (att.size < UPLOAD_SESSION_FROM) {
      const full = await graph<Record<string, unknown>>(token, "GET", `${base}/${encodeURIComponent(from)}/attachments/${encodeURIComponent(att.id)}`);
      await graph(token, "POST", `${base}/${encodeURIComponent(to)}/attachments`, {
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: full.name,
        contentType: full.contentType,
        contentBytes: full.contentBytes,
        isInline: full.isInline,
        ...(full.contentId ? { contentId: full.contentId } : {})
      });
    } else {
      const source = await fetch(`${GRAPH}${base}/${encodeURIComponent(from)}/attachments/${encodeURIComponent(att.id)}/$value`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(600_000)
      });
      if (!source.ok) throw await graphError(source, `download of ${att.name}`);
      await uploadLarge(token, sender, to, att, source);
    }
  }
}

async function permanentlyDelete(token: string, sender: string, id: string): Promise<void> {
  try {
    await graph(token, "POST", `${mailbox(sender)}/messages/${encodeURIComponent(id)}/permanentDelete`);
  } catch (err) {
    if (!(err instanceof GraphError) || err.status >= 500) throw err;
    await graph(token, "DELETE", `${mailbox(sender)}/messages/${encodeURIComponent(id)}`);
  }
}

/** Steps 2–4 for one found original; throws with the original untouched if anything fails. */
async function swap(token: string, sender: string, original: Original, copy: SignedCopy, messageId: string): Promise<string | null> {
  const attachments = await listAttachments(token, sender, original.id);
  const unsupported = attachments.find((a) => a["@odata.type"] && a["@odata.type"] !== "#microsoft.graph.fileAttachment");
  if (unsupported) return `It contains "${unsupported.name}", an attached email or cloud file, which Graph cannot copy; left as sent.`;
  const tooBig = attachments.find((a) => a.size > MAX_ATTACHMENT);
  if (tooBig) return `"${tooBig.name}" is over Graph's 150 MB attachment limit; left as sent.`;

  const created = await graph<{ id: string }>(token, "POST", `${mailbox(sender)}/mailFolders/SentItems/messages`, replacementFor(original, copy, messageId));
  try {
    await copyAttachments(token, sender, original.id, created.id, attachments);
  } catch (err) {
    // Undo: the original stays, the half-built copy goes.
    await permanentlyDelete(token, sender, created.id).catch(() => undefined);
    throw err;
  }
  await permanentlyDelete(token, sender, original.id);
  return null;
}

async function attempt(key: string, job: Job): Promise<void> {
  job.timer = null;
  job.attempt += 1;
  try {
    const token = await entraToken();
    const original = await findOriginal(token, job.sender, job.messageId);
    if (!original) return schedule(key, job);
    const skipped = await swap(token, job.sender, original, chooseVersion(job.versions).copy, job.messageId);
    finish(key, job);
    if (skipped) return note(job.sender, "skipped", skipped);
    note(job.sender, "updated", `"${original.subject ?? ""}" replaced with the signed version.`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof GraphError && (err.status === 401 || err.status === 403)) {
      finish(key, job);
      return note(job.sender, "failed", `${message} ${SENT_ITEMS_PERMISSION_HINT}`);
    }
    if (job.attempt < SEARCH_DELAYS_MS.length && (!(err instanceof GraphError) || err.status === 429 || err.status >= 500)) {
      return schedule(key, job);
    }
    finish(key, job);
    note(job.sender, "failed", message);
  }
}

export type CheckStep = { step: string; ok: boolean; detail: string };

/**
 * Settings → Sent Items → Run the check: the whole procedure on a throwaway
 * message in the admin's own Sent Items, including a file large enough to
 * need an upload session, then deletes it. Shows on this tenant, before
 * anyone's mail depends on it, that every Graph call Signer needs works.
 */
export async function checkSentItems(adminMailbox: string): Promise<{ ok: boolean; steps: CheckStep[]; hint: string }> {
  const steps: CheckStep[] = [];
  if (!entraConfigured()) {
    return { ok: false, steps, hint: "Sign-in with Microsoft (ENTRA_*) is not configured on this server." };
  }
  const run = async <T>(step: string, fn: () => Promise<T>, detail: (value: T) => string): Promise<T> => {
    try {
      const value = await fn();
      steps.push({ step, ok: true, detail: detail(value) });
      return value;
    } catch (err) {
      steps.push({ step, ok: false, detail: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  };
  let token = "";
  let createdId = "";
  let hint = "";
  try {
    token = await run("Sign in as the Entra app", () => entraToken(), () => "Got an app token");
    await run(
      `Open ${adminMailbox}'s Sent Items`,
      () => graph(token, "GET", `${mailbox(adminMailbox)}/mailFolders/SentItems?$select=id`),
      () => "Allowed"
    );
    const messageId = `<signer-check-${Date.now()}@signer.invalid>`;
    const created = await run(
      "Create a sent (not draft) message",
      () =>
        graph<{ id: string; isDraft?: boolean }>(
          token,
          "POST",
          `${mailbox(adminMailbox)}/mailFolders/SentItems/messages`,
          replacementFor(
            {
              id: "",
              subject: "Signer Sent Items check (deleted automatically)",
              from: { emailAddress: { address: adminMailbox } },
              toRecipients: [{ emailAddress: { address: adminMailbox } }]
            },
            { html: "<p>Signer check. This message deletes itself.</p>", text: "", inline: [] },
            messageId
          )
        ),
      (m) => (m.isDraft ? "Created, but marked as a draft" : "Created as a sent message")
    );
    createdId = created.id;
    const small = Buffer.alloc(64 * 1024, 1);
    await run(
      "Attach a small file",
      () =>
        graph(token, "POST", `${mailbox(adminMailbox)}/messages/${encodeURIComponent(createdId)}/attachments`, {
          "@odata.type": "#microsoft.graph.fileAttachment",
          name: "signer-check-small.bin",
          contentType: "application/octet-stream",
          contentBytes: small.toString("base64")
        }),
      () => "Attached 64 KB"
    );
    const large = Buffer.alloc(UPLOAD_SESSION_FROM + 512 * 1024, 2);
    await run(
      "Attach a 3.5 MB file through an upload session",
      () =>
        uploadLarge(
          token,
          adminMailbox,
          createdId,
          { id: "", name: "signer-check-large.bin", contentType: "application/octet-stream", size: large.length },
          new Response(new Uint8Array(large), { headers: { "content-length": String(large.length) } })
        ),
      () => "Uploaded in chunks"
    );
  } catch (err) {
    hint = err instanceof GraphError && (err.status === 401 || err.status === 403) ? SENT_ITEMS_PERMISSION_HINT : "";
  }
  if (createdId) {
    await run("Delete the test message", () => permanentlyDelete(token, adminMailbox, createdId), () => "Deleted").catch(() => undefined);
  }
  return { ok: steps.every((s) => s.ok), steps, hint };
}
