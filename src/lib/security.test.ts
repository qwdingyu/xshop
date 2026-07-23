import { describe, it, expect, vi } from "vitest";
import { sha256, getBearerToken, getIpHash, requireAdmin, verifyTurnstile } from "./security";
import { Hono } from "hono";
import type { AppEnv } from "../bindings";

describe("sha256", () => {
  it("returns a hex string of 64 characters", async () => {
    const hash = await sha256("test");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces consistent results", async () => {
    const hash1 = await sha256("hello");
    const hash2 = await sha256("hello");
    expect(hash1).toBe(hash2);
  });

  it("produces different hashes for different inputs", async () => {
    const hash1 = await sha256("hello");
    const hash2 = await sha256("world");
    expect(hash1).not.toBe(hash2);
  });

  it("handles empty string", async () => {
    const hash = await sha256("");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("getBearerToken", () => {
  it("extracts Bearer token from Authorization header", () => {
    const mockReq = { header: (name: string) => name === "authorization" ? "Bearer my-secret-token" : undefined };
    const mockC = { req: mockReq } as any;
    const token = getBearerToken(mockC);
    expect(token).toBe("my-secret-token");
  });

  it("returns empty string when no Authorization header", () => {
    const mockReq = { header: () => undefined };
    const mockC = { req: mockReq } as any;
    const token = getBearerToken(mockC);
    expect(token).toBe("");
  });

  it("returns empty string for non-Bearer scheme", () => {
    const mockReq = { header: (name: string) => name === "authorization" ? "Basic abc123" : undefined };
    const mockC = { req: mockReq } as any;
    const token = getBearerToken(mockC);
    expect(token).toBe("");
  });

  it("handles case-insensitive Bearer", () => {
    const mockReq = { header: (name: string) => name === "authorization" ? "bearer my-token" : undefined };
    const mockC = { req: mockReq } as any;
    const token = getBearerToken(mockC);
    expect(token).toBe("my-token");
  });

  it("trims whitespace from token", () => {
    const mockReq = { header: (name: string) => name === "authorization" ? "Bearer   my-token   " : undefined };
    const mockC = { req: mockReq } as any;
    const token = getBearerToken(mockC);
    expect(token).toBe("my-token");
  });
});

// ---------------------------------------------------------------------------
// requireAdmin — tested via real Hono app with env injection
// ---------------------------------------------------------------------------

describe("requireAdmin", () => {
  it("rejects when ADMIN_TOKEN is not configured", async () => {
    const app = new Hono<AppEnv>();
    app.use("/admin/*", requireAdmin);
    app.get("/admin/test", (c) => c.json({ ok: true }));

    const res = await app.request("/admin/test", {
      headers: { Authorization: "Bearer some-token" },
    }, { ADMIN_TOKEN: undefined });
    expect(res.status).toBe(503);
  });

  it("rejects when token does not match", async () => {
    const app = new Hono<AppEnv>();
    app.use("/admin/*", requireAdmin);
    app.get("/admin/test", (c) => c.json({ ok: true }));

    const res = await app.request("/admin/test", {
      headers: { Authorization: "Bearer wrong-token" },
    }, { ADMIN_TOKEN: "correct-token" });
    expect(res.status).toBe(401);
  });

  it("rejects when no Authorization header", async () => {
    const app = new Hono<AppEnv>();
    app.use("/admin/*", requireAdmin);
    app.get("/admin/test", (c) => c.json({ ok: true }));

    const res = await app.request("/admin/test", {}, { ADMIN_TOKEN: "my-token" });
    expect(res.status).toBe(401);
  });

  it("allows when token matches", async () => {
    const app = new Hono<AppEnv>();
    app.use("/admin/*", requireAdmin);
    app.get("/admin/test", (c) => c.json({ ok: true }));

    const res = await app.request("/admin/test", {
      headers: { Authorization: "Bearer my-admin-token" },
    }, { ADMIN_TOKEN: "my-admin-token" });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// getIpHash tests
// ---------------------------------------------------------------------------

describe("getIpHash", () => {
  it("returns a hash based on cf-connecting-ip header", async () => {
    const mockC = {
      req: { header: (name: string) => name === "cf-connecting-ip" ? "1.2.3.4" : undefined },
      env: { RATE_LIMIT_SALT: "test-salt" },
    } as any;
    const hash = await getIpHash(mockC);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("falls back to x-forwarded-for when cf-connecting-ip is missing", async () => {
    const mockC = {
      req: { header: (name: string) => name === "x-forwarded-for" ? "5.6.7.8" : undefined },
      env: {},
    } as any;
    const hash = await getIpHash(mockC);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("uses default IP 0.0.0.0 when no IP headers present", async () => {
    const mockC = {
      req: { header: () => undefined },
      env: {},
    } as any;
    const hash = await getIpHash(mockC);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces different hashes for different IPs", async () => {
    const mockC1 = {
      req: { header: (name: string) => name === "cf-connecting-ip" ? "1.1.1.1" : undefined },
      env: {},
    } as any;
    const mockC2 = {
      req: { header: (name: string) => name === "cf-connecting-ip" ? "2.2.2.2" : undefined },
      env: {},
    } as any;
    const hash1 = await getIpHash(mockC1);
    const hash2 = await getIpHash(mockC2);
    expect(hash1).not.toBe(hash2);
  });
});

// ---------------------------------------------------------------------------
// verifyTurnstile tests
// ---------------------------------------------------------------------------

describe("verifyTurnstile", () => {
  it("returns ok when Turnstile is disabled", async () => {
    const mockC = {
      req: { header: () => undefined },
      env: { TURNSTILE_SECRET_KEY: undefined },
    } as any;
    const result = await verifyTurnstile(mockC, "some-token");
    expect(result.ok).toBe(true);
  });

  it("returns error when token is missing but Turnstile is enabled", async () => {
    const mockC = {
      req: { header: () => undefined },
      env: { TURNSTILE_SECRET_KEY: "0x4AAAAAAAtest-secret" },
    } as any;
    const result = await verifyTurnstile(mockC, undefined, { turnstileEnabled: true, turnstileSecretKey: "0x4AAAAAAAtest-secret" });
    expect(result.ok).toBe(false);
    expect(result.message).toBe("请完成人机验证");
  });

  it("returns error when token is empty string but Turnstile is enabled", async () => {
    const mockC = {
      req: { header: () => undefined },
      env: { TURNSTILE_SECRET_KEY: "0x4AAAAAAAtest-secret" },
    } as any;
    const result = await verifyTurnstile(mockC, "", { turnstileEnabled: true, turnstileSecretKey: "0x4AAAAAAAtest-secret" });
    expect(result.ok).toBe(false);
    expect(result.message).toBe("请完成人机验证");
  });

  it("allows explicit smoke bypass with matching admin token", async () => {
    const mockC = {
      req: {
        header: (name: string) => name.toLowerCase() === "x-smoke-admin-token" ? "admin-secret" : undefined,
      },
      env: {
        TURNSTILE_SECRET_KEY: "0x4AAAAAAAtest-secret",
        ALLOW_TURNSTILE_BYPASS_FOR_SMOKE: "true",
        ADMIN_TOKEN: "admin-secret",
      },
    } as any;
    const result = await verifyTurnstile(mockC, undefined, {
      turnstileEnabled: true,
      turnstileSecretKey: "0x4AAAAAAAtest-secret",
      allowTurnstileBypassForSmoke: true,
    });
    expect(result.ok).toBe(true);
    expect(result.smokeSkipped).toBe(true);
  });

  it("rejects smoke bypass when admin token does not match", async () => {
    const mockC = {
      req: {
        header: (name: string) => name.toLowerCase() === "x-smoke-admin-token" ? "wrong-secret" : undefined,
      },
      env: {
        TURNSTILE_SECRET_KEY: "0x4AAAAAAAtest-secret",
        ALLOW_TURNSTILE_BYPASS_FOR_SMOKE: "true",
        ADMIN_TOKEN: "admin-secret",
      },
    } as any;
    const result = await verifyTurnstile(mockC, undefined, {
      turnstileEnabled: true,
      turnstileSecretKey: "0x4AAAAAAAtest-secret",
      allowTurnstileBypassForSmoke: true,
    });
    expect(result.ok).toBe(false);
  });

  it("returns ok when Turnstile API verifies successfully", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: async () => ({ success: true }),
    });
    const mockC = {
      req: { header: () => "1.2.3.4" },
      env: { TURNSTILE_SECRET_KEY: "0x4AAAAAAAtest-secret" },
    } as any;
    const result = await verifyTurnstile(mockC, "valid-turnstile-token", { turnstileEnabled: true, turnstileSecretKey: "0x4AAAAAAAtest-secret" });
    expect(result.ok).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    globalThis.fetch = originalFetch;
  });

  it("returns error when Turnstile API rejects the token", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: async () => ({ success: false, "error-codes": ["invalid-input-response"] }),
    });
    const mockC = {
      req: { header: () => undefined },
      env: { TURNSTILE_SECRET_KEY: "0x4AAAAAAAtest-secret" },
    } as any;
    const result = await verifyTurnstile(mockC, "bad-token", { turnstileEnabled: true, turnstileSecretKey: "0x4AAAAAAAtest-secret" });
    expect(result.ok).toBe(false);
    expect(result.message).toBe("Turnstile 校验失败");
    globalThis.fetch = originalFetch;
  });

  it("returns 503 when Turnstile is enabled but secret key is missing", async () => {
    const mockC = {
      req: { header: () => undefined },
      env: {},
    } as any;
    const result = await verifyTurnstile(mockC, "some-token", { turnstileEnabled: true, turnstileSecretKey: "" });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// requireAdmin — production dev token check
// ---------------------------------------------------------------------------

describe("requireAdmin production safety", () => {
  it("rejects dev-only token on non-localhost hostname", async () => {
    const app = new Hono<AppEnv>();
    app.use("/admin/*", requireAdmin);
    app.get("/admin/test", (c) => c.json({ ok: true }));

    // Use a production-like hostname to trigger the dev-only token rejection
    const res = await app.request("https://example.com/admin/test", {
      headers: { Authorization: "Bearer dev-only-change-me" },
    }, { ADMIN_TOKEN: "dev-only-change-me" });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect((body as any).error).toContain("生产环境");
  });

  it("allows dev-only token on localhost hostname", async () => {
    const app = new Hono<AppEnv>();
    app.use("/admin/*", requireAdmin);
    app.get("/admin/test", (c) => c.json({ ok: true }));

    const res = await app.request("http://127.0.0.1/admin/test", {
      headers: { Authorization: "Bearer dev-only-change-me" },
    }, { ADMIN_TOKEN: "dev-only-change-me" });
    expect(res.status).toBe(200);
  });
});
