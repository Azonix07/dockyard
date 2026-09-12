"use client";

import { Suspense } from "react";
import NewProjectClient from "./NewProjectClient";

export default function NewProjectPage() {
  return (
    <Suspense fallback={<div className="auth-wrap muted">Loading…</div>}>
      <NewProjectClient />
    </Suspense>
  );
}
