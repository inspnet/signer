import { useEffect, useState } from "react";
import { api } from "../api/client";

export function CampaignsPage() {
  const [items, setItems] = useState<Awaited<ReturnType<typeof api.campaigns>>>([]);
  const [name, setName] = useState("Campaign banner");
  const [imageUrl, setImageUrl] = useState("");
  const [href, setHref] = useState("");

  const load = () => api.campaigns().then(setItems);
  useEffect(() => {
    void load();
  }, []);

  return (
    <div>
      <h1 className="text-3xl font-semibold">Campaigns</h1>
      <p className="text-slate-600 mt-2 max-w-3xl">
        Time-bound banners appended after the signature. Use date/time rules on each campaign so marketing can rotate
        promotions without editing every template.
      </p>
      <form
        className="mt-6 bg-white border border-line rounded-xl p-5 grid gap-3 max-w-xl"
        onSubmit={async (e) => {
          e.preventDefault();
          await api.saveCampaign({ name, imageUrl, href, enabled: true });
          setImageUrl("");
          await load();
        }}
      >
        <input className="border rounded p-2" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
        <input className="border rounded p-2" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="Banner image URL" />
        <input className="border rounded p-2" value={href} onChange={(e) => setHref(e.target.value)} placeholder="Click-through URL" />
        <button className="rounded-full bg-navy text-white px-4 py-2 text-sm w-fit">Create campaign</button>
      </form>
      <div className="mt-6 space-y-3">
        {items.map((c) => (
          <div key={c.id} className="bg-white border border-line rounded-xl p-4 flex justify-between items-center">
            <div>
              <div className="font-medium">{c.name}</div>
              <div className="text-sm text-slate-500">{c.enabled ? "Enabled" : "Disabled"}</div>
            </div>
            <button className="text-rose-600 text-sm" onClick={async () => { await api.deleteCampaign(c.id); await load(); }}>
              Delete
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
