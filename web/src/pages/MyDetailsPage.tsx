import { useEffect, useState } from "react";
import { api } from "../api/client";
import { PageHeader } from "../components/PageHeader";

export function MyDetailsPage() {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.myDetails>> | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");

  useEffect(() => {
    void api.myDetails().then((d) => {
      setData(d);
      setDraft((d.user as Record<string, string>) || {});
    });
  }, []);

  if (!data) return <p className="text-stone-500">Loading…</p>;
  if (!data.user) {
    return (
      <div>
        <PageHeader kicker="You" title="My details" />
        <p className="mt-3 text-stone-600">
          Your account is not in the cached directory yet. Ask an admin to run a directory sync, or sign in with the same email as your
          mailbox.
        </p>
      </div>
    );
  }

  const sections = ["personal", "contact", "address", "social", "custom"];
  return (
    <div className="max-w-2xl">
      <PageHeader
        kicker="You"
        title="My details"
        description="You can change only the fields your administrators have unlocked. Directory-managed fields stay read-only."
      />
      {sections.map((section) => {
        const fields = data.fields.filter((f) => f.section === section);
        if (!fields.length) return null;
        return (
          <div key={section} className="mt-6 panel p-5">
            <h2 className="font-medium capitalize mb-3">{section}</h2>
            <div className="grid gap-3">
              {fields.map((f) => (
                <label key={f.key} className="text-sm">
                  {f.label}
                  <input
                    className="input mt-1 disabled:bg-mist"
                    disabled={!f.userEditable}
                    value={draft[f.key] ?? ""}
                    onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                  />
                </label>
              ))}
            </div>
          </div>
        );
      })}
      <button
        className="mt-6 btn btn-primary"
        onClick={async () => {
          const editable = Object.fromEntries(data.fields.filter((f) => f.userEditable).map((f) => [f.key, draft[f.key] ?? ""]));
          await api.saveMyDetails(editable);
          setMessage("Saved — the next email you send will use these values.");
        }}
      >
        Save my details
      </button>
      {message && <p className="text-sm text-teal-800 mt-2">{message}</p>}
    </div>
  );
}
