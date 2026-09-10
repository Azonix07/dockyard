import { createHmac, timingSafeEqual } from "node:crypto";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { config } from "./config.js";

export function verifyGitHubSignature(
  rawBody: string,
  signatureHeader: string | undefined,
): boolean {
  if (!config.githubWebhookSecret) return false;
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", config.githubWebhookSecret)
    .update(rawBody)
    .digest("hex");
  const received = signatureHeader.slice("sha256=".length);
  try {
    return timingSafeEqual(
      Buffer.from(expected, "utf8"),
      Buffer.from(received, "utf8"),
    );
  } catch {
    return false;
  }
}

export async function getGitHubCloneToken(): Promise<string | null> {
  if (config.githubToken) return config.githubToken;
  if (
    !config.githubAppId ||
    !config.githubAppPrivateKey ||
    !config.githubAppInstallationId
  ) {
    return null;
  }
  const auth = createAppAuth({
    appId: config.githubAppId,
    privateKey: config.githubAppPrivateKey,
    installationId: Number(config.githubAppInstallationId),
  });
  const installationAuth = await auth({ type: "installation" });
  return installationAuth.token;
}

export async function createOctokit(): Promise<Octokit | null> {
  const token = await getGitHubCloneToken();
  if (!token) return null;
  return new Octokit({ auth: token });
}

export function parseRepo(repoUrl: string): { owner: string; repo: string } | null {
  try {
    const u = new URL(repoUrl.replace(/\.git$/, ""));
    if (!u.hostname.includes("github.com")) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    return { owner: parts[0], repo: parts[1] };
  } catch {
    return null;
  }
}

export function authenticatedCloneUrl(repoUrl: string, token: string): string {
  const u = new URL(repoUrl.replace(/\.git$/, "") + ".git");
  u.username = "x-access-token";
  u.password = token;
  return u.toString();
}
