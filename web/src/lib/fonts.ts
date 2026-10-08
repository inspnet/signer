import type { Block, Design, TextStyle } from "../api/client";
import { mapChildLists } from "./tree";

/**
 * Aptos as Outlook writes it. Where Aptos is not installed, Outlook loads it
 * from Microsoft under the _EmbeddedFont and _MSFontService names. Mirrors
 * APTOS_STACK in src/mail/design.ts.
 */
export const APTOS_STACK = "Aptos, Aptos_EmbeddedFont, Aptos_MSFontService, Calibri, Helvetica, sans-serif";

/** Fonts mail clients have, each with fallbacks for recipients who do not. Aptos is the default. */
export const FONTS = [
  [APTOS_STACK, "Aptos"],
  ["Calibri, Arial, sans-serif", "Calibri"],
  ["Arial, Helvetica, sans-serif", "Arial"],
  ["'Segoe UI', Tahoma, Arial, sans-serif", "Segoe UI"],
  ["Verdana, Geneva, sans-serif", "Verdana"],
  ["Tahoma, Arial, sans-serif", "Tahoma"],
  ["'Trebuchet MS', Arial, sans-serif", "Trebuchet MS"],
  ["Georgia, 'Times New Roman', serif", "Georgia"],
  ["'Times New Roman', Times, serif", "Times New Roman"]
] as const;

const toPoints = (px: number) => Math.round(px * 0.75 * 2) / 2;

/**
 * The design with sizes in points, as Outlook and Word use, and Aptos written
 * as Outlook writes it. Designs saved before sizes were points have them in
 * pixels. Mirrors inPoints() in src/mail/design.ts.
 */
export function inPoints(design: Design): Design {
  const convert = design.fontUnit !== "pt";
  const style = (s?: TextStyle): TextStyle | undefined => {
    if (!s) return s;
    const next = { ...s };
    if (convert && typeof next.fontSize === "number") next.fontSize = toPoints(next.fontSize);
    if (next.fontFamily && /^\s*["']?Aptos\b/i.test(next.fontFamily)) next.fontFamily = APTOS_STACK;
    return next;
  };
  const blocks = (list: Block[]): Block[] =>
    list.map((b) => {
      if (b.type === "row" || b.type === "table") return mapChildLists(b, blocks);
      if (b.type === "text" || b.type === "field") return { ...b, style: style(b.style) };
      return b;
    });
  return { ...design, blocks: blocks(design.blocks), fontUnit: "pt" };
}
