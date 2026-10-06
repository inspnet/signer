import { useEffect, useState } from "react";
import { api } from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { MailLogTable } from "../components/MailLogTable";

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
          ["Problems (24h)", data.failed24h]
        ].map(([k, v]) => (
          <div key={String(k)} className="panel p-5">
            <div className="text-sm text-stone-500">{k}</div>
            <div className="display text-4xl mt-1">{v}</div>
          </div>
        ))}
      </div>
      <p className="mt-6 text-sm text-stone-600 leading-6">
        <strong>Unsigned</strong> means the message was delivered without a signature; <strong>Deferred</strong> means it could not
        be handed back yet, so Microsoft 365 or Google keep it and retry. Each says why underneath.
      </p>
      <div className="mt-3">
        <MailLogTable rows={data.recent} empty="No messages yet." />
      </div>
    </div>
  );
}
