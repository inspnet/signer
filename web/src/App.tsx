import type { ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./layouts/Auth";
import { AppShell } from "./layouts/AppShell";
import { LoginPage } from "./pages/LoginPage";
import { HomePage } from "./pages/HomePage";
import { SignaturesPage } from "./pages/SignaturesPage";
import { DesignerPage } from "./pages/DesignerPage";
import { RulesPage } from "./pages/RulesPage";
import { DisclaimersPage } from "./pages/DisclaimersPage";
import { CampaignsPage } from "./pages/CampaignsPage";
import { TesterPage } from "./pages/TesterPage";
import { AnalyticsPage } from "./pages/AnalyticsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { MyDetailsPage } from "./pages/MyDetailsPage";

function Guard({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="p-10 text-slate-500">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/"
          element={
            <Guard>
              <AppShell />
            </Guard>
          }
        >
          <Route index element={<HomePage />} />
          <Route path="signatures" element={<SignaturesPage />} />
          <Route path="signatures/:id/design" element={<DesignerPage />} />
          <Route path="signatures/:id/rules" element={<RulesPage />} />
          <Route path="disclaimers" element={<DisclaimersPage />} />
          <Route path="campaigns" element={<CampaignsPage />} />
          <Route path="tester" element={<TesterPage />} />
          <Route path="analytics" element={<AnalyticsPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="me" element={<MyDetailsPage />} />
        </Route>
      </Routes>
    </AuthProvider>
  );
}
