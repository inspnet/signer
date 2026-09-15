import type { DirectoryUser } from "../directory/fields.js";
import type { Block, Design, TextStyle } from "./design.js";

const DEFAULT_STYLE: Required<TextStyle> = {
  fontFamily: "Calibri, Arial, sans-serif",
  fontSize: 12,
  color: "#111827",
  bold: false,
  italic: false,
  lineHeight: "normal"
};

export function interpolate(template: string, user: DirectoryUser): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) => {
    const value = (user as unknown as Record<string, unknown>)[key];
    return value == null ? "" : String(value);
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

function styleAttr(style?: TextStyle): string {
  const s = { ...DEFAULT_STYLE, ...style };
  const parts = [
    `font-family:${s.fontFamily}`,
    `font-size:${s.fontSize}px`,
    `color:${s.color}`,
    `line-height:${s.lineHeight}`,
    "margin:0",
    "padding:0"
  ];
  if (s.bold) parts.push("font-weight:bold");
  if (s.italic) parts.push("font-style:italic");
  return parts.join(";");
}

function wrapLink(html: string, href: string | null): string {
  if (!href) return html;
  return `<a href="${escapeHtml(href)}" style="color:inherit;text-decoration:none;">${html}</a>`;
}

function renderBlock(block: Block, user: DirectoryUser, hideEmpty: boolean): string {
  switch (block.type) {
    case "text": {
      const html = interpolate(block.content, user);
      if (hideEmpty && !html.replace(/<[^>]+>/g, "").trim()) return "";
      return `<p style="${styleAttr(block.style)}">${html}</p>`;
    }
    case "field": {
      const value = fieldValue(user, block.field);
      if (hideEmpty && !value) return "";
      const text = `${block.prefix ?? ""}${escapeHtml(value)}${block.suffix ?? ""}`;
      let href: string | null = null;
      if (block.link === "email" && value) href = `mailto:${value}`;
      if (block.link === "phone" && value) href = `tel:${value.replace(/[^\d+]/g, "")}`;
      if (block.link === "url" && value) {
        href = value.startsWith("http") ? value : `https://${value}`;
      }
      return `<p style="${styleAttr(block.style)}">${wrapLink(text, href)}</p>`;
    }
    case "image": {
      if (!block.src) return "";
      const img = `<img src="${escapeHtml(block.src)}" width="${block.width ?? 120}" alt="${escapeHtml(block.alt ?? "")}" style="display:block;border:0;outline:none;text-decoration:none;" />`;
      return block.href ? `<a href="${escapeHtml(block.href)}">${img}</a>` : img;
    }
    case "banner": {
      if (!block.src) return "";
      const img = `<img src="${escapeHtml(block.src)}" width="${block.width ?? 460}" alt="${escapeHtml(block.alt ?? "")}" style="display:block;border:0;max-width:100%;" />`;
      return block.href ? `<a href="${escapeHtml(block.href)}">${img}</a>` : img;
    }
    case "divider": {
      return `<hr style="border:none;border-top:1px solid ${block.color ?? "#d1d5db"};margin:8px 0;height:${block.height ?? 1}px;" />`;
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
          const href = url.startsWith("http") ? url : `https://${url}`;
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

export function renderDesign(design: Design, user: DirectoryUser, hideEmpty = true): string {
  const inner = design.blocks.map((b) => renderBlock(b, user, hideEmpty)).filter(Boolean).join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="${design.width}" style="width:${design.width}px;background:${design.background ?? "#ffffff"};border-collapse:collapse;"><tr><td style="padding:0;">${inner}</td></tr></table>`;
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
