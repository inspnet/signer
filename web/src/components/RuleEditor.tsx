import { useState } from "react";
import type { RuleSet } from "../api/client";

/**
 * Who an item applies to and when. Signatures and disclaimers share the same
 * rules and the same engine (src/mail/rules.ts); the host page renders the
 * tabs and any tabs of its own, and this renders the rule tabs.
 */

export const RULE_TABS = [
  ["senders", "Senders"],
  ["exceptions", "Exceptions"],
  ["recipients", "Recipients"],
  ["datetime", "Schedule"],
  ["advanced", "Advanced"]
] as const;

export type RuleTab = (typeof RULE_TABS)[number][0];

const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const hours = Array.from({ length: 24 }, (_, i) => i);

const browserTimezone = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
})();

/** Full IANA list where the browser exposes it, with a usable fallback. */
const timezones = (() => {
  const supported =
    typeof Intl.supportedValuesOf === "function"
      ? (Intl.supportedValuesOf("timeZone") as string[])
      : ["UTC", "Europe/London", "Europe/Dublin", "Europe/Paris", "Europe/Berlin", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney"];
  return [...new Set([browserTimezone, "UTC", ...supported])];
})();

const domainKey = (d: string) => d.trim().toLowerCase().replace(/^@/, "");

export function RuleEditor({
  tab,
  rules,
  onChange,
  groups,
  domains,
  kind
}: {
  tab: RuleTab;
  rules: RuleSet;
  onChange: (rules: RuleSet) => void;
  groups: Array<{ id: string; name: string }>;
  /** The organisation's domains (Settings → Domains), offered as checkboxes. */
  domains: string[];
  kind: "signature" | "disclaimer";
}) {
  function patch(p: Partial<RuleSet>) {
    onChange({ ...rules, ...p });
  }
  return (
    <>
      {tab === "senders" && (
        <SenderEditor value={rules.senders} groups={groups} domains={domains} onChange={(senders) => patch({ senders })} everyoneLabel="Everyone in the organisation" />
      )}
      {tab === "exceptions" && (
        <SenderEditor value={rules.senderExceptions} groups={groups} domains={domains} onChange={(senderExceptions) => patch({ senderExceptions })} everyoneLabel="No exceptions" invertEveryone />
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
              onChange={(e) =>
                patch({ dateTime: e.target.checked ? { days: [1, 2, 3, 4, 5], timezone: browserTimezone } : null })
              }
            />
            Limit to a schedule
          </label>
          {rules.dateTime && (
            <>
              <label className="block text-sm">
                Start
                <input type="datetime-local" className="input mt-1" value={rules.dateTime.start || ""} onChange={(e) => patch({ dateTime: { ...rules.dateTime!, start: e.target.value } })} />
              </label>
              <label className="block text-sm">
                End
                <input type="datetime-local" className="input mt-1" value={rules.dateTime.end || ""} onChange={(e) => patch({ dateTime: { ...rules.dateTime!, end: e.target.value } })} />
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
              <div className="grid grid-cols-2 gap-3">
                <label className="block text-sm">
                  From hour
                  <select
                    className="input mt-1"
                    value={rules.dateTime.startHour ?? ""}
                    onChange={(e) =>
                      patch({
                        dateTime: {
                          ...rules.dateTime!,
                          startHour: e.target.value === "" ? null : Number(e.target.value)
                        }
                      })
                    }
                  >
                    <option value="">Any</option>
                    {hours.map((h) => (
                      <option key={h} value={h}>
                        {String(h).padStart(2, "0")}:00
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm">
                  Until hour
                  <select
                    className="input mt-1"
                    value={rules.dateTime.endHour ?? ""}
                    onChange={(e) =>
                      patch({
                        dateTime: {
                          ...rules.dateTime!,
                          endHour: e.target.value === "" ? null : Number(e.target.value)
                        }
                      })
                    }
                  >
                    <option value="">Any</option>
                    {hours.map((h) => (
                      <option key={h} value={h}>
                        {String(h).padStart(2, "0")}:00
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="block text-sm">
                Timezone
                <select
                  className="input mt-1"
                  value={rules.dateTime.timezone || browserTimezone}
                  onChange={(e) => patch({ dateTime: { ...rules.dateTime!, timezone: e.target.value } })}
                >
                  {timezones.map((tz) => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ))}
                </select>
                <span className="block mt-1 text-xs text-slate-500">
                  Dates, days and hours above are read in this timezone.
                </span>
              </label>
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
            <input className="input mt-1" value={rules.advanced.subjectContains || ""} onChange={(e) => patch({ advanced: { ...rules.advanced, subjectContains: e.target.value } })} />
          </label>
          <label className="block text-sm">
            Do not add if the message contains (use unique text from this {kind} to apply once per thread)
            <input className="input mt-1" value={rules.advanced.bodyDoesNotContain || ""} onChange={(e) => patch({ advanced: { ...rules.advanced, bodyDoesNotContain: e.target.value } })} />
          </label>
          <label className="block text-sm">
            Search
            <select className="input mt-1" value={rules.advanced.bodySearch} onChange={(e) => patch({ advanced: { ...rules.advanced, bodySearch: e.target.value as "latest" | "anywhere" } })}>
              <option value="anywhere">Anywhere in email trail</option>
              <option value="latest">Only in the most recent email</option>
            </select>
          </label>
          {kind === "signature" && (
            <label className="block text-sm">
              If this signature is not applied
              <select className="input mt-1" value={rules.advanced.ifNotApplied} onChange={(e) => patch({ advanced: { ...rules.advanced, ifNotApplied: e.target.value as "stop" | "continue" } })}>
                <option value="continue">Process the next signature</option>
                <option value="stop">Do not process the next signature</option>
              </select>
            </label>
          )}
        </>
      )}
    </>
  );
}

/** One line for a list: "From belzbergco.com · to external recipients · scheduled". */
export function describeRules(rules: RuleSet, groups: Array<{ id: string; name: string }> = []): string {
  const parts: string[] = [];
  const s = rules.senders ?? {};
  if (s.everyone || (!s.emails?.length && !s.domains?.length && !s.groups?.length)) parts.push("From everyone");
  else {
    const who = [
      ...(s.domains ?? []).map(domainKey),
      ...(s.groups ?? []).map((g) => groups.find((x) => x.id === g)?.name ?? "a group"),
      ...(s.emails?.length ? [`${s.emails.length} address${s.emails.length === 1 ? "" : "es"}`] : [])
    ];
    parts.push(`From ${who.join(", ")}`);
  }
  const x = rules.senderExceptions ?? {};
  const excepted = (x.domains?.length ?? 0) + (x.groups?.length ?? 0) + (x.emails?.length ?? 0);
  if (excepted) parts.push(`${excepted} exception${excepted === 1 ? "" : "s"}`);
  const r = rules.recipients ?? {};
  if (r.external) parts.push("to external recipients");
  else if (r.internal) parts.push("to internal recipients");
  else parts.push("to anyone");
  if (r.domains?.length) parts.push(`recipient domains ${r.domains.join(", ")}`);
  if (rules.dateTime) parts.push("scheduled");
  if (rules.advanced?.skipIfReply) parts.push("new messages only");
  if (rules.advanced?.subjectContains) parts.push(`subject contains "${rules.advanced.subjectContains}"`);
  return parts.join(" · ");
}

function SenderEditor({
  value,
  groups,
  domains,
  onChange,
  everyoneLabel,
  invertEveryone
}: {
  value: RuleSet["senders"];
  groups: Array<{ id: string; name: string }>;
  domains: string[];
  onChange: (v: RuleSet["senders"]) => void;
  everyoneLabel: string;
  invertEveryone?: boolean;
}) {
  const chosen = (value.domains || []).map(domainKey);
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
      {domains.length > 0 && (
        <div>
          <div className="text-sm mb-1">Your domains</div>
          <div className="flex flex-wrap gap-x-5 gap-y-1">
            {domains.map((d) => (
              <label key={d} className="flex gap-2 items-center text-sm">
                <input
                  type="checkbox"
                  checked={chosen.includes(d)}
                  onChange={(e) => {
                    const rest = (value.domains || []).filter((x) => domainKey(x) !== d);
                    onChange({ ...value, everyone: false, domains: e.target.checked ? [...rest, d] : rest });
                  }}
                />
                {d}
              </label>
            ))}
          </div>
        </div>
      )}
      <ListField
        label={domains.length ? "Other domains or wildcards" : "Domains"}
        value={(value.domains || []).filter((d) => !domains.includes(domainKey(d)))}
        onChange={(other) =>
          onChange({ ...value, everyone: false, domains: [...(value.domains || []).filter((d) => domains.includes(domainKey(d))), ...other] })
        }
      />
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
        {groups.length === 0 && <p className="text-sm text-stone-500">Sync Entra or Google groups in Settings.</p>}
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
        <input className="input flex-1" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add then press +" />
        <button
          className="btn btn-ghost"
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
          <span key={v} className="bg-mist rounded-md px-3 py-1 text-xs">
            {v}{" "}
            <button onClick={() => onChange(value.filter((x) => x !== v))}>&times;</button>
          </span>
        ))}
      </div>
    </div>
  );
}
