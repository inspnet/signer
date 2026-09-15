import { useEffect, useState } from "react";
import { api } from "../api/client";
import { PageHeader } from "../components/PageHeader";

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
      <PageHeader
        kicker="Marketing"
        title="Campaigns"
        description="Time-bound banners appended after the signature. Rotate promotions without editing every template."
      />
      <form
        className="mt-8 panel p-5 grid gap-3 max-w-xl"
        onSubmit={async (e) => {
          e.preventDefault();
          await api.saveCampaign({ name, imageUrl, href, enabled: true });
          setImageUrl("");
          await load();
        }}
      >
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
        <input className="input" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="Banner image URL" />
        <input className="input" value={href} onChange={(e) => setHref(e.target.value)} placeholder="Click-through URL" />
        <button className="btn btn-primary w-fit">Create campaign</button>
      </form>
      <div className="mt-6 space-y-3 max-w-xl">
        {items.map((c) => (
          <div key={c.id} className="panel p-4 flex justify-between items-center">
            <div>
              <div className="font-medium">{c.name}</div>
              <div className="text-sm text-stone-500">{c.enabled ? "Enabled" : "Disabled"}</div>
            </div>
            <button
              className="text-rose-700 text-sm"
              onClick={async () => {
                await api.deleteCampaign(c.id);
                await load();
              }}
            >
              Delete
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
