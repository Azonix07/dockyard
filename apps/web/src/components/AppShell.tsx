"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/components/AuthProvider";
import { BrandLogo } from "@/components/Brand";

export function AppShell({
  children,
  title,
  actions,
}: {
  children: React.ReactNode;
  title?: string;
  actions?: React.ReactNode;
}) {
  const { user, plan, authKind, logout } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const isAdmin = authKind === "admin" || user?.id === "admin";

  async function onLogout() {
    await logout();
    router.replace("/login");
  }

  const link = (href: string, label: string) => {
    const active =
      href === "/dashboard"
        ? pathname.startsWith("/dashboard") ||
          pathname.startsWith("/project") ||
          pathname.startsWith("/new")
        : pathname.startsWith(href);
    return (
      <Link href={href} className={active ? "nav-link active" : "nav-link"}>
        {label}
      </Link>
    );
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-left">
          <Link href="/dashboard" className="logo">
            <BrandLogo />
          </Link>
          <nav className="nav">
            {link("/dashboard", "Projects")}
            {link("/databases", "Databases")}
            {link("/usage", "Usage")}
            {isAdmin ? link("/admin", "Admin") : null}
          </nav>
        </div>
        <div className="topbar-right">
          {isAdmin ? <span className="plan-chip admin">Super admin</span> : null}
          {plan && !isAdmin ? <span className="plan-chip">{plan.name}</span> : null}
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

export function Meter({ value, max = 100 }: { value: number; max?: number }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="meter" aria-hidden>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}
