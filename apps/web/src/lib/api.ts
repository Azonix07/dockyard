function resolveApiUrl(): string {
  if (typeof window !== "undefined") {
    const fromStorage = localStorage.getItem("dockyard_api_url");
    // Ignore http:// API URLs on https pages (browsers block mixed content → "Failed to fetch")
    if (
      fromStorage &&
      !(
        window.location.protocol === "https:" &&
        fromStorage.startsWith("http:")
      )
    ) {
      return fromStorage.replace(/\/$/, "");
    }
  }
  const env = process.env.NEXT_PUBLIC_API_URL;
  if (env && env.trim()) return env.replace(/\/$/, "");
  if (typeof window !== "undefined") {
    const { protocol, hostname } = window.location;
    // Vercel / other https hosts: don't invent :8180 on the frontend domain
    if (protocol === "https:") {
      return "https://abhinand.tail8a4b6e.ts.net:8444";
    }
    return `${protocol}//${hostname}:8180`;
  }
  return "http://localhost:8180";
}

function token(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("dockyard_token") ?? "";
}

export function setToken(value: string) {
  localStorage.setItem("dockyard_token", value);
}

export function clearToken() {
  localStorage.removeItem("dockyard_token");
}

export function getToken() {
  return token();
}

export function setApiUrl(value: string) {
  localStorage.setItem("dockyard_api_url", value.replace(/\/$/, ""));
}

export function getApiUrl() {
  return resolveApiUrl();
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly transient: boolean,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const DEFAULT_TIMEOUT_MS = 20_000;
/** Statuses worth retrying: the host is waking up, not refusing us. */
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

function isIdempotent(method: string): boolean {
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD" || m === "OPTIONS";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type ApiOptions = RequestInit & {
  /** Extra retry attempts after the first try. Defaults to 2 for GETs. */
  retries?: number;
  timeoutMs?: number;
};

/**
 * Fetch wrapper built for a self-hosted host that can blink.
 *
 * The API lives on a laptop behind Tailscale: a container restart, a Wi-Fi
 * handover or a resumed sleep produces one failed request that means nothing.
 * Retrying idempotent calls with backoff turns those into invisible hiccups
 * rather than an error banner.
 */
export async function api<T>(path: string, init: ApiOptions = {}): Promise<T> {
  const { retries, timeoutMs, ...requestInit } = init;
  const method = (requestInit.method ?? "GET").toUpperCase();
  const attempts = (retries ?? (isIdempotent(method) ? 2 : 0)) + 1;
  const budget = timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const headers = new Headers(requestInit.headers);
    const t = token();
    if (t) headers.set("Authorization", `Bearer ${t}`);
    if (requestInit.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budget);

    try {
      const res = await fetch(`${resolveApiUrl()}${path}`, {
        ...requestInit,
        headers,
        signal: requestInit.signal ?? controller.signal,
      });

      if (res.ok) {
        return (await res.json().catch(() => ({}))) as T;
      }

      const data = (await res.json().catch(() => ({}))) as { error?: unknown };
      const errVal = data.error;
      const message =
        typeof errVal === "string"
          ? errVal
          : errVal
            ? JSON.stringify(errVal)
            : res.headers.get("X-Runbase-Error")
              ? "The service is starting or restarting. Retrying…"
              : `Request failed (${res.status})`;

      const transient = RETRYABLE.has(res.status);
      const err = new ApiError(message, res.status, transient);
      if (!transient || attempt === attempts - 1) throw err;
      lastError = err;
    } catch (err) {
      if (err instanceof ApiError) {
        if (!err.transient || attempt === attempts - 1) throw err;
        lastError = err;
      } else {
        // Network-level failure (host asleep, Tailscale reconnecting, DNS).
        lastError =
          err instanceof DOMException && err.name === "AbortError"
            ? new ApiError("The server took too long to respond.", 0, true)
            : new ApiError(
                "Cannot reach the Runbase API. Check that the host is online and Tailscale is connected.",
                0,
                true,
              );
        if (attempt === attempts - 1) throw lastError;
      }
    } finally {
      clearTimeout(timer);
    }

    // 300ms, 900ms — short enough to feel like a slow request, not a failure.
    await sleep(300 * 3 ** attempt);
  }

  throw lastError instanceof Error ? lastError : new Error("Request failed");
}
