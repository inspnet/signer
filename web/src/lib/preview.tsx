import type { CSSProperties } from "react";
import type { Block, Design, TextStyle } from "../api/client";
import { fieldLabel } from "./fields";

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
    fontFamily: style?.fontFamily || "Calibri, Arial, sans-serif",
    fontSize: style?.fontSize ?? 12,
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

export function LiveBlock({
  block,
  user,
  selected,
  onSelect,
  selectedColumn,
  onSelectColumn
}: {
  block: Block;
  user: PreviewUser;
  selected: string | null;
  onSelect: (id: string) => void;
  selectedColumn?: { rowId: string; index: number } | null;
  onSelectColumn?: (rowId: string, index: number) => void;
}) {
  const active = selected === block.id;
  return (
    <div
      className={`relative rounded-sm ${active ? "ring-2 ring-accent ring-offset-2 bg-teal-50/30" : "hover:outline hover:outline-1 hover:outline-line"}`}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(block.id);
      }}
    >
      {active && (
        <span className="absolute -top-2.5 left-0 text-[9px] uppercase tracking-[0.12em] bg-accent text-white px-1.5 py-0.5 rounded-sm z-10">
          {blockLabel(block)}
        </span>
      )}
      <BlockBody
        block={block}
        user={user}
        selected={selected}
        onSelect={onSelect}
        selectedColumn={selectedColumn}
        onSelectColumn={onSelectColumn}
      />
    </div>
  );
}

function BlockBody({
  block,
  user,
  selected,
  onSelect,
  selectedColumn,
  onSelectColumn
}: {
  block: Block;
  user: PreviewUser;
  selected: string | null;
  onSelect: (id: string) => void;
  selectedColumn?: { rowId: string; index: number } | null;
  onSelectColumn?: (rowId: string, index: number) => void;
}) {
  switch (block.type) {
    case "text":
      return <p style={styleOf(block.style)}>{interpolate(block.content, user) || "Text"}</p>;
    case "field": {
      const value = val(user, block.field);
      return (
        <p style={styleOf(block.style)}>
          {block.prefix}
          {value || <span className="text-stone-300 italic">{`{${block.field}}`}</span>}
          {block.suffix}
        </p>
      );
    }
    case "image": {
      const src = interpolate(block.src, user);
      if (src) return <img src={src} width={block.width ?? 140} alt={block.alt || ""} />;
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
        <div className="border border-dashed border-line text-stone-400 text-xs px-4 py-5 text-center rounded-md bg-mist/40">
          Upload a logo in the inspector
        </div>
      );
    }
    case "banner": {
      const src = interpolate(block.src, user);
      return src ? (
        <img src={src} width={block.width ?? 460} alt={block.alt || ""} />
      ) : (
        <div className="border border-dashed border-line text-stone-400 text-xs px-4 py-8 text-center rounded-md bg-mist/40">
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
          {block.networks.map((n) => (
            <span
              key={n.name}
              className="h-6 w-6 rounded-md bg-ink text-white text-[10px] grid place-items-center font-semibold"
              title={n.name}
            >
              {SOCIAL_MARK[n.name] ?? n.name[0]}
            </span>
          ))}
          {block.networks.length === 0 && <span className="text-xs text-stone-400">Social icons</span>}
        </div>
      );
    case "row":
      return (
        <div className="flex gap-3 items-stretch">
          {block.columns.map((col, i) => {
            const activeCol = selectedColumn?.rowId === block.id && selectedColumn.index === i;
            return (
              <div
                key={i}
                className={`min-w-0 space-y-1 rounded-md p-2 ${activeCol ? "ring-2 ring-accent bg-teal-50/50" : "border border-dashed border-line/80"}`}
                style={colFlex(col.width)}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(block.id);
                  onSelectColumn?.(block.id, i);
                }}
              >
                <div className="text-[9px] uppercase tracking-wide text-stone-400">Column {i + 1}</div>
                {col.blocks.map((child) => (
                  <LiveBlock
                    key={child.id}
                    block={child}
                    user={user}
                    selected={selected}
                    onSelect={onSelect}
                    selectedColumn={selectedColumn}
                    onSelectColumn={onSelectColumn}
                  />
                ))}
                {col.blocks.length === 0 && <p className="text-xs text-stone-400 py-4 text-center">Click, then Insert</p>}
              </div>
            );
          })}
        </div>
      );
    default:
      return null;
  }
}

export function blockLabel(block: Block): string {
  if (block.type === "field") return fieldLabel(block.field);
  if (block.type === "text") return "Text";
  if (block.type === "image") return block.alt || "Image";
  if (block.type === "spacer") return "Space";
  if (block.type === "divider") return "Rule";
  if (block.type === "row") return "Columns";
  if (block.type === "banner") return "Banner";
  if (block.type === "social") return "Social";
  return "Block";
}

export function flattenBlocks(blocks: Block[], depth = 0): Array<{ block: Block; depth: number }> {
  const out: Array<{ block: Block; depth: number }> = [];
  for (const b of blocks) {
    out.push({ block: b, depth });
    if (b.type === "row") {
      for (const c of b.columns) out.push(...flattenBlocks(c.blocks, depth + 1));
    }
  }
  return out;
}

export function findBlock(blocks: Block[], id: string): Block | null {
  for (const b of blocks) {
    if (b.id === id) return b;
    if (b.type === "row") {
      for (const c of b.columns) {
        const found = findBlock(c.blocks, id);
        if (found) return found;
      }
    }
  }
  return null;
}

export function replaceBlock(blocks: Block[], next: Block): Block[] {
  return blocks.map((b) => {
    if (b.id === next.id) return next;
    if (b.type === "row") {
      return { ...b, columns: b.columns.map((c) => ({ ...c, blocks: replaceBlock(c.blocks, next) })) };
    }
    return b;
  });
}

export function removeBlock(blocks: Block[], id: string): Block[] {
  return blocks
    .filter((b) => b.id !== id)
    .map((b) => (b.type === "row" ? { ...b, columns: b.columns.map((c) => ({ ...c, blocks: removeBlock(c.blocks, id) })) } : b));
}

export function insertAfter(blocks: Block[], afterId: string | null, item: Block): Block[] {
  if (!afterId) return [...blocks, item];
  const idx = blocks.findIndex((b) => b.id === afterId);
  if (idx !== -1) {
    const next = [...blocks];
    next.splice(idx + 1, 0, item);
    return next;
  }
  return blocks.map((b) => {
    if (b.type !== "row") return b;
    return { ...b, columns: b.columns.map((c) => ({ ...c, blocks: insertAfter(c.blocks, afterId, item) })) };
  });
}

export function moveBlock(blocks: Block[], id: string, dir: -1 | 1): Block[] {
  const idx = blocks.findIndex((b) => b.id === id);
  if (idx !== -1) {
    const swap = idx + dir;
    if (swap < 0 || swap >= blocks.length) return blocks;
    const next = [...blocks];
    [next[idx], next[swap]] = [next[swap], next[idx]];
    return next;
  }
  return blocks.map((b) => {
    if (b.type !== "row") return b;
    return { ...b, columns: b.columns.map((c) => ({ ...c, blocks: moveBlock(c.blocks, id, dir) })) };
  });
}

export function cloneBlock(block: Block): Block {
  const id = `b_${Math.random().toString(36).slice(2, 10)}`;
  if (block.type === "row") {
    return { ...block, id, columns: block.columns.map((c) => ({ ...c, blocks: c.blocks.map(cloneBlock) })) };
  }
  return { ...block, id };
}

export function duplicateBlock(blocks: Block[], id: string): Block[] {
  const idx = blocks.findIndex((b) => b.id === id);
  if (idx !== -1) {
    const next = [...blocks];
    next.splice(idx + 1, 0, cloneBlock(blocks[idx]!));
    return next;
  }
  return blocks.map((b) => {
    if (b.type !== "row") return b;
    return { ...b, columns: b.columns.map((c) => ({ ...c, blocks: duplicateBlock(c.blocks, id) })) };
  });
}

function colFlex(width: string): CSSProperties {
  if (width.endsWith("%")) return { flex: `0 0 ${width}`, width };
  if (/^\d+$/.test(width)) return { flex: Number(width), minWidth: 0 };
  return { flex: 1, minWidth: 0 };
}

export function insertIntoColumn(blocks: Block[], rowId: string, colIndex: number, item: Block): Block[] {
  return blocks.map((b) => {
    if (b.id === rowId && b.type === "row") {
      return {
        ...b,
        columns: b.columns.map((c, i) => (i === colIndex ? { ...c, blocks: [...c.blocks, item] } : c))
      };
    }
    if (b.type === "row") {
      return { ...b, columns: b.columns.map((c) => ({ ...c, blocks: insertIntoColumn(c.blocks, rowId, colIndex, item) })) };
    }
    return b;
  });
}

export function addColumnToRow(blocks: Block[], rowId: string): Block[] {
  return blocks.map((b) => {
    if (b.id === rowId && b.type === "row") {
      const n = b.columns.length + 1;
      const width = `${Math.floor(100 / n)}%`;
      return { ...b, columns: [...b.columns.map((c) => ({ ...c, width })), { width, blocks: [] }] };
    }
    if (b.type === "row") {
      return { ...b, columns: b.columns.map((c) => ({ ...c, blocks: addColumnToRow(c.blocks, rowId) })) };
    }
    return b;
  });
}

export function removeColumnFromRow(blocks: Block[], rowId: string, colIndex: number): Block[] {
  return blocks.map((b) => {
    if (b.id === rowId && b.type === "row") {
      if (b.columns.length <= 1) return b;
      const columns = b.columns.filter((_, i) => i !== colIndex);
      const width = `${Math.floor(100 / columns.length)}%`;
      return { ...b, columns: columns.map((c) => ({ ...c, width })) };
    }
    if (b.type === "row") {
      return { ...b, columns: b.columns.map((c) => ({ ...c, blocks: removeColumnFromRow(c.blocks, rowId, colIndex) })) };
    }
    return b;
  });
}

export function wrapInColumns(blocks: Block[], id: string): Block[] {
  const idx = blocks.findIndex((b) => b.id === id);
  if (idx !== -1) {
    const row: Block = {
      id: `b_${Math.random().toString(36).slice(2, 10)}`,
      type: "row",
      columns: [
        { width: "40%", blocks: [] },
        { width: "60%", blocks: [blocks[idx]!] }
      ]
    };
    const next = [...blocks];
    next.splice(idx, 1, row);
    return next;
  }
  return blocks.map((b) =>
    b.type === "row" ? { ...b, columns: b.columns.map((c) => ({ ...c, blocks: wrapInColumns(c.blocks, id) })) } : b
  );
}

export function mutateDesign(design: Design, fn: (blocks: Block[]) => Block[]): Design {
  return { ...design, blocks: fn(design.blocks) };
}
