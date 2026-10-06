import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type Signature } from "../api/client";
import { RULE_TABS, RuleEditor, type RuleTab } from "../components/RuleEditor";

export function RulesPage() {
  const { id } = useParams();
  const [sig, setSig] = useState<Signature | null>(null);
  const [groups, setGroups] = useState<Array<{ id: string; name: string }>>([]);
  const [domains, setDomains] = useState<string[]>([]);
  const [tab, setTab] = useState<"overview" | RuleTab>("overview");

  useEffect(() => {
    if (!id) return;
    void api.signature(id).then(setSig);
    void api.groups().then(setGroups);
    void api.domainNames().then(setDomains);
  }, [id]);

  if (!sig) return <p>Loading…</p>;
  const rules = sig.rules;

  return (
    <div>
      <Link to="/signatures" className="text-sm text-stone-500 hover:text-ink">
        ← Templates
      </Link>
      <h1 className="display text-4xl mt-2">{sig.name}</h1>
      <p className="text-stone-600 mt-2">Who this template stamps, and when.</p>
      <div className="tabs">
        {([["overview", "Overview"], ...RULE_TABS] as const).map(([t, label]) => (
          <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
      </div>
      <div className="mt-6 panel p-6 max-w-5xl space-y-4">
        {tab === "overview" && (
          <>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={Boolean(sig.enabled)} onChange={(e) => setSig({ ...sig, enabled: e.target.checked ? 1 : 0 })} />
              Enabled for server-side deployment
            </label>
            <p className="text-sm text-stone-600">
              Server-side signatures are applied after send via Exchange connectors or Google content compliance. Users cannot
              remove them from iOS Mail or other clients.
            </p>
          </>
        )}
        {tab !== "overview" && (
          <RuleEditor tab={tab} rules={rules} onChange={(next) => setSig({ ...sig, rules: next })} groups={groups} domains={domains} kind="signature" />
        )}
        <button
          className="btn btn-primary"
          onClick={async () => {
            await api.saveSignature(sig.id, { enabled: Boolean(sig.enabled), rules: sig.rules, name: sig.name });
            setSig({ ...sig });
          }}
        >
          Save rules
        </button>
      </div>
    </div>
  );
}
