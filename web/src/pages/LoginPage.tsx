import { useEffect } from "react";
import { useAuth } from "../layouts/Auth";
import { api } from "../api/client";
import { useNavigate } from "react-router-dom";

export function LoginPage() {
  const { providers, user, refresh } = useAuth();
  const navigate = useNavigate();
  useEffect(() => {
    if (user) navigate("/", { replace: true });
  }, [user, navigate]);
  return (
    <div className="min-h-full grid place-items-center bg-navy">
      <div className="w-full max-w-md bg-white rounded-2xl p-8 shadow-xl">
        <div className="text-2xl font-semibold text-ink">Signer</div>
        <p className="mt-2 text-slate-600 text-sm leading-6">
          Self-hosted, server-side email signatures for Microsoft 365 and Google Workspace. Sign in with your organisation
          directory. Mail is processed on this instance — it never goes to a third-party SaaS.
        </p>
        <div className="mt-6 flex flex-col gap-3">
          {providers.entra && (
            <a className="rounded-full bg-navy text-white text-center py-2.5 text-sm font-medium" href="/api/auth/entra/start">
              Continue with Microsoft
            </a>
          )}
          {providers.google && (
            <a className="rounded-full border border-line text-center py-2.5 text-sm font-medium" href="/api/auth/google/start">
              Continue with Google
            </a>
          )}
          {providers.dev && (
            <button
              className="rounded-full bg-mist py-2.5 text-sm"
              onClick={async () => {
                await api.devLogin();
                await refresh();
                navigate("/");
              }}
            >
              Continue as super admin (demo)
            </button>
          )}
          {!providers.entra && !providers.google && !providers.dev && (
            <p className="text-sm text-rose-600">
              Configure Entra ID or Google OAuth, or enable DEMO_MODE with AUTH_ALLOW_DEV_LOGIN for a local lab.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
