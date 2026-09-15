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
  onSelect
}: {
  block: Block;
  user: PreviewUser;
  selected: string | null;
  onSelect: (id: string) => void;
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
      <BlockBody block={block} user={user} selected={selected} onSelect={onSelect} />
    </div>
  );
}

function BlockBody({
  block,
  user,
  selected,
  onSelect
}: {
  block: Block;
  user: PreviewUser;
  selected: string | null;
  onSelect: (id: string) => void;
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
          Paste a logo URL in the inspector
        </div>
      );
    }
    case "banner": {
      const src = interpolate(block.src, user);
      return src ? (
        <img src={src} width={block.width ?? 460} alt={block.alt || ""} />
      ) : (
        <div className="border border-dashed border-line text-stone-400 text-xs px-4 py-8 text-center rounded-md bg-mist/40">
          Banner image URL
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
        <div className="flex gap-4 items-start">
          {block.columns.map((col, i) => (
            <div key={i} className="min-w-0 space-y-1" style={{ flex: col.width && /^\d+$/.test(col.width) ? Number(col.width) : 1 }}>
              {col.blocks.map((child) => (
                <LiveBlock key={child.id} block={child} user={user} selected={selected} onSelect={onSelect} />
              ))}
            </div>
          ))}
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
  return block.type;
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

export function mutateDesign(design: Design, fn: (blocks: Block[]) => Block[]): Design {
  return { ...design, blocks: fn(design.blocks) };
}
