import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, type Disclaimer, type RuleSet } from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { describeRules, RULE_TABS, RuleEditor, type RuleTab } from "../components/RuleEditor";

type Group = { id: string; name: string };

export function DisclaimersPage() {
  const [items, setItems] = useState<Disclaimer[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);

  const load = () => api.disclaimers().then(setItems);
  useEffect(() => {
    void load();
    void api.groups().then(setGroups);
  }, []);

  return (
    <div>
      <PageHeader
        kicker="Legal"
        title="Disclaimers"
        description="Legal notices added below the signature. Each has its own rules, like a signature: by sender domain, group or address, by recipient, on a schedule. Every disclaimer whose rules match is added."
        actions={
          <Link to="/disclaimers/new" className="btn btn-primary">
            New disclaimer
          </Link>
        }
      />
      <div className="mt-8 grid gap-4 xl:grid-cols-2">
        {items.map((d) => (
          <div key={d.id} className="panel p-5 flex justify-between gap-6">
            <div className="min-w-0">
              <div className="font-medium">
                {d.name}
                {!d.enabled && <span className="ml-2 rounded bg-mist px-2 py-0.5 text-xs text-slate-600">Disabled</span>}
              </div>
              <div className="text-sm text-slate-500 mt-1">{describeRules(d.rules, groups)}</div>
              <div className="mt-3 text-xs text-slate-600" dangerouslySetInnerHTML={{ __html: d.html }} />
            </div>
            <div className="flex gap-2 shrink-0 items-start">
              <Link className="btn btn-ghost" to={`/disclaimers/${d.id}`}>
                Edit
              </Link>
              <button
                className="btn btn-ghost text-rose-700"
                onClick={async () => {
                  if (!confirm(`Delete the disclaimer "${d.name}"?`)) return;
                  await api.deleteDisclaimer(d.id);
                  await load();
                }}
              >
                Delete
              </button>
            </div>
          </div>
        ))}
        {items.length === 0 && <p className="text-slate-500">No disclaimers yet.</p>}
      </div>
    </div>
  );
}

const NEW_RULES: RuleSet = {
  senders: { everyone: true },
  senderExceptions: {},
  recipients: { external: true },
  dateTime: null,
  advanced: { bodySearch: "anywhere", ifNotApplied: "continue" }
};

export function DisclaimerEditPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [item, setItem] = useState<Omit<Disclaimer, "priority"> | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [domains, setDomains] = useState<string[]>([]);
  const [tab, setTab] = useState<"content" | RuleTab>("content");
  const [message, setMessage] = useState("");

  useEffect(() => {
    void api.groups().then(setGroups);
    void api.domainNames().then(setDomains);
    if (!id || id === "new") {
      setItem({
        id: "",
        name: "New disclaimer",
        enabled: 1,
        html: "<p style='font-size:10px;color:#4b5563'>Confidential.</p>",
        rules: NEW_RULES
      });
      return;
    }
    void api.disclaimers().then((all) => setItem(all.find((d) => d.id === id) ?? null));
  }, [id]);

  if (!item) return <p className="text-slate-500">Loading…</p>;

  const save = async () => {
    setMessage("");
    try {
      const saved = await api.saveDisclaimer({
        id: item.id || undefined,
        name: item.name,
        html: item.html,
        enabled: Boolean(item.enabled),
        rules: item.rules
      });
      setMessage("Saved. It applies to the next message that matches.");
      if (!item.id) navigate(`/disclaimers/${saved.id}`, { replace: true });
      setItem(saved);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div>
      <Link to="/disclaimers" className="text-sm text-slate-500 hover:text-ink">
        ← Disclaimers
      </Link>
      <h1 className="text-[28px] leading-9 font-bold tracking-tight text-ink mt-2">{item.name || "Disclaimer"}</h1>
      <p className="text-slate-600 mt-2">{describeRules(item.rules, groups)}</p>
      <div className="tabs">
        {([["content", "Content"], ...RULE_TABS] as const).map(([t, label]) => (
          <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
      </div>
      <div className="mt-6 panel p-6 max-w-5xl space-y-4">
        {tab === "content" ? (
          <div className="grid gap-6 lg:grid-cols-2">
            <div className="space-y-3">
              <label className="block text-sm">
                Name
                <input className="input mt-1" value={item.name} onChange={(e) => setItem({ ...item, name: e.target.value })} />
              </label>
              <label className="flex gap-2 items-center text-sm">
                <input type="checkbox" checked={Boolean(item.enabled)} onChange={(e) => setItem({ ...item, enabled: e.target.checked ? 1 : 0 })} />
                Enabled
              </label>
              <label className="block text-sm">
                HTML
                <textarea
                  className="input mt-1 h-56 font-mono text-xs"
                  value={item.html}
                  onChange={(e) => setItem({ ...item, html: e.target.value })}
                />
              </label>
            </div>
            <div>
              <div className="text-sm text-slate-500 mb-1">Preview</div>
              <div className="rounded-lg border border-line bg-white p-4" dangerouslySetInnerHTML={{ __html: item.html }} />
              <p className="mt-3 text-xs text-slate-500 leading-5">
                Use the Senders tab to limit this to one domain (for example, a different legal entity per domain), a group
                or particular people, and Recipients for external-only notices.
              </p>
            </div>
          </div>
        ) : (
          <RuleEditor
            tab={tab}
            rules={item.rules}
            onChange={(rules) => setItem({ ...item, rules })}
            groups={groups}
            domains={domains}
            kind="disclaimer"
          />
        )}
        <div className="flex items-center gap-3">
          <button className="btn btn-primary" onClick={() => void save()}>
            Save disclaimer
          </button>
          {message && <span className="text-sm text-slate-600">{message}</span>}
        </div>
      </div>
    </div>
  );
}
