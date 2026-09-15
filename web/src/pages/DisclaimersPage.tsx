import { useEffect, useState } from "react";
import { api, type RuleSet } from "../api/client";
import { PageHeader } from "../components/PageHeader";

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
      <PageHeader
        kicker="Legal"
        title="Disclaimers"
        description="Legal notices are evaluated independently of marketing signatures. Use recipient rules for external-only confidentiality notices."
        actions={
          <button
            className="btn btn-primary"
            onClick={() =>
              setEditing({
                id: "",
                name: "New disclaimer",
                enabled: 1,
                html: "<p style='font-size:10px;color:#4b5563'>Confidential.</p>",
                rules: {
                  senders: { everyone: true },
                  senderExceptions: {},
                  recipients: { external: true },
                  dateTime: null,
                  advanced: { bodySearch: "anywhere", ifNotApplied: "continue" }
                }
              })
            }
          >
            New disclaimer
          </button>
        }
      />
      <div className="mt-8 space-y-3">
        {items.map((d) => (
          <div key={d.id} className="panel p-5 flex justify-between gap-6">
            <div>
              <div className="font-medium">{d.name}</div>
              <div className="text-sm text-stone-500 mt-1">
                {d.rules.recipients.external ? "External recipients" : "Custom rules"} · {d.enabled ? "Enabled" : "Disabled"}
              </div>
              <div className="mt-3 text-xs text-stone-600" dangerouslySetInnerHTML={{ __html: d.html }} />
            </div>
            <div className="flex gap-2 shrink-0">
              <button className="btn btn-ghost" onClick={() => setEditing(d)}>
                Edit
              </button>
              <button
                className="btn btn-ghost text-rose-700"
                onClick={async () => {
                  await api.deleteDisclaimer(d.id);
                  await load();
                }}
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
      {editing && (
        <div className="fixed inset-0 bg-ink/40 grid place-items-center p-6 z-20">
          <div className="panel p-6 w-full max-w-2xl space-y-3">
            <h2 className="display text-2xl">Disclaimer</h2>
            <input className="input" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            <textarea className="input h-40 font-mono text-sm" value={editing.html} onChange={(e) => setEditing({ ...editing, html: e.target.value })} />
            <label className="flex gap-2 text-sm">
              <input
                type="checkbox"
                checked={Boolean(editing.rules.recipients.external)}
                onChange={(e) =>
                  setEditing({ ...editing, rules: { ...editing.rules, recipients: { external: e.target.checked, any: !e.target.checked } } })
                }
              />
              External recipients only
            </label>
            <label className="flex gap-2 text-sm">
              <input type="checkbox" checked={Boolean(editing.enabled)} onChange={(e) => setEditing({ ...editing, enabled: e.target.checked ? 1 : 0 })} />
              Enabled
            </label>
            <div className="flex justify-end gap-2">
              <button className="btn btn-ghost" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
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
