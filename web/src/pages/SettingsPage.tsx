import { useEffect, useState } from "react";
import { api, type DirectoryPerson, type RelayDiagnosis, type UpdateCheck, type UpdateStatus } from "../api/client";
import { PageHeader } from "../components/PageHeader";

export function SettingsPage() {
  const [tab, setTab] = useState<"flow" | "domains" | "directory" | "fields" | "admins" | "updates">("flow");
  return (
    <div>
      <PageHeader
        kicker="Admin"
        title="Settings"
        description="Connectors, domains, directory cache, who may edit their own card, and updates."
      />
      <div className="tabs">
        {(["flow", "domains", "directory", "fields", "admins", "updates"] as const).map((t) => (
          <button key={t} className={`tab capitalize ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
            {t === "flow" ? "Connectors" : t === "fields" ? "Field locks" : t}
          </button>
        ))}
      </div>
      {tab === "flow" && <MailFlow />}
      {tab === "domains" && <Domains />}
      {tab === "updates" && <Updates />}
      {tab === "directory" && <Directory />}
      {tab === "fields" && <Fields />}
      {tab === "admins" && <Admins />}
    </div>
  );
}

function MailFlow() {
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    void api.mailFlow().then(setData);
  }, []);
  if (!data) return <p className="mt-4 text-stone-500">Loading…</p>;
  const ms = data.microsoft as {
    powershell: string;
    sendConnector: Record<string, string>;
    receiveConnector: Record<string, string>;
    transportRule: Record<string, string>;
  };
  const google = data.google as {
    hostRoute: Record<string, string | number>;
    smtpRelay: Record<string, string>;
    contentCompliance: Record<string, string>;
  };
  return (
    <div className="mt-6 space-y-6 max-w-4xl">
      <p className="text-stone-600 leading-7">{(data.notes as string[]).join(" ")}</p>
      <PublicIpNote ip={data.publicIp as PublicIpInfo} />
      <ReturnPathTest />
      <section className="panel p-5">
        <h2 className="font-semibold text-lg">Microsoft 365 / Exchange Online</h2>
        <ol className="list-decimal ml-5 mt-3 text-sm space-y-2 text-stone-700">
          <li>
            Create an outbound connector to {ms.sendConnector.smartHost} (port 25), validating its TLS certificate, scoped to a
            transport rule.
          </li>
          <li>
            Create an inbound connector from {ms.receiveConnector.from}, identified by {ms.receiveConnector.identifiedBy.toLowerCase()},
            requiring TLS.
          </li>
          <li>
            Transport rule: sender inside the organisation, except if header {ms.transportRule.exceptIfHeader} is true, redirect to the
            Signer send connector. It is created <strong>disabled</strong>: enable it for one pilot mailbox first, check that mail arrives
            signed, then remove the pilot condition to go live.
          </li>
        </ol>
        <pre className="mt-4 bg-mist p-3 rounded-lg text-xs overflow-auto">{ms.powershell}</pre>
      </section>
      <section className="panel p-5">
        <h2 className="font-semibold text-lg">Google Workspace</h2>
        <ol className="list-decimal ml-5 mt-3 text-sm space-y-2 text-stone-700">
          <li>
            Hosts: add {String(google.hostRoute.host)} port {String(google.hostRoute.port)}.
          </li>
          <li>SMTP relay: {google.smtpRelay.note}</li>
          <li>Content compliance: {google.contentCompliance.expression}, then change route to Signer with TLS.</li>
        </ol>
      </section>
      <p className="text-sm text-stone-600">{String(data.spf)}</p>
    </div>
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

  const q = query.trim().toLowerCase();
  const shown = q
    ? users.filter((u) =>
        [u.displayName, u.email, u.jobTitle, u.department].some((v) => String(v ?? "").toLowerCase().includes(q))
      )
    : users;

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
        <span className="text-sm text-stone-500">
          {shown.length} of {users.length}
        </span>
      </div>
      {status && <p className="text-sm text-stone-600">{status}</p>}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="panel overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-mist text-left text-stone-500">
              <tr>
                <th className="p-3 font-medium">Name</th>
                <th className="font-medium">Email</th>
                <th className="font-medium">Title</th>
                <th className="font-medium">Source</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((u) => (
                <tr
                  key={u.id}
                  className={`border-t border-line cursor-pointer hover:bg-mist ${selected?.id === u.id ? "bg-mist" : ""}`}
                  onClick={() => setSelected(u)}
                >
                  <td className="p-3">
                    {u.displayName}
                    {u.enabled === 0 && <span className="ml-2 text-xs text-stone-400">disabled</span>}
                  </td>
                  <td>{u.email}</td>
                  <td>{u.jobTitle}</td>
                  <td className="capitalize">{String(u.source ?? "")}</td>
                </tr>
              ))}
              {!shown.length && (
                <tr>
                  <td className="p-3 text-stone-500" colSpan={4}>
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
    <div className="panel p-5 text-sm space-y-4 self-start">
      <div>
        <h2 className="font-semibold text-lg">{person.displayName}</h2>
        <p className="text-stone-500">{person.email}</p>
      </div>
      <div>
        <h3 className="font-medium">
          From {person.source === "google" ? "Google Workspace" : person.source === "entra" ? "Entra ID" : "the directory"}
        </h3>
        <p className="text-xs text-stone-500 mb-2">Read-only here. Change these in the directory; the next sync picks them up.</p>
        <dl className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-1">
          {fromDirectory.map((f) => (
            <div key={f.key} className="contents">
              <dt className="text-stone-500">{f.label}</dt>
              <dd>{String(person[f.key] ?? "") || <span className="text-stone-300">—</span>}</dd>
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
            <span className="text-stone-600">
              {f.label}
              {f.userEditable && <span className="ml-1 text-xs text-stone-400">(they can edit this too)</span>}
            </span>
            <input
              className="input mt-1"
              value={draft[f.key] ?? ""}
              onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
            />
          </label>
        ))}
        <button className="btn btn-primary">Save</button>
        {message && <p className="text-stone-600">{message}</p>}
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
    <div className="mt-6 panel p-5 max-w-xl">
      <p className="text-sm text-stone-600 mb-4">Users may edit only the fields you enable. Directory-sourced values remain the default until overridden.</p>
      {fields.map((f) => (
        <label key={f.key} className="flex items-center justify-between py-1.5 text-sm">
          <span>
            {f.label} {f.directory && <span className="text-stone-400">(directory)</span>}
          </span>
          <input
            type="checkbox"
            checked={f.userEditable}
            onChange={(e) => setFields(fields.map((x) => (x.key === f.key ? { ...x, userEditable: e.target.checked } : x)))}
          />
        </label>
      ))}
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

function Admins() {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.admins>> | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("editor");
  useEffect(() => {
    void api.admins().then(setData);
  }, []);
  if (!data) return <p className="mt-4 text-stone-500">Loading…</p>;
  return (
    <div className="mt-6 max-w-xl">
      <p className="text-sm text-stone-600">
        Super admin is <strong>{data.superAdmin || "(set SUPER_ADMIN_EMAIL)"}</strong> and is not stored in the database.
      </p>
      <form
        className="mt-4 flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          await api.saveAdmin(email, role);
          setData(await api.admins());
        }}
      >
        <input className="input flex-1" placeholder="user@domain" value={email} onChange={(e) => setEmail(e.target.value)} />
        <select className="input w-auto" value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="owner">Owner</option>
          <option value="admin">Admin</option>
          <option value="editor">Editor</option>
          <option value="designer">Designer</option>
          <option value="user">User</option>
        </select>
        <button className="btn btn-primary">Grant</button>
      </form>
      <ul className="mt-4 panel divide-y divide-line">
        {data.roles.map((r) => (
          <li key={r.email} className="p-3 flex justify-between text-sm">
            <span>{r.email}</span>
            <span className="text-stone-500">{r.role}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

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
  if (!data) return <p className="mt-4 text-stone-500">Loading…</p>;
  return (
    <div className="mt-6 max-w-2xl space-y-6">
      <p className="text-sm text-stone-600 leading-6">
        The email domains this Microsoft 365 or Google Workspace tenant sends from. Only senders on these domains get a
        signature, disclaimer or campaign; mail from any other domain passes through unchanged. Recipients on these domains
        count as <strong>internal</strong> in rules. The connectors and routing rules already cover every domain in the
        tenant, so adding a domain here needs no change in Exchange or Google.
      </p>
      <p className="text-sm text-stone-600 leading-6">
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
              {d.primary && <span className="ml-2 rounded bg-mist px-2 py-0.5 text-xs text-stone-600">Primary</span>}
              {d.route && (
                <span className="block text-xs text-stone-500 mt-1">
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
        {!data.domains.length && <li className="p-3 text-sm text-stone-500">No domains yet: every sender is signed until you add one.</li>}
      </ul>
      {data.suggestions.length > 0 && (
        <div>
          <h3 className="font-medium text-sm">Found in the directory</h3>
          <p className="text-xs text-stone-500 mt-1">Staff addresses use these domains, but they are not in the list.</p>
          <ul className="mt-2 panel divide-y divide-line">
            {data.suggestions.map((s) => (
              <li key={s.domain} className="p-3 flex items-center justify-between text-sm">
                <span>
                  {s.domain} <span className="text-stone-400">({s.people} {s.people === 1 ? "person" : "people"})</span>
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

  if (!info) return <p className="mt-4 text-stone-500">Loading…</p>;
  const current = info.current;
  return (
    <div className="mt-6 max-w-3xl space-y-6">
      <section className="panel p-5 text-sm space-y-1">
        <h2 className="font-semibold text-lg">Installed version</h2>
        {current ? (
          <>
            <p>
              <code>{shortSha(current.commit)}</code> {current.subject}
            </p>
            <p className="text-stone-500">
              {current.date && new Date(current.date).toLocaleString()} · branch {current.branch}
            </p>
          </>
        ) : (
          <p className="text-stone-500">Not a git checkout, so the version is unknown.</p>
        )}
      </section>

      {!info.available ? (
        <p className="text-sm text-stone-600 leading-6">
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
          {check && !check.updateAvailable && <p className="text-stone-600">Signer is up to date.</p>}
          {check?.updateAvailable && (
            <div>
              <p>
                {check.commits.length ? `${check.commits.length} new change${check.commits.length === 1 ? "" : "s"}` : "A newer version is available"}{" "}
                (<code>{shortSha(check.latest.commit)}</code>){check.commits.length ? ":" : "."}
              </p>
              <ul className="mt-2 list-disc ml-5 space-y-1">
                {check.commits.map((c) => (
                  <li key={c.commit}>
                    {c.subject} <span className="text-stone-400">— {new Date(c.date).toLocaleDateString()}</span>
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

      {status && status.state !== "idle" && (
        <section className="panel p-5 text-sm">
          <h2 className="font-semibold">
            Last update: {status.state.replace("-", " ")}
            {status.from && status.to && (
              <span className="font-normal text-stone-500">
                {" "}
                ({shortSha(status.from)} → {shortSha(status.to)})
              </span>
            )}
          </h2>
          <p className="mt-1 text-stone-600">{status.message}</p>
          {status.state === "succeeded" && (
            <button className="btn btn-ghost mt-2" onClick={() => window.location.reload()}>
              Reload the portal
            </button>
          )}
          {status.log.length > 0 && <pre className="mt-3 bg-mist p-3 rounded-lg text-xs overflow-auto max-h-80">{status.log.join("\n")}</pre>}
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
      <button className="block mt-1 text-xs text-teal-800 underline" onClick={() => setOpen(true)}>
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

function PublicIpNote({ ip }: { ip: PublicIpInfo }) {
  const how = {
    config: "set by PUBLIC_IPV4",
    interface: "read from this server's network interface",
    dns: "from this server's DNS record",
    none: ""
  }[ip.source];
  return (
    <div className="panel p-4 text-sm">
      {ip.address ? (
        <p>
          This server sends mail from <code className="font-semibold">{ip.address}</code> ({how}). It is filled in below.
        </p>
      ) : (
        <p>This server's public IPv4 could not be determined; replace the placeholder below.</p>
      )}
      {ip.warning && <p className="mt-2 text-amber-800">{ip.warning}</p>}
    </div>
  );
}

const STEP_TONE = { ok: "text-teal-800", warn: "text-amber-800", fail: "text-red-700", skipped: "text-stone-500" } as const;
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
      <p className="mt-2 text-sm text-stone-600 leading-6">
        Connects to where signed mail for the domain goes back to, exactly as a real message would: TLS, sender, then one of your
        mailboxes and an address outside your organisation. It stops before sending, so nothing is delivered. The outside address
        is the real test for Microsoft 365: it only accepts it when the &quot;Signer receive&quot; connector recognises this server.
      </p>
      <form
        className="mt-4 flex flex-wrap gap-2 items-end"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <label className="text-sm">
          <span className="block text-stone-500 mb-1">Domain</span>
          <select className="input" value={domain} onChange={(e) => setDomain(e.target.value)}>
            {domains.map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
        </label>
        <label className="text-sm flex-1 min-w-[14rem]">
          <span className="block text-stone-500 mb-1">Outside address (optional)</span>
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
          <p className={`text-sm font-semibold ${result.ok ? "text-teal-800" : "text-red-700"}`}>
            {result.ok
              ? `Signed mail from ${result.domain} can get back to ${result.target.host}.`
              : `Signed mail from ${result.domain} cannot get back to ${result.target.host}.`}
          </p>
          <p className="text-xs text-stone-500 mt-1">
            {result.target.host}:{result.target.port}, {result.target.tls}
            {result.target.auth ? ", signed in" : ""}: {result.target.route}
          </p>
          <ol className="mt-3 space-y-1 text-sm">
            {result.steps.map((s, i) => (
              <li key={i} className="flex gap-2">
                <span className={`w-4 font-bold ${STEP_TONE[s.status]}`}>{STEP_MARK[s.status]}</span>
                <span className="min-w-0">
                  <span className="font-medium">{s.step}</span>
                  <span className="text-stone-600 break-words"> — {s.detail}</span>
                  {s.ms > 0 && <span className="text-stone-400 text-xs"> {s.ms} ms</span>}
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
