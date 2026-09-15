import { useState } from "react";
import { api } from "../api/client";

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
  const [from, setFrom] = useState("scott@inspired.co");
  const [to, setTo] = useState("ada@contoso.com");
  const [subject, setSubject] = useState("Project update");
  const [body, setBody] = useState("Hello, please see the attached update.");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");

  return (
    <div>
      <h1 className="text-3xl font-semibold">Signatures Tester</h1>
      <p className="text-slate-600 mt-2 max-w-3xl">
        Simulates server-side evaluation in signature order. This does not send mail and does not evaluate Exchange or
        Google routing rules outside Signer.
      </p>
      <div className="mt-6 grid grid-cols-2 gap-6">
        <form
          className="bg-white border border-line rounded-xl p-5 space-y-3"
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
          <label className="block text-sm">From
            <input className="block border rounded p-2 w-full mt-1" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="block text-sm">To
            <input className="block border rounded p-2 w-full mt-1" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <label className="block text-sm">Subject
            <input className="block border rounded p-2 w-full mt-1" value={subject} onChange={(e) => setSubject(e.target.value)} />
          </label>
          <label className="block text-sm">Body
            <textarea className="block border rounded p-2 w-full mt-1 h-28" value={body} onChange={(e) => setBody(e.target.value)} />
          </label>
          <button className="rounded-full bg-navy text-white px-4 py-2 text-sm">Test</button>
          {error && <p className="text-rose-600 text-sm">{error}</p>}
        </form>
        <div className="bg-white border border-line rounded-xl p-5">
          {!result && <p className="text-slate-500 text-sm">Run a test to see which signature, campaigns, and disclaimers apply.</p>}
          {result && (
            <>
              <div className="text-sm mb-3">
                Applied signature: <strong>{result.signature?.name || "None"}</strong>
              </div>
              <div className="border rounded p-3" dangerouslySetInnerHTML={{ __html: result.htmlPreview }} />
              <div className="mt-4 space-y-2">
                {result.details.map((d) => (
                  <details key={d.id} className="border rounded p-2 text-sm">
                    <summary className={d.applied ? "text-emerald-700" : "text-slate-600"}>
                      {d.kind}: {d.name} — {d.applied ? "applied" : "not applied"}
                    </summary>
                    <ul className="mt-2 space-y-1">
                      {d.checks.map((c) => (
                        <li key={c.name} className={c.applicable && !c.passed ? "text-amber-700" : ""}>
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
