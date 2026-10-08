export type TextStyle = {
  fontFamily?: string;
  fontSize?: number;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  lineHeight?: string;
};

export type Block =
  | {
      id: string;
      type: "text";
      content: string;
      style?: TextStyle;
      /** Makes the whole text a link: https://…, mailto:, tel: or a {{field}}. */
      href?: string;
      underline?: boolean;
    }
  | {
      id: string;
      type: "field";
      field: string;
      prefix?: string;
      suffix?: string;
      style?: TextStyle;
      link?: "email" | "phone" | "url" | "none";
    }
  | {
      id: string;
      type: "image";
      src: string;
      width?: number;
      /** Display height, set when an uploaded image is fitted on save. */
      height?: number;
      /** The upload as first added; src is a copy resized to fit (see fitImages in the designer). */
      original?: string;
      alt?: string;
      href?: string;
    }
  | {
      id: string;
      type: "social";
      networks: Array<{ name: "linkedin" | "x" | "facebook" | "instagram" | "website"; urlField?: string; url?: string }>;
      iconSize?: number;
    }
  | {
      id: string;
      type: "divider";
      color?: string;
      height?: number;
    }
  | {
      id: string;
      type: "spacer";
      height?: number;
    }
  | {
      id: string;
      type: "banner";
      src: string;
      href?: string;
      alt?: string;
      width?: number;
      height?: number;
      original?: string;
    }
  | {
      id: string;
      type: "row";
      columns: Array<{ width: string; blocks: Block[] }>;
    }
  | {
      id: string;
      type: "table";
      /** One width per grid column: pixels as digits, or "" for automatic. */
      columns: string[];
      /** A full grid, rows × columns. Cells covered by a neighbour's span are marked merged. */
      rows: TableCell[][];
    };

export type CellSide = "top" | "right" | "bottom" | "left";

export type TableCell = {
  blocks: Block[];
  colSpan?: number;
  rowSpan?: number;
  /** Covered by another cell's colSpan or rowSpan; not rendered. */
  merged?: boolean;
  align?: "left" | "center" | "right";
  valign?: "top" | "middle" | "bottom";
  padding?: Partial<Record<CellSide, number>>;
  background?: string;
  border?: { sides: CellSide[]; color?: string; width?: number };
};

/** Every list of blocks directly inside a block: a row's columns, a table's cells. */
export function childLists(block: Block): Block[][] {
  if (block.type === "row") return block.columns.map((c) => c.blocks);
  if (block.type === "table") return block.rows.flatMap((r) => r.map((c) => c.blocks));
  return [];
}

/** The block with each of its child lists replaced by fn(list). */
export function mapChildLists(block: Block, fn: (blocks: Block[]) => Block[]): Block {
  if (block.type === "row") return { ...block, columns: block.columns.map((c) => ({ ...c, blocks: fn(c.blocks) })) };
  if (block.type === "table") return { ...block, rows: block.rows.map((r) => r.map((c) => ({ ...c, blocks: fn(c.blocks) }))) };
  return block;
}

export type Design = {
  width: number;
  background?: string;
  blocks: Block[];
  /**
   * Text sizes are points, as in Outlook and Word, when "pt". Designs saved
   * before that have none and sizes in pixels; inPoints() converts them.
   */
  fontUnit?: "pt";
};

/**
 * Aptos as Outlook writes it. Where Aptos is not installed, Outlook (new and
 * on the web) loads it from Microsoft under the _EmbeddedFont and
 * _MSFontService names; without them a signature would fall back to Calibri
 * next to body text in real Aptos.
 */
export const APTOS_STACK = "Aptos, Aptos_EmbeddedFont, Aptos_MSFontService, Calibri, Helvetica, sans-serif";

const toPoints = (px: number) => Math.round(px * 0.75 * 2) / 2;

/** The design with sizes in points and Aptos written the way Outlook writes it. */
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

export function newBlockId(): string {
  return `b_${Math.random().toString(36).slice(2, 10)}`;
}
