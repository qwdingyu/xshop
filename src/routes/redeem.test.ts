import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { redeemRoute } from "./redeem";

const fulfillmentMocks = vi.hoisted(() => ({
  fulfillCardInventory: vi.fn(),
  rollbackFulfilledInventory: vi.fn(),
}));
const couponMocks = vi.hoisted(() => ({
  getCoupon: vi.fn(),
  quoteCoupon: vi.fn(),
  consumeCoupon: vi.fn(),
}));
const productMocks = vi.hoisted(() => ({
  getProduct: vi.fn(),
}));
const auditMocks = vi.hoisted(() => ({
  writeOrderEvent: vi.fn(),
}));
const orderServiceMocks = vi.hoisted(() => ({
  checkProductPurchaseLimitForQuantity: vi.fn(),
}));
const emailMocks = vi.hoisted(() => ({
  sendEmail: vi.fn(),
}));

vi.mock("../services/fulfillment-service", () => ({
  fulfillCardInventory: (...args: unknown[]) => fulfillmentMocks.fulfillCardInventory(...args),
  rollbackFulfilledInventory: (...args: unknown[]) => fulfillmentMocks.rollbackFulfilledInventory(...args),
}));

vi.mock("../services/coupon-service", () => ({
  getCoupon: (...args: unknown[]) => couponMocks.getCoupon(...args),
  quoteCoupon: (...args: unknown[]) => couponMocks.quoteCoupon(...args),
  consumeCoupon: (...args: unknown[]) => couponMocks.consumeCoupon(...args),
}));

vi.mock("../services/product-service", () => ({
  getProduct: (...args: unknown[]) => productMocks.getProduct(...args),
}));

vi.mock("../services/audit-service", () => ({
  writeOrderEvent: (...args: unknown[]) => auditMocks.writeOrderEvent(...args),
}));

vi.mock("../services/order-service", () => ({
  deliveryVisibilityPayload: (input: { deliveryVisibility?: string | null; buyerEmail?: string | null; status?: string | null }) => {
    if (input.deliveryVisibility !== "email_only") return { deliveryVisibility: "web_and_email" };
    if (input.status !== "issued") return { deliveryVisibility: "email_only" };
    return {
      deliveryVisibility: "email_only",
      deliveryMessage: `卡密已生成并将发送到 ${input.buyerEmail || "下单邮箱"}，邮件可能延迟；如未收到，请检查垃圾邮件或联系售后。`,
    };
  },
  checkProductPurchaseLimitForQuantity: (...args: unknown[]) => orderServiceMocks.checkProductPurchaseLimitForQuantity(...args),
}));

vi.mock("../services/email-service", () => ({
  sendEmail: (...args: unknown[]) => emailMocks.sendEmail(...args),
}));

vi.mock("../lib/rate-limit", () => ({
  enforceRateLimit: vi.fn().mockResolvedValue({ ok: true, ipHash: "ip-hash" }),
  writeRequestLog: vi.fn(),
}));

vi.mock("../lib/security", () => ({
  sha256: vi.fn(async (value: string) => `hash-${value}`),
  verifyTurnstile: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("../lib/runtime-config", () => ({
  readRuntimeConfig: vi.fn().mockResolvedValue({
    resendApiKey: "",
    emailFrom: "",
    turnstileEnabled: false,
    turnstileSecretKey: "",
    allowTurnstileBypassForSmoke: false,
  }),
  mergeRuntimeConfig: vi.fn((dbConfig: Record<string, unknown>, env?: Record<string, unknown>) => ({
    resendApiKey: (dbConfig.resendApiKey as string) || env?.RESEND_API_KEY || "",
    emailFrom: (dbConfig.emailFrom as string) || env?.EMAIL_FROM || "",
    turnstileEnabled: Boolean(dbConfig.turnstileEnabled),
    turnstileSecretKey: (dbConfig.turnstileSecretKey as string) || env?.TURNSTILE_SECRET_KEY || "",
    allowTurnstileBypassForSmoke:
      (dbConfig.allowTurnstileBypassForSmoke as boolean) || env?.ALLOW_TURNSTILE_BYPASS_FOR_SMOKE === "true",
  })),
}));

function createDb(options: { failOrderInsert?: boolean; insertedRows?: Array<Record<string, unknown>> } = {}) {
  const tx = {
    insert: () => ({
      values: (data: Record<string, unknown>) => {
        options.insertedRows?.push(data);
        return options.failOrderInsert
          ? Promise.reject(new Error("insert failed"))
          : Promise.resolve({ rowsAffected: 1 });
      },
    }),
  };
  return {
    transaction: async (fn: (txArg: unknown) => Promise<unknown>) => fn(tx),
    insert: () => ({ values: () => Promise.resolve({ rowsAffected: 1 }) }),
  };
}

function createApp(db = createDb()) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    await next();
  });
  app.route("/api", redeemRoute);
  return app;
}

function redeemPayload(extra?: Record<string, unknown>) {
  return {
    couponCode: "FREE100",
    buyerEmail: "buyer@example.com",
    ...extra,
  };
}

function mockFreeCoupon() {
  couponMocks.getCoupon.mockResolvedValue({ code: "FREE100", productId: "prod-1" });
  productMocks.getProduct.mockResolvedValue({ id: "prod-1", title: "Test Product", priceCents: 1000, currency: "CNY", issueMode: "manual", fulfillmentMode: "card", deliveryVisibility: "web_and_email" });
  couponMocks.quoteCoupon.mockResolvedValue({ valid: true, discountCents: 1000, payableCents: 0, message: "折扣码可用" });
}

describe("redeemRoute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auditMocks.writeOrderEvent.mockResolvedValue(undefined);
    orderServiceMocks.checkProductPurchaseLimitForQuantity.mockReset().mockResolvedValue({ ok: true });
  });

  it("rejects non-free coupon before issuing card", async () => {
    couponMocks.getCoupon.mockResolvedValueOnce({ code: "SAVE10", productId: "prod-1" });
    productMocks.getProduct.mockResolvedValueOnce({ id: "prod-1", priceCents: 1000, currency: "CNY", issueMode: "manual", fulfillmentMode: "card" });
    couponMocks.quoteCoupon.mockResolvedValueOnce({
      valid: true,
      discountCents: 100,
      payableCents: 900,
      message: "折扣码可用",
    });

    const res = await createApp().request("/api/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(redeemPayload({ couponCode: "SAVE10" })),
    });

    const body = await res.json() as { error: string };
    expect(res.status).toBe(402);
    expect(body.error).toContain("不是全额兑换码");
    expect(fulfillmentMocks.fulfillCardInventory).not.toHaveBeenCalled();
    expect(couponMocks.consumeCoupon).not.toHaveBeenCalled();
  });

  it("consumes coupon, issues card, writes order, and returns delivery in one transaction", async () => {
    mockFreeCoupon();
    const insertedRows: Array<Record<string, unknown>> = [];
    couponMocks.consumeCoupon.mockResolvedValue({ success: true });
    fulfillmentMocks.fulfillCardInventory.mockResolvedValue({
      mode: "card",
      card: { id: "card-1", accountLabel: "ACC", deliverySecret: "SECRET", deliveryNote: "NOTE" },
      delivery: { accountLabel: "ACC", deliverySecret: "SECRET", deliveryNote: "NOTE" },
    });

    const res = await createApp(createDb({ insertedRows })).request("/api/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(redeemPayload()),
    });
    const body = await res.json() as {
      ok: boolean;
      orderId?: string;
      orderNo?: string;
      orderToken?: string;
      delivery: { deliverySecret: string };
    };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.orderId).toBeTruthy();
    expect(body.orderNo).toBeTruthy();
    expect(body.orderToken).toBeTruthy();
    expect(body.delivery.deliverySecret).toBe("SECRET");
    expect(insertedRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ productId: "prod-1", fulfillmentMode: "card", quantity: 1 }),
      expect.objectContaining({ productId: "prod-1", productTitle: "Test Product", fulfillmentMode: "card", quantity: 1 }),
    ]));
    expect(couponMocks.consumeCoupon).toHaveBeenCalledTimes(1);
    expect(fulfillmentMocks.fulfillCardInventory).toHaveBeenCalledTimes(1);
    expect(auditMocks.writeOrderEvent).toHaveBeenCalledWith(expect.anything(), expect.any(String), "redeemed", expect.stringContaining("card-1"));
  });

  it("enforces the product email purchase limit before redeeming a coupon", async () => {
    mockFreeCoupon();
    productMocks.getProduct.mockResolvedValueOnce({
      id: "prod-1",
      title: "Limited Product",
      priceCents: 1000,
      currency: "CNY",
      issueMode: "manual",
      fulfillmentMode: "card",
      purchaseLimit: 1,
      deliveryVisibility: "email_only",
    });
    orderServiceMocks.checkProductPurchaseLimitForQuantity.mockResolvedValueOnce({
      ok: false,
      status: 429,
      message: "该商品每人限购 1 件，您已达到上限",
    });

    const res = await createApp().request("/api/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(redeemPayload({ buyerEmail: "Buyer@Example.COM" })),
    }, {
      RESEND_API_KEY: "resend-key",
      EMAIL_FROM: "shop@example.com",
    });
    const body = await res.json() as { error: string };

    expect(res.status).toBe(429);
    expect(body.error).toContain("限购 1 件");
    expect(orderServiceMocks.checkProductPurchaseLimitForQuantity).toHaveBeenCalledWith(
      expect.anything(),
      "buyer@example.com",
      "prod-1",
      1,
      1,
    );
    expect(couponMocks.consumeCoupon).not.toHaveBeenCalled();
    expect(fulfillmentMocks.fulfillCardInventory).not.toHaveBeenCalled();
  });

  it("rechecks the purchase limit inside the redeem transaction", async () => {
    mockFreeCoupon();
    productMocks.getProduct.mockResolvedValueOnce({
      id: "prod-1",
      title: "Limited Product",
      priceCents: 1000,
      currency: "CNY",
      issueMode: "manual",
      fulfillmentMode: "card",
      purchaseLimit: 1,
      deliveryVisibility: "web_and_email",
    });
    orderServiceMocks.checkProductPurchaseLimitForQuantity
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        message: "该商品每人限购 1 件，您已达到上限",
      });

    const res = await createApp().request("/api/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(redeemPayload()),
    });
    const body = await res.json() as { error: string };

    expect(res.status).toBe(429);
    expect(body.error).toContain("限购 1 件");
    expect(orderServiceMocks.checkProductPurchaseLimitForQuantity).toHaveBeenCalledTimes(2);
    expect(couponMocks.consumeCoupon).not.toHaveBeenCalled();
    expect(fulfillmentMocks.fulfillCardInventory).not.toHaveBeenCalled();
  });

  it("does not issue a card when coupon consumption loses the race", async () => {
    mockFreeCoupon();
    couponMocks.consumeCoupon.mockResolvedValue({ success: false });

    const res = await createApp().request("/api/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(redeemPayload()),
    });
    const body = await res.json() as { error: string };

    expect(res.status).toBe(409);
    expect(body.error).toContain("折扣码已被使用");
    expect(fulfillmentMocks.fulfillCardInventory).not.toHaveBeenCalled();
    expect(fulfillmentMocks.rollbackFulfilledInventory).not.toHaveBeenCalled();
  });

  it("rolls back coupon consumption automatically when stock is unavailable", async () => {
    mockFreeCoupon();
    couponMocks.consumeCoupon.mockResolvedValue({ success: true });
    fulfillmentMocks.fulfillCardInventory.mockResolvedValue(null);

    const res = await createApp().request("/api/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(redeemPayload()),
    });
    const body = await res.json() as { error: string };

    expect(res.status).toBe(409);
    expect(body.error).toContain("库存不足");
    expect(couponMocks.consumeCoupon).toHaveBeenCalledTimes(1);
    expect(fulfillmentMocks.rollbackFulfilledInventory).not.toHaveBeenCalled();
  });

  it("lets the transaction roll back card issue and coupon consumption when order insert fails", async () => {
    mockFreeCoupon();
    couponMocks.consumeCoupon.mockResolvedValue({ success: true });
    fulfillmentMocks.fulfillCardInventory.mockResolvedValue({
      mode: "card",
      card: { id: "card-1", accountLabel: "ACC", deliverySecret: "SECRET", deliveryNote: "NOTE" },
      delivery: { accountLabel: "ACC", deliverySecret: "SECRET", deliveryNote: "NOTE" },
    });

    const res = await createApp(createDb({ failOrderInsert: true })).request("/api/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(redeemPayload()),
    });
    const body = await res.json() as { error: string };

    expect(res.status).toBe(500);
    expect(body.error).toContain("兑换失败");
    expect(fulfillmentMocks.rollbackFulfilledInventory).not.toHaveBeenCalled();
  });

  it("rejects email-only redemption before consuming coupon when email is not configured", async () => {
    mockFreeCoupon();
    productMocks.getProduct.mockResolvedValueOnce({
      id: "prod-1",
      title: "Email Only Product",
      priceCents: 1000,
      currency: "CNY",
      issueMode: "manual",
      fulfillmentMode: "card",
      deliveryVisibility: "email_only",
    });

    const res = await createApp().request("/api/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(redeemPayload()),
    });
    const body = await res.json() as { error: string; details?: { code?: string } };

    expect(res.status).toBe(503);
    expect(body.error).toContain("邮件服务未配置");
    expect(body.details?.code).toBe("EMAIL_REQUIRED_FOR_EMAIL_ONLY_DELIVERY");
    expect(couponMocks.consumeCoupon).not.toHaveBeenCalled();
    expect(fulfillmentMocks.fulfillCardInventory).not.toHaveBeenCalled();
  });

  it("sends email and redacts card data for email-only redemption", async () => {
    mockFreeCoupon();
    productMocks.getProduct.mockResolvedValueOnce({
      id: "prod-1",
      title: "Email Only Product",
      priceCents: 1000,
      currency: "CNY",
      issueMode: "manual",
      fulfillmentMode: "card",
      deliveryVisibility: "email_only",
    });
    couponMocks.consumeCoupon.mockResolvedValue({ success: true });
    fulfillmentMocks.fulfillCardInventory.mockResolvedValue({
      mode: "card",
      card: { id: "card-1", accountLabel: "ACC", deliverySecret: "SECRET", deliveryNote: "NOTE" },
      delivery: { accountLabel: "ACC", deliverySecret: "SECRET", deliveryNote: "NOTE" },
    });
    emailMocks.sendEmail.mockResolvedValue({ ok: true });

    const res = await createApp().request("/api/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(redeemPayload()),
    }, {
      RESEND_API_KEY: "resend-key",
      EMAIL_FROM: "shop@example.com",
    });
    const body = await res.json() as {
      ok: boolean;
      deliveryVisibility?: string;
      deliveryMessage?: string;
      delivery?: Record<string, string>;
    };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.deliveryVisibility).toBe("email_only");
    expect(body.deliveryMessage).toContain("buyer@example.com");
    expect(body.delivery).toBeUndefined();
    expect(emailMocks.sendEmail).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({
      to: "buyer@example.com",
      template: "order_issued",
      templateData: expect.objectContaining({
        accountLabel: "ACC",
        deliverySecret: "SECRET",
      }),
      orderId: expect.any(String),
    }));
  });
});
