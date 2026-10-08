import type { Block, TableCell } from "../api/client";

/**
 * Pure operations on a signature's block tree. Blocks nest inside "row"
 * columns and "table" cells; each list of blocks has a key within its
 * container ("c0" for a row's first column, "r1c2" for a table cell), so a
 * drop target can name a list that is still empty.
 */

export type Slot = { container: string | null; key: string };

/** Where moved blocks land: next to a block, or at the end of a list. */
export type DropTarget = { before: string } | { after: string } | { into: Slot };

export function nid(): string {
  return `b_${Math.random().toString(36).slice(2, 10)}`;
}

export function cellKey(r: number, c: number): string {
  return `r${r}c${c}`;
}

/** The lists of blocks directly inside a block, with their keys. */
export function childLists(block: Block): Array<{ key: string; blocks: Block[] }> {
  if (block.type === "row") return block.columns.map((c, i) => ({ key: `c${i}`, blocks: c.blocks }));
  if (block.type === "table") {
    return block.rows.flatMap((row, r) => row.flatMap((cell, c) => (cell.merged ? [] : [{ key: cellKey(r, c), blocks: cell.blocks }])));
  }
  return [];
}

/** The block with each child list replaced by fn(list, key). */
export function mapChildLists(block: Block, fn: (blocks: Block[], key: string) => Block[]): Block {
  if (block.type === "row") return { ...block, columns: block.columns.map((c, i) => ({ ...c, blocks: fn(c.blocks, `c${i}`) })) };
  if (block.type === "table") {
    return { ...block, rows: block.rows.map((row, r) => row.map((cell, c) => ({ ...cell, blocks: fn(cell.blocks, cellKey(r, c)) }))) };
  }
  return block;
}

const isContainer = (b: Block) => b.type === "row" || b.type === "table";

export function flattenBlocks(blocks: Block[], depth = 0): Array<{ block: Block; depth: number }> {
  const out: Array<{ block: Block; depth: number }> = [];
  for (const b of blocks) {
    out.push({ block: b, depth });
    for (const list of childLists(b)) out.push(...flattenBlocks(list.blocks, depth + 1));
  }
  return out;
}

export function findBlock(blocks: Block[], id: string): Block | null {
  for (const b of blocks) {
    if (b.id === id) return b;
    for (const list of childLists(b)) {
      const found = findBlock(list.blocks, id);
      if (found) return found;
    }
  }
  return null;
}

/** Whether `id` is `ancestor` itself or somewhere inside it. */
export function contains(ancestor: Block, id: string): boolean {
  return ancestor.id === id || findBlock(childLists(ancestor).flatMap((l) => l.blocks), id) !== null;
}

export function replaceBlock(blocks: Block[], next: Block): Block[] {
  return blocks.map((b) => (b.id === next.id ? next : isContainer(b) ? mapChildLists(b, (list) => replaceBlock(list, next)) : b));
}

export function removeBlocks(blocks: Block[], ids: ReadonlySet<string>): Block[] {
  return blocks.filter((b) => !ids.has(b.id)).map((b) => (isContainer(b) ? mapChildLists(b, (list) => removeBlocks(list, ids)) : b));
}

export function removeBlock(blocks: Block[], id: string): Block[] {
  return removeBlocks(blocks, new Set([id]));
}

/** Insert items next to a block, or into a list, wherever it is in the tree. */
export function insertAt(blocks: Block[], target: DropTarget, items: Block[], container: string | null = null, key = "root"): Block[] {
  if ("into" in target) {
    if (target.into.container === container && target.into.key === key) return [...blocks, ...items];
  } else {
    const id = "before" in target ? target.before : target.after;
    const idx = blocks.findIndex((b) => b.id === id);
    if (idx !== -1) {
      const next = [...blocks];
      next.splice("before" in target ? idx : idx + 1, 0, ...items);
      return next;
    }
  }
  return blocks.map((b) => (isContainer(b) ? mapChildLists(b, (list, k) => insertAt(list, target, items, b.id, k)) : b));
}

export function insertAfter(blocks: Block[], afterId: string | null, item: Block): Block[] {
  return afterId && findBlock(blocks, afterId) ? insertAt(blocks, { after: afterId }, [item]) : [...blocks, item];
}

/** The given blocks in document order, leaving out any already inside another one given. */
export function topmost(blocks: Block[], ids: ReadonlySet<string>): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    if (ids.has(b.id)) out.push(b);
    else for (const list of childLists(b)) out.push(...topmost(list.blocks, ids));
  }
  return out;
}

/**
 * Move blocks to a drop target, keeping their order. Returns the blocks
 * unchanged when the target is one of them or inside one of them.
 */
export function moveBlocks(blocks: Block[], ids: ReadonlySet<string>, target: DropTarget): Block[] {
  const moving = topmost(blocks, ids);
  if (!moving.length) return blocks;
  const anchor = "into" in target ? target.into.container : "before" in target ? target.before : target.after;
  if (anchor && moving.some((m) => contains(m, anchor))) return blocks;
  const rest = removeBlocks(blocks, new Set(moving.map((m) => m.id)));
  return insertAt(rest, target, moving);
}

/** Move one block up or down within its own list. */
export function moveBlock(blocks: Block[], id: string, dir: -1 | 1): Block[] {
  const idx = blocks.findIndex((b) => b.id === id);
  if (idx !== -1) {
    const swap = idx + dir;
    if (swap < 0 || swap >= blocks.length) return blocks;
    const next = [...blocks];
    [next[idx], next[swap]] = [next[swap]!, next[idx]!];
    return next;
  }
  return blocks.map((b) => (isContainer(b) ? mapChildLists(b, (list) => moveBlock(list, id, dir)) : b));
}

export function cloneBlock(block: Block): Block {
  return mapChildLists({ ...block, id: nid() }, (list) => list.map(cloneBlock));
}

export function duplicateBlocks(blocks: Block[], ids: ReadonlySet<string>): Block[] {
  return blocks.flatMap((b) => {
    const kept = isContainer(b) ? mapChildLists(b, (list) => duplicateBlocks(list, ids)) : b;
    return ids.has(b.id) ? [kept, cloneBlock(b)] : [kept];
  });
}

// ---------------------------------------------------------------------------
// Tables. The grid is always rectangular: a cell covered by another's span is
// still there, marked merged, so rows and columns can be added and removed
// with plain index arithmetic.

type Table = Extract<Block, { type: "table" }>;

const empty = (): TableCell => ({ blocks: [] });
const spanOf = (cell: TableCell) => ({ cs: Math.max(1, cell.colSpan ?? 1), rs: Math.max(1, cell.rowSpan ?? 1) });
const copyRows = (t: Table) => t.rows.map((row) => row.map((cell) => ({ ...cell })));

export function newTable(rows: number, cols: number): Table {
  return {
    id: nid(),
    type: "table",
    columns: Array.from({ length: cols }, () => ""),
    rows: Array.from({ length: rows }, () => Array.from({ length: cols }, empty))
  };
}

/** The visible cell covering grid position (r, c). */
export function anchorOf(t: Table, r: number, c: number): { r: number; c: number } {
  for (let ar = r; ar >= 0; ar--) {
    for (let ac = c; ac >= 0; ac--) {
      const cell = t.rows[ar]?.[ac];
      if (!cell || cell.merged) continue;
      const { cs, rs } = spanOf(cell);
      if (ar + rs > r && ac + cs > c) return { r: ar, c: ac };
    }
  }
  return { r, c };
}

/** Add a row before index `at` (0 to the row count). Spans crossing that line grow to cover it. */
export function insertRow(t: Table, at: number): Table {
  const rows = copyRows(t);
  const cols = t.columns.length;
  const row: TableCell[] = [];
  const grown = new Set<string>();
  for (let c = 0; c < cols; c++) {
    if (at > 0 && at < rows.length) {
      const a = anchorOf(t, at, c);
      if (a.r < at) {
        if (!grown.has(`${a.r},${a.c}`)) {
          grown.add(`${a.r},${a.c}`);
          const cell = rows[a.r]![a.c]!;
          cell.rowSpan = spanOf(cell).rs + 1;
        }
        row.push({ blocks: [], merged: true });
        continue;
      }
    }
    row.push(empty());
  }
  rows.splice(at, 0, row);
  return { ...t, rows };
}

/** Add a column before index `at` (0 to the column count). */
export function insertColumn(t: Table, at: number): Table {
  const rows = copyRows(t);
  const cols = t.columns.length;
  const grown = new Set<string>();
  rows.forEach((row, r) => {
    if (at > 0 && at < cols) {
      const a = anchorOf(t, r, at);
      if (a.c < at) {
        if (!grown.has(`${a.r},${a.c}`)) {
          grown.add(`${a.r},${a.c}`);
          const cell = rows[a.r]![a.c]!;
          cell.colSpan = spanOf(cell).cs + 1;
        }
        row.splice(at, 0, { blocks: [], merged: true });
        return;
      }
    }
    row.splice(at, 0, empty());
  });
  const columns = [...t.columns];
  columns.splice(at, 0, "");
  return { ...t, columns, rows };
}

/** Remove row r. A span starting there moves down to the next row; a span crossing it shrinks. */
export function deleteRow(t: Table, r: number): Table | null {
  if (t.rows.length <= 1) return null;
  const rows = copyRows(t);
  const done = new Set<string>();
  for (let c = 0; c < t.columns.length; c++) {
    const a = anchorOf(t, r, c);
    const key = `${a.r},${a.c}`;
    if (done.has(key)) continue;
    done.add(key);
    const cell = rows[a.r]![a.c]!;
    const { rs } = spanOf(cell);
    if (rs === 1) continue;
    if (a.r < r) cell.rowSpan = rs - 1;
    else rows[r + 1]![a.c] = { ...cell, rowSpan: rs - 1, merged: false };
  }
  rows.splice(r, 1);
  return { ...t, rows };
}

/** Remove column c. */
export function deleteColumn(t: Table, c: number): Table | null {
  if (t.columns.length <= 1) return null;
  const rows = copyRows(t);
  const done = new Set<string>();
  for (let r = 0; r < t.rows.length; r++) {
    const a = anchorOf(t, r, c);
    const key = `${a.r},${a.c}`;
    if (done.has(key)) continue;
    done.add(key);
    const cell = rows[a.r]![a.c]!;
    const { cs } = spanOf(cell);
    if (cs === 1) continue;
    if (a.c < c) cell.colSpan = cs - 1;
    else rows[a.r]![c + 1] = { ...cell, colSpan: cs - 1, merged: false };
  }
  for (const row of rows) row.splice(c, 1);
  const columns = [...t.columns];
  columns.splice(c, 1);
  return { ...t, columns, rows };
}

/**
 * Merge the cell at (r, c) with the one to its right (dir "right") or below
 * ("down"). Only possible when the neighbour lines up exactly: same height
 * for right, same width for down. The neighbour's content moves in.
 */
export function mergeCells(t: Table, r: number, c: number, dir: "right" | "down"): Table | null {
  const cell = t.rows[r]?.[c];
  if (!cell || cell.merged) return null;
  const { cs, rs } = spanOf(cell);
  const nr = dir === "down" ? r + rs : r;
  const nc = dir === "right" ? c + cs : c;
  const other = t.rows[nr]?.[nc];
  if (!other || other.merged) return null;
  const o = spanOf(other);
  if (dir === "right" && o.rs !== rs) return null;
  if (dir === "down" && o.cs !== cs) return null;
  const rows = copyRows(t);
  rows[r]![c] = {
    ...cell,
    blocks: [...cell.blocks, ...other.blocks],
    colSpan: dir === "right" ? cs + o.cs : cs,
    rowSpan: dir === "down" ? rs + o.rs : rs
  };
  for (let y = nr; y < nr + o.rs; y++) for (let x = nc; x < nc + o.cs; x++) rows[y]![x] = { blocks: [], merged: true };
  return { ...t, rows };
}

/** Undo a merge: the cell keeps its content and the cells it covered come back empty. */
export function splitCell(t: Table, r: number, c: number): Table | null {
  const cell = t.rows[r]?.[c];
  if (!cell || cell.merged) return null;
  const { cs, rs } = spanOf(cell);
  if (cs === 1 && rs === 1) return null;
  const rows = copyRows(t);
  for (let y = r; y < r + rs; y++) for (let x = c; x < c + cs; x++) rows[y]![x] = empty();
  const { colSpan: _c, rowSpan: _r, ...rest } = cell;
  rows[r]![c] = rest;
  return { ...t, rows };
}

export function updateCell(t: Table, r: number, c: number, next: TableCell): Table {
  const rows = copyRows(t);
  rows[r]![c] = next;
  return { ...t, rows };
}

/** A Columns block as a one-row table, so it can use spans and cell styles. */
export function rowToTable(row: Extract<Block, { type: "row" }>): Table {
  return {
    id: row.id,
    type: "table",
    columns: row.columns.map((c) => (/^\d+$/.test(c.width.trim()) ? c.width.trim() : "")),
    rows: [row.columns.map((c, i) => ({ blocks: c.blocks, padding: i < row.columns.length - 1 ? { right: 12 } : undefined }))]
  };
}
