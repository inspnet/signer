import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

export function hostedAssetUrl(src: string): string {
  if (src.startsWith("/uploads/")) return `${config.publicUrl}${src}`;
  const prefix = `${config.publicUrl.replace(/\/$/, "")}/uploads/`;
  if (src.startsWith(prefix)) return src;
  return src;
}

export type InlineImage = {
  filename: string;
  content: Buffer;
  cid: string;
  contentType: string;
  contentDisposition: "inline";
};

const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml"
};

function uploadRel(src: string): string | null {
  if (src.startsWith("/uploads/")) return src.slice("/uploads/".length);
  const prefix = `${config.publicUrl.replace(/\/$/, "")}/uploads/`;
  if (src.startsWith(prefix)) return src.slice(prefix.length);
  return null;
}

export function embedLocalImages(html: string): { html: string; attachments: InlineImage[] } {
  const attachments: InlineImage[] = [];
  const htmlOut = html.replace(/src="([^"]+)"/gi, (full, src: string) => {
    const rel = uploadRel(src);
    if (!rel) return full;
    const name = path.basename(rel);
    const file = path.join(config.dataDir, "uploads", name);
    if (!fs.existsSync(file)) return `src="${hostedAssetUrl(`/uploads/${name}`)}"`;
    const cid = `${name.replace(/[^a-zA-Z0-9]/g, "")}@signer`;
    const ext = path.extname(name).toLowerCase();
    attachments.push({
      filename: name,
      content: fs.readFileSync(file),
      cid,
      contentType: TYPES[ext] || "application/octet-stream",
      contentDisposition: "inline"
    });
    return `src="cid:${cid}"`;
  });
  return { html: htmlOut, attachments };
}
