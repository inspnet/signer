import type { DirectoryUser } from "../directory/fields.js";
import { APTOS_STACK, inPoints, type Block, type Design, type TextStyle } from "./design.js";

const DEFAULT_STYLE: Required<TextStyle> = {
  fontFamily: APTOS_STACK,
  fontSize: 9,
  color: "#111827",
  bold: false,
  italic: false,
  lineHeight: "normal"
};

export function interpolate(template: string, user: DirectoryUser): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) => {
    const value = (user as unknown as Record<string, unknown>)[key];
    return value == null ? "" : escapeHtml(String(value));
  });
}

function fieldValue(user: DirectoryUser, field: string): string {
  const value = (user as unknown as Record<string, unknown>)[field];
  return value == null ? "" : String(value).trim();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Keep a CSS value inside one declaration. Quotes and semicolons would break out of the attribute. */
function cssValue(value: string | number | undefined, fallback: string): string {
  const raw = value == null || value === "" ? fallback : String(value);
  const cleaned = raw.replace(/[;"'\\<>{}]|[\r\n]/g, "");
  return cleaned.trim() || fallback;
}

function styleAttr(style?: TextStyle): string {
  const s = { ...DEFAULT_STYLE, ...style };
  const size = typeof s.fontSize === "number" && Number.isFinite(s.fontSize) ? s.fontSize : DEFAULT_STYLE.fontSize;
  const parts = [
    `font-family:${cssValue(s.fontFamily, DEFAULT_STYLE.fontFamily)}`,
    `font-size:${size}pt`,
    `color:${cssValue(s.color, DEFAULT_STYLE.color)}`,
    `line-height:${cssValue(s.lineHeight, DEFAULT_STYLE.lineHeight)}`,
    "margin:0",
    "padding:0"
  ];
  if (s.bold) parts.push("font-weight:bold");
  if (s.italic) parts.push("font-style:italic");
  return parts.join(";");
}

function wrapLink(html: string, href: string | null, underline = false): string {
  if (!href) return html;
  return `<a href="${escapeHtml(href)}" style="color:inherit;text-decoration:${underline ? "underline" : "none"};">${html}</a>`;
}

/** A link a designer typed: web, mail and phone links only; a bare domain gets https://. */
export function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (!href) return null;
  if (/^(https?:|mailto:|tel:)/i.test(href)) return href;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  return /^[\w-]+(\.[\w-]+)+/.test(href) ? `https://${href}` : null;
}

function renderBlock(block: Block, user: DirectoryUser, hideEmpty: boolean): string {
  switch (block.type) {
    case "text": {
      const html = interpolate(block.content, user);
      if (hideEmpty && !html.replace(/<[^>]+>/g, "").trim()) return "";
      const href = block.href ? safeHref(interpolate(block.href, user)) : null;
      return `<p style="${styleAttr(block.style)}">${wrapLink(html, href, block.underline)}</p>`;
    }
    case "field": {
      const value = fieldValue(user, block.field);
      if (hideEmpty && !value) return "";
      const text = `${escapeHtml(block.prefix ?? "")}${escapeHtml(value)}${escapeHtml(block.suffix ?? "")}`;
      let href: string | null = null;
      if (block.link === "email" && value) href = safeHref(`mailto:${value.replace(/[\r\n]/g, "")}`);
      if (block.link === "phone" && value) href = safeHref(`tel:${value.replace(/[^\d+]/g, "")}`);
      if (block.link === "url" && value) href = safeHref(value);
      return `<p style="${styleAttr(block.style)}">${wrapLink(text, href)}</p>`;
    }
    case "image": {
      const src = interpolate(block.src, user).trim();
      if (!src) return "";
      const img = `<img src="${escapeHtml(src)}" width="${block.width ?? 120}" alt="${escapeHtml(block.alt ?? "")}" style="display:block;border:0;outline:none;text-decoration:none;" />`;
      const href = block.href ? safeHref(block.href) : null;
      return href ? `<a href="${escapeHtml(href)}">${img}</a>` : img;
    }
    case "banner": {
      const src = interpolate(block.src, user).trim();
      if (!src) return "";
      const img = `<img src="${escapeHtml(src)}" width="${block.width ?? 460}" alt="${escapeHtml(block.alt ?? "")}" style="display:block;border:0;max-width:100%;" />`;
      const href = block.href ? safeHref(block.href) : null;
      return href ? `<a href="${escapeHtml(href)}">${img}</a>` : img;
    }
    case "divider": {
      const height = typeof block.height === "number" && Number.isFinite(block.height) ? block.height : 1;
      return `<hr style="border:none;border-top:1px solid ${cssValue(block.color, "#d1d5db")};margin:8px 0;height:${height}px;" />`;
    }
    case "spacer": {
      return `<div style="height:${block.height ?? 8}px;line-height:${block.height ?? 8}px;font-size:1px;">&nbsp;</div>`;
    }
    case "social": {
      const icons: Record<string, string> = {
        linkedin: "https://cdn.jsdelivr.net/npm/simple-icons@v11/icons/linkedin.svg",
        x: "https://cdn.jsdelivr.net/npm/simple-icons@v11/icons/x.svg",
        facebook: "https://cdn.jsdelivr.net/npm/simple-icons@v11/icons/facebook.svg",
        instagram: "https://cdn.jsdelivr.net/npm/simple-icons@v11/icons/instagram.svg",
        website: "https://cdn.jsdelivr.net/npm/simple-icons@v11/icons/googlechrome.svg"
      };
      const size = block.iconSize ?? 18;
      const cells = block.networks
        .map((net) => {
          const url = net.url || (net.urlField ? fieldValue(user, net.urlField) : "");
          if (!url) return "";
          const href = safeHref(url);
          if (!href) return "";
          return `<a href="${escapeHtml(href)}" style="padding-right:6px;"><img src="${icons[net.name] ?? icons.website}" width="${size}" height="${size}" alt="${net.name}" style="border:0;" /></a>`;
        })
        .filter(Boolean);
      if (!cells.length) return "";
      return `<p style="margin:0;">${cells.join("")}</p>`;
    }
    case "row": {
      const cols = block.columns
        .map((col) => {
          const inner = col.blocks.map((b) => renderBlock(b, user, hideEmpty)).filter(Boolean).join("");
          if (hideEmpty && !inner) return "";
          return `<td valign="top" width="${escapeHtml(col.width)}" style="padding-right:12px;">${inner}</td>`;
        })
        .filter(Boolean);
      if (!cols.length) return "";
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${cols.join("")}</tr></table>`;
    }
    default:
      return "";
  }
}

export function renderDesign(input: Design, user: DirectoryUser, hideEmpty = true): string {
  // Sizes in points, as Outlook's own text is, so 12 in the designer matches 12 in Outlook.
  const design = inPoints(input);
  const width = typeof design.width === "number" && Number.isFinite(design.width) ? design.width : 520;
  const inner = design.blocks.map((b) => renderBlock(b, user, hideEmpty)).filter(Boolean).join("");
  // No background unless one was chosen on purpose. White was the default, and
  // dark-mode mail clients (iOS Mail, Outlook) turn an explicit white into a
  // grey box behind the signature instead of leaving it on the page colour.
  const bg = cssValue(design.background, "");
  const background = bg && !/^(#fff|#ffffff|white|transparent|none)$/i.test(bg) ? `background:${bg};` : "";
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="${width}" style="width:${width}px;${background}border-collapse:collapse;"><tr><td style="padding:0;">${inner}</td></tr></table>`;
}

export function renderPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
