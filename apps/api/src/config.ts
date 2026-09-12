export const config = {
  port: Number(process.env.PORT ?? 8080),
  databaseUrl: process.env.DATABASE_URL ?? "",
  adminToken: process.env.ADMIN_TOKEN ?? "",
  webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:3000",
  publicHost: process.env.PUBLIC_HOST ?? "localhost",
  dataDir: process.env.DATA_DIR ?? "/var/lib/laptop-paas",
  defaultMemory: Number(process.env.DEFAULT_MEMORY_LIMIT ?? 536870912),
  defaultCpu: Number(process.env.DEFAULT_CPU_NANO ?? 1_000_000_000),
  githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET ?? "",
  githubToken: process.env.GITHUB_TOKEN ?? "",
  githubAppId: process.env.GITHUB_APP_ID ?? "",
  githubAppPrivateKey: (process.env.GITHUB_APP_PRIVATE_KEY ?? "").replace(
    /\\n/g,
    "\n",
  ),
  githubAppInstallationId: process.env.GITHUB_APP_INSTALLATION_ID ?? "",
  githubClientId: process.env.GITHUB_CLIENT_ID ?? "",
  githubClientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
  /** Public API base used in OAuth callback (e.g. https://host:8444). Falls back to request host. */
  githubOAuthCallbackBase: process.env.GITHUB_OAUTH_CALLBACK_BASE ?? "",
  githubAppSlug: process.env.GITHUB_APP_SLUG ?? "",
  /** Public HTTPS base for hosted apps (Vercel frontends call this). e.g. https://abhinand.tail8a4b6e.ts.net:8443 */
  publicAppBase: process.env.PUBLIC_APP_BASE ?? "",
  vercelClientId: process.env.VERCEL_CLIENT_ID ?? "",
  vercelClientSecret: process.env.VERCEL_CLIENT_SECRET ?? "",
  vercelOAuthCallbackBase: process.env.VERCEL_OAUTH_CALLBACK_BASE ?? "",
  /** Integrations Console slug → install URL https://vercel.com/integrations/<slug>/new */
  vercelIntegrationSlug: process.env.VERCEL_INTEGRATION_SLUG ?? "",
  /** Live Windows host health JSON from scripts/host-health-daemon.sh */
  hostHealthPath:
    process.env.HOST_HEALTH_PATH ?? "/host-data/host-health.json",
  hostHealthHistoryPath:
    process.env.HOST_HEALTH_HISTORY_PATH ??
    "/host-data/host-health-history.jsonl",
  caddyfilePath:
    process.env.CADDYFILE_PATH ?? "/etc/caddy/dynamic/Caddyfile",
  nodeEnv: process.env.NODE_ENV ?? "development",
  allowInsecureWebhooks: process.env.ALLOW_INSECURE_WEBHOOKS === "true",
  /** AES key material for OAuth tokens at rest (falls back to ADMIN_TOKEN). */
  tokenEncryptionKey:
    process.env.TOKEN_ENCRYPTION_KEY || process.env.ADMIN_TOKEN || "",
  /** Extra allowed CORS origins (comma-separated), plus WEB_ORIGIN. */
  corsExtraOrigins: (process.env.CORS_EXTRA_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
};

export function assertConfig() {
  if (!config.adminToken || config.adminToken === "change-me-to-a-long-random-string") {
    if (config.nodeEnv === "production") {
      throw new Error("ADMIN_TOKEN must be set to a strong secret in production");
    }
    console.warn(
      "WARNING: ADMIN_TOKEN is weak/unset. Set a strong ADMIN_TOKEN before exposing this host.",
    );
    if (!config.adminToken) {
      config.adminToken = "dev-admin-token";
    }
  }
}
