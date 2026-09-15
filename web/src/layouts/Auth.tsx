import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, type SessionUser } from "../api/client";

type AuthState = {
  user: SessionUser | null;
  loading: boolean;
  providers: { entra: boolean; google: boolean; dev: boolean };
  refresh: () => Promise<void>;
};

const Ctx = createContext<AuthState>({
  user: null,
  loading: true,
  providers: { entra: false, google: false, dev: false },
  refresh: async () => undefined
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [providers, setProviders] = useState({ entra: false, google: false, dev: false });

  const refresh = async () => {
    const data = await api.bootstrap();
    setUser(data.user);
    setProviders(data.providers);
    setLoading(false);
  };

  useEffect(() => {
    void refresh();
  }, []);

  return <Ctx.Provider value={{ user, loading, providers, refresh }}>{children}</Ctx.Provider>;
}

export function useAuth() {
  return useContext(Ctx);
}
