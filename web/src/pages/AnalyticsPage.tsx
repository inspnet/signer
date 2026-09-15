import { useEffect, useState } from "react";
import { api } from "../api/client";

export function AnalyticsPage() {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.analytics>> | null>(null);
  useEffect(() => {
    void api.analytics().then(setData);
  }, []);
  if (!data) return <p>Loading…</p>;
  return (
    <div>
      <h1 className="text-3xl font-semibold">Analytics</h1>
      <p className="text-slate-600 mt-2">Message metadata only — Signer does not retain email bodies after processing.</p>
      <div className="grid grid-cols-3 gap-4 mt-6">
        {[
          ["Processed (24h)", data.processed24h],
          ["Signed (24h)", data.signed24h],
          ["Errors (24h)", data.failed24h]
        ].map(([k, v]) => (
          <div key={String(k)} className="bg-white border border-line rounded-xl p-5">
            <div className="text-sm text-slate-500">{k}</div>
            <div className="text-3xl font-semibold mt-1">{v}</div>
          </div>
        ))}
      </div>
      <table className="mt-6 w-full text-sm bg-white border border-line rounded-xl overflow-hidden">
        <thead className="bg-mist text-left">
          <tr>
            <th className="p-3">When</th>
            <th>Sender</th>
            <th>Subject</th>
            <th>Status</th>
            <th>ms</th>
          </tr>
        </thead>
        <tbody>
          {data.recent.map((r, i) => (
            <tr key={i} className="border-t border-line">
              <td className="p-3">{new Date(r.receivedAt).toLocaleString()}</td>
              <td>{r.sender}</td>
              <td>{r.subject}</td>
              <td>{r.status}</td>
              <td>{r.processingMs}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
