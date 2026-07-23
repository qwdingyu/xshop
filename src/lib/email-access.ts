import { constantTimeEqual } from "./security";

const EMAIL_ACCESS_WINDOW_MS = 5 * 60 * 1000;
const EMAIL_ACCESS_CONTEXT = "cf-shop-email-access-v1";
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function codeForWindow(email: string, key: CryptoKey, window: number): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${EMAIL_ACCESS_CONTEXT}:${normalizeEmail(email)}:${window}`),
  );
  const bytes = new Uint8Array(signature);
  const value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0) % 1_000_000;
  return value.toString().padStart(6, "0");
}

export function getEmailAccessSecret(adminToken: string | undefined, requestUrl: string): string {
  const secret = adminToken?.trim() || "";
  if (!secret) return "";
  try {
    const hostname = new URL(requestUrl).hostname;
    if (secret === "dev-only-change-me" && !LOCAL_HOSTS.has(hostname)) return "";
  } catch {
    return "";
  }
  return secret;
}

export function createEmailAccessCode(email: string, secret: string, now = Date.now()): Promise<string> {
  return importHmacKey(secret).then((key) => codeForWindow(email, key, Math.floor(now / EMAIL_ACCESS_WINDOW_MS)));
}

export async function verifyEmailAccessCode(
  email: string,
  code: string | undefined,
  secret: string,
  now = Date.now(),
): Promise<boolean> {
  const candidate = code?.trim() || "";
  if (!/^\d{6}$/.test(candidate) || !secret) return false;

  const currentWindow = Math.floor(now / EMAIL_ACCESS_WINDOW_MS);
  const key = await importHmacKey(secret);
  const [currentCode, previousCode] = await Promise.all([
    codeForWindow(email, key, currentWindow),
    codeForWindow(email, key, currentWindow - 1),
  ]);
  return constantTimeEqual(candidate, currentCode) || constantTimeEqual(candidate, previousCode);
}
