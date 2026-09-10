"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/components/AuthProvider";

export function AppShell({
  children,
  title,
  actions,
}: {
  children: React.ReactNode;
  title?: string;
  actions?: React.ReactNode;
}) {
  const { user, plan, logout } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  async function onLogout() {
    await logout();
    router.replace("/login");
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-left">
          <Link href="/dashboard" className="logo">
            <span className="logo-mark" aria-hidden />
            <span className="logo-text">Dockyard</span>
          </Link>
          <nav className="nav">
            <Link
              href="/dashboard"
              className={pathname.startsWith("/dashboard") || pathname.startsWith("/project") || pathname.startsWith("/new") ? "nav-link active" : "nav-link"}
            >
              Projects
            </Link>
            <Link
              href="/databases"
              className={pathname.startsWith("/databases") ? "nav-link active" : "nav-link"}
            >
              Databases
            </Link>
          </nav>
        </div>
        <div className="topbar-right">
          {plan ? <span className="plan-chip">{plan.name}</span> : null}
          <span className="user-chip">{user?.email}</span>
          <button className="btn ghost" type="button" onClick={() => void onLogout()}>
            Log out
          </button>
        </div>
      </header>
      {(title || actions) && (
        <div className="page-head">
          <h1>{title}</h1>
          <div className="page-actions">{actions}</div>
        </div>
      )}
      <main className="page-body">{children}</main>
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return <span className={`status-badge ${status}`}>{status}</span>;
}
