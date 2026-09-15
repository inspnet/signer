import { useState } from "react";
import { api } from "../api/client";
import { PageHeader } from "../components/PageHeader";

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
      <PageHeader
        kicker="Lab"
        title="Rule tester"
        description="Simulates server-side evaluation in signature order. This does not send mail."
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
          <button className="btn btn-primary">Test</button>
          {error && <p className="text-rose-700 text-sm">{error}</p>}
        </form>
        <div className="panel p-5">
          {!result && <p className="text-stone-500 text-sm">Run a test to see which signature, campaigns, and disclaimers apply.</p>}
          {result && (
            <>
              <div className="text-sm mb-3">
                Applied signature: <strong>{result.signature?.name || "None"}</strong>
              </div>
              <div className="border border-line rounded-lg p-3 bg-white" dangerouslySetInnerHTML={{ __html: result.htmlPreview }} />
              <div className="mt-4 space-y-2">
                {result.details.map((d) => (
                  <details key={d.id} className="border border-line rounded-lg p-2 text-sm">
                    <summary className={d.applied ? "text-teal-800" : "text-stone-600"}>
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
