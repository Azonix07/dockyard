"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/AuthProvider";
import { BrandLogo, PRODUCT_NAME } from "@/components/Brand";

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
          <BrandLogo />
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
          <h1>{PRODUCT_NAME}</h1>
          <p>
            Ship backends and datastores on hardware you own. Push to GitHub,
            watch metrics, and keep everything on your private network.
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
