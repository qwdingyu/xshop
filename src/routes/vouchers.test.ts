import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { voucherRoute } from "./vouchers";

const redeemVoucher = vi.fn();
const getUserBalance = vi.fn();
const verifyEmailAccessCode = vi.fn();
const verifyTurnstile = vi.fn();

vi.mock("../services/voucher-service", () => ({
  redeemVoucher: (...args: unknown[]) => redeemVoucher(...args),
  getUserBalance: (...args: unknown[]) => getUserBalance(...args),
}));

vi.mock("../lib/rate-limit", () => ({
  enforceRateLimit: vi.fn().mockResolvedValue({ ok: true, ipHash: "ip-hash" }),
  writeRequestLog: vi.fn(),
}));

vi.mock("../lib/email-access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/email-access")>();
  return {
    ...actual,
    verifyEmailAccessCode: (...args: unknown[]) => verifyEmailAccessCode(...args),
  };
});

vi.mock("../lib/runtime-config", () => ({
  readRuntimeConfig: vi.fn().mockResolvedValue({
    resendApiKey: "",
    emailFrom: "",
    turnstileEnabled: true,
    turnstileSecretKey: "",
    allowTurnstileBypassForSmoke: false,
    inventoryWarningEmailTo: "",
  }),
  mergeRuntimeConfig: vi.fn((dbConfig: Record<string, unknown>, env?: Record<string, unknown>) => ({
    ...dbConfig,
    turnstileEnabled: Boolean(dbConfig.turnstileEnabled),
    turnstileSecretKey: (dbConfig.turnstileSecretKey as string) || env?.TURNSTILE_SECRET_KEY || "",
    allowTurnstileBypassForSmoke:
      (dbConfig.allowTurnstileBypassForSmoke as boolean) || env?.ALLOW_TURNSTILE_BYPASS_FOR_SMOKE === "true",
  })),
}));

vi.mock("../lib/security", () => ({
  verifyTurnstile: (...args: unknown[]) => verifyTurnstile(...args),
}));

function createApp(env: Partial<AppEnv["Bindings"]> = {}) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", {} as never);
    await next();
  });
  app.route("/api", voucherRoute);
  return { app, env };
}

describe("voucherRoute", () => {
  it("returns a user-facing message for incomplete voucher codes", async () => {
    redeemVoucher.mockClear();
    verifyTurnstile.mockClear();
    const { app, env } = createApp();

    const res = await app.request("/api/vouchers/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "1", email: "buyer@example.com" }),
    }, env);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      error: "请输入完整充值码",
      details: {
        code: "VOUCHER_REDEEM_INVALID_INPUT",
        fieldErrors: {
          code: ["请输入完整充值码"],
        },
      },
    });
    expect(verifyTurnstile).not.toHaveBeenCalled();
    expect(redeemVoucher).not.toHaveBeenCalled();
  });

  it("rejects balance lookup when mailbox ownership is not verified", async () => {
    getUserBalance.mockClear();
    verifyTurnstile.mockResolvedValueOnce({ ok: true });
    verifyEmailAccessCode.mockResolvedValueOnce(false);
    const { app, env } = createApp({ ADMIN_TOKEN: "admin-secret" });

    const res = await app.request("/api/vouchers/balance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "buyer@example.com", emailAccessCode: "000000", turnstileToken: "token" }),
    }, env);

    expect(res.status).toBe(403);
    expect(getUserBalance).not.toHaveBeenCalled();
  });

  it("does not reuse a Turnstile token after a valid email code", async () => {
    getUserBalance.mockClear();
    verifyEmailAccessCode.mockResolvedValueOnce(true);
    getUserBalance.mockResolvedValueOnce({
      email: "buyer@example.com",
      balanceCents: 1200,
      totalDepositedCents: 5000,
      totalSpentCents: 3800,
    });
    const { app, env } = createApp({ ADMIN_TOKEN: "admin-secret" });

    const res = await app.request("/api/vouchers/balance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "buyer@example.com", emailAccessCode: "123456" }),
    }, env);

    expect(res.status).toBe(200);
    expect(verifyTurnstile).not.toHaveBeenCalled();
    expect(getUserBalance).toHaveBeenCalledWith(expect.anything(), "buyer@example.com");
  });
});
