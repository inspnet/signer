import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type RuleSet, type Signature } from "../api/client";

const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function RulesPage() {
  const { id } = useParams();
  const [sig, setSig] = useState<Signature | null>(null);
  const [groups, setGroups] = useState<Array<{ id: string; name: string }>>([]);
  const [tab, setTab] = useState("overview");

  useEffect(() => {
    if (!id) return;
    void api.signature(id).then(setSig);
    void api.groups().then(setGroups);
  }, [id]);

  if (!sig) return <p>Loading…</p>;
  const rules = sig.rules;

  function patch(p: Partial<RuleSet>) {
    setSig({ ...sig!, rules: { ...rules, ...p } });
  }

  return (
    <div>
      <Link to="/signatures" className="text-sm text-slate-500">
        ← Signatures
      </Link>
      <h1 className="text-3xl font-semibold mt-2">{sig.name} — rules</h1>
      <div className="flex gap-4 mt-6 border-b border-line text-sm">
        {["overview", "senders", "exceptions", "recipients", "datetime", "advanced"].map((t) => (
          <button key={t} className={`pb-3 capitalize ${tab === t ? "border-b-2 border-navy font-medium" : "text-slate-500"}`} onClick={() => setTab(t)}>
            {t === "datetime" ? "Date/Time" : t}
          </button>
        ))}
      </div>
      <div className="mt-6 bg-white border border-line rounded-xl p-6 max-w-3xl space-y-4">
        {tab === "overview" && (
          <>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={Boolean(sig.enabled)} onChange={(e) => setSig({ ...sig, enabled: e.target.checked ? 1 : 0 })} />
              Enabled for server-side deployment
            </label>
            <p className="text-sm text-slate-600">
              Server-side signatures are applied after send via Exchange connectors or Google content compliance. Users cannot
              remove them from iOS Mail or other clients.
            </p>
          </>
        )}
        {tab === "senders" && (
          <SenderEditor value={rules.senders} groups={groups} onChange={(senders) => patch({ senders })} everyoneLabel="Everyone in the organisation" />
        )}
        {tab === "exceptions" && (
          <SenderEditor value={rules.senderExceptions} groups={groups} onChange={(senderExceptions) => patch({ senderExceptions })} everyoneLabel="No exceptions" invertEveryone />
        )}
        {tab === "recipients" && (
          <>
            <label className="flex gap-2 items-center">
              <input type="checkbox" checked={Boolean(rules.recipients.any)} onChange={(e) => patch({ recipients: { ...rules.recipients, any: e.target.checked, internal: false, external: false } })} />
              Any recipient
            </label>
            <label className="flex gap-2 items-center">
              <input type="checkbox" checked={Boolean(rules.recipients.internal)} onChange={(e) => patch({ recipients: { ...rules.recipients, internal: e.target.checked, any: false } })} />
              Internal only
            </label>
            <label className="flex gap-2 items-center">
              <input type="checkbox" checked={Boolean(rules.recipients.external)} onChange={(e) => patch({ recipients: { ...rules.recipients, external: e.target.checked, any: false } })} />
              External only
            </label>
            <ListField label="Include addresses / wildcards" value={rules.recipients.emails || []} onChange={(emails) => patch({ recipients: { ...rules.recipients, emails } })} />
            <ListField label="Include domains (@example.com)" value={rules.recipients.domains || []} onChange={(domains) => patch({ recipients: { ...rules.recipients, domains } })} />
            <ListField label="Exclude addresses" value={rules.recipients.exceptEmails || []} onChange={(exceptEmails) => patch({ recipients: { ...rules.recipients, exceptEmails } })} />
            <ListField label="Exclude domains" value={rules.recipients.exceptDomains || []} onChange={(exceptDomains) => patch({ recipients: { ...rules.recipients, exceptDomains } })} />
          </>
        )}
        {tab === "datetime" && (
          <>
            <label className="flex gap-2 items-center">
              <input
                type="checkbox"
                checked={Boolean(rules.dateTime)}
                onChange={(e) => patch({ dateTime: e.target.checked ? { days: [1, 2, 3, 4, 5] } : null })}
              />
              Limit to a schedule
            </label>
            {rules.dateTime && (
              <>
                <label className="block text-sm">
                  Start
                  <input type="datetime-local" className="block border rounded p-2 mt-1" value={rules.dateTime.start || ""} onChange={(e) => patch({ dateTime: { ...rules.dateTime!, start: e.target.value } })} />
                </label>
                <label className="block text-sm">
                  End
                  <input type="datetime-local" className="block border rounded p-2 mt-1" value={rules.dateTime.end || ""} onChange={(e) => patch({ dateTime: { ...rules.dateTime!, end: e.target.value } })} />
                </label>
                <div className="flex gap-2">
                  {days.map((d, i) => (
                    <label key={d} className="text-xs">
                      <input
                        type="checkbox"
                        checked={(rules.dateTime?.days || []).includes(i)}
                        onChange={(e) => {
                          const set = new Set(rules.dateTime?.days || []);
                          if (e.target.checked) set.add(i);
                          else set.delete(i);
                          patch({ dateTime: { ...rules.dateTime!, days: [...set] } });
                        }}
                      />{" "}
                      {d}
                    </label>
                  ))}
                </div>
              </>
            )}
          </>
        )}
        {tab === "advanced" && (
          <>
            <label className="flex gap-2 items-center">
              <input type="checkbox" checked={Boolean(rules.advanced.skipIfReply)} onChange={(e) => patch({ advanced: { ...rules.advanced, skipIfReply: e.target.checked } })} />
              Do not apply to replies / forwards (first message in a chain only)
            </label>
            <label className="block text-sm">
              Only if subject contains
              <input className="block border rounded p-2 mt-1 w-full" value={rules.advanced.subjectContains || ""} onChange={(e) => patch({ advanced: { ...rules.advanced, subjectContains: e.target.value } })} />
            </label>
            <label className="block text-sm">
              Do not add if the message contains (use unique text from this signature to apply once per thread)
              <input className="block border rounded p-2 mt-1 w-full" value={rules.advanced.bodyDoesNotContain || ""} onChange={(e) => patch({ advanced: { ...rules.advanced, bodyDoesNotContain: e.target.value } })} />
            </label>
            <label className="block text-sm">
              Search
              <select className="block border rounded p-2 mt-1" value={rules.advanced.bodySearch} onChange={(e) => patch({ advanced: { ...rules.advanced, bodySearch: e.target.value as "latest" | "anywhere" } })}>
                <option value="anywhere">Anywhere in email trail</option>
                <option value="latest">Only in the most recent email</option>
              </select>
            </label>
            <label className="block text-sm">
              If this signature is not applied
              <select className="block border rounded p-2 mt-1" value={rules.advanced.ifNotApplied} onChange={(e) => patch({ advanced: { ...rules.advanced, ifNotApplied: e.target.value as "stop" | "continue" } })}>
                <option value="continue">Process the next signature</option>
                <option value="stop">Do not process the next signature</option>
              </select>
            </label>
          </>
        )}
        <button
          className="rounded-full bg-navy text-white px-4 py-2 text-sm"
          onClick={async () => {
            await api.saveSignature(sig.id, { enabled: Boolean(sig.enabled), rules: sig.rules, name: sig.name });
            alert("Rules saved");
          }}
        >
          Save rules
        </button>
      </div>
    </div>
  );
}

function SenderEditor({
  value,
  groups,
  onChange,
  everyoneLabel,
  invertEveryone
}: {
  value: RuleSet["senders"];
  groups: Array<{ id: string; name: string }>;
  onChange: (v: RuleSet["senders"]) => void;
  everyoneLabel: string;
  invertEveryone?: boolean;
}) {
  return (
    <div className="space-y-3">
      <label className="flex gap-2 items-center">
        <input
          type="checkbox"
          checked={invertEveryone ? !value.everyone && !value.emails?.length && !value.groups?.length && !value.domains?.length : Boolean(value.everyone)}
          onChange={(e) => onChange({ ...value, everyone: invertEveryone ? false : e.target.checked })}
        />
        {everyoneLabel}
      </label>
      <ListField label="Email addresses" value={value.emails || []} onChange={(emails) => onChange({ ...value, everyone: false, emails })} />
      <ListField label="Domains" value={value.domains || []} onChange={(domains) => onChange({ ...value, everyone: false, domains })} />
      <div>
        <div className="text-sm mb-1">Groups</div>
        {groups.map((g) => (
          <label key={g.id} className="flex gap-2 text-sm">
            <input
              type="checkbox"
              checked={(value.groups || []).includes(g.id)}
              onChange={(e) => {
                const set = new Set(value.groups || []);
                if (e.target.checked) set.add(g.id);
                else set.delete(g.id);
                onChange({ ...value, everyone: false, groups: [...set] });
              }}
            />
            {g.name}
          </label>
        ))}
        {groups.length === 0 && <p className="text-sm text-slate-500">Sync Entra or Google groups in Settings.</p>}
      </div>
    </div>
  );
}

function ListField({ label, value, onChange }: { label: string; value: string[]; onChange: (v: string[]) => void }) {
  const [draft, setDraft] = useState("");
  return (
    <div>
      <div className="text-sm mb-1">{label}</div>
      <div className="flex gap-2">
        <input className="border rounded p-2 flex-1" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add then press +" />
        <button
          className="border rounded px-3"
          onClick={() => {
            if (!draft.trim()) return;
            onChange([...value, draft.trim()]);
            setDraft("");
          }}
        >
          +
        </button>
      </div>
      <div className="flex flex-wrap gap-2 mt-2">
        {value.map((v) => (
          <span key={v} className="bg-mist rounded-full px-3 py-1 text-xs">
            {v}{" "}
            <button onClick={() => onChange(value.filter((x) => x !== v))}>&times;</button>
          </span>
        ))}
      </div>
    </div>
  );
}
