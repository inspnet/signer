import { APTOS_STACK } from "./fonts";

/** Mirrors DisclaimerStyle in src/mail/disclaimer.ts. */
export type DisclaimerStyle = {
  fontFamily?: string;
  fontSize?: number;
  color?: string;
  lineHeight?: number;
  paragraphSpacing?: number;
  spaceAbove?: number;
};

export const DISCLAIMER_DEFAULTS = { paragraphSpacing: 4, spaceAbove: 8 } as const;

/** The style a new disclaimer starts with: small grey text, close lines. */
export const NEW_DISCLAIMER_STYLE: DisclaimerStyle = { fontSize: 8, color: "#4b5563", lineHeight: 1.15, paragraphSpacing: 4, spaceAbove: 8 };

/** Mirrors spaceParagraphs in src/mail/disclaimer.ts: explicit margins, so clients add no blank lines. */
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

/** The CSS the email wraps a disclaimer in, for the editor and previews. */
export function baseCss(style: DisclaimerStyle): Record<string, string> {
  const css: Record<string, string> = { fontFamily: style.fontFamily || APTOS_STACK };
  if (style.fontSize !== undefined) css.fontSize = `${style.fontSize}pt`;
  if (style.color) css.color = style.color;
  if (style.lineHeight !== undefined) css.lineHeight = `${Math.round(style.lineHeight * 100)}%`;
  return css;
}

/** Mirrors renderDisclaimer in src/mail/disclaimer.ts. */
export function renderDisclaimer(html: string, style: DisclaimerStyle = {}): string {
  const css = baseCss(style);
  const decl = [
    `font-family:${css.fontFamily}`,
    css.fontSize && `font-size:${css.fontSize}`,
    css.color && `color:${css.color}`,
    css.lineHeight && `line-height:${css.lineHeight}`
  ].filter(Boolean);
  return `<div style="${decl.join(";")};">${spaceParagraphs(html, style.paragraphSpacing ?? DISCLAIMER_DEFAULTS.paragraphSpacing)}</div>`;
}
