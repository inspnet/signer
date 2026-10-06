import { NavLink, Navigate, Outlet, useLocation, useNavigate } from "react-router-dom";
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
  { to: "/tester", label: "Rule Tester", icon: Sparkles, end: false },
  { to: "/analytics", label: "Activity", icon: BarChart3, end: false },
  { to: "/me", label: "My Details", icon: UserRound, end: false },
  { to: "/settings", label: "Settings", icon: Settings, end: false }
];

export function AppShell() {
  const { user, refresh } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const staff = user != null && user.role !== "user";
  const items = staff ? nav : nav.filter((item) => item.to === "/me");
  if (user?.role === "user" && location.pathname !== "/me") return <Navigate to="/me" replace />;
  const initials = (user?.name || user?.email || "U")
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="h-full flex bg-paper">
      <aside className="w-[248px] shrink-0 bg-white border-r border-line flex flex-col">
        <button className="flex items-center gap-3 px-6 h-20 text-left" onClick={() => navigate("/")}>
          <span className="h-9 w-9 rounded-xl bg-navy grid place-items-center text-white shadow-sm">
            <PenLine size={17} />
          </span>
          <span>
            <span className="block font-bold text-ink tracking-tight text-[15px]">Signer</span>
            <span className="block text-[11px] text-slate-500">Server-side signatures</span>
          </span>
        </button>
        <nav className="flex-1 px-4 py-2 space-y-1">
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors ${
                  isActive ? "bg-sky text-accent-2 font-semibold" : "text-slate-500 hover:bg-paper hover:text-ink"
                }`
              }
            >
              {({ isActive }) => (
                <>
                  <item.icon size={18} className={isActive ? "text-accent" : "text-slate-400"} />
                  {item.label}
                </>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="m-4 p-3 rounded-2xl bg-paper">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-full bg-navy text-white grid place-items-center text-xs font-semibold">{initials}</div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-ink truncate">{user?.name || "Admin"}</div>
              <div className="text-[11px] text-slate-500 truncate">{user?.email}</div>
            </div>
            <button
              className="text-slate-400 hover:text-ink"
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
        <div className="max-w-[1600px] mx-auto px-6 py-8 lg:px-10 lg:py-10">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
