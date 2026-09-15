import { NavLink, Outlet, useNavigate } from "react-router-dom";
import {
  BarChart3,
  Home,
  Image,
  LayoutTemplate,
  LogOut,
  PenLine,
  Settings,
  Shield,
  Sparkles,
  UserRound
} from "lucide-react";
import { api } from "../api/client";
import { useAuth } from "./Auth";

const nav = [
  { to: "/", label: "Overview", icon: Home, end: true },
  { to: "/signatures", label: "Signatures", icon: LayoutTemplate, end: false },
  { to: "/campaigns", label: "Campaigns", icon: Image, end: false },
  { to: "/disclaimers", label: "Disclaimers", icon: Shield, end: false },
  { to: "/tester", label: "Rule tester", icon: Sparkles, end: false },
  { to: "/analytics", label: "Activity", icon: BarChart3, end: false },
  { to: "/me", label: "My details", icon: UserRound, end: false },
  { to: "/settings", label: "Mail flow", icon: Settings, end: false }
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
    <div className="min-h-full flex bg-paper">
      <aside className="w-[232px] shrink-0 bg-ink text-[#e7e0d4] flex flex-col">
        <button className="flex items-center gap-3 px-5 h-16 text-left" onClick={() => navigate("/")}>
          <span className="h-8 w-8 rounded-lg bg-accent grid place-items-center text-white">
            <PenLine size={16} />
          </span>
          <span>
            <span className="block font-semibold text-white tracking-tight">Signer</span>
            <span className="block text-[11px] text-stone-400">Server-side mail</span>
          </span>
        </button>
        <nav className="flex-1 px-3 py-2 space-y-0.5">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-lg px-3 py-2 text-sm ${isActive ? "bg-white/10 text-white" : "text-stone-400 hover:bg-white/5 hover:text-white"}`
              }
            >
              <item.icon size={16} />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="p-4 border-t border-white/10">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-accent/30 text-white grid place-items-center text-xs font-semibold">
              {initials}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm text-white truncate">{user?.name || "Admin"}</div>
              <div className="text-[11px] text-stone-500 truncate">{user?.email}</div>
            </div>
            <button
              className="text-stone-500 hover:text-white"
              title="Sign out"
              onClick={async () => {
                await api.logout();
                await refresh();
                navigate("/login");
              }}
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>
      <main className="flex-1 overflow-auto">
        <div className="max-w-6xl mx-auto px-8 py-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
