import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, type Block, type Design, type Signature } from "../api/client";

const toolbox: Array<{ label: string; section: string; make: () => Block }> = [
  { section: "Text & Fields", label: "Text", make: () => ({ id: nid(), type: "text", content: "Text", style: { fontSize: 12, color: "#000000", fontFamily: "Calibri, Arial, sans-serif" } }) },
  { section: "Text & Fields", label: "Display name", make: () => field("displayName", { bold: true, fontSize: 16 }) },
  { section: "Text & Fields", label: "Job title", make: () => field("jobTitle") },
  { section: "Text & Fields", label: "Department", make: () => field("department") },
  { section: "Text & Fields", label: "Email", make: () => field("email", {}, "email") },
  { section: "Text & Fields", label: "Telephone", make: () => field("telephone", {}, "phone") },
  { section: "Text & Fields", label: "Mobile", make: () => field("mobile", {}, "phone") },
  { section: "Text & Fields", label: "Website", make: () => field("website", {}, "url") },
  { section: "Text & Fields", label: "Pronouns", make: () => field("pronouns") },
  { section: "Text & Fields", label: "Address", make: () => field("streetAddress") },
  { section: "Images & Icons", label: "Image / logo", make: () => ({ id: nid(), type: "image", src: "", width: 140, alt: "Logo" }) },
  { section: "Images & Icons", label: "Banner", make: () => ({ id: nid(), type: "banner", src: "", width: 460, alt: "Banner" }) },
  { section: "Social Media", label: "Social icons", make: () => ({ id: nid(), type: "social", networks: [{ name: "linkedin", urlField: "linkedin" }, { name: "website", urlField: "website" }], iconSize: 18 }) },
  { section: "Legal & Compliance", label: "Divider", make: () => ({ id: nid(), type: "divider", color: "#d1d5db" }) },
  { section: "Legal & Compliance", label: "Spacer", make: () => ({ id: nid(), type: "spacer", height: 8 }) }
];

function nid() {
  return `b_${Math.random().toString(36).slice(2, 10)}`;
}
function field(name: string, style: object = {}, link: "email" | "phone" | "url" | "none" = "none"): Block {
  return { id: nid(), type: "field", field: name, style: { fontFamily: "Calibri, Arial, sans-serif", fontSize: 12, color: "#000000", ...style }, link };
}

export function DesignerPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [sig, setSig] = useState<Signature | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [users, setUsers] = useState<Array<{ email: string; displayName: string }>>([]);
  const [previewUser, setPreviewUser] = useState("");
  const [html, setHtml] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!id) return;
    void api.signature(id).then(setSig);
    void api.users().then((list) => {
      setUsers(list);
      if (list[0]) setPreviewUser(list[0].email);
    });
  }, [id]);

  useEffect(() => {
    if (!id || !previewUser) return;
    void api.preview(id, previewUser).then((p) => setHtml(p.html));
  }, [id, previewUser, sig]);

  const selectedBlock = useMemo(() => (sig && selected ? findBlock(sig.design.blocks, selected) : null), [sig, selected]);

  if (!sig) return <p>Loading…</p>;

  function updateDesign(mut: (d: Design) => Design) {
    setSig((s) => (s ? { ...s, design: mut(s.design) } : s));
  }

  return (
    <div className="min-h-full flex flex-col bg-white">
      <header className="h-12 bg-navy text-white flex items-center px-4 text-sm font-semibold">Signer</header>
      <div className="h-14 border-b border-line flex items-center px-4 gap-3">
        <Link to="/signatures" className="text-slate-500 text-sm">
          ← Signatures
        </Link>
        <input
          className="font-medium outline-none flex-1"
          value={sig.name}
          onChange={(e) => setSig({ ...sig, name: e.target.value })}
        />
        <button
          className="rounded-full bg-navy text-white px-4 py-1.5 text-sm"
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            await api.saveSignature(sig.id, { name: sig.name, design: sig.design, htmlOverride: sig.htmlOverride });
            setSaving(false);
            const p = await api.preview(sig.id, previewUser || users[0]?.email || "");
            setHtml(p.html);
          }}
        >
          Save Changes
        </button>
        <button className="rounded-full border border-line px-4 py-1.5 text-sm" onClick={() => navigate("/signatures")}>
          Cancel Changes
        </button>
      </div>
      <div className="flex flex-1 min-h-0">
        <aside className="w-64 border-r border-line overflow-auto p-3">
          {Object.entries(groupBy(toolbox, (t) => t.section)).map(([section, items]) => (
            <div key={section} className="mb-4">
              <div className="text-xs font-semibold text-slate-500 mb-2">{section}</div>
              <div className="grid grid-cols-2 gap-2">
                {items.map((item) => (
                  <button
                    key={item.label}
                    className="rounded-lg border border-line bg-mist px-2 py-3 text-xs text-left hover:border-indigo-400"
                    onClick={() =>
                      updateDesign((d) => ({
                        ...d,
                        blocks: [...d.blocks, item.make()]
                      }))
                    }
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </aside>
        <section className="flex-1 bg-mist overflow-auto p-8 flex flex-col items-center">
          <div className="bg-white shadow-sm border border-line p-6 min-w-[480px]">
            {sig.design.blocks.map((b) => (
              <BlockView key={b.id} block={b} selected={selected} onSelect={setSelected} />
            ))}
            {sig.design.blocks.length === 0 && <p className="text-slate-400 text-sm">Add blocks from the toolbox.</p>}
          </div>
        </section>
        <aside className="w-80 border-l border-line overflow-auto p-4">
          <div className="font-medium mb-3">Item</div>
          {!selectedBlock && <p className="text-sm text-slate-500">Select a block on the canvas.</p>}
          {selectedBlock && (
            <BlockProps
              block={selectedBlock}
              onChange={(next) => updateDesign((d) => ({ ...d, blocks: replaceBlock(d.blocks, next) }))}
              onDelete={() => {
                updateDesign((d) => ({ ...d, blocks: d.blocks.filter((b) => b.id !== selectedBlock.id) }));
                setSelected(null);
              }}
            />
          )}
        </aside>
      </div>
      <div className="border-t border-line bg-white p-4">
        <select className="border border-line rounded px-2 py-1 text-sm mb-3" value={previewUser} onChange={(e) => setPreviewUser(e.target.value)}>
          {users.map((u) => (
            <option key={u.email} value={u.email}>
              {u.displayName} &lt;{u.email}&gt;
            </option>
          ))}
        </select>
        <div className="max-w-xl text-sm" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
}

function BlockView({ block, selected, onSelect }: { block: Block; selected: string | null; onSelect: (id: string) => void }) {
  const active = selected === block.id;
  return (
    <div
      className={`cursor-pointer ${active ? "outline outline-2 outline-indigo-500" : "hover:outline hover:outline-1 hover:outline-indigo-200"}`}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(block.id);
      }}
    >
      {block.type === "text" && <p>{block.content}</p>}
      {block.type === "field" && (
        <p style={{ fontWeight: block.style?.bold ? 700 : 400, fontSize: block.style?.fontSize, color: block.style?.color }}>
          [{block.field}]
        </p>
      )}
      {block.type === "image" && <div className="text-xs text-slate-400 border border-dashed p-4">{block.src ? <img src={block.src} width={block.width} alt="" /> : "Logo / image"}</div>}
      {block.type === "banner" && <div className="text-xs text-slate-400 border border-dashed p-4">Banner</div>}
      {block.type === "divider" && <hr />}
      {block.type === "spacer" && <div style={{ height: block.height }} />}
      {block.type === "social" && <p className="text-xs">Social icons</p>}
      {block.type === "row" && (
        <div className="flex gap-3">
          {block.columns.map((c, i) => (
            <div key={i} className="flex-1">
              {c.blocks.map((b) => (
                <BlockView key={b.id} block={b} selected={selected} onSelect={onSelect} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BlockProps({ block, onChange, onDelete }: { block: Block; onChange: (b: Block) => void; onDelete: () => void }) {
  return (
    <div className="space-y-3 text-sm">
      <div className="capitalize text-slate-500">{block.type}</div>
      {(block.type === "text" || block.type === "field") && (
        <>
          {block.type === "text" && (
            <label className="block">
              Content
              <textarea className="mt-1 w-full border rounded p-2" value={block.content} onChange={(e) => onChange({ ...block, content: e.target.value })} />
            </label>
          )}
          {block.type === "field" && (
            <label className="block">
              Field
              <input className="mt-1 w-full border rounded p-2" value={block.field} onChange={(e) => onChange({ ...block, field: e.target.value })} />
            </label>
          )}
          <label className="block">
            Font size
            <input
              type="number"
              className="mt-1 w-full border rounded p-2"
              value={block.style?.fontSize ?? 12}
              onChange={(e) => onChange({ ...block, style: { ...block.style, fontSize: Number(e.target.value) } })}
            />
          </label>
          <label className="block">
            Color
            <input
              className="mt-1 w-full border rounded p-2"
              value={block.style?.color ?? "#000000"}
              onChange={(e) => onChange({ ...block, style: { ...block.style, color: e.target.value } })}
            />
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={Boolean(block.style?.bold)} onChange={(e) => onChange({ ...block, style: { ...block.style, bold: e.target.checked } })} />
            Bold
          </label>
        </>
      )}
      {(block.type === "image" || block.type === "banner") && (
        <>
          <label className="block">
            Image URL
            <input className="mt-1 w-full border rounded p-2" value={block.src} onChange={(e) => onChange({ ...block, src: e.target.value })} />
          </label>
          <label className="block">
            Width
            <input type="number" className="mt-1 w-full border rounded p-2" value={block.width ?? 140} onChange={(e) => onChange({ ...block, width: Number(e.target.value) })} />
          </label>
        </>
      )}
      <button className="text-rose-600" onClick={onDelete}>
        Delete
      </button>
    </div>
  );
}

function findBlock(blocks: Block[], id: string): Block | null {
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

function replaceBlock(blocks: Block[], next: Block): Block[] {
  return blocks.map((b) => {
    if (b.id === next.id) return next;
    if (b.type === "row") {
      return { ...b, columns: b.columns.map((c) => ({ ...c, blocks: replaceBlock(c.blocks, next) })) };
    }
    return b;
  });
}

function groupBy<T>(items: T[], fn: (i: T) => string): Record<string, T[]> {
  return items.reduce((acc, item) => {
    const key = fn(item);
    acc[key] = acc[key] || [];
    acc[key].push(item);
    return acc;
  }, {} as Record<string, T[]>);
}
