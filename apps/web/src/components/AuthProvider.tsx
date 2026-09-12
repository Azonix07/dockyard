"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import type { Plan, User } from "@laptop-paas/shared";
import { api, clearToken, getToken, setToken } from "@/lib/api";

type AuthState = {
  user: User | null;
  plan: Plan | null;
  authKind: "user" | "admin" | null;
  loading: boolean;
  refresh: () => Promise<User | null>;
  loginWithToken: (token: string) => Promise<User>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [authKind, setAuthKind] = useState<"user" | "admin" | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setUser(null);
      setPlan(null);
      setAuthKind(null);
      setLoading(false);
      return null;
    }
    try {
      const res = await api<{
        user: User;
        plan: Plan;
        authKind?: "user" | "admin";
      }>("/api/auth/me");
      setUser(res.user);
      setPlan(res.plan);
      setAuthKind(res.authKind ?? (res.user.id === "admin" ? "admin" : "user"));
      setLoading(false);
      return res.user;
    } catch {
      clearToken();
      setUser(null);
      setPlan(null);
      setAuthKind(null);
      setLoading(false);
      return null;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loginWithToken = useCallback(
    async (token: string) => {
      setToken(token);
      const u = await refresh();
      if (!u) throw new Error("Session could not be established");
      return u;
    },
    [refresh],
  );

  const logout = useCallback(async () => {
    try {
      await api("/api/auth/logout", { method: "POST" });
    } catch {
      /* ignore */
    }
    clearToken();
    setUser(null);
    setPlan(null);
    setAuthKind(null);
  }, []);

  const value = useMemo(
    () => ({
      user,
      plan,
      authKind,
      loading,
      refresh,
      loginWithToken,
      logout,
    }),
    [user, plan, authKind, loading, refresh, loginWithToken, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

export function useRequireAuth(opts?: { requireOnboarding?: boolean }) {
  const auth = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (auth.loading) return;
    if (!auth.user) {
      router.replace("/login");
      return;
    }
    if (
      opts?.requireOnboarding !== false &&
      !auth.user.onboardingCompleted &&
      auth.user.id !== "admin" &&
      auth.authKind !== "admin"
    ) {
      router.replace("/onboarding/plan");
    }
  }, [auth.loading, auth.user, auth.authKind, opts?.requireOnboarding, router]);

  return auth;
}

export function useRequireAdmin() {
  const auth = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (auth.loading) return;
    if (!auth.user) {
      router.replace("/login");
      return;
    }
    if (auth.authKind !== "admin" && auth.user.id !== "admin") {
      router.replace("/dashboard");
    }
  }, [auth.loading, auth.user, auth.authKind, router]);

  return auth;
}
