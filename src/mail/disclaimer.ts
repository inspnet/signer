import { APTOS_STACK } from "./design.js";

/**
 * How a disclaimer's text is laid out in the email. The editor's own markup
 * carries bold, links and per-word sizes; these set the base the whole notice
 * sits on, so empty lines and line breaks are the notice's size, not the
 * email body's 12pt.
 */
export type DisclaimerStyle = {
  fontFamily?: string;
  /** Points. Unset leaves the size to the email (12pt in Outlook). */
  fontSize?: number;
  color?: string;
  /** A multiple of the font size, such as 1.2. Unset is the mail client's default. */
  lineHeight?: number;
  /** Points between paragraphs (Enter). A line break (Shift+Enter) adds none. */
  paragraphSpacing?: number;
  /** Points of space above the disclaimer: below the signature, or between disclaimers. */
  spaceAbove?: number;
};

export const DISCLAIMER_DEFAULTS = { paragraphSpacing: 4, spaceAbove: 8 } as const;

/** Keep a CSS value inside one declaration. */
function cssValue(value: unknown): string {
  return String(value ?? "")
    .replace(/[;"'\\<>{}]|[\r\n]/g, "")
    .trim();
}

/** A finite number in [min, max], or undefined. */
function bounded(value: unknown, min: number, max: number): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : undefined;
}

/** A style from a request or the database, with anything unusable dropped. */
export function cleanDisclaimerStyle(input: unknown): DisclaimerStyle {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const out: DisclaimerStyle = {};
  const fontFamily = cssValue(raw.fontFamily);
  if (fontFamily) out.fontFamily = fontFamily;
  const color = cssValue(raw.color);
  if (/^#[0-9a-f]{3,8}$/i.test(color)) out.color = color;
  const fontSize = bounded(raw.fontSize, 5, 36);
  if (fontSize !== undefined) out.fontSize = fontSize;
  const lineHeight = bounded(raw.lineHeight, 0.8, 3);
  if (lineHeight !== undefined) out.lineHeight = lineHeight;
  const paragraphSpacing = bounded(raw.paragraphSpacing, 0, 48);
  if (paragraphSpacing !== undefined) out.paragraphSpacing = paragraphSpacing;
  const spaceAbove = bounded(raw.spaceAbove, 0, 72);
  if (spaceAbove !== undefined) out.spaceAbove = spaceAbove;
  return out;
}

/**
 * Give every paragraph an explicit margin. A <p> or <div> without one gets a
 * blank line above and below it in Outlook and most other clients, which is
 * where most of the extra space in disclaimers came from. Margins the HTML
 * sets itself are kept.
 */
export function spaceParagraphs(html: string, spacingPt: number): string {
  const margin = `margin:0 0 ${spacingPt}pt 0;`;
  return html.replace(/<(p|div|ul|ol)\b([^>]*)>/gi, (tag, name: string, attrs: string) => {
    const list = /^(ul|ol)$/i.test(name);
    const add = list ? `${margin}padding-left:20px;` : margin;
    const style = /\sstyle\s*=\s*(["'])(.*?)\1/i.exec(attrs);
    if (!style) return `<${name}${attrs} style="${add}">`;
    if (/(^|;)\s*margin(-bottom|-top)?\s*:/i.test(style[2]!)) return tag;
    return `<${name}${attrs.replace(style[0], ` style=${style[1]}${add}${style[2]}${style[1]}`)}>`;
  });
}

/** The disclaimer's HTML as it goes into the email: its base style around its own markup. */
export function renderDisclaimer(html: string, input: DisclaimerStyle = {}): string {
  const style = cleanDisclaimerStyle(input);
  const css = [`font-family:${style.fontFamily || APTOS_STACK}`];
  if (style.fontSize !== undefined) css.push(`font-size:${style.fontSize}pt`);
  if (style.color) css.push(`color:${style.color}`);
  if (style.lineHeight !== undefined) css.push(`line-height:${Math.round(style.lineHeight * 100)}%`);
  const spacing = style.paragraphSpacing ?? DISCLAIMER_DEFAULTS.paragraphSpacing;
  return `<div style="${css.join(";")};">${spaceParagraphs(html, spacing)}</div>`;
}

/** Fixed space above a disclaimer. A spacer row, since Outlook ignores margins and padding on a div. */
export function disclaimerSpacer(input: DisclaimerStyle = {}): string {
  const pt = cleanDisclaimerStyle(input).spaceAbove ?? DISCLAIMER_DEFAULTS.spaceAbove;
  if (!pt) return "";
  return `<div style="height:${pt}pt;line-height:${pt}pt;font-size:1px;mso-line-height-rule:exactly;">&nbsp;</div>`;
}
