import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../bindings";

const getBalanceRechargeConfig = vi.fn();
const verifyEmailAccessCode = vi.fn();
const checkIdempotency = vi.fn();
const saveIdempotentResponse = vi.fn();
const createPayment = vi.fn();
const verifyCallback = vi.fn();
const createRechargeOrder = vi.fn();
const getRechargeOrderByNo = vi.fn();
const getRechargeOrderById = vi.fn();
const queryStatus = vi.fn();
const settleRechargeOrder = vi.fn();
const didPaymentHappenBeforeExpiry = vi.fn();

vi.mock("../db/client", () => ({
  withDbTransaction: (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(_db),
}));

vi.mock("../lib/system-config-registry", () => ({
  getBalanceRechargeConfig: (...args: unknown[]) => getBalanceRechargeConfig(...args),
  getOrderExpireMinutes: vi.fn().mockResolvedValue(30),
}));

vi.mock("../lib/email-access", () => ({
  getEmailAccessSecret: vi.fn().mockReturnValue("secret"),
  verifyEmailAccessCode: (...args: unknown[]) => verifyEmailAccessCode(...args),
}));

vi.mock("../lib/idempotency", () => ({
  isStrongIdempotencyKey: vi.fn().mockReturnValue(true),
  hashIdempotencyRequest: vi.fn().mockResolvedValue("request-hash"),
  checkIdempotency: (...args: unknown[]) => checkIdempotency(...args),
  saveIdempotentResponse: (...args: unknown[]) => saveIdempotentResponse(...args),
  clearPendingIdempotency: vi.fn(),
  clearCachedIdempotentResponse: vi.fn(),
}));

vi.mock("../lib/token", () => ({
  createOrderToken: vi.fn().mockReturnValue("x".repeat(43)),
  hashOrderToken: vi.fn().mockResolvedValue("token-hash"),
}));

vi.mock("../lib/rate-limit", () => ({
  enforceRateLimit: vi.fn().mockResolvedValue({ ok: true, ipHash: "ip-hash" }),
  writeRequestLog: vi.fn(),
}));

vi.mock("../services/payments", () => ({
  createDbProviderRegistry: vi.fn().mockResolvedValue({ get: vi.fn(), list: vi.fn(), selectOnline: vi.fn() }),
  createDbProviderRegistryForCallback: vi.fn().mockResolvedValue({
    get: vi.fn().mockReturnValue({
      verifyCallback: (...args: unknown[]) => verifyCallback(...args),
      queryStatus: (...args: unknown[]) => queryStatus(...args),
    }),
  }),
  selectOnlineProviderForCurrency: vi.fn().mockReturnValue({
    name: "easypay",
    createPayment: (...args: unknown[]) => createPayment(...args),
  }),
  isValidProviderName: vi.fn().mockReturnValue(true),
  isAmbiguousEasyPayProviderError: vi.fn().mockReturnValue(false),
  normalizeEasyPayPayType: vi.fn().mockReturnValue("alipay"),
  easyPayPayTypeLabel: vi.fn().mockReturnValue("支付宝"),
}));

vi.mock("../services/recharge-service", () => ({
  createRechargeOrder: (...args: unknown[]) => createRechargeOrder(...args),
  getRechargeOrderByNo: (...args: unknown[]) => getRechargeOrderByNo(...args),
  getRechargeOrderById: (...args: unknown[]) => getRechargeOrderById(...args),
  markRechargeOrderFailed: vi.fn(),
  expireRechargeOrder: vi.fn(),
  settleRechargeOrder: (...args: unknown[]) => settleRechargeOrder(...args),
}));

vi.mock("../services/payment-reconciliation-service", () => ({
  didPaymentHappenBeforeExpiry: (...args: unknown[]) => didPaymentHappenBeforeExpiry(...args),
  inferEasyPayPaidAt: vi.fn().mockReturnValue("2026-07-19T00:01:00.000Z"),
}));

import { rechargeRoute } from "./recharge";

function createApp() {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", {} as never);
    c.set("executionCtx", { waitUntil: vi.fn() } as never);
    await next();
  });
  app.route("/api", rechargeRoute);
  return app;
}

function createPayload() {
  return {
    buyerEmail: "Buyer@Example.com",
    emailAccessCode: "123456",
    amountCents: 5000,
    paymentChannel: "alipay",
  };
}

beforeEach(() => {
  getBalanceRechargeConfig.mockReset();
  getBalanceRechargeConfig.mockResolvedValue({ enabled: true, minCents: 100, maxCents: 500000 });
  verifyEmailAccessCode.mockReset();
  verifyEmailAccessCode.mockResolvedValue(true);
  checkIdempotency.mockReset();
  checkIdempotency.mockResolvedValue({ shouldProceed: true, cachedResponse: null, pending: false, requestMismatch: false, leaseVersion: "lease" });
  saveIdempotentResponse.mockReset();
  saveIdempotentResponse.mockResolvedValue(undefined);
  createPayment.mockReset();
  createPayment.mockResolvedValue({ redirectUrl: "https://pay.example.com/recharge", raw: { payType: "alipay" } });
  createRechargeOrder.mockReset();
  createRechargeOrder.mockResolvedValue(undefined);
  getRechargeOrderByNo.mockReset();
  getRechargeOrderById.mockReset();
  queryStatus.mockReset();
  settleRechargeOrder.mockReset();
  didPaymentHappenBeforeExpiry.mockReset();
  didPaymentHappenBeforeExpiry.mockReturnValue(true);
});

describe("rechargeRoute", () => {
  it("rejects recharge creation while the explicit feature switch is off", async () => {
    getBalanceRechargeConfig.mockResolvedValueOnce({ enabled: false, minCents: 100, maxCents: 500000 });
    const res = await createApp().request("/api/recharge/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify(createPayload()),
    }, { ADMIN_TOKEN: "admin" });

    expect(res.status).toBe(403);
    expect(createPayment).not.toHaveBeenCalled();
  });

  it("requires mailbox verification before creating a monetary order", async () => {
    verifyEmailAccessCode.mockResolvedValueOnce(false);
    const res = await createApp().request("/api/recharge/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify(createPayload()),
    }, { ADMIN_TOKEN: "admin" });

    expect(res.status).toBe(403);
    expect(createPayment).not.toHaveBeenCalled();
  });

  it("requires the idempotency key in the request header and ignores body compatibility fields", async () => {
    const res = await createApp().request("/api/recharge/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...createPayload(), idempotencyKey: crypto.randomUUID() }),
    }, { ADMIN_TOKEN: "admin" });

    expect(res.status).toBe(400);
    expect(verifyEmailAccessCode).not.toHaveBeenCalled();
    expect(checkIdempotency).not.toHaveBeenCalled();
    expect(createPayment).not.toHaveBeenCalled();
  });

  it("creates an isolated idempotent recharge order and forwards the selected channel", async () => {
    const res = await createApp().request("/api/recharge/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify(createPayload()),
    }, { ADMIN_TOKEN: "admin" });
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, status: "pending", amountCents: 5000, paymentChannel: "alipay" });
    expect(createRechargeOrder).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      buyerEmail: "buyer@example.com",
      amountCents: 5000,
      paymentProvider: "easypay",
    }));
    expect(createPayment).toHaveBeenCalledWith(expect.objectContaining({
      amountCents: 5000,
      currency: "CNY",
      returnUrl: "http://localhost/shop",
      metadata: expect.objectContaining({ payType: "alipay" }),
    }));
  });

  it.each([
    [{ amountCents: 4900, currency: "CNY" }, "amount"],
    [{ amountCents: 5000, currency: "USD" }, "currency"],
    [{ amountCents: 5000 }, "missing currency"],
  ])("does not settle a status reconciliation with a mismatched %s", async (statusFields, _reason) => {
    const order = {
      id: "123e4567-e89b-42d3-a456-426614174000",
      orderNo: "RTEST0001",
      orderTokenHash: "token-hash",
      buyerEmail: "buyer@example.com",
      amountCents: 5000,
      currency: "CNY",
      status: "pending",
      paymentProvider: "easypay",
      paymentRef: "",
      createdAt: "2026-07-19T00:00:00.000Z",
      expiresAt: "2099-07-19T00:30:00.000Z",
    };
    getRechargeOrderById.mockResolvedValue(order);
    queryStatus.mockResolvedValue({ paid: true, providerTradeNo: "TRADE-1", ...statusFields });

    const res = await createApp().request("/api/recharge/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId: order.id, orderToken: "x".repeat(43) }),
    });

    expect(res.status).toBe(200);
    expect(settleRechargeOrder).not.toHaveBeenCalled();
  });

  it("rejects callback amount mismatches without crediting balance", async () => {
    verifyCallback.mockResolvedValueOnce({
      orderNo: "RTEST0001",
      amountCents: 1,
      currency: "CNY",
      providerTradeNo: "TRADE-1",
    });
    getRechargeOrderByNo.mockResolvedValueOnce({
      id: "recharge-1",
      orderNo: "RTEST0001",
      amountCents: 5000,
      currency: "CNY",
      status: "pending",
      paymentProvider: "easypay",
      paymentRef: "",
      createdAt: "2026-07-19T00:00:00.000Z",
      expiresAt: "2026-07-19T00:30:00.000Z",
    });

    const res = await createApp().request("/api/recharge/callback/easypay?sign=valid");

    expect(res.status).toBe(400);
    expect(settleRechargeOrder).not.toHaveBeenCalled();
  });

  it("rejects callbacks without an explicit currency", async () => {
    verifyCallback.mockResolvedValueOnce({
      orderNo: "RTEST0001",
      amountCents: 5000,
      providerTradeNo: "TRADE-1",
    });
    getRechargeOrderByNo.mockResolvedValueOnce({
      id: "recharge-1",
      orderNo: "RTEST0001",
      amountCents: 5000,
      currency: "CNY",
      status: "pending",
      paymentProvider: "easypay",
      paymentRef: "",
      createdAt: "2026-07-19T00:00:00.000Z",
      expiresAt: "2099-07-19T00:30:00.000Z",
    });

    const res = await createApp().request("/api/recharge/callback/easypay?sign=valid");

    expect(res.status).toBe(400);
    expect(settleRechargeOrder).not.toHaveBeenCalled();
  });

  it("rejects an expired callback when provider reconciliation reports another currency", async () => {
    verifyCallback.mockResolvedValueOnce({
      orderNo: "RTEST0002",
      amountCents: 5000,
      providerTradeNo: "TRADE-2",
    });
    getRechargeOrderByNo.mockResolvedValueOnce({
      id: "recharge-2",
      orderNo: "RTEST0002",
      amountCents: 5000,
      currency: "CNY",
      status: "expired",
      paymentProvider: "easypay",
      paymentRef: "",
      createdAt: "2026-07-19T00:00:00.000Z",
      expiresAt: "2026-07-19T00:30:00.000Z",
    });
    queryStatus.mockResolvedValueOnce({
      paid: true,
      providerTradeNo: "TRADE-2",
      amountCents: 5000,
      currency: "USD",
      paidAt: "2026-07-19T00:01:00.000Z",
    });

    const res = await createApp().request("/api/recharge/callback/easypay?sign=valid");

    expect(res.status).toBe(400);
    expect(settleRechargeOrder).not.toHaveBeenCalled();
  });

  it("does not credit an expired recharge paid after its expiry", async () => {
    verifyCallback.mockResolvedValueOnce({
      orderNo: "RTEST0003",
      amountCents: 5000,
      currency: "CNY",
      providerTradeNo: "TRADE-3",
    });
    getRechargeOrderByNo.mockResolvedValueOnce({
      id: "recharge-3",
      orderNo: "RTEST0003",
      amountCents: 5000,
      currency: "CNY",
      status: "expired",
      paymentProvider: "easypay",
      paymentRef: "",
      createdAt: "2026-07-19T00:00:00.000Z",
      expiresAt: "2026-07-19T00:30:00.000Z",
    });
    queryStatus.mockResolvedValueOnce({
      paid: true,
      providerTradeNo: "TRADE-3",
      amountCents: 5000,
      currency: "CNY",
      paidAt: "2026-07-19T00:31:00.000Z",
    });
    didPaymentHappenBeforeExpiry.mockReturnValueOnce(false);

    const res = await createApp().request("/api/recharge/callback/easypay?sign=valid");

    expect(res.status).toBe(409);
    expect(settleRechargeOrder).not.toHaveBeenCalled();
  });
});
