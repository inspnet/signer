import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { config } from "../config.js";
import type { InlineImage } from "./mime.js";

/**
 * Images uploaded to Signer (logos, banners) travel inside the message as
 * inline attachments, referenced by cid:, instead of as links back to this
 * server. Recipients' mail clients then show them without "download external
 * images?" prompts, and nothing is fetched from Signer when a message is
 * opened.
 *
 * An image counts as uploaded when its src is /uploads/<file>, relative or
 * under PUBLIC_URL. Other image URLs (a directory photo URL, a CDN) are left
 * as they are.
 */

const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const cache = new Map<string, { mtimeMs: number; image: InlineImage }>();

function uploadPattern(): RegExp {
  const base = config.publicUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(<img\\b[^>]*?\\bsrc=)(["'])(?:${base})?/uploads/([A-Za-z0-9._-]+)\\2`, "gi");
}

function load(file: string): InlineImage | null {
  const full = path.join(config.dataDir, "uploads", file);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(full);
  } catch {
    return null;
  }
  const hit = cache.get(full);
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.image;
  const content = fs.readFileSync(full);
  const ext = path.extname(file).slice(1).toLowerCase();
  const image: InlineImage = {
    // Same bytes, same cid: an image used twice is attached once.
    cid: `${createHash("sha256").update(content).digest("hex").slice(0, 24)}@signer`,
    // Uploads are stored as <timestamp>_<name>.<ext>; recipients see the name.
    filename: file.replace(/^\d+_/, ""),
    contentType: TYPES[ext] ?? "application/octet-stream",
    content
  };
  cache.set(full, { mtimeMs: stat.mtimeMs, image });
  return image;
}

export function embedImages(html: string): { html: string; inline: InlineImage[] } {
  const inline = new Map<string, InlineImage>();
  const out = html.replace(uploadPattern(), (match, prefix: string, quote: string, file: string) => {
    const image = load(file);
    // A missing file keeps an absolute link, which still beats a broken relative one.
    if (!image) return `${prefix}${quote}${config.publicUrl}/uploads/${file}${quote}`;
    inline.set(image.cid, image);
    return `${prefix}${quote}cid:${image.cid}${quote}`;
  });
  return { html: out, inline: [...inline.values()] };
}
