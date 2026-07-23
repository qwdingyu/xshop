import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import type { DbType } from "../db/client";
import { idempotencyKeys } from "../db/schema";

const mocks = vi.hoisted(() => ({
  enforceRateLimit: vi.fn(),
  verifyTurnstile: vi.fn(),
}));

vi.mock("../lib/rate-limit", () => ({
  enforceRateLimit: (...args: unknown[]) => mocks.enforceRateLimit(...args),
  writeRequestLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/security", () => ({
  verifyTurnstile: (...args: unknown[]) => mocks.verifyTurnstile(...args),
}));

vi.mock("../lib/runtime-config", () => ({
  readRuntimeConfig: vi.fn().mockResolvedValue({
    turnstileEnabled: true,
    turnstileSecretKey: "secret",
    allowTurnstileBypassForSmoke: false,
  }),
  mergeRuntimeConfig: (config: Record<string, unknown>) => config,
}));

vi.mock("../services/storefront-service", () => ({
  resolvePublicStorefront: vi.fn().mockResolvedValue({
    id: "sf_default",
    slug: "shop",
    name: "Shop",
    logoUrl: "",
    supportEmail: "",
    isDefault: true,
    homePath: "/shop",
  }),
  getActiveStorefrontById: vi.fn(),
  validateStorefrontProductMapping: vi.fn(),
}));

import { payRoute } from "./pay";

function createApp() {
  let clearedReservations = 0;
  let reservedReservations = 0;
  const db = {
    insert: (table: unknown) => ({
      values: () => {
        if (table === idempotencyKeys) reservedReservations += 1;
        return {
          onConflictDoNothing: () => ({
            returning: () => Promise.resolve(table === idempotencyKeys ? [{ responseJson: "__pending__" }] : []),
          }),
        };
      },
    }),
    delete: (table: unknown) => ({
      where: () => {
        if (table === idempotencyKeys) clearedReservations += 1;
        return Promise.resolve({ rowsAffected: 1 });
      },
    }),
  } as unknown as DbType;

  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    c.set("executionCtx", { waitUntil: vi.fn() } as unknown as ExecutionContext);
    await next();
  });
  app.route("/api", payRoute);
  return {
    app,
    clearedReservations: () => clearedReservations,
    reservedReservations: () => reservedReservations,
  };
}

function request(app: Hono<AppEnv>) {
  return app.request("/api/pay/unified", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": "r".repeat(32),
    },
    body: JSON.stringify({ storefrontId: "sf_default", productId: "product-1", buyerEmail: "buyer@example.com" }),
  }, {});
}

describe("pay idempotency reservation cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enforceRateLimit.mockResolvedValue({ ok: true, ipHash: "ip-hash" });
    mocks.verifyTurnstile.mockResolvedValue({ ok: true });
  });

  it("does not reserve a key when the payment rate limit rejects the request", async () => {
    mocks.enforceRateLimit.mockResolvedValueOnce({ ok: false, status: 429, message: "rate limited" });
    const { app, clearedReservations, reservedReservations } = createApp();

    const response = await request(app);

    expect(response.status).toBe(429);
    expect(reservedReservations()).toBe(0);
    expect(clearedReservations()).toBe(0);
  });

  it("clears a newly reserved key when Turnstile rejects the request", async () => {
    mocks.verifyTurnstile.mockResolvedValueOnce({ ok: false, status: 403, message: "turnstile rejected" });
    const { app, clearedReservations } = createApp();

    const response = await request(app);

    expect(response.status).toBe(403);
    expect(clearedReservations()).toBe(1);
  });
});
