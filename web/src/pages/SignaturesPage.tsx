import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type Signature } from "../api/client";

export function SignaturesPage() {
  const [items, setItems] = useState<Signature[]>([]);
  const [tab, setTab] = useState<"all" | "reorder">("all");
  const navigate = useNavigate();

  const load = () => api.signatures().then(setItems);
  useEffect(() => {
    void load();
  }, []);

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-semibold text-ink">Signatures</h1>
        <div className="flex gap-2">
          <button
            className="rounded-full bg-navy text-white px-4 py-2 text-sm"
            onClick={async () => {
              const name = prompt("Signature name", "New signature");
              if (!name) return;
              const created = await api.createSignature(name);
              navigate(`/signatures/${created.id}/design`);
            }}
          >
            Create Signature
          </button>
          <button
            className="rounded-full border border-line bg-white px-4 py-2 text-sm"
            onClick={async () => {
              const name = prompt("Folder name");
              if (!name) return;
              await api.createFolder(name);
              await load();
            }}
          >
            Create Folder
          </button>
        </div>
      </div>
      <div className="flex gap-6 mt-6 border-b border-line text-sm">
        <button className={`pb-3 ${tab === "all" ? "border-b-2 border-navy font-medium" : "text-slate-500"}`} onClick={() => setTab("all")}>
          All Signatures
        </button>
        <button className={`pb-3 ${tab === "reorder" ? "border-b-2 border-navy font-medium" : "text-slate-500"}`} onClick={() => setTab("reorder")}>
          Re-order
        </button>
      </div>
      <p className="text-sm text-slate-500 mt-4">Signatures are displayed below in the order in which they are evaluated.</p>
      {tab === "reorder" && (
        <div className="mt-4 bg-white border border-line rounded-xl p-4">
          <p className="text-sm text-slate-600 mb-3">Move a signature earlier so it is considered first (Exclaimer-style first match wins).</p>
          {items.map((s, i) => (
            <div key={s.id} className="flex items-center gap-3 py-2 border-b border-line last:border-0">
              <span className="w-6 text-slate-400">{i + 1}</span>
              <span className="flex-1">{s.name}</span>
              <button
                className="text-sm"
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
                className="text-sm"
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
        <div className="mt-4 space-y-4">
          {items.map((s) => (
            <div key={s.id} className="bg-white border border-line rounded-xl p-5 flex gap-8">
              <div>
                <div className="font-medium text-lg">{s.name}</div>
                <div className="mt-3 w-56 h-32 bg-mist rounded-lg overflow-hidden border border-line">
                  <SignatureThumb id={s.id} />
                </div>
              </div>
              <div className="text-sm">
                <div className="text-slate-500">Senders</div>
                <div className="mt-1">{s.rules.senders.everyone ? "Everyone" : (s.rules.senders.emails || s.rules.senders.groups || []).join(", ") || "Filtered"}</div>
              </div>
              <div className="text-sm flex-1">
                <div className="text-slate-500">Configuration</div>
                <ul className="mt-1 space-y-1">
                  <li>Server-Side (Microsoft 365 / Google Workspace)</li>
                  <li>{s.rules.dateTime ? "Scheduled" : "Always Active"}</li>
                  <li>
                    {s.rules.recipients.external ? "External recipients" : s.rules.recipients.internal ? "Internal recipients" : "Any Recipient"}
                  </li>
                  <li className={s.enabled ? "text-emerald-700" : "text-amber-700"}>{s.enabled ? "Enabled" : "Disabled"}</li>
                </ul>
              </div>
              <div className="flex flex-col gap-2 justify-end">
                <Link className="rounded-full bg-navy text-white px-4 py-2 text-sm text-center" to={`/signatures/${s.id}/design`}>
                  Edit Design
                </Link>
                <Link className="rounded-full border border-line px-4 py-2 text-sm text-center" to={`/signatures/${s.id}/rules`}>
                  Manage Rules
                </Link>
              </div>
            </div>
          ))}
          <p className="text-sm text-slate-500">All signatures have been loaded.</p>
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
  return <div className="origin-top-left scale-[0.55] p-3" dangerouslySetInnerHTML={{ __html: html }} />;
}
