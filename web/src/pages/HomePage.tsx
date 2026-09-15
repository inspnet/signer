import { useEffect, useState } from "react";
import { api } from "../api/client";
import { Link } from "react-router-dom";

export function HomePage() {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.home>> | null>(null);
  useEffect(() => {
    void api.home().then(setData);
  }, []);
  if (!data) return <p>Loading…</p>;
  const cards = [
    { label: "Processed (24h)", value: data.stats.processed24h },
    { label: "Signed (24h)", value: data.stats.signed24h },
    { label: "Signatures", value: data.signatures },
    { label: "Directory users", value: data.users }
  ];
  return (
    <div>
      <h1 className="text-3xl font-semibold text-ink">Home</h1>
      <p className="mt-2 text-slate-600 max-w-3xl">
        Signer applies signatures and legal disclaimers in the mail flow after the user clicks Send. That works for Outlook,
        Gmail, and iOS Mail — senders cannot remove the block, and mail stays in your Microsoft or Google environment plus
        this host.
      </p>
      <div className="grid grid-cols-4 gap-4 mt-8">
        {cards.map((c) => (
          <div key={c.label} className="bg-white rounded-xl border border-line p-5">
            <div className="text-sm text-slate-500">{c.label}</div>
            <div className="text-3xl font-semibold mt-2">{c.value}</div>
          </div>
        ))}
      </div>
      <div className="mt-8 flex gap-3">
        <Link to="/signatures" className="rounded-full bg-navy text-white px-4 py-2 text-sm">
          Manage signatures
        </Link>
        <Link to="/settings" className="rounded-full border border-line px-4 py-2 text-sm bg-white">
          Connect mail flow
        </Link>
      </div>
      <h2 className="mt-10 font-medium">Recent processing</h2>
      <div className="mt-3 bg-white border border-line rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-mist text-left text-slate-500">
            <tr>
              <th className="p-3">When</th>
              <th>Sender</th>
              <th>Subject</th>
              <th>Status</th>
              <th>ms</th>
            </tr>
          </thead>
          <tbody>
            {data.stats.recent.length === 0 && (
              <tr>
                <td className="p-3 text-slate-500" colSpan={5}>
                  No messages processed yet. Point Exchange or Google connectors at this host to start.
                </td>
              </tr>
            )}
            {data.stats.recent.map((r, i) => (
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
    </div>
  );
}
