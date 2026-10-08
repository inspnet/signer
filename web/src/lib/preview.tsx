import { createContext, useContext, useRef, type CSSProperties, type DragEvent, type ReactNode } from "react";
import type { Block, CellSide, TableCell, TextStyle } from "../api/client";
import { fieldLabel } from "./fields";
import { APTOS_STACK } from "./fonts";
import { cellKey, type DropTarget, type Slot } from "./tree";

export {
  cloneBlock,
  duplicateBlocks,
  findBlock,
  flattenBlocks,
  insertAfter,
  moveBlock,
  removeBlock,
  removeBlocks,
  replaceBlock
} from "./tree";

export type PreviewUser = Record<string, unknown>;

export function val(user: PreviewUser, key: string): string {
  const v = user[key];
  return v == null ? "" : String(v).trim();
}

function interpolate(template: string, user: PreviewUser): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) => val(user, key));
}

function styleOf(style?: TextStyle): CSSProperties {
  return {
    fontFamily: style?.fontFamily || APTOS_STACK,
    // Points, as the designer and Outlook use.
    fontSize: `${style?.fontSize ?? 9}pt`,
    color: style?.color ?? "#1c1917",
    fontWeight: style?.bold ? 700 : 400,
    fontStyle: style?.italic ? "italic" : "normal",
    lineHeight: style?.lineHeight || 1.35,
    margin: 0
  };
}

function initials(user: PreviewUser): string {
  const name = val(user, "displayName") || val(user, "email") || "?";
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

const SOCIAL_MARK: Record<string, string> = {
  linkedin: "in",
  x: "X",
  facebook: "f",
  instagram: "ig",
  website: "w"
};

/** What the canvas needs from the designer: selection, the active table cell, dragging and image resizing. */
export type CanvasState = {
  user: PreviewUser;
  selected: ReadonlySet<string>;
  /** additive: Shift, Ctrl or ⌘ was held, so add or remove instead of replacing the selection. */
  onSelect: (id: string, additive: boolean) => void;
  activeCell: { table: string; r: number; c: number } | null;
  onSelectCell: (table: string, r: number, c: number) => void;
  dragging: ReadonlySet<string> | null;
  drop: DropTarget | null;
  onDragStart: (id: string) => void;
  onDragOver: (target: DropTarget | null) => void;
  onDrop: () => void;
  onDragEnd: () => void;
  onResize: (id: string, width: number) => void;
  maxWidth: number;
};

const Canvas = createContext<CanvasState | null>(null);
/** True inside a block that is being dragged: it cannot be dropped into itself. */
const InsideDragged = createContext(false);

export function CanvasProvider({ value, children }: { value: CanvasState; children: ReactNode }) {
  return <Canvas.Provider value={value}>{children}</Canvas.Provider>;
}

export function useCanvasState(): CanvasState {
  return useCanvas();
}

function useCanvas(): CanvasState {
  const ctx = useContext(Canvas);
  if (!ctx) throw new Error("LiveBlock outside CanvasProvider");
  return ctx;
}

export function sameTarget(a: DropTarget | null, b: DropTarget | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Before or after the element, by which half the pointer is over. */
export function edgeTarget(e: DragEvent, id: string): DropTarget {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  return e.clientY < rect.top + rect.height / 2 ? { before: id } : { after: id };
}

/** Handlers that make an element accept a drop into a list (a column, a cell, the signature itself). */
export function useSlotDrop(slot: Slot) {
  const ctx = useCanvas();
  const inside = useContext(InsideDragged);
  const target: DropTarget = { into: slot };
  return {
    active: ctx.dragging !== null && sameTarget(ctx.drop, target),
    props: {
      onDragOver: (e: DragEvent) => {
        if (!ctx.dragging) return;
        e.preventDefault();
        e.stopPropagation();
        if (inside) return ctx.onDragOver(null);
        if (!sameTarget(ctx.drop, target)) ctx.onDragOver(target);
      },
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        ctx.onDrop();
      }
    }
  };
}

export function LiveBlock({ block }: { block: Block }) {
  const ctx = useCanvas();
  const active = ctx.selected.has(block.id);
  const inside = useContext(InsideDragged);
  const moving = inside || (ctx.dragging?.has(block.id) ?? false);
  const drop = ctx.drop;
  const line = !drop ? null : "before" in drop && drop.before === block.id ? "before" : "after" in drop && drop.after === block.id ? "after" : null;
  return (
    <div
      className={`relative rounded-sm cursor-grab ${moving && !inside ? "opacity-40" : ""} ${active ? "ring-2 ring-accent ring-offset-2 bg-sky/40" : "hover:outline hover:outline-1 hover:outline-line"}`}
      draggable
      onDragStart={(e) => {
        e.stopPropagation();
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", block.id);
        ctx.onDragStart(block.id);
      }}
      onDragOver={(e) => {
        if (!ctx.dragging) return;
        e.preventDefault();
        e.stopPropagation();
        const target = moving ? null : edgeTarget(e, block.id);
        if (!sameTarget(ctx.drop, target)) ctx.onDragOver(target);
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        ctx.onDrop();
      }}
      onDragEnd={() => ctx.onDragEnd()}
      onClick={(e) => {
        e.stopPropagation();
        ctx.onSelect(block.id, e.shiftKey || e.metaKey || e.ctrlKey);
      }}
    >
      {line && <span className={`pointer-events-none absolute left-0 right-0 h-0.5 bg-accent z-20 ${line === "before" ? "-top-1" : "-bottom-1"}`} />}
      {active && ctx.selected.size === 1 && (
        <span className="absolute -top-2.5 left-0 text-[9px] uppercase tracking-[0.12em] bg-accent text-white px-1.5 py-0.5 rounded-sm z-10">
          {blockLabel(block)}
        </span>
      )}
      <InsideDragged.Provider value={moving}>
        <BlockBody block={block} />
      </InsideDragged.Provider>
    </div>
  );
}

/** An image with a corner handle to resize it, shown when it is the only thing selected. */
function SizedImage({ id, src, width, alt }: { id: string; src: string; width: number; alt: string }) {
  const ctx = useCanvas();
  const start = useRef<{ x: number; width: number } | null>(null);
  const handle = ctx.selected.size === 1 && ctx.selected.has(id);
  return (
    <span className="relative inline-block align-top">
      <img src={src} width={width} alt={alt} draggable={false} style={{ display: "block", height: "auto" }} />
      {handle && (
        <span
          title="Drag to resize"
          className="absolute -right-1.5 -bottom-1.5 h-3 w-3 rounded-sm bg-white border-2 border-accent cursor-nwse-resize z-20"
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => {
            // Stops the browser starting a drag-and-drop of the block instead.
            e.preventDefault();
            e.stopPropagation();
            start.current = { x: e.clientX, width };
            const move = (ev: MouseEvent) => {
              if (!start.current) return;
              const next = Math.round(start.current.width + ev.clientX - start.current.x);
              ctx.onResize(id, Math.max(16, Math.min(ctx.maxWidth, next)));
            };
            const up = () => {
              start.current = null;
              window.removeEventListener("mousemove", move);
              window.removeEventListener("mouseup", up);
            };
            window.addEventListener("mousemove", move);
            window.addEventListener("mouseup", up);
          }}
        />
      )}
    </span>
  );
}

function BlockBody({ block }: { block: Block }) {
  const { user } = useCanvas();
  switch (block.type) {
    case "text": {
      const text = interpolate(block.content, user) || "Text";
      return (
        <p style={styleOf(block.style)}>
          {block.href ? (
            <span style={{ textDecoration: block.underline ? "underline" : "none" }} title={interpolate(block.href, user)}>
              {text}
            </span>
          ) : (
            text
          )}
        </p>
      );
    }
    case "field": {
      const value = val(user, block.field);
      return (
        <p style={styleOf(block.style)}>
          {block.prefix}
          {value || <span className="text-slate-300 italic">{`{${block.field}}`}</span>}
          {block.suffix}
        </p>
      );
    }
    case "image": {
      const src = interpolate(block.src, user);
      if (src) return <SizedImage id={block.id} src={src} width={block.width ?? 140} alt={block.alt || ""} />;
      if ((block.alt || "").toLowerCase().includes("photo")) {
        return (
          <div
            className="rounded-full bg-accent text-white grid place-items-center font-semibold"
            style={{ width: block.width ?? 72, height: block.width ?? 72, fontSize: (block.width ?? 72) / 2.8 }}
          >
            {initials(user)}
          </div>
        );
      }
      return (
        <div className="border border-dashed border-line text-slate-400 text-xs px-4 py-5 text-center rounded-md bg-mist/40">
          Upload a logo in the inspector
        </div>
      );
    }
    case "banner": {
      const src = interpolate(block.src, user);
      return src ? (
        <SizedImage id={block.id} src={src} width={block.width ?? 460} alt={block.alt || ""} />
      ) : (
        <div className="border border-dashed border-line text-slate-400 text-xs px-4 py-8 text-center rounded-md bg-mist/40">
          Upload a banner in the inspector
        </div>
      );
    }
    case "divider":
      return <hr style={{ border: "none", borderTop: `${block.height ?? 1}px solid ${block.color || "#d6d3d1"}`, margin: "4px 0" }} />;
    case "spacer":
      return <div style={{ height: block.height ?? 8 }} />;
    case "social":
      return (
        <div className="flex gap-1.5 py-0.5">
          {block.networks.map((n, i) => (
            <span
              key={`${n.name}-${i}`}
              className="h-6 w-6 rounded-md bg-ink text-white text-[10px] grid place-items-center font-semibold"
              title={n.name}
            >
              {SOCIAL_MARK[n.name] ?? n.name[0]}
            </span>
          ))}
          {block.networks.length === 0 && <span className="text-xs text-slate-400">Social icons</span>}
        </div>
      );
    case "row":
      return (
        <div className="flex gap-4 items-start">
          {block.columns.map((col, i) => (
            <RowColumn key={i} row={block.id} index={i} blocks={col.blocks} flex={col.width && /^\d+$/.test(col.width) ? Number(col.width) : 1} />
          ))}
        </div>
      );
    case "table":
      return <LiveTable table={block} />;
    default:
      return null;
  }
}

function RowColumn({ row, index, blocks, flex }: { row: string; index: number; blocks: Block[]; flex: number }) {
  const slot = useSlotDrop({ container: row, key: `c${index}` });
  return (
    <div {...slot.props} className={`min-w-0 space-y-1 min-h-6 rounded-sm ${slot.active ? "bg-sky outline outline-1 outline-accent" : ""}`} style={{ flex }}>
      {blocks.map((child) => (
        <LiveBlock key={child.id} block={child} />
      ))}
      {blocks.length === 0 && <EmptyList />}
    </div>
  );
}

function EmptyList() {
  return <div className="text-[11px] text-slate-300 italic px-1 py-1">Empty</div>;
}

const SIDES: CellSide[] = ["top", "right", "bottom", "left"];

function cellStyle(cell: TableCell, width: number | undefined): CSSProperties {
  const style: CSSProperties = {
    padding: SIDES.map((s) => `${cell.padding?.[s] ?? 0}px`).join(" "),
    verticalAlign: cell.valign ?? "top",
    textAlign: cell.align ?? "left",
    background: cell.background || undefined,
    width
  };
  if (cell.border?.sides.length) {
    const line = `${cell.border.width ?? 1}px solid ${cell.border.color || "#d1d5db"}`;
    for (const s of cell.border.sides) style[`border${s[0]!.toUpperCase()}${s.slice(1)}` as "borderTop"] = line;
  }
  return style;
}

function LiveTable({ table }: { table: Extract<Block, { type: "table" }> }) {
  const widths = table.columns.map((w) => (/^\d+$/.test(w.trim()) ? Number(w) : undefined));
  return (
    <table style={{ borderCollapse: "collapse" }}>
      <tbody>
        {table.rows.map((row, r) => (
          <tr key={r}>
            {row.map((cell, c) => {
              if (cell.merged) return null;
              const span = widths.slice(c, c + (cell.colSpan ?? 1));
              const width = span.every((w) => w !== undefined) ? span.reduce<number>((a, w) => a + (w ?? 0), 0) : undefined;
              return <LiveCell key={c} table={table.id} r={r} c={c} cell={cell} width={width} />;
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function LiveCell({ table, r, c, cell, width }: { table: string; r: number; c: number; cell: TableCell; width: number | undefined }) {
  const ctx = useCanvas();
  const slot = useSlotDrop({ container: table, key: cellKey(r, c) });
  const active = ctx.activeCell?.table === table && ctx.activeCell.r === r && ctx.activeCell.c === c;
  return (
    <td
      {...slot.props}
      colSpan={cell.colSpan ?? 1}
      rowSpan={cell.rowSpan ?? 1}
      style={cellStyle(cell, width)}
      className={`${active ? "outline outline-2 outline-accent -outline-offset-2" : "outline outline-1 outline-dashed outline-line -outline-offset-1"} ${slot.active ? "bg-sky" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        ctx.onSelectCell(table, r, c);
      }}
    >
      {/* Room to click and drop into on the letter; the email itself has no minimum. */}
      <div className={`space-y-1 min-h-6 ${cell.blocks.length ? "" : "min-w-20"}`}>
        {cell.blocks.map((child) => (
          <LiveBlock key={child.id} block={child} />
        ))}
        {cell.blocks.length === 0 && <EmptyList />}
      </div>
    </td>
  );
}

export function blockLabel(block: Block): string {
  if (block.type === "field") return fieldLabel(block.field);
  if (block.type === "text") return "Text";
  if (block.type === "image") return block.alt || "Image";
  if (block.type === "spacer") return "Space";
  if (block.type === "divider") return "Rule";
  if (block.type === "row") return "Columns";
  if (block.type === "table") return `Table ${block.rows.length}×${block.columns.length}`;
  if (block.type === "banner") return "Banner";
  if (block.type === "social") return "Social";
  return "Block";
}
