import { useState } from "react";
import { api } from "../api/client";
import { HtmlFrame } from "../components/HtmlFrame";
import { PageHeader } from "../components/PageHeader";
import { useAuth } from "../layouts/Auth";

type Result = {
  signature: { id: string; name: string; html: string } | null;
  disclaimers: Array<{ id: string; name: string }>;
  campaigns: Array<{ id: string; name: string }>;
  details: Array<{
    kind: string;
    id: string;
    name: string;
    applied: boolean;
    checks: Array<{ name: string; applicable: boolean; passed: boolean; detail: string }>;
  }>;
  htmlPreview: string;
};

export function TesterPage() {
  const { user } = useAuth();
  const [from, setFrom] = useState(user?.email ?? "");
  const [to, setTo] = useState("ada@contoso.com");
  const [subject, setSubject] = useState("Project update");
  const [body, setBody] = useState("Hello, please see the attached update.");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");
  const [sendState, setSendState] = useState<{ busy: boolean; message: string; ok: boolean }>({ busy: false, message: "", ok: true });
  const canSend = user && ["super_admin", "owner", "admin", "editor", "designer"].includes(user.role);

  return (
    <div>
      <PageHeader
        kicker="Lab"
        title="Rule Tester"
        description="Simulates server-side evaluation in signature order. Send test emails the result to your own mailbox."
      />
      <div className="mt-8 grid lg:grid-cols-2 gap-6">
        <form
          className="panel p-5 space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setError("");
            try {
              setResult((await api.tester({ from, to, subject, body })) as Result);
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            }
          }}
        >
          <label className="block text-sm">
            From
            <input className="input mt-1" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="block text-sm">
            To
            <input className="input mt-1" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <label className="block text-sm">
            Subject
            <input className="input mt-1" value={subject} onChange={(e) => setSubject(e.target.value)} />
          </label>
          <label className="block text-sm">
            Body
            <textarea className="input mt-1 h-28" value={body} onChange={(e) => setBody(e.target.value)} />
          </label>
          <div className="flex gap-2">
            <button className="btn btn-primary">Test</button>
            {canSend && (
              <button
                type="button"
                className="btn btn-ghost"
                disabled={sendState.busy}
                title={`Emails what ${to || "the recipient"} would receive to ${user?.email}`}
                onClick={async () => {
                  setSendState({ busy: true, message: "Sending…", ok: true });
                  try {
                    const sent = await api.sendTest({ from, to, subject, body });
                    setSendState({
                      busy: false,
                      ok: true,
                      message: `Sent to ${sent.sentTo}${sent.signature ? ` with "${sent.signature}"` : " (no signature matched)"}. It may take a minute to arrive.`
                    });
                  } catch (err) {
                    setSendState({ busy: false, ok: false, message: err instanceof Error ? err.message : String(err) });
                  }
                }}
              >
                Send test to me
              </button>
            )}
          </div>
          {error && <p className="text-rose-700 text-sm">{error}</p>}
          {sendState.message && (
            <p className={`text-sm ${sendState.ok ? "text-emerald-700" : "text-rose-700"}`}>{sendState.message}</p>
          )}
          {canSend && (
            <p className="text-xs text-slate-500">
              Send test delivers the result to <strong>{user?.email}</strong> only, through the same return path real mail
              uses, from the address in From.
            </p>
          )}
        </form>
        <div className="panel p-5">
          {!result && <p className="text-slate-500 text-sm">Run a test to see which signature, campaigns, and disclaimers apply.</p>}
          {result && (
            <>
              <div className="text-sm mb-3">
                Applied signature: <strong>{result.signature?.name || "None"}</strong>
              </div>
              <HtmlFrame html={result.htmlPreview} className="w-full h-64 border border-line rounded-lg bg-white" />
              <div className="mt-4 space-y-2">
                {result.details.map((d) => (
                  <details key={d.id} className="border border-line rounded-lg p-2 text-sm">
                    <summary className={d.applied ? "text-emerald-700" : "text-slate-600"}>
                      {d.kind}: {d.name} — {d.applied ? "applied" : "not applied"}
                    </summary>
                    <ul className="mt-2 space-y-1">
                      {d.checks.map((c) => (
                        <li key={c.name} className={c.applicable && !c.passed ? "text-amber-800" : ""}>
                          {c.applicable ? (c.passed ? "✓" : "✗") : "–"} {c.name}: {c.detail}
                        </li>
                      ))}
                    </ul>
                  </details>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
