import { NavLink, Outlet, useNavigate } from "react-router-dom";
import {
  BarChart3,
  FileText,
  FolderKanban,
  HelpCircle,
  Home,
  Image,
  LayoutTemplate,
  Search,
  Settings,
  Shield,
  Sparkles,
  UserRound
} from "lucide-react";
import { api } from "../api/client";
import { useAuth } from "./Auth";

const nav = [
  { to: "/", label: "Home", icon: Home },
  { to: "/signatures", label: "Signatures", icon: LayoutTemplate },
  { to: "/campaigns", label: "Campaigns", icon: Image },
  { to: "/disclaimers", label: "Disclaimers", icon: Shield },
  { to: "/tester", label: "Signatures Tester", icon: Sparkles },
  { to: "/analytics", label: "Analytics", icon: BarChart3 },
  { to: "/me", label: "My details", icon: UserRound },
  { to: "/settings", label: "Mail flow & settings", icon: Settings }
];

export function AppShell() {
  const { user, refresh } = useAuth();
  const navigate = useNavigate();
  const initials = (user?.name || user?.email || "U")
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="min-h-full flex flex-col">
      <header className="h-14 bg-navy text-white flex items-center gap-4 px-4 shrink-0">
        <div className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-white/10 text-indigo-200">
            <FileText size={18} />
          </span>
          Signer
        </div>
        <div className="flex-1 max-w-xl mx-auto">
          <label className="flex items-center gap-2 bg-white/10 rounded-full px-3 py-1.5 text-sm text-white/80">
            <Search size={16} />
            <input className="bg-transparent outline-none w-full placeholder:text-white/50" placeholder="Signature Search" />
          </label>
        </div>
        <button className="text-white/80 hover:text-white" title="Help">
          <HelpCircle size={18} />
        </button>
        <button
          className="h-8 w-8 rounded-full bg-indigo-300 text-navy text-xs font-bold"
          title={user?.email}
          onClick={async () => {
            await api.logout();
            await refresh();
            navigate("/login");
          }}
        >
          {initials}
        </button>
      </header>
      <div className="flex flex-1 min-h-0">
        <aside className="w-56 bg-white border-r border-line pt-4">
          <nav className="flex flex-col gap-0.5 px-2">
            {nav.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === "/"}
                className={({ isActive }) =>
                  `flex items-center gap-3 rounded-lg px-3 py-2 text-sm ${isActive ? "bg-mist text-indigo-700 font-medium" : "text-slate-600 hover:bg-mist"}`
                }
              >
                <item.icon size={16} />
                {item.label}
              </NavLink>
            ))}
            <div className="px-3 pt-6 text-[11px] uppercase tracking-wide text-slate-400 flex items-center gap-2">
              <FolderKanban size={12} /> Server-side only
            </div>
          </nav>
        </aside>
        <main className="flex-1 overflow-auto p-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
