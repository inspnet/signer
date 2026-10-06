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
        {kicker && <p className="text-xs uppercase tracking-[0.14em] text-slate-400 font-semibold">{kicker}</p>}
        <h1 className="text-[28px] leading-9 font-bold tracking-tight text-ink mt-1">{title}</h1>
        {description && <p className="text-slate-500 mt-2 max-w-3xl text-[15px] leading-7">{description}</p>}
      </div>
      {actions ? <div className="flex gap-2">{actions}</div> : null}
    </div>
  );
}
