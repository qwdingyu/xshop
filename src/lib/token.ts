import { sha256 } from "./security";

export function createOrderToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function hashOrderToken(token: string) {
  return sha256(`order-token:${token}`);
}

export function createOrderNo() {
  const now = new Date();
  const stamp = now.toISOString().slice(0, 10).replaceAll("-", "");
  const suffix = crypto.randomUUID().slice(0, 8).toUpperCase();
  return `AB${stamp}${suffix}`;
}
