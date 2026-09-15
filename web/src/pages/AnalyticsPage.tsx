import { useEffect, useState } from "react";
import { api } from "../api/client";
import { PageHeader } from "../components/PageHeader";

export function AnalyticsPage() {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.analytics>> | null>(null);
  useEffect(() => {
    void api.analytics().then(setData);
  }, []);
  if (!data) return <p className="text-stone-500">Loading…</p>;
  return (
    <div>
      <PageHeader kicker="Activity" title="Mail log" description="Message metadata only — Signer does not retain email bodies after processing." />
      <div className="grid grid-cols-3 gap-4 mt-8">
        {[
          ["Processed (24h)", data.processed24h],
          ["Signed (24h)", data.signed24h],
          ["Errors (24h)", data.failed24h]
        ].map(([k, v]) => (
          <div key={String(k)} className="panel p-5">
            <div className="text-sm text-stone-500">{k}</div>
            <div className="display text-4xl mt-1">{v}</div>
          </div>
        ))}
      </div>
      <div className="mt-6 panel overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-mist text-left text-stone-500">
            <tr>
              <th className="p-3 font-medium">When</th>
              <th className="font-medium">Sender</th>
              <th className="font-medium">Subject</th>
              <th className="font-medium">Status</th>
              <th className="font-medium">ms</th>
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
            {data.recent.length === 0 && (
              <tr>
                <td className="p-4 text-stone-500" colSpan={5}>
                  No messages yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
