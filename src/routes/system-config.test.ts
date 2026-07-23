import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { systemConfigRoute } from "./system-config";

function createApp(rows: Array<{ key: string; value: string }> = []) {
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue(rows),
      })),
    })),
  };
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    await next();
  });
  app.route("/api", systemConfigRoute);
  return app;
}

describe("systemConfigRoute", () => {
  it("reads public config directly from DB with no-store headers", async () => {
    const app = createApp([{ key: "shop_name", value: "db-shop" }]);

    const res = await app.request("/api/system-config");
    const body = await res.json() as { config: Record<string, string> };

    expect(body.config.shop_name).toBe("db-shop");
    expect(res.headers.get("Cache-Control")).toBe("no-store, no-cache, must-revalidate");
    expect(res.headers.get("Pragma")).toBe("no-cache");
    expect(res.headers.get("Expires")).toBe("0");
  });

  it("uses TURNSTILE_SITE_KEY env fallback when DB value is empty", async () => {
    const app = createApp();

    const res = await app.request("/api/system-config", {}, {
      TURNSTILE_SITE_KEY: "0x4AAAAAAAtest-site-key",
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { config: Record<string, string> };
    expect(body.config.turnstile_site_key).toBe("0x4AAAAAAAtest-site-key");
    expect(body.config.offline_pay_qr_wechat).toBeUndefined();
    expect(body.config.offline_pay_qr_alipay).toBeUndefined();
    expect(body.config.balance_payment_enabled).toBe("false");
    expect(body.config.turnstile_enabled).toBe("false");
  });

  it("returns balance payment switch to the storefront", async () => {
    const app = createApp([{ key: "balance_payment_enabled", value: "true" }]);

    const res = await app.request("/api/system-config");

    expect(res.status).toBe(200);
    const body = await res.json() as { config: Record<string, string> };
    expect(body.config.balance_payment_enabled).toBe("true");
    expect(res.headers.get("Cache-Control")).toBe("no-store, no-cache, must-revalidate");
  });

  it("keeps DB turnstile_site_key when it is configured", async () => {
    const app = createApp([{ key: "turnstile_site_key", value: "db-site-key" }]);

    const res = await app.request("/api/system-config", {}, {
      TURNSTILE_SITE_KEY: "env-site-key",
    });

    const body = await res.json() as { config: Record<string, string> };
    expect(body.config.turnstile_site_key).toBe("db-site-key");
  });

  it("returns DB turnstile_enabled flag to frontend", async () => {
    const app = createApp([{ key: "turnstile_enabled", value: "true" }]);

    const res = await app.request("/api/system-config");

    expect(res.status).toBe(200);
    const body = await res.json() as { config: Record<string, string> };
    expect(body.config.turnstile_enabled).toBe("true");
  });
});
