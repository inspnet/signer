import { useEffect, useState } from "react";
import { api } from "../api/client";
import { Link } from "react-router-dom";
import { MailLogTable } from "../components/MailLogTable";

export function HomePage() {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.home>> | null>(null);
  useEffect(() => {
    void api.home().then(setData);
  }, []);
  if (!data) return <p className="text-stone-500">Loading…</p>;
  const cards = [
    { label: "Processed, 24h", value: data.stats.processed24h },
    { label: "Signed, 24h", value: data.stats.signed24h },
    { label: "Templates", value: data.signatures },
    { label: "Directory people", value: data.users }
  ];
  return (
    <div>
      <p className="text-xs uppercase tracking-[0.16em] text-accent-2 font-semibold">Overview</p>
      <h1 className="display text-4xl mt-1">Today’s mail</h1>
      <p className="mt-3 text-stone-600 max-w-2xl leading-7">
        Signer stamps signatures after send, inside your Exchange or Google routing. Senders cannot remove them, including
        on iOS Mail.
      </p>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mt-8">
        {cards.map((c) => (
          <div key={c.label} className="panel p-5">
            <div className="text-sm text-stone-500">{c.label}</div>
            <div className="display text-4xl mt-2">{c.value}</div>
          </div>
        ))}
      </div>
      <div className="mt-8 flex gap-3">
        <Link to="/signatures" className="btn btn-primary">
          Open templates
        </Link>
        <Link to="/settings" className="btn btn-ghost">
          Connect mail flow
        </Link>
      </div>
      <h2 className="mt-12 text-lg font-semibold">Recent processing</h2>
      <div className="mt-3">
        <MailLogTable rows={data.stats.recent.slice(0, 10)} empty="No messages yet. Point Exchange or Google connectors at this host." />
      </div>
    </div>
  );
}
