import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, type Disclaimer, type RuleSet } from "../api/client";
import { HtmlFrame } from "../components/HtmlFrame";
import { PageHeader } from "../components/PageHeader";
import { RichTextEditor } from "../components/RichTextEditor";
import { describeRules, RULE_TABS, RuleEditor, type RuleTab } from "../components/RuleEditor";
import { baseCss, DISCLAIMER_DEFAULTS, NEW_DISCLAIMER_STYLE, renderDisclaimer, type DisclaimerStyle } from "../lib/disclaimer";
import { APTOS_STACK, FONTS } from "../lib/fonts";

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
              <HtmlFrame html={renderDisclaimer(d.html, d.style)} className="mt-3 w-full h-24 border-0 bg-transparent" />
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

const LINE_HEIGHTS: Array<[string, string]> = [
  ["", "Email default"],
  ["1", "Tight (1.0)"],
  ["1.15", "Close (1.15)"],
  ["1.3", "Normal (1.3)"],
  ["1.5", "Open (1.5)"]
];

/** The disclaimer's base text and its spacing, as the email lays it out. */
function TextAndSpacing({ style, onChange }: { style: DisclaimerStyle; onChange: (style: DisclaimerStyle) => void }) {
  const set = (patch: Partial<DisclaimerStyle>) => {
    const next = { ...style, ...patch };
    for (const k of Object.keys(next) as Array<keyof DisclaimerStyle>) if (next[k] === undefined || next[k] === "") delete next[k];
    onChange(next);
  };
  const num = (v: string) => (v.trim() === "" ? undefined : Number(v));
  return (
    <div className="rounded-xl border border-line p-4">
      <div className="text-sm font-medium text-ink">Text &amp; spacing</div>
      <p className="text-xs text-slate-500 mt-0.5 mb-3">
        The base for the whole notice, blank lines included. Formatting applied in the editor (bold, a size on some words) still wins.
      </p>
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6 text-sm">
        <label className="block">
          Font
          <select className="input mt-1" value={style.fontFamily ?? APTOS_STACK} onChange={(e) => set({ fontFamily: e.target.value === APTOS_STACK ? undefined : e.target.value })}>
            {FONTS.map(([value, label]) => (
              <option key={label} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          Size (pt)
          <input
            type="number"
            step={0.5}
            min={5}
            max={36}
            placeholder="12 (email)"
            className="input mt-1"
            value={style.fontSize ?? ""}
            onChange={(e) => set({ fontSize: num(e.target.value) })}
          />
        </label>
        <label className="block">
          Colour
          <div className="flex gap-2 mt-1">
            <input
              type="color"
              className="h-9 w-full rounded-md border border-line"
              value={style.color ?? "#4b5563"}
              onChange={(e) => set({ color: e.target.value })}
            />
          </div>
        </label>
        <label className="block">
          Line height
          <select className="input mt-1" value={style.lineHeight === undefined ? "" : String(style.lineHeight)} onChange={(e) => set({ lineHeight: num(e.target.value) })}>
            {LINE_HEIGHTS.map(([value, label]) => (
              <option key={label} value={value}>
                {label}
              </option>
            ))}
            {style.lineHeight !== undefined && !LINE_HEIGHTS.some(([v]) => v === String(style.lineHeight)) && (
              <option value={String(style.lineHeight)}>{style.lineHeight}</option>
            )}
          </select>
        </label>
        <label className="block">
          Paragraph gap (pt)
          <input
            type="number"
            min={0}
            max={48}
            className="input mt-1"
            value={style.paragraphSpacing ?? DISCLAIMER_DEFAULTS.paragraphSpacing}
            onChange={(e) => set({ paragraphSpacing: num(e.target.value) ?? 0 })}
          />
        </label>
        <label className="block">
          Space above (pt)
          <input
            type="number"
            min={0}
            max={72}
            className="input mt-1"
            value={style.spaceAbove ?? DISCLAIMER_DEFAULTS.spaceAbove}
            onChange={(e) => set({ spaceAbove: num(e.target.value) ?? 0 })}
          />
        </label>
      </div>
      <p className="text-xs text-slate-500 mt-2">Space above is the gap below the signature, or below the disclaimer before this one.</p>
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
        html: "<p>Confidential.</p>",
        style: NEW_DISCLAIMER_STYLE,
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
        style: item.style ?? {},
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
          <div className="space-y-4">
            <div className="flex flex-wrap items-end gap-4">
              <label className="block text-sm flex-1 min-w-[16rem] max-w-xl">
                Name
                <input className="input mt-1" value={item.name} onChange={(e) => setItem({ ...item, name: e.target.value })} />
              </label>
              <label className="flex gap-2 items-center text-sm h-9">
                <input type="checkbox" checked={Boolean(item.enabled)} onChange={(e) => setItem({ ...item, enabled: e.target.checked ? 1 : 0 })} />
                Enabled
              </label>
            </div>
            <div className="text-sm">
              <div className="mb-1">Text</div>
              <RichTextEditor
                value={item.html}
                onChange={(html) => setItem({ ...item, html })}
                baseStyle={baseCss(item.style ?? {})}
                paragraphSpacing={item.style?.paragraphSpacing ?? DISCLAIMER_DEFAULTS.paragraphSpacing}
              />
              <p className="mt-2 text-xs text-slate-500 leading-5">
                What you see is what recipients get, below the signature. Enter starts a new paragraph, spaced as set below; Shift+Enter
                breaks the line with no extra space. Use the Senders tab to limit this to one domain (for example, a different legal
                entity per domain), a group or particular people, and Recipients for external-only notices.
              </p>
            </div>
            <TextAndSpacing style={item.style ?? {}} onChange={(style) => setItem({ ...item, style })} />
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
