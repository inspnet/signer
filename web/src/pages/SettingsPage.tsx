import { useEffect, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { api, type AlertConfig, type SentItemsConfig, type DirectoryPerson, type RelayDiagnosis, type UpdateCheck, type UpdateStatus } from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { useAuth } from "../layouts/Auth";

export function SettingsPage() {
  const [tab, setTab] = useState<"flow" | "domains" | "directory" | "fields" | "admins" | "sent" | "alerts" | "updates">("flow");
  return (
    <div>
      <PageHeader
        kicker="Admin"
        title="Settings"
        description="Connectors, domains, directory cache, who may edit their own card, alerts and updates."
      />
      <div className="tabs">
        {(["flow", "domains", "directory", "fields", "admins", "sent", "alerts", "updates"] as const).map((t) => (
          <button key={t} className={`tab capitalize ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
            {t === "flow" ? "Connectors" : t === "fields" ? "Field locks" : t === "sent" ? "Sent Items" : t}
          </button>
        ))}
      </div>
      {tab === "flow" && <MailFlow />}
      {tab === "domains" && <Domains />}
      {tab === "updates" && <Updates />}
      {tab === "alerts" && <Alerts />}
      {tab === "sent" && <SentItems />}
      {tab === "directory" && <Directory />}
      {tab === "fields" && <Fields />}
      {tab === "admins" && <Admins />}
    </div>
  );
}

type MailFlowData = {
  publicIp: PublicIpInfo;
  provider: "microsoft" | "google";
  smtp: { host: string; port: number };
  returnPath: string;
  microsoft: { steps: Array<{ title: string; detail: string; commands: string[] }>; powershell: string };
  google: {
    hostRoute: { host: string; port: number };
    smtpRelay: { name: string; allowedSenders: string; auth: string; note: string };
    contentCompliance: { name: string; affect: string; expression: string; action: string };
  };
  spf: string;
};

function MailFlow() {
  const [data, setData] = useState<MailFlowData | null>(null);
  const [provider, setProvider] = useState<"microsoft" | "google" | null>(null);
  useEffect(() => {
    void api.mailFlow().then((d) => setData(d as unknown as MailFlowData));
  }, []);
  if (!data) return <p className="mt-4 text-slate-500">Loading…</p>;
  const shown = provider ?? data.provider;
  const ip = data.publicIp;
  const ipSource = { config: "set by PUBLIC_IPV4", interface: "from the network interface", dns: "from DNS", none: "" }[ip.source];
  const g = data.google;

  return (
    <div className="mt-6 space-y-6">
      <div className="grid gap-4 md:grid-cols-3">
        <Fact label="This server sends from" value={ip.address ?? "Unknown"} note={ip.address ? ipSource : "Set PUBLIC_IPV4"} copy={ip.address ?? undefined} />
        <Fact label="Microsoft / Google deliver to" value={`${data.smtp.host}:${data.smtp.port}`} note="STARTTLS required" copy={data.smtp.host} />
        <Fact label="Signed mail returns to" value={data.returnPath} note="Microsoft 365 endpoint per domain; see Settings → Domains" />
      </div>
      {ip.warning && <p className="rounded-xl bg-amber-50 text-amber-900 px-4 py-3 text-sm">{ip.warning}</p>}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_400px] items-start">
        <section className="panel p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="tabs !mt-0">
              {(
                [
                  ["microsoft", "Microsoft 365"],
                  ["google", "Google Workspace"]
                ] as const
              ).map(([key, label]) => (
                <button key={key} className={`tab ${shown === key ? "active" : ""}`} onClick={() => setProvider(key)}>
                  {label}
                </button>
              ))}
            </div>
            {shown === "microsoft" && <CopyButton text={data.microsoft.powershell} label="Copy the whole script" />}
          </div>

          {shown === "microsoft" ? (
            <ol className="mt-6 space-y-6">
              {data.microsoft.steps.map((step, i) => (
                <Step key={step.title} n={i + 1} title={step.title} detail={step.detail}>
                  <CodeBlock code={step.commands.join("\n")} />
                </Step>
              ))}
            </ol>
          ) : (
            <ol className="mt-6 space-y-6">
              <Step n={1} title="Add Signer as a host" detail="Admin console → Apps → Google Workspace → Gmail → Hosts.">
                <SettingRows rows={[["Name", "Signer"], ["Host", `${g.hostRoute.host}`], ["Port", String(g.hostRoute.port)], ["Require TLS", "On"]]} />
              </Step>
              <Step n={2} title="Let Signer return mail through the SMTP relay" detail="Gmail → Routing → SMTP relay service.">
                <SettingRows rows={[["Name", g.smtpRelay.name], ["Allowed senders", g.smtpRelay.allowedSenders], ["Authentication", g.smtpRelay.note], ["Encryption", g.smtpRelay.auth]]} />
              </Step>
              <Step n={3} title="Route outgoing mail to Signer" detail="Gmail → Compliance → Content compliance.">
                <SettingRows rows={[["Name", g.contentCompliance.name], ["Messages to affect", g.contentCompliance.affect], ["Expression", g.contentCompliance.expression], ["Action", g.contentCompliance.action]]} />
              </Step>
            </ol>
          )}
        </section>

        <div className="space-y-6 xl:sticky xl:top-6">
          <ReturnPathTest />
          <section className="panel p-5 text-sm">
            <h2 className="font-semibold text-base">Before you turn it on</h2>
            <ul className="mt-3 space-y-2.5 text-slate-600 leading-6">
              <li>
                <strong className="text-ink">Port 25 open.</strong> Linode blocks outbound mail ports on new accounts until a support
                ticket lifts it. The return-path test shows whether it is open.
              </li>
              <li>
                <strong className="text-ink">Certificate.</strong> {data.smtp.host} must resolve to this server and have a valid
                certificate; the install script sets this up.
              </li>
              <li>
                <strong className="text-ink">Nothing leaves your tenant.</strong> Mail is signed here and handed back to Microsoft or
                Google, which deliver it. {data.spf.replace(/^No SPF change is needed for [^:]+: /, "No SPF or DKIM change is needed: ")}
              </li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}

function Fact({ label, value, note, copy }: { label: string; value: string; note?: string; copy?: string }) {
  return (
    <div className="panel p-5 min-w-0">
      <div className="stat-label">{label}</div>
      <div className="mt-1 flex items-center gap-2 min-w-0">
        <span className="font-semibold text-ink text-lg truncate" title={value}>
          {value}
        </span>
        {copy && <CopyButton text={copy} compact />}
      </div>
      {note && <div className="mt-0.5 text-xs text-slate-500">{note}</div>}
    </div>
  );
}

function Step({ n, title, detail, children }: { n: number; title: string; detail: string; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3">
      <span className="h-7 w-7 rounded-full bg-sky text-accent-2 text-sm font-semibold grid place-items-center">{n}</span>
      <div className="min-w-0">
        <h3 className="font-semibold text-ink leading-7">{title}</h3>
        <p className="text-sm text-slate-500 leading-6">{detail}</p>
        <div className="mt-3">{children}</div>
      </div>
    </li>
  );
}

function CodeBlock({ code }: { code: string }) {
  return (
    <div className="relative group rounded-xl bg-[#0f1b3d] text-slate-100">
      <pre className="p-4 pr-24 text-xs leading-5 font-mono whitespace-pre-wrap [overflow-wrap:anywhere]">{code}</pre>
      <div className="absolute top-2 right-2">
        <CopyButton text={code} dark />
      </div>
    </div>
  );
}

function SettingRows({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="rounded-xl border border-line divide-y divide-line text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="grid grid-cols-[10rem_minmax(0,1fr)] gap-3 px-4 py-2.5">
          <dt className="text-slate-500">{k}</dt>
          <dd className="text-ink break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function CopyButton({ text, label = "Copy", compact, dark }: { text: string; label?: string; compact?: boolean; dark?: boolean }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    } catch {
      /* clipboard blocked: the text is still selectable */
    }
  };
  const Icon = done ? Check : Copy;
  if (compact) {
    return (
      <button type="button" className="text-slate-400 hover:text-accent-2 shrink-0" title={`Copy ${text}`} onClick={() => void copy()}>
        <Icon size={15} />
      </button>
    );
  }
  return (
    <button
      type="button"
      className={
        dark
          ? "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium bg-white/10 text-slate-100 hover:bg-white/20"
          : "btn btn-ghost"
      }
      onClick={() => void copy()}
    >
      <Icon size={14} />
      {done ? "Copied" : label}
    </button>
  );
}

function Directory() {
  const [users, setUsers] = useState<DirectoryPerson[]>([]);
  const [fields, setFields] = useState<Awaited<ReturnType<typeof api.fields>>>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<DirectoryPerson | null>(null);
  const [status, setStatus] = useState("");
  useEffect(() => {
    void api.users().then(setUsers);
    void api.fields().then(setFields);
  }, []);

  const [showDisabled, setShowDisabled] = useState(false);
  const q = query.trim().toLowerCase();
  const disabledCount = users.filter((u) => u.enabled === 0).length;
  const shown = users.filter(
    (u) =>
      (showDisabled || u.enabled !== 0) &&
      (!q || [u.displayName, u.email, u.jobTitle, u.department].some((v) => String(v ?? "").toLowerCase().includes(q)))
  );

  return (
    <div className="mt-6 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <button
          className="btn btn-primary"
          onClick={async () => {
            setStatus("Syncing…");
            try {
              const res = (await api.sync()) as Array<{ source: string; users: number; groups: number; removed?: number; error?: string }>;
              setStatus(
                res.length
                  ? res
                      .map((r) =>
                        r.error
                          ? `${r.source}: ${r.error}`
                          : `${r.source}: ${r.users} people, ${r.groups} groups${r.removed ? `, ${r.removed} removed` : ""}`
                      )
                      .join(" · ")
                  : "No directory is configured."
              );
              setUsers(await api.users());
            } catch (err) {
              setStatus(err instanceof Error ? err.message : String(err));
            }
          }}
        >
          Synchronise Entra / Google
        </button>
        <input
          className="input max-w-sm"
          placeholder="Search name, email, title or department"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {disabledCount > 0 && (
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={showDisabled} onChange={(e) => setShowDisabled(e.target.checked)} />
            Include {disabledCount} disabled account{disabledCount === 1 ? "" : "s"}
          </label>
        )}
        <span className="text-sm text-slate-500 ml-auto">
          {shown.length} of {users.length}
        </span>
      </div>
      {status && <p className="text-sm text-slate-600">{status}</p>}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_400px] items-start">
        <div className="panel overflow-auto max-h-[calc(100vh-16rem)]">
          <table className="w-full text-sm">
            <thead className="table-head sticky top-0 z-10">
              <tr>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Email</th>
                <th className="px-4 py-3 font-medium">Title</th>
                <th className="px-4 py-3 font-medium">Department</th>
                <th className="px-4 py-3 font-medium">Source</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((u) => (
                <tr
                  key={u.id}
                  className={`border-t border-line cursor-pointer transition-colors ${
                    selected?.id === u.id ? "bg-sky" : "hover:bg-paper"
                  }`}
                  onClick={() => setSelected(u)}
                >
                  <td className="px-4 py-2.5 font-medium text-ink">
                    {u.displayName}
                    {u.enabled === 0 && <span className="badge ml-2">Disabled</span>}
                  </td>
                  <td className="px-4 py-2.5 text-slate-600">{u.email}</td>
                  <td className="px-4 py-2.5 text-slate-600">{u.jobTitle}</td>
                  <td className="px-4 py-2.5 text-slate-600">{u.department}</td>
                  <td className="px-4 py-2.5 text-slate-500 capitalize">{String(u.source ?? "")}</td>
                </tr>
              ))}
              {!shown.length && (
                <tr>
                  <td className="px-4 py-3 text-slate-500" colSpan={5}>
                    {users.length ? "Nobody matches that search." : "Nobody yet: run a directory sync."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {selected && (
          <PersonEditor
            key={selected.id}
            person={selected}
            fields={fields}
            onSaved={(saved) => {
              setUsers(users.map((u) => (u.id === saved.id ? saved : u)));
              setSelected(saved);
            }}
          />
        )}
      </div>
    </div>
  );
}

function PersonEditor(props: {
  person: DirectoryPerson;
  fields: Awaited<ReturnType<typeof api.fields>>;
  onSaved: (person: DirectoryPerson) => void;
}) {
  const { person, fields } = props;
  const editable = fields.filter((f) => !f.directory);
  const fromDirectory = fields.filter((f) => f.directory);
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(editable.map((f) => [f.key, String(person[f.key] ?? "")]))
  );
  const [message, setMessage] = useState("");
  return (
    <div className="panel p-5 text-sm space-y-5 xl:sticky xl:top-6 xl:max-h-[calc(100vh-3rem)] xl:overflow-auto">
      <div>
        <h2 className="font-bold text-lg text-ink">{person.displayName}</h2>
        <p className="text-slate-500">{person.email}</p>
      </div>
      <div>
        <h3 className="font-medium">
          From {person.source === "google" ? "Google Workspace" : person.source === "entra" ? "Entra ID" : "the directory"}
        </h3>
        <p className="text-xs text-slate-500 mb-2">Read-only here. Change these in the directory; the next sync picks them up.</p>
        <dl className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5">
          {fromDirectory.map((f) => (
            <div key={f.key} className="contents">
              <dt className="text-slate-500">{f.label}</dt>
              <dd className="break-words text-ink">{String(person[f.key] ?? "") || <span className="text-slate-300">—</span>}</dd>
            </div>
          ))}
        </dl>
      </div>
      <form
        className="space-y-2"
        onSubmit={async (e) => {
          e.preventDefault();
          setMessage("");
          try {
            const saved = await api.saveUserDetails(person.email, draft);
            props.onSaved(saved);
            setMessage("Saved. The next email from this person uses these values.");
          } catch (err) {
            setMessage(err instanceof Error ? err.message : String(err));
          }
        }}
      >
        <h3 className="font-medium">Signature details</h3>
        {editable.map((f) => (
          <label key={f.key} className="block">
            <span className="text-slate-600">
              {f.label}
              {f.userEditable && <span className="ml-1 text-xs text-slate-400">(they can edit this too)</span>}
            </span>
            <input
              className="input mt-1"
              value={draft[f.key] ?? ""}
              onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
            />
          </label>
        ))}
        <button className="btn btn-primary">Save</button>
        {message && <p className="text-slate-600">{message}</p>}
      </form>
    </div>
  );
}

function Fields() {
  const [fields, setFields] = useState<Awaited<ReturnType<typeof api.fields>>>([]);
  useEffect(() => {
    void api.fields().then(setFields);
  }, []);
  return (
    <div className="mt-6 panel p-5">
      <p className="text-sm text-slate-600 mb-4">Users may edit only the fields you enable. Directory-sourced values remain the default until overridden.</p>
      <div className="grid gap-x-10 sm:grid-cols-2 xl:grid-cols-3">
        {fields.map((f) => (
          <label key={f.key} className="flex items-center justify-between gap-3 py-1.5 text-sm border-b border-line">
            <span>
              {f.label} {f.directory && <span className="text-slate-400">(directory)</span>}
            </span>
            <input
              type="checkbox"
              checked={f.userEditable}
              onChange={(e) => setFields(fields.map((x) => (x.key === f.key ? { ...x, userEditable: e.target.checked } : x)))}
            />
          </label>
        ))}
      </div>
      <button
        className="mt-4 btn btn-primary"
        onClick={async () => {
          await api.saveFields(fields.filter((f) => f.userEditable).map((f) => f.key));
        }}
      >
        Save field permissions
      </button>
    </div>
  );
}

const ROLE_OPTIONS = [
  ["owner", "Owner"],
  ["admin", "Admin"],
  ["editor", "Editor"],
  ["designer", "Designer"]
] as const;

function Admins() {
  const { user } = useAuth();
  const [data, setData] = useState<Awaited<ReturnType<typeof api.admins>> | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("editor");
  const [error, setError] = useState("");
  const load = () => api.admins().then(setData);
  useEffect(() => {
    void load();
  }, []);
  if (!data) return <p className="mt-4 text-slate-500">Loading…</p>;
  const isSuper = user?.role === "super_admin";
  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  /** Mirrors the server's rules, so buttons that would be refused are not offered. */
  const locked = (r: { email: string; role: string }) =>
    r.email === user?.email.toLowerCase()
      ? "Your own role: ask another admin to change it"
      : r.role === "owner" && !isSuper
        ? "Only the super admin can change an owner"
        : "";
  return (
    <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] items-start">
      <div>
        <p className="text-sm text-slate-600">
          Super admin is <strong>{data.superAdmin || "(set SUPER_ADMIN_EMAIL)"}</strong>, set on the server. Everyone else who
          signs in is a user unless they have a role here.
        </p>
        <form
          className="mt-4 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await api.saveAdmin(email, role);
              setEmail("");
            });
          }}
        >
          <input
            className="input flex-1 min-w-0"
            type="email"
            required
            placeholder="user@domain"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <select className="input w-40 shrink-0" value={role} onChange={(e) => setRole(e.target.value)}>
            {ROLE_OPTIONS.filter(([value]) => value !== "owner" || isSuper).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <button className="btn btn-primary">Grant</button>
        </form>
        {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
        <div className="mt-4 panel overflow-hidden">
          <table className="w-full text-sm">
            <thead className="table-head">
              <tr>
                <th className="px-4 py-2.5 font-medium">Email</th>
                <th className="px-4 py-2.5 font-medium w-48">Role</th>
                <th className="px-4 py-2.5 w-24" />
              </tr>
            </thead>
            <tbody>
              {data.roles.map((r) => {
                const why = locked(r);
                return (
                  <tr key={r.email} className="border-t border-line">
                    <td className="px-4 py-2">{r.email}</td>
                    <td className="px-4 py-2">
                      {why ? (
                        <span className="capitalize text-slate-600" title={why}>
                          {r.role}
                        </span>
                      ) : (
                        <select
                          className="input py-1"
                          value={r.role}
                          aria-label={`Role for ${r.email}`}
                          onChange={(e) => void act(() => api.saveAdmin(r.email, e.target.value))}
                        >
                          {ROLE_OPTIONS.filter(([value]) => value !== "owner" || isSuper).map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {!why && (
                        <button
                          className="text-sm text-red-700 hover:underline"
                          onClick={() => {
                            if (confirm(`Remove ${r.email}'s ${r.role} role? They will sign in as an ordinary user.`)) {
                              void act(() => api.removeAdmin(r.email));
                            }
                          }}
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!data.roles.length && (
                <tr>
                  <td className="px-4 py-3 text-slate-500" colSpan={3}>
                    No roles granted yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-slate-500">Changes apply on that person&apos;s next click; they do not need to sign out.</p>
      </div>
      <section className="panel p-5 text-sm">
        <h2 className="font-semibold text-base">What each role can do</h2>
        <dl className="mt-3 grid grid-cols-[6rem_1fr] gap-x-3 gap-y-2 text-slate-700">
          {ROLES.map(([name, can]) => (
            <div key={name} className="contents">
              <dt className="font-medium">{name}</dt>
              <dd>{can}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 text-xs text-slate-500">
          Nobody can change their own role, and only the super admin can grant, change or remove the owner role.
        </p>
      </section>
    </div>
  );
}

const ROLES = [
  ["Owner", "Everything an admin can do, and install updates."],
  ["Admin", "Settings: connectors, domains, directory, field locks and roles; plus everything an editor can do."],
  ["Editor", "Create, edit, delete and reorder signatures, disclaimers and campaigns; send tests."],
  ["Designer", "Create and edit signatures, disclaimers and campaigns, and upload images; cannot delete or reorder."],
  ["User", "Edit their own details under My Details, where field locks allow."]
] as const;

function Domains() {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.domains>> | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const load = () => api.domains().then(setData);
  useEffect(() => {
    void load();
  }, []);
  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  if (!data) return <p className="mt-4 text-slate-500">Loading…</p>;
  return (
    <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] items-start">
      <div className="space-y-4 xl:order-2">
        <p className="text-sm text-slate-600 leading-6">
          The email domains this Microsoft 365 or Google Workspace tenant sends from. Only senders on these domains get a
          signature, disclaimer or campaign; mail from any other domain passes through unchanged. Recipients on these domains
          count as <strong>internal</strong> in rules. The connectors and routing rules already cover every domain in the
          tenant, so adding a domain here needs no change in Exchange or Google.
        </p>
        <p className="text-sm text-slate-600 leading-6">
          {data.perDomainMx ? (
            <>
              Signed mail goes back to each domain&apos;s own Microsoft 365 endpoint, found from its MX record. A domain whose MX is
              not Microsoft 365 (a filtering service, for example) uses <code>{data.upstreamHost}</code> from setup unless you set a
              return host for it.
            </>
          ) : (
            <>
              Signed mail goes back through <code>{data.upstreamHost || "UPSTREAM_HOST (not set)"}</code> for every domain, unless you
              set a return host for a domain.
            </>
          )}
        </p>
      </div>
      <div className="space-y-4 xl:order-1">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await api.addDomain(name);
              setName("");
            });
          }}
        >
          <input className="input flex-1" placeholder="example.com" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn btn-primary" disabled={!name.trim()}>
            Add domain
          </button>
        </form>
        {error && <p className="text-sm text-red-700">{error}</p>}
        <ul className="panel divide-y divide-line">
          {data.domains.map((d) => (
            <li key={d.name} className="p-3 flex items-start justify-between gap-4 text-sm">
              <span className="min-w-0">
                <strong>{d.name}</strong>
                {d.primary && <span className="ml-2 rounded bg-mist px-2 py-0.5 text-xs text-slate-600">Primary</span>}
                {d.route && (
                  <span className="block text-xs text-slate-500 mt-1">
                    Returns to <code>{d.route.host || "(nowhere: UPSTREAM_HOST is not set)"}</code> · {d.route.detail}
                  </span>
                )}
                <ReturnHostEditor
                  domain={d.name}
                  value={d.returnHost}
                  onSaved={() => void load()}
                  onError={setError}
                />
              </span>
              {!d.primary && (
                <span className="flex gap-2 shrink-0">
                  <button className="btn btn-ghost" onClick={() => void act(() => api.makePrimaryDomain(d.name))}>
                    Make primary
                  </button>
                  <button
                    className="btn btn-ghost"
                    onClick={() => {
                      if (confirm(`Stop adding signatures for senders on ${d.name}?`)) void act(() => api.removeDomain(d.name));
                    }}
                  >
                    Remove
                  </button>
                </span>
              )}
            </li>
          ))}
          {!data.domains.length && <li className="p-3 text-sm text-slate-500">No domains yet: every sender is signed until you add one.</li>}
        </ul>
        {data.suggestions.length > 0 && (
          <div>
            <h3 className="font-medium text-sm">Found in the directory</h3>
            <p className="text-xs text-slate-500 mt-1">Staff addresses use these domains, but they are not in the list.</p>
            <ul className="mt-2 panel divide-y divide-line">
              {data.suggestions.map((s) => (
                <li key={s.domain} className="p-3 flex items-center justify-between text-sm">
                  <span>
                    {s.domain} <span className="text-slate-400">({s.people} {s.people === 1 ? "person" : "people"})</span>
                  </span>
                  <button className="btn btn-ghost" onClick={() => void act(() => api.addDomain(s.domain))}>
                    Add
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

const FINISHED = new Set(["idle", "succeeded", "failed", "rolled-back", "current"]);

function shortSha(sha?: string) {
  return sha ? sha.slice(0, 7) : "";
}

function Updates() {
  const [info, setInfo] = useState<Awaited<ReturnType<typeof api.updates>> | null>(null);
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [polling, setPolling] = useState(false);

  useEffect(() => {
    void api.updates().then((res) => {
      setInfo(res);
      setStatus(res.status);
      if (!FINISHED.has(res.status.state)) setPolling(true);
    });
  }, []);

  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(async () => {
      try {
        const next = await api.updateStatus();
        setStatus(next);
        if (FINISHED.has(next.state)) {
          setPolling(false);
          setInfo(await api.updates());
        }
      } catch {
        // Signer is restarting onto the new version; keep polling.
        setStatus((s) => (s ? { ...s, message: "Signer is restarting…" } : s));
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [polling]);

  if (!info) return <p className="mt-4 text-slate-500">Loading…</p>;
  const current = info.current;
  return (
    <div className="mt-6 grid gap-6 xl:grid-cols-2 items-start">
      <div className="space-y-6">
        <section className="panel p-5 text-sm space-y-1">
          <h2 className="font-semibold text-lg">Installed version</h2>
          {current ? (
            <>
              <p>
                <code>{shortSha(current.commit)}</code> {current.subject}
              </p>
              <p className="text-slate-500">
                {current.date && new Date(current.date).toLocaleString()} · branch {current.branch}
              </p>
            </>
          ) : (
            <p className="text-slate-500">Not a git checkout, so the version is unknown.</p>
          )}
        </section>

        {!info.available ? (
          <p className="text-sm text-slate-600 leading-6">
            Updating from the portal needs a server set up with <code>deploy/install.sh</code>. To turn it on for an install
            made before this feature existed, re-run the installer once on the server:{" "}
            <code>curl -fsSL https://raw.githubusercontent.com/inspnet/signer/main/deploy/install.sh -o install.sh && sudo bash install.sh</code>
          </p>
        ) : (
          <section className="panel p-5 text-sm space-y-3">
            <div className="flex gap-2">
              <button
                className="btn btn-ghost"
                disabled={!!busy || polling}
                onClick={async () => {
                  setBusy("check");
                  setError("");
                  try {
                    setCheck(await api.checkUpdates());
                  } catch (err) {
                    setError(err instanceof Error ? err.message : String(err));
                  } finally {
                    setBusy("");
                  }
                }}
              >
                {busy === "check" ? "Checking…" : "Check for updates"}
              </button>
              {check?.updateAvailable && (
                <button
                  className="btn btn-primary"
                  disabled={!!busy || polling}
                  onClick={async () => {
                    if (!confirm("Install the update now? Signer restarts, and mail arriving during the restart is retried by Microsoft or Google.")) return;
                    setBusy("install");
                    setError("");
                    try {
                      await api.installUpdate();
                      setStatus({ state: "requested", message: "Waiting for the updater to start…", log: [] });
                      setPolling(true);
                    } catch (err) {
                      setError(err instanceof Error ? err.message : String(err));
                    } finally {
                      setBusy("");
                    }
                  }}
                >
                  Install update
                </button>
              )}
            </div>
            {error && <p className="text-red-700">{error}</p>}
            {check && !check.updateAvailable && <p className="text-slate-600">Signer is up to date.</p>}
            {check?.updateAvailable && (
              <div>
                <p>
                  {check.commits.length ? `${check.commits.length} new change${check.commits.length === 1 ? "" : "s"}` : "A newer version is available"}{" "}
                  (<code>{shortSha(check.latest.commit)}</code>){check.commits.length ? ":" : "."}
                </p>
                <ul className="mt-2 list-disc ml-5 space-y-1">
                  {check.commits.map((c) => (
                    <li key={c.commit}>
                      {c.subject} <span className="text-slate-400">— {new Date(c.date).toLocaleDateString()}</span>
                    </li>
                  ))}
                </ul>
                {check.installerChanged && (
                  <p className="mt-3 text-amber-800">
                    This update also changes the server setup (<code>deploy/install.sh</code>). Install it here, then re-run the
                    installer on the server to apply those changes too.
                  </p>
                )}
              </div>
            )}
          </section>
        )}
      </div>

      {status && status.state !== "idle" && (
        <section className="panel p-5 text-sm">
          <h2 className="font-semibold">
            Last update: {status.state.replace("-", " ")}
            {status.from && status.to && (
              <span className="font-normal text-slate-500">
                {" "}
                ({shortSha(status.from)} → {shortSha(status.to)})
              </span>
            )}
          </h2>
          <p className="mt-1 text-slate-600">{status.message}</p>
          {status.state === "succeeded" && (
            <button className="btn btn-ghost mt-2" onClick={() => window.location.reload()}>
              Reload the portal
            </button>
          )}
          {status.log.length > 0 && <pre className="mt-3 bg-mist p-3 rounded-lg text-xs overflow-auto max-h-[32rem]">{status.log.join("\n")}</pre>}
        </section>
      )}
    </div>
  );
}

function ReturnHostEditor(props: { domain: string; value: string; onSaved: () => void; onError: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState(props.value);
  if (!open) {
    return (
      <button className="block mt-1 text-xs text-accent-2 hover:underline font-medium" onClick={() => setOpen(true)}>
        {props.value ? "Change return host" : "Set a return host"}
      </button>
    );
  }
  const save = async (value: string) => {
    try {
      await api.setDomainReturnHost(props.domain, value);
      setOpen(false);
      props.onSaved();
    } catch (err) {
      props.onError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <form
      className="mt-2 flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void save(host);
      }}
    >
      <input
        className="input text-xs py-1"
        placeholder="contoso-com.mail.protection.outlook.com"
        value={host}
        onChange={(e) => setHost(e.target.value)}
      />
      <button className="btn btn-ghost text-xs">Save</button>
      {props.value && (
        <button type="button" className="btn btn-ghost text-xs" onClick={() => void save("")}>
          Use automatic
        </button>
      )}
    </form>
  );
}

type PublicIpInfo = { address: string | null; source: "config" | "interface" | "dns" | "none"; dnsAddresses: string[]; warning?: string };


const STEP_TONE = { ok: "text-emerald-700", warn: "text-amber-800", fail: "text-red-700", skipped: "text-slate-500" } as const;
const STEP_MARK = { ok: "✓", warn: "!", fail: "✕", skipped: "–" } as const;

/**
 * Talks SMTP to the host signed mail goes back to, as a real message would,
 * and stops before sending anything. The outside recipient shows whether
 * Microsoft 365 recognises Signer through the "Signer receive" connector.
 */
function ReturnPathTest() {
  const [domains, setDomains] = useState<string[]>([]);
  const [domain, setDomain] = useState("");
  const [external, setExternal] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RelayDiagnosis | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void api.domains().then((d) => {
      setDomains(d.domains.map((x) => x.name));
      setDomain(d.domains.find((x) => x.primary)?.name ?? d.domains[0]?.name ?? "");
    });
    if (window.location.hash === "#return-path") {
      setTimeout(() => document.getElementById("return-path")?.scrollIntoView({ behavior: "smooth" }), 100);
    }
  }, []);
  const run = async () => {
    setRunning(true);
    setError("");
    setResult(null);
    try {
      setResult(await api.diagnoseRelay({ domain, externalRecipient: external || undefined }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };
  return (
    <section id="return-path" className="panel p-5">
      <h2 className="font-semibold text-lg">Test the return path</h2>
      <p className="mt-2 text-sm text-slate-500 leading-6">
        Talks to where the domain&apos;s signed mail goes back to, as a real message would, and stops before sending. The outside
        address shows whether Microsoft 365 recognises this server.
      </p>
      <form
        className="mt-4 flex flex-wrap gap-2 items-end"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <label className="text-sm">
          <span className="block text-slate-500 mb-1">Domain</span>
          <select className="input" value={domain} onChange={(e) => setDomain(e.target.value)}>
            {domains.map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
        </label>
        <label className="text-sm flex-1 min-w-[14rem]">
          <span className="block text-slate-500 mb-1">Outside address (optional)</span>
          <input
            className="input w-full"
            placeholder="signer-relay-check@example.com"
            value={external}
            onChange={(e) => setExternal(e.target.value)}
          />
        </label>
        <button className="btn btn-primary" disabled={running || !domain}>
          {running ? "Testing…" : "Run test"}
        </button>
      </form>
      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
      {result && (
        <div className="mt-4">
          <p className={`text-sm font-semibold ${result.ok ? "text-emerald-700" : "text-red-700"}`}>
            {result.ok
              ? `Signed mail from ${result.domain} can get back to ${result.target.host}.`
              : `Signed mail from ${result.domain} cannot get back to ${result.target.host}.`}
          </p>
          <p className="text-xs text-slate-500 mt-1">
            {result.target.host}:{result.target.port}, {result.target.tls}
            {result.target.auth ? ", signed in" : ""}: {result.target.route}
          </p>
          <ol className="mt-3 space-y-1 text-sm">
            {result.steps.map((s, i) => (
              <li key={i} className="flex gap-2">
                <span className={`w-4 font-bold ${STEP_TONE[s.status]}`}>{STEP_MARK[s.status]}</span>
                <span className="min-w-0">
                  <span className="font-medium">{s.step}</span>
                  <span className="text-slate-600 break-words"> — {s.detail}</span>
                  {s.ms > 0 && <span className="text-slate-400 text-xs"> {s.ms} ms</span>}
                </span>
              </li>
            ))}
          </ol>
          {result.hint && <p className="mt-3 rounded-lg bg-amber-50 text-amber-900 p-3 text-sm leading-6">{result.hint}</p>}
        </div>
      )}
    </section>
  );
}

/** Email alerts for deferred or unsigned mail, sent through Mailgun's HTTP API. */
function Alerts() {
  const [saved, setSaved] = useState<AlertConfig | null>(null);
  const [form, setForm] = useState({
    enabled: false,
    domain: "",
    region: "us" as "us" | "eu",
    apiKey: "",
    from: "",
    recipients: "",
    intervalMinutes: 15
  });
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const adopt = (c: AlertConfig) => {
    setSaved(c);
    setForm({
      enabled: c.enabled,
      domain: c.domain,
      region: c.region,
      apiKey: "",
      from: c.from,
      recipients: c.recipients.join(", "),
      intervalMinutes: c.intervalMinutes
    });
  };
  useEffect(() => {
    void api.alerts().then(adopt);
  }, []);
  if (!saved) return <p className="mt-4 text-slate-500">Loading…</p>;

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setMessage(null);
    try {
      setMessage({ ok: true, text: await fn() });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    run(async () => {
      adopt(await api.saveAlerts({ ...form, apiKey: form.apiKey || undefined }));
      return "Saved.";
    });
  const test = () =>
    run(async () => {
      adopt(await api.saveAlerts({ ...form, apiKey: form.apiKey || undefined }));
      const res = await api.testAlert();
      setSaved(await api.alerts());
      return res.detail;
    });

  return (
    <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] items-start">
      <form
        className="panel p-5 space-y-4 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="flex gap-2 items-center font-medium">
          <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
          Email an alert when messages are deferred or delivered unsigned
        </label>
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_10rem]">
          <label className="block">
            Mailgun sending domain
            <input className="input mt-1" placeholder="mg.yourdomain.com" value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} />
          </label>
          <label className="block">
            Region
            <select className="input mt-1" value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value as "us" | "eu" })}>
              <option value="us">US</option>
              <option value="eu">EU</option>
            </select>
          </label>
        </div>
        <label className="block">
          API key
          <input
            className="input mt-1 font-mono"
            type="password"
            autoComplete="off"
            placeholder={saved.apiKeySet ? "Saved — leave empty to keep it" : "A sending key for this domain"}
            value={form.apiKey}
            onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
          />
        </label>
        <label className="block">
          Send alerts to
          <input
            className="input mt-1"
            placeholder="it@yourdomain.com, oncall@yourdomain.com"
            value={form.recipients}
            onChange={(e) => setForm({ ...form, recipients: e.target.value })}
          />
          <span className="block mt-1 text-xs text-slate-500">Use addresses that do not depend on this tenant's mail flow, if you can.</span>
        </label>
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_10rem]">
          <label className="block">
            From (optional)
            <input
              className="input mt-1"
              placeholder={`Signer alerts <signer@${form.domain || "mg.yourdomain.com"}>`}
              value={form.from}
              onChange={(e) => setForm({ ...form, from: e.target.value })}
            />
          </label>
          <label className="block">
            At most one every
            <select
              className="input mt-1"
              value={form.intervalMinutes}
              onChange={(e) => setForm({ ...form, intervalMinutes: Number(e.target.value) })}
            >
              {[5, 15, 30, 60, 240, 1440].map((m) => (
                <option key={m} value={m}>
                  {m < 60 ? `${m} minutes` : m === 60 ? "hour" : m === 1440 ? "day" : `${m / 60} hours`}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn btn-primary" disabled={busy}>
            Save
          </button>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void test()}>
            Save and send a test
          </button>
          {message && <span className={message.ok ? "text-emerald-700" : "text-red-700"}>{message.text}</span>}
        </div>
        {saved.last && (
          <p className="text-xs text-slate-500">
            Last {saved.last.kind === "test" ? "test" : saved.last.kind === "recovery" ? "recovery notice" : "alert"}:{" "}
            {new Date(saved.last.at).toLocaleString()} — <span className={saved.last.ok ? "" : "text-red-700"}>{saved.last.detail}</span>
          </p>
        )}
      </form>
      <section className="panel p-5 text-sm leading-6 text-slate-700 space-y-3">
        <h2 className="font-semibold text-lg text-ink">How alerts work</h2>
        <p>
          Signer emails these addresses when a message is <strong>Deferred</strong> (it could not be handed back, so Microsoft 365
          or Google are holding it and retrying) or <strong>Unsigned</strong> (delivered without a signature). The first problem
          is reported straight away; later ones are collected into one email per interval. One more email follows when mail is
          flowing again.
        </p>
        <p>
          Alerts go out through Mailgun&apos;s HTTPS API, not through Signer&apos;s own mail path, so they still arrive when port 25 is
          blocked or Exchange is refusing Signer.
        </p>
        <p>
          They contain counts, sender domains and the reasons, with email addresses removed. The full detail stays in Activity on
          this server.
        </p>
        <p className="text-xs text-slate-500">
          In Mailgun: add and verify a sending domain (a subdomain such as mg.yourdomain.com keeps it apart from your main mail), then
          create a sending API key for it under Domain settings → Sending keys. Pick the region the domain was created in.
        </p>
      </section>
    </div>
  );
}

const RESULT_TONE = { updated: "text-emerald-700", "not-found": "text-slate-500", skipped: "text-amber-800", failed: "text-red-700" } as const;
const RESULT_LABEL = { updated: "Updated", "not-found": "Not found", skipped: "Left as sent", failed: "Failed" } as const;

/** Swapping the unsigned copy in people's Sent Items for the signed one (Microsoft 365). */
function SentItems() {
  const [data, setData] = useState<SentItemsConfig | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [scope, setScope] = useState<"everyone" | "groups">("groups");
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [check, setCheck] = useState<Awaited<ReturnType<typeof api.checkSentItems>> | null>(null);
  const [busy, setBusy] = useState("");
  const adopt = (c: SentItemsConfig) => {
    setData(c);
    setEnabled(c.enabled);
    setGroupIds(c.groupIds);
    setScope(c.groupIds.length || !c.enabled ? "groups" : "everyone");
  };
  useEffect(() => {
    void api.sentItems().then(adopt);
  }, []);
  if (!data) return <p className="mt-4 text-slate-500">Loading…</p>;
  if (!data.available) {
    return (
      <p className="mt-6 panel p-5 text-sm text-slate-600">
        Sent Items update is for Microsoft 365 and needs sign-in with Microsoft (ENTRA_*) configured on this server.
      </p>
    );
  }
  const save = async () => {
    setBusy("save");
    setMessage(null);
    try {
      adopt(await api.saveSentItems({ enabled, groupIds: scope === "everyone" ? [] : groupIds }));
      setMessage({ ok: true, text: "Saved." });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy("");
    }
  };
  const runCheck = async () => {
    setBusy("check");
    setCheck(null);
    try {
      setCheck(await api.checkSentItems());
    } catch (err) {
      setCheck({ ok: false, steps: [], hint: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy("");
    }
  };
  const shownGroups = data.groups.filter((g) => g.name.toLowerCase().includes(filter.trim().toLowerCase()));
  const noGroups = scope === "groups" && !groupIds.length;
  const id = data.clientId || "<application (client) ID>";

  return (
    <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] items-start">
      <div className="space-y-6">
        <section className="panel p-5 space-y-4 text-sm">
          <label className="flex gap-2 items-center font-medium">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Replace the copy in the sender&apos;s Sent Items with the signed version
          </label>
          <div className="space-y-2">
            <label className="flex gap-2 items-center">
              <input type="radio" checked={scope === "groups"} onChange={() => setScope("groups")} />
              Only people in these groups (recommended to start)
            </label>
            {scope === "groups" && (
              <div className="ml-6 rounded-xl border border-line">
                <input
                  className="w-full border-b border-line px-3 py-2 text-sm outline-none rounded-t-xl"
                  placeholder="Filter groups"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
                <div className="max-h-56 overflow-auto p-2">
                  {shownGroups.map((g) => (
                    <label key={g.id} className="flex gap-2 items-center px-1 py-1">
                      <input
                        type="checkbox"
                        checked={groupIds.includes(g.id)}
                        onChange={(e) => setGroupIds(e.target.checked ? [...groupIds, g.id] : groupIds.filter((x) => x !== g.id))}
                      />
                      {g.name}
                    </label>
                  ))}
                  {!data.groups.length && <p className="px-1 py-1 text-slate-500">No groups yet: run a directory sync.</p>}
                </div>
              </div>
            )}
            <label className="flex gap-2 items-center">
              <input type="radio" checked={scope === "everyone"} onChange={() => setScope("everyone")} />
              Everyone whose mail Signer signs
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn btn-primary" disabled={busy !== "" || (enabled && noGroups)} onClick={() => void save()}>
              Save
            </button>
            <button className="btn btn-ghost" disabled={busy !== ""} onClick={() => void runCheck()}>
              {busy === "check" ? "Checking…" : "Run the check"}
            </button>
            {enabled && noGroups && <span className="text-amber-800">Choose at least one group, or Everyone.</span>}
            {message && <span className={message.ok ? "text-emerald-700" : "text-red-700"}>{message.text}</span>}
          </div>
          {check && (
            <div className="rounded-xl bg-paper p-4">
              <p className={`font-semibold ${check.ok ? "text-emerald-700" : "text-red-700"}`}>
                {check.ok ? "Your tenant allows everything Sent Items update needs." : "Something the update needs was refused."}
              </p>
              <ol className="mt-2 space-y-1">
                {check.steps.map((s) => (
                  <li key={s.step} className="flex gap-2">
                    <span className={`w-4 font-bold ${!s.ok ? "text-red-700" : s.warn ? "text-amber-700" : "text-emerald-700"}`}>
                      {!s.ok ? "✕" : s.warn ? "!" : "✓"}
                    </span>
                    <span className="min-w-0">
                      <span className="font-medium">{s.step}</span>
                      <span className="text-slate-600 break-words"> — {s.detail}</span>
                    </span>
                  </li>
                ))}
              </ol>
              {check.hint && <p className="mt-2 text-amber-900">{check.hint}</p>}
            </div>
          )}
        </section>

        <section className="panel overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4">
            <h2 className="font-semibold">Recent updates</h2>
            <span className="text-xs text-slate-500">{data.pending} waiting · kept in memory, last 50</span>
          </div>
          <table className="w-full text-sm">
            <thead className="table-head">
              <tr>
                <th className="px-5 py-2.5 font-medium">When</th>
                <th className="px-3 py-2.5 font-medium">Sender</th>
                <th className="px-3 py-2.5 font-medium">Result</th>
              </tr>
            </thead>
            <tbody>
              {data.results.map((r, i) => (
                <tr key={i} className="border-t border-line align-top">
                  <td className="px-5 py-2.5 whitespace-nowrap">{new Date(r.at).toLocaleString()}</td>
                  <td className="px-3 py-2.5">{r.sender}</td>
                  <td className="px-3 py-2.5">
                    <span className={`font-medium ${RESULT_TONE[r.result]}`}>{RESULT_LABEL[r.result]}</span>
                    <span className="block text-xs text-slate-500 break-words">{r.detail}</span>
                  </td>
                </tr>
              ))}
              {!data.results.length && (
                <tr>
                  <td className="px-5 py-3 text-slate-500" colSpan={3}>
                    Nothing yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      </div>

      <div className="space-y-6">
        <section className="panel p-5 text-sm leading-6 text-slate-600 space-y-3">
          <h2 className="font-semibold text-base text-ink">How it works</h2>
          <p>
            Outlook saves the unsigned message to Sent Items before Signer signs it. A few seconds after Signer hands the signed
            message back, it creates the signed copy in the sender&apos;s Sent Items, with the same recipients, time and conversation,
            copies the attachments across (up to 150 MB each), and permanently deletes the unsigned original.
          </p>
          <p>
            If any step fails, the signed copy is removed and the original is left as it was. Messages with an attached email or
            a cloud file are left as sent.
          </p>
          <p>
            Signer keeps only the signed body and signature images in memory until the swap is done (at most about 15 minutes),
            never the attachments, and writes nothing to disk.
          </p>
        </section>
        <section className="panel p-5 text-sm leading-6 text-slate-600 space-y-3">
          <h2 className="font-semibold text-base text-ink">Permission</h2>
          <p>
            Signer&apos;s Entra app needs <strong className="text-ink">Mail.ReadWrite</strong> as an Application permission. Choose one:
          </p>
          <p>
            <strong className="text-ink">Every mailbox:</strong> Entra admin center → App registrations → the Signer app → API
            permissions → Add a permission → <strong className="text-ink">Microsoft Graph</strong> → Application permissions →
            Mail.ReadWrite → Grant admin consent. Not the Mail.ReadWrite under &quot;Office 365 Exchange Online&quot;: that is a
            different permission, which Graph ignores.
          </p>
          <p>
            <strong className="text-ink">Only the people in scope (recommended):</strong> leave it out of Entra and grant it in
            Exchange Online with RBAC for Applications, limited to a mail-enabled security group. The object ID is the Signer
            app&apos;s, under Entra → Enterprise applications.
          </p>
          <CodeBlock
            code={[
              `New-ServicePrincipal -AppId "${id}" -ObjectId "<enterprise app object ID>" -DisplayName "Signer"`,
              `New-ManagementScope -Name "Signer Sent Items" -RecipientRestrictionFilter "MemberOfGroup -eq '<group distinguished name>'"`,
              `New-ManagementRoleAssignment -App "${id}" -Role "Application Mail.ReadWrite" -CustomResourceScope "Signer Sent Items"`
            ].join("\n")}
          />
          <p className="text-xs text-slate-500">Then click Run the check, with your own mailbox inside that group.</p>
        </section>
      </div>
    </div>
  );
}
