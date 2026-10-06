import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

/** Separate from the public loop header, which Exchange rules already match on "true". */
export const STAMP_HEADER = "X-Signer-Stamp";

function key(): string {
  return config.sessionSecret || "demo";
}

function mac(body: Buffer): string {
  return createHmac("sha256", key()).update(body).digest("base64url");
}

/**
 * The public loop header, matched only in the header block.
 * Kept here so the mail path and the SMTP server share one implementation.
 */
export function hasProcessedHeader(raw: Buffer): boolean {
  const text = raw.toString("latin1");
  const blankLine = text.search(/\r?\n\r?\n/);
  const headerBlock = blankLine === -1 ? text : text.slice(0, blankLine);
  const name = config.processedHeader.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${name}:[ \\t]*true[ \\t]*$`, "im").test(headerBlock.replace(/\r?\n[ \t]+/g, " "));
}

/** True when this process sealed the bytes under the stamp. A copied "true" header is not enough. */
export function hasValidStamp(raw: Buffer): boolean {
  const text = raw.toString("latin1");
  const match = text.match(new RegExp(`^${STAMP_HEADER}:[ \\t]*([A-Za-z0-9_-]+)\\r?\\n`, "i"));
  if (!match) return false;
  const rest = Buffer.from(text.slice(match[0].length), "latin1");
  const expected = Buffer.from(mac(rest));
  const got = Buffer.from(match[1]);
  if (got.length !== expected.length) return false;
  return timingSafeEqual(got, expected);
}

/**
 * Prepend the public processed header (when it is not already there) and a
 * stamp over those exact bytes. Existing transport rules still look for
 * "true". Signer itself only skips signing when the stamp verifies.
 */
export function sealProcessed(raw: Buffer): Buffer {
  const marked = hasProcessedHeader(raw)
    ? raw
    : Buffer.concat([Buffer.from(`${config.processedHeader}: true\r\n`, "utf8"), raw]);
  return Buffer.concat([Buffer.from(`${STAMP_HEADER}: ${mac(marked)}\r\n`, "utf8"), marked]);
}
