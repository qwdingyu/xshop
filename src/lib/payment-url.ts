const LOCAL_HTTP_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Payment URLs must use TLS except for explicit loopback development endpoints. */
export function normalizeSecurePaymentUrl(value: string | undefined): string {
  const trimmed = value?.trim() || "";
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    const localHttp = url.protocol === "http:" && LOCAL_HTTP_HOSTS.has(url.hostname);
    return url.protocol === "https:" || localHttp ? trimmed : "";
  } catch {
    return "";
  }
}

export function isSecurePaymentUrl(value: unknown): boolean {
  return typeof value === "string" && normalizeSecurePaymentUrl(value) !== "";
}
