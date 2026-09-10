function resolveApiUrl(): string {
  if (typeof window !== "undefined") {
    const fromStorage = localStorage.getItem("dockyard_api_url");
    if (fromStorage) return fromStorage.replace(/\/$/, "");
  }
  const env = process.env.NEXT_PUBLIC_API_URL;
  if (env && env.trim()) return env.replace(/\/$/, "");
  if (typeof window !== "undefined") {
    const { protocol, hostname } = window.location;
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

export async function api<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  const t = token();
  if (t) headers.set("Authorization", `Bearer ${t}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(`${resolveApiUrl()}${path}`, { ...init, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errVal = (data as { error?: unknown }).error;
    throw new Error(
      typeof errVal === "string"
        ? errVal
        : errVal
          ? JSON.stringify(errVal)
          : `Request failed (${res.status})`,
    );
  }
  return data as T;
}
