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
          <span className="logo-text">Dockyard</span>
        </Link>
        <div className="cta-row">
          <Link href="/login" className="btn secondary">
            Log in
          </Link>
          <Link href="/signup" className="btn">
            Start for free
          </Link>
        </div>
      </nav>
      <section className="landing-hero">
        <h1 className="brand-hero">Dockyard</h1>
        <p>
          Instantly deploy backends and databases on your own machine — the
          Railway-style workflow for a cafe laptop on Tailscale.
        </p>
        <div className="cta-row">
          <Link href="/signup" className="btn">
            Create account
          </Link>
          <Link href="/login" className="btn secondary">
            I already have an account
          </Link>
        </div>
      </section>
    </div>
  );
}
