import { useEffect, useState } from "react";
import { api, type RuleSet } from "../api/client";

type Disc = { id: string; name: string; enabled: number; html: string; rules: RuleSet };

export function DisclaimersPage() {
  const [items, setItems] = useState<Disc[]>([]);
  const [editing, setEditing] = useState<Disc | null>(null);

  const load = () => api.disclaimers().then(setItems);
  useEffect(() => {
    void load();
  }, []);

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold">Disclaimers</h1>
          <p className="text-slate-600 mt-2 max-w-3xl">
            Legal notices are evaluated independently of marketing signatures. Use recipient rules for external-only
            confidentiality notices, and keep disclaimer HTML in the signature designer only if it must always travel with
            that template.
          </p>
        </div>
        <button
          className="rounded-full bg-navy text-white px-4 py-2 text-sm"
          onClick={() =>
            setEditing({
              id: "",
              name: "New disclaimer",
              enabled: 1,
              html: "<p style='font-size:10px;color:#4b5563'>Confidential.</p>",
              rules: { senders: { everyone: true }, senderExceptions: {}, recipients: { external: true }, dateTime: null, advanced: { bodySearch: "anywhere", ifNotApplied: "continue" } }
            })
          }
        >
          Create Disclaimer
        </button>
      </div>
      <div className="mt-6 space-y-3">
        {items.map((d) => (
          <div key={d.id} className="bg-white border border-line rounded-xl p-5 flex justify-between gap-6">
            <div>
              <div className="font-medium">{d.name}</div>
              <div className="text-sm text-slate-500 mt-1">{d.rules.recipients.external ? "External recipients" : "Custom rules"} · {d.enabled ? "Enabled" : "Disabled"}</div>
              <div className="mt-3 text-xs text-slate-600" dangerouslySetInnerHTML={{ __html: d.html }} />
            </div>
            <div className="flex gap-2">
              <button className="rounded-full border px-3 py-1 text-sm" onClick={() => setEditing(d)}>
                Edit
              </button>
              <button className="rounded-full border px-3 py-1 text-sm text-rose-600" onClick={async () => { await api.deleteDisclaimer(d.id); await load(); }}>
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
      {editing && (
        <div className="fixed inset-0 bg-black/30 grid place-items-center p-6">
          <div className="bg-white rounded-2xl p-6 w-full max-w-2xl space-y-3">
            <h2 className="text-lg font-medium">Disclaimer</h2>
            <input className="border rounded p-2 w-full" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            <textarea className="border rounded p-2 w-full h-40 font-mono text-sm" value={editing.html} onChange={(e) => setEditing({ ...editing, html: e.target.value })} />
            <label className="flex gap-2 text-sm">
              <input type="checkbox" checked={Boolean(editing.rules.recipients.external)} onChange={(e) => setEditing({ ...editing, rules: { ...editing.rules, recipients: { external: e.target.checked, any: !e.target.checked } } })} />
              External recipients only
            </label>
            <label className="flex gap-2 text-sm">
              <input type="checkbox" checked={Boolean(editing.enabled)} onChange={(e) => setEditing({ ...editing, enabled: e.target.checked ? 1 : 0 })} />
              Enabled
            </label>
            <div className="flex justify-end gap-2">
              <button onClick={() => setEditing(null)}>Cancel</button>
              <button
                className="rounded-full bg-navy text-white px-4 py-2 text-sm"
                onClick={async () => {
                  await api.saveDisclaimer({ ...editing, id: editing.id || undefined, enabled: Boolean(editing.enabled) });
                  setEditing(null);
                  await load();
                }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
