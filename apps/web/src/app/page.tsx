"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/AuthProvider";

export default function HomePage() {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (user) {
      router.replace(
        user.onboardingCompleted || user.id === "admin"
          ? "/dashboard"
          : "/onboarding/plan",
      );
    }
  }, [user, loading, router]);

  return (
    <div className="landing">
      <nav className="landing-nav">
        <Link href="/" className="logo">
          <span className="logo-mark" aria-hidden />
          <span>Dockyard</span>
        </Link>
        <div className="cta-row">
          <Link href="/login" className="btn secondary">
            Log in
          </Link>
          <Link href="/signup" className="btn">
            Create account
          </Link>
        </div>
      </nav>
      <div className="landing-main">
        <section className="landing-copy">
          <div className="eyebrow">Self-hosted PaaS</div>
          <h1>Dockyard</h1>
          <p>
            Ship backends and datastores on hardware you own. Push to GitHub,
            watch metrics, and keep everything on your Tailscale network —
            Railway/Render workflow, cafe-laptop footprint.
          </p>
          <div className="cta-row">
            <Link href="/signup" className="btn">
              Create account
            </Link>
            <Link href="/login" className="btn secondary">
              Log in
            </Link>
          </div>
        </section>
        <aside className="landing-side">
          <div className="stat-tile">
            <div className="k">Deploy path</div>
            <div className="v">Git → build → live</div>
          </div>
          <div className="stat-tile">
            <div className="k">Datastores</div>
            <div className="v">Postgres · Redis · MySQL · Mongo · MinIO</div>
          </div>
          <div className="stat-tile">
            <div className="k">Observability</div>
            <div className="v">CPU · memory · deploy history</div>
          </div>
        </aside>
      </div>
    </div>
  );
}
