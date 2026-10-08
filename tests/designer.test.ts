import { describe, expect, it } from "vitest";
import type { Block } from "../web/src/api/client";
import {
  anchorOf,
  deleteColumn,
  deleteRow,
  duplicateBlocks,
  findBlock,
  flattenBlocks,
  insertAt,
  insertColumn,
  insertRow,
  mergeCells,
  moveBlocks,
  newTable,
  removeBlocks,
  rowToTable,
  splitCell
} from "../web/src/lib/tree";
import { planFit } from "../web/src/lib/images";

type Table = Extract<Block, { type: "table" }>;

const text = (id: string): Block => ({ id, type: "text", content: id });
const ids = (blocks: Block[]) => flattenBlocks(blocks).map(({ block }) => block.id);

/** A 3×3 table whose cell (r, c) holds one text block named "r,c". */
function grid(): Table {
  const t = newTable(3, 3);
  t.id = "t";
  t.rows = t.rows.map((row, r) => row.map((_, c) => ({ blocks: [text(`${r},${c}`)] })));
  return t;
}

/** The visible layout: each row's cells as "content:colSpan×rowSpan". */
function layout(t: Table): string[][] {
  return t.rows.map((row) =>
    row.filter((cell) => !cell.merged).map((cell) => `${cell.blocks.map((b) => b.id).join("+") || "-"}:${cell.colSpan ?? 1}x${cell.rowSpan ?? 1}`)
  );
}

describe("designer block tree", () => {
  const tree = (): Block[] => [text("a"), { ...grid() }, text("b")];

  it("finds, removes and duplicates blocks inside table cells", () => {
    expect(findBlock(tree(), "1,1")).toMatchObject({ content: "1,1" });
    const removed = removeBlocks(tree(), new Set(["a", "1,1", "2,2"]));
    expect(ids(removed)).not.toContain("1,1");
    expect(ids(removed)).not.toContain("a");
    const doubled = duplicateBlocks(tree(), new Set(["0,0"]));
    expect((doubled[1] as Table).rows[0]![0]!.blocks).toHaveLength(2);
  });

  it("moves several blocks together, in document order, into an empty cell", () => {
    let blocks = tree();
    (blocks[1] as Table).rows[2]![2]!.blocks = [];
    blocks = moveBlocks(blocks, new Set(["b", "a"]), { into: { container: "t", key: "r2c2" } });
    expect(blocks.map((b) => b.id)).toEqual(["t"]);
    expect((blocks[0] as Table).rows[2]![2]!.blocks.map((b) => b.id)).toEqual(["a", "b"]);
  });

  it("moves a block before or after another, across lists", () => {
    const blocks = moveBlocks(tree(), new Set(["0,0"]), { after: "b" });
    expect(blocks.map((b) => b.id)).toEqual(["a", "t", "b", "0,0"]);
    expect(moveBlocks(tree(), new Set(["b"]), { before: "1,1" })[1]).toMatchObject({ type: "table" });
    expect(((moveBlocks(tree(), new Set(["b"]), { before: "1,1" })[1] as Table).rows[1]![1]!.blocks.map((b) => b.id))).toEqual(["b", "1,1"]);
  });

  it("will not drop a table inside itself", () => {
    const blocks = tree();
    expect(moveBlocks(blocks, new Set(["t"]), { into: { container: "t", key: "r0c0" } })).toBe(blocks);
    expect(moveBlocks(blocks, new Set(["t"]), { before: "1,1" })).toBe(blocks);
  });

  it("inserts at the end of the signature", () => {
    expect(insertAt([text("a")], { into: { container: null, key: "root" } }, [text("z")]).map((b) => b.id)).toEqual(["a", "z"]);
  });
});

describe("table spans", () => {
  it("merges right and down, then splits back", () => {
    let t = mergeCells(grid(), 0, 0, "right")!;
    expect(layout(t)[0]).toEqual(["0,0+0,1:2x1", "0,2:1x1"]);
    t = mergeCells(t, 0, 0, "down")!;
    expect(t).toBeNull();
    let u = mergeCells(grid(), 0, 0, "down")!;
    u = mergeCells(u, 0, 0, "down")!;
    expect(layout(u).map((r) => r.length)).toEqual([3, 2, 2]);
    expect(layout(u)[0]![0]).toBe("0,0+1,0+2,0:1x3");
    const split = splitCell(u, 0, 0)!;
    expect(layout(split)[1]![0]).toBe("-:1x1");
  });

  it("only merges cells that line up", () => {
    const tall = mergeCells(grid(), 0, 1, "down")!;
    expect(mergeCells(tall, 0, 0, "right")).toBeNull();
    expect(mergeCells(tall, 1, 0, "right")).toBeNull();
    expect(mergeCells(tall, 0, 1, "right")).toBeNull();
  });

  it("grows a span when a row or column is added through it", () => {
    const wide = mergeCells(mergeCells(grid(), 0, 0, "right")!, 0, 0, "down");
    expect(wide).toBeNull();
    const t = mergeCells(grid(), 0, 1, "down")!;
    const rows = insertRow(t, 1);
    expect(rows.rows).toHaveLength(4);
    expect(rows.rows[0]![1]!.rowSpan).toBe(3);
    expect(rows.rows[1]![1]!.merged).toBe(true);
    expect(rows.rows[1]![0]!.merged).toBeUndefined();
    const cols = insertColumn(mergeCells(grid(), 0, 0, "right")!, 1);
    expect(cols.columns).toHaveLength(4);
    expect(cols.rows[0]![0]!.colSpan).toBe(3);
    expect(cols.rows[1]!.filter((c) => !c.merged)).toHaveLength(4);
  });

  it("keeps a span's content when the row it starts in is deleted", () => {
    const t = mergeCells(grid(), 0, 1, "down")!;
    const next = deleteRow(t, 0)!;
    expect(next.rows).toHaveLength(2);
    expect(next.rows[0]![1]).toMatchObject({ rowSpan: 1, merged: false });
    expect(next.rows[0]![1]!.blocks.map((b) => b.id)).toEqual(["0,1", "1,1"]);
    const shrunk = deleteRow(t, 1)!;
    expect(shrunk.rows[0]![1]!.rowSpan).toBe(1);
    const cols = deleteColumn(mergeCells(grid(), 1, 0, "right")!, 0)!;
    expect(cols.rows[1]![0]).toMatchObject({ colSpan: 1, merged: false });
    expect(deleteRow(newTable(1, 2), 0)).toBeNull();
  });

  it("finds the cell covering a merged position", () => {
    const wide = mergeCells(mergeCells(grid(), 1, 1, "right")!, 2, 1, "right")!;
    const t = mergeCells(wide, 1, 1, "down")!;
    expect(layout(t)[1]).toEqual(["1,0:1x1", "1,1+1,2+2,1+2,2:2x2"]);
    expect(anchorOf(t, 2, 2)).toEqual({ r: 1, c: 1 });
    expect(anchorOf(t, 2, 0)).toEqual({ r: 2, c: 0 });
  });

  it("turns Columns into a one-row table", () => {
    const t = rowToTable({ id: "r", type: "row", columns: [{ width: "88", blocks: [text("p")] }, { width: "auto", blocks: [] }] });
    expect(t).toMatchObject({ id: "r", type: "table", columns: ["88", ""] });
    expect(t.rows[0]![0]).toMatchObject({ padding: { right: 12 } });
  });
});

describe("fitting uploaded images", () => {
  const logo = (over: object = {}) => ({ id: "i", type: "image" as const, src: "/uploads/1_logo.png", width: 140, ...over });

  it("saves a large upload at twice the size shown", () => {
    expect(planFit(logo(), { width: 1600, height: 400 })).toMatchObject({ shown: { width: 140, height: 35 }, saved: { width: 280, height: 70 } });
  });

  it("never enlarges, keeps GIFs and links, and converts WEBP", () => {
    expect(planFit(logo(), { width: 200, height: 100 }).saved).toBeNull();
    expect(planFit(logo({ src: "/uploads/1_a.gif" }), { width: 1600, height: 400 }).saved).toBeNull();
    expect(planFit(logo({ src: "https://cdn.example/logo.png" }), { width: 1600, height: 400 }).saved).toBeNull();
    expect(planFit(logo({ src: "/uploads/1_a.webp" }), { width: 200, height: 100 }).saved).toEqual({ width: 200, height: 100 });
  });

  it("resizes from the original, not from an earlier smaller copy", () => {
    const plan = planFit(logo({ src: "/uploads/2_logo-280w.png", original: "/uploads/1_logo.png", width: 300 }), { width: 1600, height: 400 });
    expect(plan.saved).toEqual({ width: 600, height: 150 });
  });
});
