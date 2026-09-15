import { useEffect, useMemo, useState, type ComponentType } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Image as ImageIcon,
  Minus,
  Share2,
  Trash2,
  Type,
  UserRound
} from "lucide-react";
import { api, type Block, type DirectoryPerson, type Signature } from "../api/client";
import { DIRECTORY_FIELDS } from "../lib/fields";
import {
  LiveBlock,
  blockLabel,
  duplicateBlock,
  findBlock,
  flattenBlocks,
  insertAfter,
  moveBlock,
  mutateDesign,
  removeBlock,
  replaceBlock,
  type PreviewUser
} from "../lib/preview";

function nid() {
  return `b_${Math.random().toString(36).slice(2, 10)}`;
}

function field(name: string, style: object = {}, link: "email" | "phone" | "url" | "none" = "none"): Block {
  return {
    id: nid(),
    type: "field",
    field: name,
    style: { fontFamily: "Calibri, Arial, sans-serif", fontSize: 13, color: "#1c1917", ...style },
    link
  };
}

const chips: Array<{ label: string; icon: ComponentType<{ size?: number; className?: string }>; make: () => Block }> = [
  { label: "Text", icon: Type, make: () => ({ id: nid(), type: "text", content: "Your text", style: { fontSize: 12, color: "#44403c" } }) },
  { label: "Name", icon: UserRound, make: () => field("displayName", { bold: true, fontSize: 18, color: "#0f766e" }) },
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
  { label: "Space", icon: Minus, make: () => ({ id: nid(), type: "spacer", height: 10 }) }
];

export function DesignerPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [sig, setSig] = useState<Signature | null>(null);
  const [saved, setSaved] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [users, setUsers] = useState<DirectoryPerson[]>([]);
  const [previewEmail, setPreviewEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    if (!id) return;
    void api.signature(id).then((s) => {
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
  const selectedBlock = sig && selected ? findBlock(sig.design.blocks, selected) : null;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if ((e.key === "Backspace" || e.key === "Delete") && selected) {
        e.preventDefault();
        patch((s) => ({ ...s, design: mutateDesign(s.design, (b) => removeBlock(b, selected)) }));
        setSelected(null);
      }
      if (e.key === "Escape") setSelected(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  useEffect(() => {
    function warn(e: BeforeUnloadEvent) {
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function patch(fn: (s: Signature) => Signature) {
    setSig((s) => (s ? fn(s) : s));
  }

  if (!sig) return <p className="p-8 text-stone-500">Loading editor…</p>;
  const current = sig;

  function add(block: Block) {
    patch((s) => ({ ...s, design: mutateDesign(s.design, (blocks) => insertAfter(blocks, selected, block)) }));
    setSelected(block.id);
  }

  async function save() {
    setSaving(true);
    try {
      await api.saveSignature(current.id, { name: current.name, design: current.design });
      setSaved(JSON.stringify({ name: current.name, design: current.design }));
      setStatus("Saved");
      setTimeout(() => setStatus(""), 1500);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="h-dvh flex flex-col bg-[#ece7dc] text-ink">
      <header className="h-14 shrink-0 bg-ink text-[#e7e0d4] flex items-center px-4 gap-3">
        <Link to="/signatures" className="text-sm text-stone-400 hover:text-white">
          Templates
        </Link>
        <span className="text-stone-600">/</span>
        <input
          className="font-semibold bg-transparent outline-none flex-1 text-white min-w-0"
          value={sig.name}
          onChange={(e) => patch((s) => ({ ...s, name: e.target.value }))}
        />
        <label className="hidden md:flex items-center gap-2 text-sm text-stone-400">
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
        {status && <span className="text-xs text-teal-200">{status}</span>}
        <button className="btn btn-ghost bg-transparent text-stone-300 border-white/15 hover:bg-white/10" onClick={() => navigate("/signatures")}>
          Close
        </button>
        <button className="btn btn-primary" disabled={saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save"}
        </button>
      </header>

      <div className="shrink-0 bg-card/80 border-b border-line px-4 py-2 flex items-center gap-1 overflow-x-auto">
        <span className="text-[11px] uppercase tracking-[0.14em] text-stone-500 mr-2 shrink-0">Insert</span>
        {chips.map((item) => (
          <button key={item.label} className="chip" onClick={() => add(item.make())} type="button">
            <item.icon size={14} />
            {item.label}
          </button>
        ))}
        <button
          className="chip"
          type="button"
          onClick={() =>
            add({
              id: nid(),
              type: "row",
              columns: [
                { width: "88", blocks: [{ id: nid(), type: "image", src: "{{photoUrl}}", width: 72, alt: "Photo" }] },
                {
                  width: "360",
                  blocks: [field("displayName", { bold: true, fontSize: 16, color: "#0f766e" }), field("jobTitle"), field("email", {}, "email")]
                }
              ]
            })
          }
        >
          <UserRound size={14} />
          Photo + details
        </button>
      </div>

      <div className="flex flex-1 min-h-0">
        <section className="flex-1 overflow-auto p-8" onClick={() => setSelected(null)}>
          <div className="max-w-[680px] mx-auto">
            <div className="letter" onClick={(e) => e.stopPropagation()}>
              <div className="bg-[#f7f4ee] px-7 py-4 border-b border-line text-[13px] space-y-1.5">
                <div className="flex gap-3">
                  <span className="w-12 text-stone-400 shrink-0">From</span>
                  <span>
                    {String(user.displayName || "Sender")} <span className="text-stone-500">&lt;{String(user.email || "")}&gt;</span>
                  </span>
                </div>
                <div className="flex gap-3">
                  <span className="w-12 text-stone-400 shrink-0">To</span>
                  <span>Ada Lovelace &lt;ada@contoso.com&gt;</span>
                </div>
                <div className="flex gap-3">
                  <span className="w-12 text-stone-400 shrink-0">Subject</span>
                  <span className="font-medium">Project update</span>
                </div>
              </div>
              <div className="bg-white px-7 py-8 min-h-[320px]">
                <p className="text-[15px] text-stone-600 mb-8 leading-7">Hello — thanks for the note. See you Thursday.</p>
                <div className="space-y-1 border-l-2 border-accent/30 pl-4">
                  {sig.design.blocks.map((b) => (
                    <LiveBlock key={b.id} block={b} user={user} selected={selected} onSelect={setSelected} />
                  ))}
                  {sig.design.blocks.length === 0 && (
                    <p className="text-stone-400 text-sm">Use Insert above. Click a line to style it.</p>
                  )}
                </div>
              </div>
            </div>
            <p className="text-center text-xs text-stone-500 mt-4">Live values from the directory. Empty fields stay as placeholders until the person has data.</p>
          </div>
        </section>

        <aside className="w-[300px] shrink-0 border-l border-line overflow-auto bg-card flex flex-col">
          <div className="p-4 border-b border-line">
            <p className="text-[11px] uppercase tracking-[0.14em] text-stone-500 mb-2">Layers</p>
            <div className="space-y-0.5">
              {flattenBlocks(sig.design.blocks).map(({ block, depth }) => (
                <button
                  key={block.id}
                  type="button"
                  className={`w-full text-left text-xs rounded-md px-2 py-1.5 ${selected === block.id ? "bg-accent text-white" : "hover:bg-mist text-stone-600"}`}
                  style={{ paddingLeft: 8 + depth * 12 }}
                  onClick={() => setSelected(block.id)}
                >
                  {blockLabel(block)}
                </button>
              ))}
            </div>
          </div>
          <div className="p-4 flex-1">
            <p className="text-[11px] uppercase tracking-[0.14em] text-stone-500 mb-3">Inspector</p>
            {!selectedBlock && <p className="text-sm text-stone-500">Select a line on the letter, or a layer on the left of this panel.</p>}
            {selectedBlock && (
              <>
                <div className="flex gap-1 mb-4">
                  <button className="btn btn-ghost px-2" title="Up" onClick={() => patch((s) => ({ ...s, design: mutateDesign(s.design, (b) => moveBlock(b, selectedBlock.id, -1)) }))}>
                    <ArrowUp size={14} />
                  </button>
                  <button className="btn btn-ghost px-2" title="Down" onClick={() => patch((s) => ({ ...s, design: mutateDesign(s.design, (b) => moveBlock(b, selectedBlock.id, 1)) }))}>
                    <ArrowDown size={14} />
                  </button>
                  <button className="btn btn-ghost px-2" title="Duplicate" onClick={() => patch((s) => ({ ...s, design: mutateDesign(s.design, (b) => duplicateBlock(b, selectedBlock.id)) }))}>
                    <Copy size={14} />
                  </button>
                  <button
                    className="btn btn-ghost px-2 text-rose-700 ml-auto"
                    title="Delete"
                    onClick={() => {
                      patch((s) => ({ ...s, design: mutateDesign(s.design, (b) => removeBlock(b, selectedBlock.id)) }));
                      setSelected(null);
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <Inspector
                  block={selectedBlock}
                  onChange={(next) => patch((s) => ({ ...s, design: mutateDesign(s.design, (b) => replaceBlock(b, next)) }))}
                />
              </>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

function Inspector({ block, onChange }: { block: Block; onChange: (b: Block) => void }) {
  return (
    <div className="space-y-3 text-sm">
      <div className="font-medium capitalize">{blockLabel(block)}</div>
      {block.type === "text" && (
        <label className="block">
          Content
          <textarea className="input mt-1 h-24" value={block.content} onChange={(e) => onChange({ ...block, content: e.target.value })} />
          <span className="text-[11px] text-stone-400">Use {"{{field}}"} for directory values.</span>
        </label>
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
              value={block.style?.fontFamily || "Calibri, Arial, sans-serif"}
              onChange={(e) => onChange({ ...block, style: { ...block.style, fontFamily: e.target.value } })}
            >
              <option>Calibri, Arial, sans-serif</option>
              <option>Arial, Helvetica, sans-serif</option>
              <option>Georgia, serif</option>
              <option>Tahoma, sans-serif</option>
            </select>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label>
              Size
              <input
                type="number"
                className="input mt-1"
                value={block.style?.fontSize ?? 13}
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
          <label className="block">
            Image URL
            <input className="input mt-1" value={block.src} onChange={(e) => onChange({ ...block, src: e.target.value })} placeholder="https://… or {{photoUrl}}" />
          </label>
          <label className="block">
            Width
            <input type="number" className="input mt-1" value={block.width ?? 140} onChange={(e) => onChange({ ...block, width: Number(e.target.value) })} />
          </label>
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
        </div>
      )}
    </div>
  );
}
