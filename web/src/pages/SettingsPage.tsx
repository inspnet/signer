import { useEffect, useState } from "react";
import { api } from "../api/client";

export function SettingsPage() {
  const [tab, setTab] = useState<"flow" | "directory" | "fields" | "admins">("flow");
  return (
    <div>
      <h1 className="text-3xl font-semibold">Settings</h1>
      <div className="flex gap-4 mt-6 border-b border-line text-sm">
        {(["flow", "directory", "fields", "admins"] as const).map((t) => (
          <button key={t} className={`pb-3 capitalize ${tab === t ? "border-b-2 border-navy font-medium" : "text-slate-500"}`} onClick={() => setTab(t)}>
            {t === "flow" ? "Mail flow" : t}
          </button>
        ))}
      </div>
      {tab === "flow" && <MailFlow />}
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
  if (!data) return <p className="mt-4">Loading…</p>;
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
      <p className="text-slate-600">{(data.notes as string[]).join(" ")}</p>
      <section className="bg-white border border-line rounded-xl p-5">
        <h2 className="font-medium text-lg">Microsoft 365 / Exchange Online</h2>
        <ol className="list-decimal ml-5 mt-3 text-sm space-y-2 text-slate-700">
          <li>Create a Send connector to partner {ms.sendConnector.smartHost} with TLS, scoped to a transport rule.</li>
          <li>Create a Receive connector from partner, requiring TLS and certificate name {ms.receiveConnector.certDomain}.</li>
          <li>
            Transport rule: sender inside the organisation, except if header {ms.transportRule.exceptIfHeader} is true,
            redirect to the Signer send connector.
          </li>
        </ol>
        <pre className="mt-4 bg-mist p-3 rounded text-xs overflow-auto">{ms.powershell}</pre>
      </section>
      <section className="bg-white border border-line rounded-xl p-5">
        <h2 className="font-medium text-lg">Google Workspace</h2>
        <ol className="list-decimal ml-5 mt-3 text-sm space-y-2 text-slate-700">
          <li>Hosts: add {String(google.hostRoute.host)} port {String(google.hostRoute.port)}.</li>
          <li>SMTP relay: {google.smtpRelay.note}</li>
          <li>Content compliance: {google.contentCompliance.expression}, then change route to Signer with TLS.</li>
        </ol>
      </section>
      <p className="text-sm text-slate-600">{String(data.spf)}</p>
    </div>
  );
}

function Directory() {
  const [users, setUsers] = useState<Awaited<ReturnType<typeof api.users>>>([]);
  const [status, setStatus] = useState("");
  useEffect(() => {
    void api.users().then(setUsers);
  }, []);
  return (
    <div className="mt-6">
      <button
        className="rounded-full bg-navy text-white px-4 py-2 text-sm"
        onClick={async () => {
          setStatus("Syncing…");
          try {
            const res = await api.sync();
            setStatus(JSON.stringify(res));
            setUsers(await api.users());
          } catch (err) {
            setStatus(err instanceof Error ? err.message : String(err));
          }
        }}
      >
        Synchronise Entra / Google
      </button>
      {status && <p className="text-sm mt-2 text-slate-600">{status}</p>}
      <table className="mt-4 w-full text-sm bg-white border rounded-xl overflow-hidden">
        <thead className="bg-mist text-left">
          <tr>
            <th className="p-3">Name</th>
            <th>Email</th>
            <th>Title</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className="border-t border-line">
              <td className="p-3">{u.displayName}</td>
              <td>{u.email}</td>
              <td>{u.jobTitle}</td>
              <td>{u.domain}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Fields() {
  const [fields, setFields] = useState<Awaited<ReturnType<typeof api.fields>>>([]);
  useEffect(() => {
    void api.fields().then(setFields);
  }, []);
  return (
    <div className="mt-6 bg-white border rounded-xl p-5 max-w-xl">
      <p className="text-sm text-slate-600 mb-4">Users may edit only the fields you enable. Directory-sourced values remain the default until overridden.</p>
      {fields.map((f) => (
        <label key={f.key} className="flex items-center justify-between py-1 text-sm">
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
      <button
        className="mt-4 rounded-full bg-navy text-white px-4 py-2 text-sm"
        onClick={async () => {
          await api.saveFields(fields.filter((f) => f.userEditable).map((f) => f.key));
          alert("Saved");
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
  if (!data) return <p className="mt-4">Loading…</p>;
  return (
    <div className="mt-6 max-w-xl">
      <p className="text-sm text-slate-600">
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
        <input className="border rounded p-2 flex-1" placeholder="user@domain" value={email} onChange={(e) => setEmail(e.target.value)} />
        <select className="border rounded p-2" value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="owner">Owner</option>
          <option value="admin">Admin</option>
          <option value="editor">Editor</option>
          <option value="designer">Designer</option>
          <option value="user">User</option>
        </select>
        <button className="rounded-full bg-navy text-white px-4">Grant</button>
      </form>
      <ul className="mt-4 bg-white border rounded-xl divide-y">
        {data.roles.map((r) => (
          <li key={r.email} className="p-3 flex justify-between text-sm">
            <span>{r.email}</span>
            <span className="text-slate-500">{r.role}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
