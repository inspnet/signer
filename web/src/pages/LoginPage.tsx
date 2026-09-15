import { useEffect } from "react";
import { useAuth } from "../layouts/Auth";
import { api } from "../api/client";
import { useNavigate } from "react-router-dom";
import { PenLine } from "lucide-react";

export function LoginPage() {
  const { providers, user, refresh } = useAuth();
  const navigate = useNavigate();
  useEffect(() => {
    if (user) navigate("/", { replace: true });
  }, [user, navigate]);
  return (
    <div className="min-h-full grid lg:grid-cols-2">
      <div className="hidden lg:flex flex-col justify-between bg-ink text-[#e7e0d4] p-12">
        <div className="flex items-center gap-3 text-white">
          <span className="h-10 w-10 rounded-xl bg-accent grid place-items-center">
            <PenLine size={18} />
          </span>
          <span className="text-lg font-semibold">Signer</span>
        </div>
        <div>
          <h1 className="display text-5xl text-white leading-[1.1] max-w-md">Stamp every send, on your own metal.</h1>
          <p className="mt-5 max-w-md text-stone-400 leading-7">
            Signatures and legal notices are applied in Microsoft 365 or Google Workspace mail flow. Nothing is pushed into
            Outlook or iOS Mail, and mail never leaves your tenant plus this host.
          </p>
        </div>
        <p className="text-xs text-stone-500">Self-hosted · Entra ID · Google Workspace</p>
      </div>
      <div className="grid place-items-center p-8">
        <div className="w-full max-w-sm">
          <h2 className="display text-3xl">Sign in</h2>
          <p className="mt-2 text-sm text-stone-600 leading-6">Use your organisation directory. Demo mode is for labs only.</p>
          <div className="mt-8 flex flex-col gap-3">
            {providers.entra && (
              <a className="btn btn-primary w-full" href="/api/auth/entra/start">
                Continue with Microsoft
              </a>
            )}
            {providers.google && (
              <a className="btn btn-ghost w-full" href="/api/auth/google/start">
                Continue with Google
              </a>
            )}
            {providers.dev && (
              <button
                className="btn btn-primary w-full"
                onClick={async () => {
                  await api.devLogin();
                  await refresh();
                  navigate("/");
                }}
              >
                Open demo as super admin
              </button>
            )}
            {!providers.entra && !providers.google && !providers.dev && (
              <p className="text-sm text-rose-700">Set Entra or Google OAuth, or enable DEMO_MODE for a lab login.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
