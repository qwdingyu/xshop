import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { signJwt } from "@usethink/cf-core/auth/jwt";
import type { AppEnv } from "../bindings";
import { adminPublicRoute } from "./admin";

vi.mock("../lib/rate-limit", () => ({
  enforceRateLimit: vi.fn().mockResolvedValue({ ok: true, ipHash: "ip-hash" }),
}));

function createApp() {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", {} as never);
    await next();
  });
  app.route("/api/admin", adminPublicRoute);
  return app;
}

function base64Url(value: string | Uint8Array): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signPayload(payload: Record<string, unknown>, secret: string): Promise<string> {
  const input = `${base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${base64Url(JSON.stringify(payload))}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input));
  return `${input}.${base64Url(new Uint8Array(signature))}`;
}

describe("POST /admin/verify-jwt", () => {
  it("exchanges a token issued for the configured Telegram owner", async () => {
    const jwt = await signJwt("12345", "", "jwt-secret", 60);
    const res = await createApp().request("/api/admin/verify-jwt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jwt }),
    }, { JWT_SECRET: "jwt-secret", TG_OWNER_ID: "12345", ADMIN_TOKEN: "admin-secret" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ adminToken: "admin-secret" });
  });

  it("rejects a validly signed token for a different Telegram user", async () => {
    const jwt = await signJwt("99999", "", "jwt-secret", 60);
    const res = await createApp().request("/api/admin/verify-jwt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jwt }),
    }, { JWT_SECRET: "jwt-secret", TG_OWNER_ID: "12345", ADMIN_TOKEN: "admin-secret" });

    expect(res.status).toBe(403);
  });

  it("does not return a successful response with an empty admin token", async () => {
    const jwt = await signJwt("12345", "", "jwt-secret", 60);
    const res = await createApp().request("/api/admin/verify-jwt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jwt }),
    }, { JWT_SECRET: "jwt-secret", TG_OWNER_ID: "12345" });

    expect(res.status).toBe(503);
  });

  it("rejects a signed token that has no usable expiry", async () => {
    const jwt = await signPayload({ sub: "12345", email: "", iat: Math.floor(Date.now() / 1000) }, "jwt-secret");
    const res = await createApp().request("/api/admin/verify-jwt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jwt }),
    }, { JWT_SECRET: "jwt-secret", TG_OWNER_ID: "12345", ADMIN_TOKEN: "admin-secret" });

    expect(res.status).toBe(401);
  });
});
