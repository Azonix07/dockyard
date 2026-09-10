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
  caddyfilePath:
    process.env.CADDYFILE_PATH ?? "/etc/caddy/dynamic/Caddyfile",
  nodeEnv: process.env.NODE_ENV ?? "development",
  allowInsecureWebhooks: process.env.ALLOW_INSECURE_WEBHOOKS === "true",
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
