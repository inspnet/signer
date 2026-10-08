import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type DragEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Grid2x2,
  Image as ImageIcon,
  Minus,
  Share2,
  Trash2,
  Type,
  Undo2,
  UserRound
} from "lucide-react";
import { api, type Block, type CellSide, type DirectoryPerson, type Signature, type TableCell } from "../api/client";
import { DIRECTORY_FIELDS } from "../lib/fields";
import { APTOS_STACK, FONTS, inPoints } from "../lib/fonts";
import { defaultWidth, fitImages, isUpload, loadImage, planFit, type FitPlan } from "../lib/images";
import { CanvasProvider, LiveBlock, blockLabel, edgeTarget, sameTarget, useCanvasState, useSlotDrop, type CanvasState, type PreviewUser } from "../lib/preview";
import {
  anchorOf,
  deleteColumn,
  deleteRow,
  duplicateBlocks,
  findBlock,
  flattenBlocks,
  insertAfter,
  insertAt,
  insertColumn,
  insertRow,
  mergeCells,
  moveBlock,
  moveBlocks,
  newTable,
  nid,
  removeBlocks,
  replaceBlock,
  rowToTable,
  splitCell,
  updateCell,
  cellKey,
  contains,
  type DropTarget
} from "../lib/tree";

type Table = Extract<Block, { type: "table" }>;
type Cell = { table: string; r: number; c: number };

function field(name: string, style: object = {}, link: "email" | "phone" | "url" | "none" = "none"): Block {
  return {
    id: nid(),
    type: "field",
    field: name,
    style: { fontFamily: APTOS_STACK, fontSize: 10, color: "#1c1917", ...style },
    link
  };
}

function photoAndDetails(): Table {
  const t = newTable(1, 2);
  t.columns = ["88", "360"];
  t.rows[0]![0] = { blocks: [{ id: nid(), type: "image", src: "{{photoUrl}}", width: 72, alt: "Photo" }], padding: { right: 12 } };
  t.rows[0]![1] = { blocks: [field("displayName", { bold: true, fontSize: 12, color: "#0f766e" }), field("jobTitle"), field("email", {}, "email")] };
  return t;
}

const chips: Array<{ label: string; icon: ComponentType<{ size?: number; className?: string }>; make: () => Block }> = [
  { label: "Text", icon: Type, make: () => ({ id: nid(), type: "text", content: "Your text", style: { fontFamily: APTOS_STACK, fontSize: 10, color: "#44403c" } }) },
  { label: "Name", icon: UserRound, make: () => field("displayName", { bold: true, fontSize: 14, color: "#0f766e" }) },
  { label: "Title", icon: UserRound, make: () => field("jobTitle") },
  { label: "Email", icon: Type, make: () => field("email", {}, "email") },
  { label: "Phone", icon: Type, make: () => field("telephone", {}, "phone") },
  { label: "Mobile", icon: Type, make: () => field("mobile", {}, "phone") },
  { label: "Logo", icon: ImageIcon, make: () => ({ id: nid(), type: "image", src: "", width: 140, alt: "Logo" }) },
  { label: "Photo", icon: UserRound, make: () => ({ id: nid(), type: "image", src: "{{photoUrl}}", width: 72, alt: "Photo" }) },
  { label: "Banner", icon: ImageIcon, make: () => ({ id: nid(), type: "banner", src: "", width: 480, alt: "Banner" }) },
  {
    label: "Social",
    icon: Share2,
    make: () => ({
      id: nid(),
      type: "social",
      networks: [
        { name: "linkedin", urlField: "linkedin" },
        { name: "website", urlField: "website" }
      ],
      iconSize: 18
    })
  },
  { label: "Rule", icon: Minus, make: () => ({ id: nid(), type: "divider", color: "#0f766e", height: 2 }) },
  { label: "Space", icon: Minus, make: () => ({ id: nid(), type: "spacer", height: 10 }) },
  { label: "Table", icon: Grid2x2, make: () => newTable(2, 2) },
  { label: "Photo + details", icon: UserRound, make: photoAndDetails }
];

/** Edits typed within this long of each other undo as one step. */
const UNDO_COALESCE_MS = 800;

export function DesignerPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [sig, setSig] = useState<Signature | null>(null);
  const [saved, setSaved] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [activeCell, setActiveCell] = useState<Cell | null>(null);
  const [users, setUsers] = useState<DirectoryPerson[]>([]);
  const [previewEmail, setPreviewEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [dragging, setDragging] = useState<ReadonlySet<string> | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const history = useRef<{ stack: Signature[]; at: number }>({ stack: [], at: 0 });
  const lastClicked = useRef<string | null>(null);
  // The signature as of the latest edit, so several edits in one event build on each other.
  const sigRef = useRef<Signature | null>(null);
  sigRef.current = sig;

  useEffect(() => {
    if (!id) return;
    void api.signature(id).then((loaded) => {
      // Sizes in points, as in Outlook: 12 here is the same size as 12 there.
      const s = { ...loaded, design: inPoints(loaded.design) };
      setSig(s);
      setSaved(JSON.stringify({ name: s.name, design: s.design }));
    });
    void api.users().then((list) => {
      setUsers(list);
      if (list[0]) setPreviewEmail(list[0].email);
    });
  }, [id]);

  const user = useMemo<PreviewUser>(
    () => users.find((u) => u.email === previewEmail) || users[0] || { email: "", displayName: "" },
    [users, previewEmail]
  );
  const dirty = sig ? JSON.stringify({ name: sig.name, design: sig.design }) !== saved : false;
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const single = sig && selected.length === 1 ? findBlock(sig.design.blocks, selected[0]!) : null;

  /** Change the signature, keeping the previous version for undo. */
  const patch = useCallback((fn: (s: Signature) => Signature, coalesce = false) => {
    const s = sigRef.current;
    if (!s) return;
    const next = fn(s);
    if (next === s) return;
    const h = history.current;
    const now = Date.now();
    if (!(coalesce && now - h.at < UNDO_COALESCE_MS)) h.stack = [...h.stack.slice(-99), s];
    h.at = now;
    sigRef.current = next;
    setSig(next);
  }, []);

  const editBlocks = useCallback(
    (fn: (blocks: Block[]) => Block[], coalesce = false) => patch((s) => ({ ...s, design: { ...s.design, blocks: fn(s.design.blocks) } }), coalesce),
    [patch]
  );

  const undo = useCallback(() => {
    const previous = history.current.stack.pop();
    if (!previous) return;
    history.current.at = 0;
    sigRef.current = previous;
    setSig(previous);
    setSelected((ids) => ids.filter((x) => findBlock(previous.design.blocks, x)));
    setActiveCell(null);
  }, []);

  const deleteSelected = useCallback(() => {
    if (!selected.length) return;
    editBlocks((b) => removeBlocks(b, new Set(selected)));
    setSelected([]);
    setActiveCell(null);
  }, [selected, editBlocks]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      const typing = el?.tagName === "INPUT" || el?.tagName === "TEXTAREA" || el?.tagName === "SELECT" || el?.isContentEditable;
      if (typing) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      }
      // With a table cell active, Delete would take the whole table; the inspector's bin does that on purpose.
      if ((e.key === "Backspace" || e.key === "Delete") && selected.length && !activeCell) {
        e.preventDefault();
        deleteSelected();
      }
      if (e.key === "Escape") {
        setSelected([]);
        setActiveCell(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, activeCell, undo, deleteSelected]);

  useEffect(() => {
    function warn(e: BeforeUnloadEvent) {
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const select = useCallback(
    (blockId: string, additive: boolean, range = false) => {
      setActiveCell(null);
      if (range && sig && lastClicked.current) {
        const order = flattenBlocks(sig.design.blocks).map(({ block }) => block.id);
        const a = order.indexOf(lastClicked.current);
        const b = order.indexOf(blockId);
        if (a !== -1 && b !== -1) {
          const span = order.slice(Math.min(a, b), Math.max(a, b) + 1);
          setSelected((ids) => [...new Set([...ids, ...span])]);
          return;
        }
      }
      lastClicked.current = blockId;
      setSelected((ids) => (additive ? (ids.includes(blockId) ? ids.filter((x) => x !== blockId) : [...ids, blockId]) : [blockId]));
    },
    [sig]
  );

  const canvas: CanvasState = {
    user,
    selected: selectedSet,
    onSelect: (blockId, additive) => select(blockId, additive),
    activeCell,
    onSelectCell: (table, r, c) => {
      setSelected([table]);
      setActiveCell({ table, r, c });
    },
    dragging,
    drop,
    onDragStart: (blockId) => {
      // Dragging one of several selected blocks moves them all.
      const ids = selectedSet.has(blockId) ? selectedSet : new Set([blockId]);
      if (!selectedSet.has(blockId)) setSelected([blockId]);
      setDragging(ids);
    },
    onDragOver: setDrop,
    onDrop: () => {
      if (dragging && drop) editBlocks((b) => moveBlocks(b, dragging, drop));
      setDragging(null);
      setDrop(null);
    },
    onDragEnd: () => {
      setDragging(null);
      setDrop(null);
    },
    onResize: (blockId, width) =>
      editBlocks((blocks) => {
        const b = findBlock(blocks, blockId);
        return b && (b.type === "image" || b.type === "banner") ? replaceBlock(blocks, { ...b, width }) : blocks;
      }, true),
    maxWidth: sig?.design.width ?? 520
  };

  if (!sig) return <p className="p-8 text-slate-500">Loading editor…</p>;
  const current = sig;

  function add(block: Block) {
    const cell = activeCell && selected.length === 1 && selected[0] === activeCell.table ? activeCell : null;
    editBlocks((blocks) => {
      if (cell) return insertAt(blocks, { into: { container: cell.table, key: cellKey(cell.r, cell.c) } }, [block]);
      return insertAfter(blocks, selected.length === 1 ? selected[0]! : null, block);
    });
    setSelected([block.id]);
    setActiveCell(null);
  }

  async function save() {
    setSaving(true);
    try {
      setStatus("Fitting images…");
      const design = await fitImages(current.design, api.uploadImage);
      if (design !== current.design) patch((s) => ({ ...s, design }));
      setStatus("Saving…");
      await api.saveSignature(current.id, { name: current.name, design });
      setSaved(JSON.stringify({ name: current.name, design }));
      setStatus("Saved");
      setTimeout(() => setStatus(""), 1500);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="h-dvh flex flex-col bg-paper text-ink">
      <header className="h-14 shrink-0 bg-ink text-slate-200 flex items-center px-4 gap-3">
        <Link to="/signatures" className="text-sm text-slate-400 hover:text-white">
          Templates
        </Link>
        <span className="text-slate-600">/</span>
        <input
          className="font-semibold bg-transparent outline-none flex-1 text-white min-w-0"
          value={sig.name}
          onChange={(e) => patch((s) => ({ ...s, name: e.target.value }), true)}
        />
        <label className="hidden md:flex items-center gap-2 text-sm text-slate-400">
          Preview as
          <select
            className="bg-white/10 text-white rounded-md px-2 py-1 outline-none"
            value={previewEmail}
            onChange={(e) => setPreviewEmail(e.target.value)}
          >
            {users.map((u) => (
              <option key={u.email} value={u.email} className="text-ink">
                {u.displayName || u.email} ({u.email})
              </option>
            ))}
          </select>
        </label>
        {dirty && <span className="text-xs text-amber-200 bg-amber-900/40 px-2 py-0.5 rounded-md">Unsaved</span>}
        {status && <span className="text-xs text-sky-200">{status}</span>}
        <button
          className="btn btn-ghost bg-transparent text-slate-300 border-white/15 hover:bg-white/10 px-2"
          title="Undo (Ctrl+Z / ⌘Z)"
          disabled={!history.current.stack.length}
          onClick={undo}
        >
          <Undo2 size={16} />
        </button>
        <button className="btn btn-ghost bg-transparent text-slate-300 border-white/15 hover:bg-white/10" onClick={() => navigate("/signatures")}>
          Close
        </button>
        <button className="btn btn-primary" disabled={saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save"}
        </button>
      </header>

      <div className="shrink-0 bg-card/80 border-b border-line px-4 py-2 flex items-center gap-1 overflow-x-auto">
        <span className="text-[11px] uppercase tracking-[0.14em] text-slate-500 mr-2 shrink-0">Insert</span>
        {chips.map((item) => (
          <button key={item.label} className="chip" onClick={() => add(item.make())} type="button">
            <item.icon size={14} />
            {item.label}
          </button>
        ))}
      </div>

      <CanvasProvider value={canvas}>
        <div className="flex flex-1 min-h-0">
          <section
            className="flex-1 overflow-auto p-8"
            onClick={() => {
              setSelected([]);
              setActiveCell(null);
            }}
          >
            <div className="max-w-[680px] mx-auto">
              <div className="letter" onClick={(e) => e.stopPropagation()}>
                <div className="bg-[#f8fafc] px-7 py-4 border-b border-line text-[13px] space-y-1.5">
                  <div className="flex gap-3">
                    <span className="w-12 text-slate-400 shrink-0">From</span>
                    <span>
                      {String(user.displayName || "Sender")} <span className="text-slate-500">&lt;{String(user.email || "")}&gt;</span>
                    </span>
                  </div>
                  <div className="flex gap-3">
                    <span className="w-12 text-slate-400 shrink-0">To</span>
                    <span>Ada Lovelace &lt;ada@contoso.com&gt;</span>
                  </div>
                  <div className="flex gap-3">
                    <span className="w-12 text-slate-400 shrink-0">Subject</span>
                    <span className="font-medium">Project update</span>
                  </div>
                </div>
                <div className="bg-white px-7 py-8 min-h-[320px]">
                  <p className="text-[15px] text-slate-600 mb-8 leading-7">Hello — thanks for the note. See you Thursday.</p>
                  <RootList blocks={sig.design.blocks} />
                </div>
              </div>
              <p className="text-center text-xs text-slate-500 mt-4">
                Drag to move. Shift- or ⌘/Ctrl-click to select several. Live values from the directory; empty fields stay as placeholders.
              </p>
            </div>
          </section>

          <aside className="w-[320px] shrink-0 border-l border-line overflow-auto bg-card flex flex-col">
            <Layers blocks={sig.design.blocks} selected={selectedSet} onSelect={select} />
            <div className="p-4 flex-1">
              <p className="text-[11px] uppercase tracking-[0.14em] text-slate-500 mb-3">Inspector</p>
              {selected.length === 0 && <p className="text-sm text-slate-500">Select a line on the letter, or a layer above.</p>}
              {selected.length > 1 && (
                <div className="space-y-3 text-sm">
                  <div className="font-medium">{selected.length} selected</div>
                  <div className="flex gap-2">
                    <button className="btn btn-ghost" onClick={() => editBlocks((b) => duplicateBlocks(b, selectedSet))}>
                      <Copy size={14} /> Duplicate
                    </button>
                    <button className="btn btn-ghost text-rose-700" onClick={deleteSelected}>
                      <Trash2 size={14} /> Delete {selected.length}
                    </button>
                  </div>
                  <p className="text-xs text-slate-500 leading-5">Delete or Backspace removes them; ⌘/Ctrl+Z brings them back. Drag any of them to move them together.</p>
                </div>
              )}
              {single && (
                <>
                  <div className="flex gap-1 mb-4">
                    <button className="btn btn-ghost px-2" title="Up" onClick={() => editBlocks((b) => moveBlock(b, single.id, -1))}>
                      <ArrowUp size={14} />
                    </button>
                    <button className="btn btn-ghost px-2" title="Down" onClick={() => editBlocks((b) => moveBlock(b, single.id, 1))}>
                      <ArrowDown size={14} />
                    </button>
                    <button className="btn btn-ghost px-2" title="Duplicate" onClick={() => editBlocks((b) => duplicateBlocks(b, new Set([single.id])))}>
                      <Copy size={14} />
                    </button>
                    <button className="btn btn-ghost px-2 text-rose-700 ml-auto" title="Delete" onClick={deleteSelected}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                  <Inspector
                    block={single}
                    activeCell={activeCell?.table === single.id ? activeCell : null}
                    onCell={setActiveCell}
                    onChange={(next) => editBlocks((b) => replaceBlock(b, next), true)}
                  />
                </>
              )}
            </div>
          </aside>
        </div>
      </CanvasProvider>
    </div>
  );
}

function RootList({ blocks }: { blocks: Block[] }) {
  const slot = useSlotDrop({ container: null, key: "root" });
  return (
    <div {...slot.props} className={`space-y-1 border-l-2 border-accent/30 pl-4 pb-4 ${slot.active ? "border-accent" : ""}`}>
      {blocks.map((b) => (
        <LiveBlock key={b.id} block={b} />
      ))}
      {blocks.length === 0 && <p className="text-slate-400 text-sm">Use Insert above. Click a line to style it.</p>}
    </div>
  );
}

/**
 * The layer list: the same tree as the letter, sharing its drag, so a layer
 * can be dropped among the layers or onto the letter. Shift-click selects a
 * range, ⌘/Ctrl-click adds or removes one.
 */
function Layers({
  blocks,
  selected,
  onSelect
}: {
  blocks: Block[];
  selected: ReadonlySet<string>;
  onSelect: (id: string, additive: boolean, range?: boolean) => void;
}) {
  const ctx = useCanvasState();
  const moving = ctx.dragging ? [...ctx.dragging].map((id) => findBlock(blocks, id)).filter((b): b is Block => b !== null) : [];
  return (
    <div className="p-4 border-b border-line">
      <p className="text-[11px] uppercase tracking-[0.14em] text-slate-500 mb-2">Layers</p>
      <div className="space-y-0.5">
        {flattenBlocks(blocks).map(({ block, depth }) => {
          const isOn = selected.has(block.id);
          const drop = ctx.drop;
          const line = drop && "before" in drop && drop.before === block.id ? "before" : drop && "after" in drop && drop.after === block.id ? "after" : null;
          const isMoving = moving.some((m) => contains(m, block.id));
          return (
            <button
              key={block.id}
              type="button"
              draggable
              className={`relative w-full text-left text-xs rounded-md px-2 py-1.5 cursor-grab ${isOn ? "bg-accent text-white" : "hover:bg-mist text-slate-600"} ${isMoving ? "opacity-40" : ""}`}
              style={{ paddingLeft: 8 + depth * 12 }}
              onClick={(e) => onSelect(block.id, e.metaKey || e.ctrlKey, e.shiftKey)}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", block.id);
                ctx.onDragStart(block.id);
              }}
              onDragOver={(e: DragEvent) => {
                if (!ctx.dragging) return;
                e.preventDefault();
                const target = isMoving ? null : edgeTarget(e, block.id);
                if (!sameTarget(ctx.drop, target)) ctx.onDragOver(target);
              }}
              onDrop={(e) => {
                e.preventDefault();
                ctx.onDrop();
              }}
              onDragEnd={() => ctx.onDragEnd()}
            >
              {line && <span className={`pointer-events-none absolute left-0 right-0 h-0.5 bg-accent ${line === "before" ? "top-0" : "bottom-0"}`} />}
              {blockLabel(block)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Inspector({
  block,
  onChange,
  activeCell,
  onCell
}: {
  block: Block;
  onChange: (b: Block) => void;
  activeCell: Cell | null;
  onCell: (cell: Cell | null) => void;
}) {
  return (
    <div className="space-y-3 text-sm">
      <div className="font-medium capitalize">{blockLabel(block)}</div>
      {block.type === "text" && (
        <>
          <label className="block">
            Content
            <textarea className="input mt-1 h-24" value={block.content} onChange={(e) => onChange({ ...block, content: e.target.value })} />
            <span className="text-[11px] text-slate-400">Use {"{{field}}"} for directory values.</span>
          </label>
          <label className="block">
            Link
            <input
              className="input mt-1"
              value={block.href || ""}
              onChange={(e) => onChange({ ...block, href: e.target.value })}
              placeholder="https://…, mailto:…, tel:… or {{website}}"
            />
            <span className="text-[11px] text-slate-400">Optional. Makes the whole text clickable.</span>
          </label>
          {block.href && (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={Boolean(block.underline)} onChange={(e) => onChange({ ...block, underline: e.target.checked })} />
              Underline the link
            </label>
          )}
        </>
      )}
      {block.type === "field" && (
        <>
          <label className="block">
            Directory field
            <select className="input mt-1" value={block.field} onChange={(e) => onChange({ ...block, field: e.target.value })}>
              {DIRECTORY_FIELDS.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
              {!DIRECTORY_FIELDS.some((f) => f.key === block.field) && <option value={block.field}>{block.field}</option>}
            </select>
          </label>
          <label className="block">
            Prefix
            <input className="input mt-1" value={block.prefix || ""} onChange={(e) => onChange({ ...block, prefix: e.target.value })} />
          </label>
          <label className="block">
            Suffix
            <input className="input mt-1" value={block.suffix || ""} onChange={(e) => onChange({ ...block, suffix: e.target.value })} />
          </label>
          <label className="block">
            Link
            <select className="input mt-1" value={block.link || "none"} onChange={(e) => onChange({ ...block, link: e.target.value as "email" | "phone" | "url" | "none" })}>
              <option value="none">None</option>
              <option value="email">Email</option>
              <option value="phone">Phone</option>
              <option value="url">URL</option>
            </select>
          </label>
        </>
      )}
      {(block.type === "text" || block.type === "field") && (
        <>
          <label className="block">
            Font
            <select
              className="input mt-1"
              value={block.style?.fontFamily || APTOS_STACK}
              onChange={(e) => onChange({ ...block, style: { ...block.style, fontFamily: e.target.value } })}
            >
              {FONTS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
              {!FONTS.some(([value]) => value === (block.style?.fontFamily || APTOS_STACK)) && (
                <option value={block.style?.fontFamily}>{block.style?.fontFamily}</option>
              )}
            </select>
            {(block.style?.fontFamily || APTOS_STACK).startsWith("Aptos") && (
              <span className="block mt-1 text-xs text-slate-500">
                Aptos is Microsoft 365&apos;s default font. Recipients without it see Calibri, then Arial; so may this preview.
              </span>
            )}
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label>
              Size (pt)
              <input
                type="number"
                step={0.5}
                min={6}
                className="input mt-1"
                value={block.style?.fontSize ?? 9}
                onChange={(e) => onChange({ ...block, style: { ...block.style, fontSize: Number(e.target.value) } })}
              />
            </label>
            <label>
              Color
              <input
                type="color"
                className="mt-1 h-10 w-full rounded-md border border-line"
                value={block.style?.color ?? "#1c1917"}
                onChange={(e) => onChange({ ...block, style: { ...block.style, color: e.target.value } })}
              />
            </label>
          </div>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={Boolean(block.style?.bold)} onChange={(e) => onChange({ ...block, style: { ...block.style, bold: e.target.checked } })} />
            Bold
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={Boolean(block.style?.italic)} onChange={(e) => onChange({ ...block, style: { ...block.style, italic: e.target.checked } })} />
            Italic
          </label>
        </>
      )}
      {(block.type === "image" || block.type === "banner") && (
        <>
          <ImageSource src={block.original || block.src} onChange={(src) => onChange({ ...block, src, original: undefined, height: undefined })} />
          <label className="block">
            Width (px)
            <input type="number" min={16} className="input mt-1" value={defaultWidth(block)} onChange={(e) => onChange({ ...block, width: Number(e.target.value) })} />
            <span className="text-[11px] text-slate-400">Or drag the corner of the image on the letter.</span>
          </label>
          <ImageFit block={block} />
          <label className="block">
            Alt text
            <input className="input mt-1" value={block.alt || ""} onChange={(e) => onChange({ ...block, alt: e.target.value })} />
          </label>
          <label className="block">
            Link
            <input className="input mt-1" value={block.href || ""} onChange={(e) => onChange({ ...block, href: e.target.value })} />
          </label>
        </>
      )}
      {block.type === "divider" && (
        <>
          <label className="block">
            Color
            <input type="color" className="mt-1 h-10 w-full rounded-md border border-line" value={block.color || "#d6d3d1"} onChange={(e) => onChange({ ...block, color: e.target.value })} />
          </label>
          <label className="block">
            Thickness
            <input type="number" className="input mt-1" value={block.height ?? 1} onChange={(e) => onChange({ ...block, height: Number(e.target.value) })} />
          </label>
        </>
      )}
      {block.type === "spacer" && (
        <label className="block">
          Height
          <input type="number" className="input mt-1" value={block.height ?? 8} onChange={(e) => onChange({ ...block, height: Number(e.target.value) })} />
        </label>
      )}
      {block.type === "social" && (
        <div className="space-y-2">
          {block.networks.map((n, i) => (
            <div key={`${n.name}-${i}`} className="grid grid-cols-2 gap-2">
              <select
                className="input"
                value={n.name}
                onChange={(e) => {
                  const networks = [...block.networks];
                  networks[i] = { ...n, name: e.target.value as typeof n.name };
                  onChange({ ...block, networks });
                }}
              >
                <option value="linkedin">LinkedIn</option>
                <option value="x">X</option>
                <option value="facebook">Facebook</option>
                <option value="instagram">Instagram</option>
                <option value="website">Website</option>
              </select>
              <input
                className="input"
                value={n.urlField || n.url || ""}
                placeholder="field or URL"
                onChange={(e) => {
                  const networks = [...block.networks];
                  const v = e.target.value;
                  networks[i] = v.includes("://") || v.startsWith("www.") ? { ...n, url: v, urlField: undefined } : { ...n, urlField: v, url: undefined };
                  onChange({ ...block, networks });
                }}
              />
            </div>
          ))}
          <button
            type="button"
            className="btn btn-ghost w-full"
            onClick={() => onChange({ ...block, networks: [...block.networks, { name: "linkedin", urlField: "linkedin" }] })}
          >
            Add network
          </button>
        </div>
      )}
      {block.type === "row" && (
        <div className="space-y-2">
          {block.columns.map((col, i) => (
            <label key={i} className="block">
              Column {i + 1} width
              <input
                className="input mt-1"
                value={col.width}
                onChange={(e) => {
                  const columns = block.columns.map((c, idx) => (idx === i ? { ...c, width: e.target.value } : c));
                  onChange({ ...block, columns });
                }}
              />
            </label>
          ))}
          <button type="button" className="btn btn-ghost w-full" onClick={() => onChange(rowToTable(block))}>
            Convert to table
          </button>
          <p className="text-xs text-slate-500 leading-5">A table can add rows, merge cells across columns or rows, and set padding, alignment and borders per cell.</p>
        </div>
      )}
      {block.type === "table" && <TableInspector table={block} cell={activeCell} onCell={onCell} onChange={onChange} />}
    </div>
  );
}

const SIDES: CellSide[] = ["top", "right", "bottom", "left"];

function TableInspector({
  table,
  cell,
  onCell,
  onChange
}: {
  table: Table;
  cell: Cell | null;
  onCell: (cell: Cell | null) => void;
  onChange: (b: Block) => void;
}) {
  const at = cell && table.rows[cell.r]?.[cell.c] && !table.rows[cell.r]![cell.c]!.merged ? cell : null;
  const data = at ? table.rows[at.r]![at.c]! : null;

  /** Apply a table operation and keep a sensible cell selected afterwards. */
  function apply(next: Table | null, focus?: { r: number; c: number }) {
    if (!next) return;
    onChange(next);
    if (focus) {
      const r = Math.min(focus.r, next.rows.length - 1);
      const c = Math.min(focus.c, next.columns.length - 1);
      onCell({ table: table.id, ...anchorOf(next, r, c) });
    }
  }
  const setCell = (next: TableCell) => at && onChange(updateCell(table, at.r, at.c, next));
  const can = {
    right: at ? mergeCells(table, at.r, at.c, "right") !== null : false,
    down: at ? mergeCells(table, at.r, at.c, "down") !== null : false,
    split: at ? splitCell(table, at.r, at.c) !== null : false
  };

  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs text-slate-500 mb-1">Column widths (px, empty for automatic)</div>
        <div className="grid grid-cols-4 gap-1.5">
          {table.columns.map((w, i) => (
            <input
              key={i}
              className="input px-2"
              inputMode="numeric"
              placeholder="auto"
              value={w}
              onChange={(e) => onChange({ ...table, columns: table.columns.map((x, j) => (j === i ? e.target.value.replace(/\D/g, "") : x)) })}
            />
          ))}
        </div>
      </div>

      {!at && <p className="text-xs text-slate-500 leading-5">Click a cell on the letter to add rows or columns next to it, merge it with a neighbour, or style it.</p>}

      {at && data && (
        <>
          <div className="text-xs text-slate-500">
            Cell: row {at.r + 1}, column {at.c + 1}
            {(data.colSpan ?? 1) > 1 && `, spans ${data.colSpan} columns`}
            {(data.rowSpan ?? 1) > 1 && `, spans ${data.rowSpan} rows`}
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            <button className="btn btn-ghost px-2 text-xs" onClick={() => apply(insertRow(table, at.r), { r: at.r + 1, c: at.c })}>
              Row above
            </button>
            <button className="btn btn-ghost px-2 text-xs" onClick={() => apply(insertRow(table, at.r + (data.rowSpan ?? 1)), at)}>
              Row below
            </button>
            <button className="btn btn-ghost px-2 text-xs text-rose-700" disabled={table.rows.length < 2} onClick={() => apply(deleteRow(table, at.r), at)}>
              Delete row
            </button>
            <button className="btn btn-ghost px-2 text-xs" onClick={() => apply(insertColumn(table, at.c), { r: at.r, c: at.c + 1 })}>
              Column left
            </button>
            <button className="btn btn-ghost px-2 text-xs" onClick={() => apply(insertColumn(table, at.c + (data.colSpan ?? 1)), at)}>
              Column right
            </button>
            <button className="btn btn-ghost px-2 text-xs text-rose-700" disabled={table.columns.length < 2} onClick={() => apply(deleteColumn(table, at.c), at)}>
              Delete col
            </button>
            <button className="btn btn-ghost px-2 text-xs" disabled={!can.right} title="Merge with the cell to the right (column span)" onClick={() => apply(mergeCells(table, at.r, at.c, "right"), at)}>
              Merge →
            </button>
            <button className="btn btn-ghost px-2 text-xs" disabled={!can.down} title="Merge with the cell below (row span)" onClick={() => apply(mergeCells(table, at.r, at.c, "down"), at)}>
              Merge ↓
            </button>
            <button className="btn btn-ghost px-2 text-xs" disabled={!can.split} onClick={() => apply(splitCell(table, at.r, at.c), at)}>
              Split
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs">
              Align
              <select className="input mt-1" value={data.align ?? "left"} onChange={(e) => setCell({ ...data, align: e.target.value as TableCell["align"] })}>
                <option value="left">Left</option>
                <option value="center">Centre</option>
                <option value="right">Right</option>
              </select>
            </label>
            <label className="text-xs">
              Vertical
              <select className="input mt-1" value={data.valign ?? "top"} onChange={(e) => setCell({ ...data, valign: e.target.value as TableCell["valign"] })}>
                <option value="top">Top</option>
                <option value="middle">Middle</option>
                <option value="bottom">Bottom</option>
              </select>
            </label>
          </div>

          <div>
            <div className="text-xs mb-1">Padding (px): top, right, bottom, left</div>
            <div className="grid grid-cols-4 gap-1.5">
              {SIDES.map((side) => (
                <input
                  key={side}
                  type="number"
                  min={0}
                  title={side}
                  className="input px-2"
                  value={data.padding?.[side] ?? 0}
                  onChange={(e) => setCell({ ...data, padding: { ...data.padding, [side]: Math.max(0, Number(e.target.value) || 0) } })}
                />
              ))}
            </div>
          </div>

          <div>
            <div className="text-xs mb-1">Border</div>
            <div className="flex flex-wrap gap-3 text-xs">
              {SIDES.map((side) => (
                <label key={side} className="flex items-center gap-1 capitalize">
                  <input
                    type="checkbox"
                    checked={data.border?.sides.includes(side) ?? false}
                    onChange={(e) => {
                      const sides = new Set(data.border?.sides ?? []);
                      if (e.target.checked) sides.add(side);
                      else sides.delete(side);
                      setCell({ ...data, border: sides.size ? { ...data.border, sides: SIDES.filter((s) => sides.has(s)) } : undefined });
                    }}
                  />
                  {side}
                </label>
              ))}
            </div>
            {data.border && (
              <div className="grid grid-cols-2 gap-2 mt-2">
                <input
                  type="color"
                  className="h-9 w-full rounded-md border border-line"
                  value={data.border.color ?? "#d1d5db"}
                  onChange={(e) => setCell({ ...data, border: { ...data.border!, color: e.target.value } })}
                />
                <input
                  type="number"
                  min={1}
                  className="input"
                  title="Thickness (px)"
                  value={data.border.width ?? 1}
                  onChange={(e) => setCell({ ...data, border: { ...data.border!, width: Math.max(1, Number(e.target.value) || 1) } })}
                />
              </div>
            )}
          </div>

          <label className="block text-xs">
            Background
            <div className="flex gap-2 mt-1">
              <input
                type="color"
                className="h-9 w-16 rounded-md border border-line"
                value={data.background || "#ffffff"}
                onChange={(e) => setCell({ ...data, background: e.target.value })}
              />
              {data.background && (
                <button className="btn btn-ghost text-xs" onClick={() => setCell({ ...data, background: undefined })}>
                  None
                </button>
              )}
            </div>
          </label>
        </>
      )}
    </div>
  );
}

/** The image's file size against where it is placed, and what saving will do with it. */
function ImageFit({ block }: { block: Extract<Block, { type: "image" | "banner" }> }) {
  const source = block.original || block.src;
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    setNatural(null);
    if (!source || source.includes("{{")) return;
    let live = true;
    void loadImage(source)
      .then((img) => live && setNatural({ width: img.naturalWidth, height: img.naturalHeight }))
      .catch(() => live && setNatural(null));
    return () => {
      live = false;
    };
  }, [source]);
  if (!natural) return null;
  const plan: FitPlan = planFit(block, natural);
  return (
    <div className="rounded-md bg-mist px-3 py-2 text-xs text-slate-600 leading-5">
      <div>
        File {natural.width} × {natural.height} px · shown at {plan.shown.width} × {plan.shown.height}
      </div>
      {plan.saved && isUpload(source) && (
        <div className="font-medium text-ink">
          Saved as {plan.saved.width} × {plan.saved.height} px when you save
        </div>
      )}
      <div className="text-slate-500">{plan.note}</div>
    </div>
  );
}

/**
 * Where an image comes from: an upload (embedded in every email, so
 * recipients see it without loading external images) or a link.
 */
function ImageSource({ src, onChange }: { src: string; onChange: (src: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const uploaded = src.startsWith("/uploads/");
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <label className={`btn btn-ghost cursor-pointer ${busy ? "opacity-50" : ""}`}>
          {busy ? "Uploading…" : uploaded ? "Replace image" : "Upload image"}
          <input
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            className="hidden"
            disabled={busy}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              setBusy(true);
              setError("");
              try {
                onChange((await api.uploadImage(file)).url);
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              } finally {
                setBusy(false);
              }
            }}
          />
        </label>
        {uploaded && <span className="text-xs text-emerald-700">Embedded in the email</span>}
      </div>
      {error && <p className="text-xs text-red-700">{error}</p>}
      <label className="block">
        Or image link
        <input
          className="input mt-1"
          value={uploaded ? "" : src}
          onChange={(e) => onChange(e.target.value)}
          placeholder={uploaded ? "Using the uploaded image" : "https://… or {{photoUrl}}"}
        />
      </label>
      <p className="text-xs text-slate-500 leading-5">
        Uploaded images (PNG, JPEG, GIF or WEBP, up to 8 MB) travel inside each email, so recipients see them without &quot;download
        pictures&quot; prompts. Upload the full-size file: saving resizes it to fit. Links are loaded from the web when the email is opened.
      </p>
    </div>
  );
}
