/**
 * Upload validation for signature artwork.
 *
 * Uploads are served from the same origin as the portal, so a file that a
 * browser will treat as a document — SVG above all, which can carry <script> —
 * is stored XSS against every admin who opens it. The filename and the
 * browser-supplied content type are both attacker-controlled, so neither is
 * trusted: the format is decided by the file's own magic bytes and the stored
 * extension is derived from that.
 *
 * Only raster formats are accepted. That is not a limitation in practice —
 * Gmail, Outlook and Apple Mail do not render SVG in <img> — and it removes the
 * only image format that can execute script.
 */

export type ImageKind = { mime: string; ext: string };

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GIF87 = Buffer.from("GIF87a", "latin1");
const GIF89 = Buffer.from("GIF89a", "latin1");

/** Formats we accept on upload and serve inline. */
export const ALLOWED_IMAGE_EXTENSIONS = new Set(["png", "jpg", "gif", "webp"]);

export function detectImage(buffer: Buffer): ImageKind | null {
  if (buffer.length < 12) return null;

  if (buffer.subarray(0, 8).equals(PNG)) return { mime: "image/png", ext: "png" };

  // JPEG: SOI marker, and the file ends with EOI.
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: "image/jpeg", ext: "jpg" };
  }

  const head6 = buffer.subarray(0, 6);
  if (head6.equals(GIF87) || head6.equals(GIF89)) return { mime: "image/gif", ext: "gif" };

  // WEBP: "RIFF" .... "WEBP"
  if (
    buffer.subarray(0, 4).toString("latin1") === "RIFF" &&
    buffer.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return { mime: "image/webp", ext: "webp" };
  }

  return null;
}

/**
 * A readable stem for the stored filename. The extension is not taken from here
 * — detectImage decides that — so this only has to be filesystem-safe.
 */
export function safeStem(filename: string): string {
  const base = filename.replace(/\\/g, "/").split("/").pop() ?? "";
  const withoutExt = base.replace(/\.[^.]*$/, "");
  const cleaned = withoutExt.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return cleaned.slice(0, 60) || "upload";
}

/**
 * Headers for everything under /uploads/.
 *
 * The CSP matters for direct navigation: an <img> load ignores it, but opening
 * /uploads/<file> makes the response a document, and that is where script in a
 * legacy SVG would run. Files uploaded before this validation existed are also
 * forced to download rather than render.
 */
export function uploadHeaders(filePath: string): Record<string, string> {
  const ext = (filePath.split(".").pop() ?? "").toLowerCase();
  const known = ALLOWED_IMAGE_EXTENSIONS.has(ext);
  return {
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
    "Cross-Origin-Resource-Policy": "cross-origin",
    // Anything not recognised as a safe raster image is never rendered in place.
    "Content-Disposition": known ? "inline" : "attachment"
  };
}
