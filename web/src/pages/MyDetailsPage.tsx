import { useEffect, useState } from "react";
import { api } from "../api/client";
import { PageHeader } from "../components/PageHeader";

export function MyDetailsPage() {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.myDetails>> | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [hidden, setHidden] = useState<string[]>([]);
  const [message, setMessage] = useState("");

  useEffect(() => {
    void api.myDetails().then((d) => {
      setData(d);
      setDraft((d.user as Record<string, string>) || {});
      setHidden(d.hiddenFields);
    });
  }, []);

  if (!data) return <p className="text-slate-500">Loading…</p>;
  if (!data.user) {
    return (
      <div>
        <PageHeader kicker="You" title="My Details" />
        <p className="mt-3 text-slate-600">
          Your account is not in the cached directory yet. Ask an admin to run a directory sync, or sign in with the same email as your
          mailbox.
        </p>
      </div>
    );
  }

  const sections = ["personal", "contact", "address", "social", "custom"];
  return (
    <div>
      <PageHeader
        kicker="You"
        title="My Details"
        description="You can change only the fields your administrators have unlocked. Directory-managed fields stay read-only. Where allowed, untick Show in my signature to leave a field out."
      />
      <div className="mt-6 grid gap-6 xl:grid-cols-2 items-start">
        {sections.map((section) => {
          const fields = data.fields.filter((f) => f.section === section);
          if (!fields.length) return null;
          return (
            <div key={section} className="panel p-5">
              <h2 className="font-medium capitalize mb-3">{section}</h2>
              <div className="grid gap-3 sm:grid-cols-2">
                {fields.map((f) => {
                  const isHidden = f.userHideable && hidden.includes(f.key);
                  return (
                    <div key={f.key} className="text-sm">
                      <label className="block">
                        {f.label}
                        <input
                          className={`input mt-1 disabled:bg-mist ${isHidden ? "text-slate-400 line-through" : ""}`}
                          disabled={!f.userEditable}
                          value={draft[f.key] ?? ""}
                          onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                        />
                      </label>
                      {f.userHideable && (
                        <label className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
                          <input
                            type="checkbox"
                            checked={!isHidden}
                            onChange={(e) => setHidden(e.target.checked ? hidden.filter((k) => k !== f.key) : [...hidden, f.key])}
                          />
                          Show in my signature
                        </label>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <button
        className="mt-6 btn btn-primary"
        onClick={async () => {
          const editable = Object.fromEntries(data.fields.filter((f) => f.userEditable).map((f) => [f.key, draft[f.key] ?? ""]));
          await api.saveMyDetails(editable, hidden);
          setMessage("Saved — the next email you send will use these values.");
        }}
      >
        Save my details
      </button>
      {message && <p className="text-sm text-emerald-700 mt-2">{message}</p>}
    </div>
  );
}
