import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type Signature } from "../api/client";

export function SignaturesPage() {
  const [items, setItems] = useState<Signature[]>([]);
  const [tab, setTab] = useState<"all" | "order">("all");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("New signature");
  const navigate = useNavigate();

  const load = () => api.signatures().then(setItems);
  useEffect(() => {
    void load();
  }, []);

  return (
    <div>
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.16em] text-accent-2 font-semibold">Library</p>
          <h1 className="display text-4xl mt-1">Signatures</h1>
          <p className="text-stone-600 mt-2">Evaluated top to bottom. The first match is stamped on the message.</p>
        </div>
        <div className="flex gap-2">
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            New template
          </button>
          <button
            className="btn btn-ghost"
            onClick={async () => {
              const folder = window.prompt("Folder name");
              if (!folder) return;
              await api.createFolder(folder);
              await load();
            }}
          >
            Folder
          </button>
        </div>
      </div>
      <div className="tabs">
        {(["all", "order"] as const).map((t) => (
          <button
            key={t}
            className={`tab ${tab === t ? "active" : ""}`}
            onClick={() => setTab(t)}
          >
            {t === "all" ? "Templates" : "Evaluation order"}
          </button>
        ))}
      </div>
      {tab === "order" && (
        <div className="mt-5 panel p-4">
          {items.map((s, i) => (
            <div key={s.id} className="flex items-center gap-3 py-2 border-b border-line last:border-0">
              <span className="w-7 h-7 rounded-md bg-mist grid place-items-center text-xs">{i + 1}</span>
              <span className="flex-1 font-medium">{s.name}</span>
              <button
                className="btn btn-ghost px-2 py-1"
                disabled={i === 0}
                onClick={async () => {
                  const next = [...items];
                  [next[i - 1], next[i]] = [next[i], next[i - 1]];
                  await api.reorder(next.map((x) => x.id));
                  await load();
                }}
              >
                Up
              </button>
              <button
                className="btn btn-ghost px-2 py-1"
                disabled={i === items.length - 1}
                onClick={async () => {
                  const next = [...items];
                  [next[i + 1], next[i]] = [next[i], next[i + 1]];
                  await api.reorder(next.map((x) => x.id));
                  await load();
                }}
              >
                Down
              </button>
            </div>
          ))}
        </div>
      )}
      {tab === "all" && (
        <div className="mt-5 grid md:grid-cols-2 gap-4">
          {items.map((s) => (
            <article key={s.id} className="panel overflow-hidden flex flex-col">
              <div className="h-40 bg-[radial-gradient(#e7e0d4_1px,transparent_1px)] bg-[size:16px_16px] p-4 overflow-hidden">
                <SignatureThumb id={s.id} />
              </div>
              <div className="p-4 flex-1">
                <div className="flex items-start justify-between gap-3">
                  <h2 className="font-semibold text-lg">{s.name}</h2>
                  <span className={`text-xs px-2 py-0.5 rounded-md ${s.enabled ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"}`}>
                    {s.enabled ? "Live" : "Off"}
                  </span>
                </div>
                <p className="text-sm text-stone-500 mt-2">
                  {s.rules.senders.everyone ? "Everyone" : "Filtered senders"} ·{" "}
                  {s.rules.recipients.external ? "External recipients" : s.rules.recipients.internal ? "Internal" : "Any recipient"}
                </p>
              </div>
              <div className="p-4 pt-0 flex gap-2">
                <Link className="btn btn-primary flex-1" to={`/signatures/${s.id}/design`}>
                  Design
                </Link>
                <Link className="btn btn-ghost flex-1" to={`/signatures/${s.id}/rules`}>
                  Rules
                </Link>
              </div>
            </article>
          ))}
        </div>
      )}
      {creating && (
        <div className="fixed inset-0 bg-ink/40 grid place-items-center p-6 z-20">
          <form
            className="panel p-6 w-full max-w-md space-y-4"
            onSubmit={async (e) => {
              e.preventDefault();
              const created = await api.createSignature(name);
              navigate(`/signatures/${created.id}/design`);
            }}
          >
            <h2 className="display text-2xl">New template</h2>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            <div className="flex justify-end gap-2">
              <button type="button" className="btn btn-ghost" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button className="btn btn-primary" type="submit">
                Create
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

function SignatureThumb({ id }: { id: string }) {
  const [html, setHtml] = useState("");
  useEffect(() => {
    void api.users().then(async (users) => {
      const email = users[0]?.email;
      if (!email) return;
      const preview = await api.preview(id, email);
      setHtml(preview.html);
    });
  }, [id]);
  return <div className="origin-top-left scale-[0.62] bg-white shadow-sm p-3 w-[520px]" dangerouslySetInnerHTML={{ __html: html }} />;
}
