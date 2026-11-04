import { domainNames } from "../db/index.js";

/**
 * Exchange sends its automatic mail (out-of-office and rule-based
 * auto-replies, read receipts, some notices) with an empty envelope sender.
 * When "Signer receive" identifies Signer by IP address, Exchange places a
 * returned message in the tenant by its sender's domain, so empty-sender mail
 * coming back from Signer is refused with 451 4.4.62 ATTR35 and never arrives.
 *
 * Such a message goes back with its From address as the envelope sender, when
 * that address is on one of the organisation's domains: Exchange can then
 * place it, and a bounce goes to the person it came from. Delivery reports
 * (bounces) keep their empty sender, as RFC 3461 requires, so a failed
 * bounce cannot set off another.
 */

/** The top-level header block, with folded lines joined. */
function headers(raw: Buffer): string {
  const text = raw.subarray(0, Math.min(raw.length, 256 * 1024)).toString("latin1");
  const end = text.search(/\r?\n\r?\n/);
  return (end === -1 ? text : text.slice(0, end)).replace(/\r?\n[ \t]+/g, " ");
}

/** The address in a From header value: inside angle brackets, or the bare address. */
function fromAddress(value: string): string {
  const bracketed = [...value.matchAll(/<([^<>\s]+@[^<>\s]+)>/g)].pop()?.[1];
  const bare = /([^\s<>"(),;:]+@[^\s<>"(),;:]+)/.exec(value)?.[1];
  return (bracketed ?? bare ?? "").toLowerCase();
}

/** The envelope sender to hand an empty-sender message back with, or "" to keep it empty. */
export function returnSenderFor(raw: Buffer): string {
  const head = headers(raw);
  if (/^content-type:\s*multipart\/report\b[^\n]*report-type\s*=\s*"?delivery-status/im.test(head)) return "";
  const from = /^from:(.*)$/im.exec(head)?.[1];
  if (!from) return "";
  const address = fromAddress(from);
  const domain = address.split("@")[1] ?? "";
  return domain && domainNames().includes(domain) ? address : "";
}

export function emptySenderNote(returnFrom: string): string {
  return `Its envelope sender was empty (an automatic message), so it was handed back as ${returnFrom}: Exchange cannot place empty-sender mail from Signer in your tenant (4.4.62).`;
}
