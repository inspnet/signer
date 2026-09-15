import type { ReactNode } from "react";

export function PageHeader({
  kicker,
  title,
  description,
  actions
}: {
  kicker?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-end justify-between gap-4 flex-wrap">
      <div>
        {kicker && <p className="text-xs uppercase tracking-[0.16em] text-accent-2 font-semibold">{kicker}</p>}
        <h1 className="display text-4xl mt-1">{title}</h1>
        {description && <p className="text-stone-600 mt-2 max-w-3xl leading-7">{description}</p>}
      </div>
      {actions ? <div className="flex gap-2">{actions}</div> : null}
    </div>
  );
}
