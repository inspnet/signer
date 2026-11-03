import { getSetting, setSetting } from "../db/index.js";

/**
 * Journaling (archive services such as Global Relay).
 *
 * Exchange journals a message as it leaves for Signer, before the signature
 * and disclaimers are added, and marks it as journaled. The marker travels to
 * Signer and back, so Exchange does not journal the signed copy: the archive
 * holds the message without its disclaimer.
 *
 * With "Journal the signed copy" on, Signer removes the marker from the
 * messages it changes. Exchange then journals the signed copy as it leaves for
 * the recipients as well, so the archive holds both: the original and the
 * message as sent. Messages Signer passes through unchanged keep the marker,
 * since their journaled copy is already exact.
 */

const KEY = "journal_signed_copy";

/** The headers Exchange uses to remember a message has been journaled, within the tenant and across connectors. */
const MARKER = /^X-MS-Exchange-(?:Organization|CrossPremises)-Processed-By-Journaling$/i;

export function journalSignedCopy(): boolean {
  return getSetting(KEY, "false") === "true";
}

export function setJournalSignedCopy(enabled: boolean): void {
  setSetting(KEY, enabled ? "true" : "false");
}

function headerBlockEnd(text: string): number {
  const m = /\r?\n\r?\n/.exec(text);
  return m ? m.index + m[0].length : text.length;
}

/** The names of the message's top-level headers that mention journaling, for Activity. */
export function journalHeaderNames(raw: Buffer): string[] {
  const text = raw.toString("latin1");
  const head = text.slice(0, headerBlockEnd(text));
  return [...new Set([...head.matchAll(/^([!-9;-~]+):/gm)].map((m) => m[1]!).filter((n) => /journal/i.test(n)))];
}

/** The message without Exchange's journaling marker, and the header names removed. */
export function removeJournalMarker(raw: Buffer): { raw: Buffer; removed: string[] } {
  const text = raw.toString("latin1");
  const end = headerBlockEnd(text);
  const lines = text.slice(0, end).split(/(?<=\n)/);
  const kept: string[] = [];
  const removed: string[] = [];
  let dropping = false;
  for (const line of lines) {
    // A folded continuation belongs to the header above it.
    if (/^[ \t]/.test(line) && kept.length + removed.length > 0) {
      if (!dropping) kept.push(line);
      continue;
    }
    const name = /^([!-9;-~]+):/.exec(line)?.[1];
    dropping = Boolean(name && MARKER.test(name));
    if (dropping) removed.push(name!);
    else kept.push(line);
  }
  if (!removed.length) return { raw, removed };
  return { raw: Buffer.concat([Buffer.from(kept.join(""), "latin1"), raw.subarray(Buffer.byteLength(text.slice(0, end), "latin1"))]), removed };
}

/** For Activity: what happened to the journaling marker on a signed message. */
export function journalNote(removed: string[], seen: string[]): string {
  if (removed.length) return `Journaling marker removed (${removed.join(", ")}), so Exchange journals this signed copy.`;
  return `"Journal the signed copy" is on, but the message had no journaling marker${seen.length ? ` (journal headers: ${seen.join(", ")})` : ""}.`;
}
