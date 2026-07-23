import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { orderRoute } from "./orders";

const rateLimitMocks = vi.hoisted(() => ({
  enforceRateLimit: vi.fn(),
}));

const runtimeConfigMocks = vi.hoisted(() => ({
  readRuntimeConfig: vi.fn(),
  mergeRuntimeConfig: vi.fn(),
}));

const securityMocks = vi.hoisted(() => ({
  verifyTurnstile: vi.fn(),
}));

const emailAccessMocks = vi.hoisted(() => ({
  verifyEmailAccessCode: vi.fn(),
}));

const orderServiceMocks = vi.hoisted(() => ({
  createOrder: vi.fn(),
  getOrderByToken: vi.fn(),
  getOrderSummaryByNo: vi.fn(),
  getOrderSummariesByEmail: vi.fn(),
}));

const productServiceMocks = vi.hoisted(() => ({
  getProduct: vi.fn(),
}));

const couponServiceMocks = vi.hoisted(() => ({
  quoteCoupon: vi.fn(),
}));

const storefrontServiceMocks = vi.hoisted(() => ({
  resolvePublicStorefront: vi.fn(),
  getActiveStorefrontById: vi.fn(),
}));

const defaultStorefront = {
  id: "sf_default",
  slug: "shop",
  name: "Shop",
  logoUrl: "",
  supportEmail: "",
  isDefault: true,
  homePath: "/shop",
};

vi.mock("../lib/rate-limit", () => ({
  enforceRateLimit: (...args: unknown[]) => rateLimitMocks.enforceRateLimit(...args),
}));

vi.mock("../lib/runtime-config", () => ({
  readRuntimeConfig: (...args: unknown[]) => runtimeConfigMocks.readRuntimeConfig(...args),
  mergeRuntimeConfig: (...args: unknown[]) => runtimeConfigMocks.mergeRuntimeConfig(...args),
}));

vi.mock("../lib/security", () => ({
  verifyTurnstile: (...args: unknown[]) => securityMocks.verifyTurnstile(...args),
}));

vi.mock("../lib/email-access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/email-access")>();
  return {
    ...actual,
    verifyEmailAccessCode: (...args: unknown[]) => emailAccessMocks.verifyEmailAccessCode(...args),
  };
});

vi.mock("../services/order-service", () => ({
  createOrder: (...args: unknown[]) => orderServiceMocks.createOrder(...args),
  getOrderByToken: (...args: unknown[]) => orderServiceMocks.getOrderByToken(...args),
  getOrderSummaryByNo: (...args: unknown[]) => orderServiceMocks.getOrderSummaryByNo(...args),
  getOrderSummariesByEmail: (...args: unknown[]) => orderServiceMocks.getOrderSummariesByEmail(...args),
}));

vi.mock("../services/product-service", () => ({
  getProduct: (...args: unknown[]) => productServiceMocks.getProduct(...args),
}));

vi.mock("../services/coupon-service", () => ({
  quoteCoupon: (...args: unknown[]) => couponServiceMocks.quoteCoupon(...args),
}));

vi.mock("../services/storefront-service", () => ({
  resolvePublicStorefront: (...args: unknown[]) => storefrontServiceMocks.resolvePublicStorefront(...args),
  getActiveStorefrontById: (...args: unknown[]) => storefrontServiceMocks.getActiveStorefrontById(...args),
}));

function createApp() {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", {} as never);
    await next();
  });
  app.route("/api", orderRoute);
  return app;
}

function orderPayload(extra?: Record<string, unknown>) {
  return {
    productId: "prod-1",
    buyerEmail: "buyer@example.com",
    turnstileToken: "turnstile-token",
    ...extra,
  };
}

describe("POST /coupons/quote", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rateLimitMocks.enforceRateLimit.mockResolvedValue({ ok: true, ipHash: "ip-hash" });
    storefrontServiceMocks.resolvePublicStorefront.mockResolvedValue(defaultStorefront);
    storefrontServiceMocks.getActiveStorefrontById.mockResolvedValue(defaultStorefront);
    productServiceMocks.getProduct.mockResolvedValue({ id: "prod-1", priceCents: 1200, currency: "CNY" });
    couponServiceMocks.quoteCoupon.mockResolvedValue({
      valid: true,
      discountCents: 200,
      payableCents: 1000,
      message: "优惠码可用",
    });
  });

  it("uses the explicit storefront when quoting a product", async () => {
    const softwareStorefront = {
      ...defaultStorefront,
      id: "sf_software",
      slug: "software",
      isDefault: false,
      homePath: "/s/software",
    };
    storefrontServiceMocks.getActiveStorefrontById.mockResolvedValueOnce(softwareStorefront);
    const res = await createApp().request("/api/coupons/quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        productId: "prod-1",
        storefrontId: "sf_software",
        quantity: 2,
        couponCode: "SAVE",
      }),
    });

    expect(res.status).toBe(200);
    expect(storefrontServiceMocks.getActiveStorefrontById).toHaveBeenCalledWith(expect.anything(), "sf_software");
    expect(productServiceMocks.getProduct).toHaveBeenCalledWith(expect.anything(), "prod-1", softwareStorefront.id);
    expect(couponServiceMocks.quoteCoupon).toHaveBeenCalledWith(expect.anything(), 2400, "prod-1", "SAVE", "CNY");
    await expect(res.json()).resolves.toMatchObject({ ok: true, storefrontId: softwareStorefront.id, payableCents: 1000 });
  });

  it("rejects coupon quotes for a base-free product before calling the coupon service", async () => {
    productServiceMocks.getProduct.mockResolvedValueOnce({ id: "prod-free", priceCents: 0, currency: "CNY" });

    const res = await createApp().request("/api/coupons/quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        productId: "prod-free",
        storefrontId: "sf_default",
        quantity: 1,
        couponCode: "SAVE",
      }),
    });
    const body = await res.json() as { details?: { code?: string } };

    expect(res.status).toBe(400);
    expect(body.details?.code).toBe("FREE_PRODUCT_COUPON_UNSUPPORTED");
    expect(couponServiceMocks.quoteCoupon).not.toHaveBeenCalled();
  });

  it("rejects an inactive or missing storefront before reading the product", async () => {
    storefrontServiceMocks.getActiveStorefrontById.mockResolvedValueOnce(null);

    const res = await createApp().request("/api/coupons/quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ productId: "prod-1", storefrontId: "sf_disabled" }),
    });

    expect(res.status).toBe(404);
    expect(productServiceMocks.getProduct).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toMatchObject({ details: { code: "STOREFRONT_NOT_FOUND" } });
  });

  it("does not quote a product that is not mapped to the storefront", async () => {
    productServiceMocks.getProduct.mockResolvedValueOnce(null);

    const res = await createApp().request("/api/coupons/quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ productId: "prod-1", storefrontId: "sf_default" }),
    });

    expect(res.status).toBe(404);
    expect(couponServiceMocks.quoteCoupon).not.toHaveBeenCalled();
  });
});

describe("POST /orders legacy creation endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rateLimitMocks.enforceRateLimit.mockResolvedValue({ ok: true, ipHash: "ip-hash" });
  });

  it("rejects legacy order creation and directs clients to unified payment", async () => {
    const res = await createApp().request("/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "same-key" },
      body: JSON.stringify(orderPayload()),
    });
    const body = await res.json() as { ok: boolean; error: string; details?: { code?: string } };

    expect(res.status).toBe(410);
    expect(body.ok).toBe(false);
    expect(body.details?.code).toBe("LEGACY_ORDER_DISABLED");
    expect(body.error).toContain("/api/pay/unified");
    expect(rateLimitMocks.enforceRateLimit).toHaveBeenCalledWith(expect.anything(), "create_order", 8);
    expect(orderServiceMocks.createOrder).not.toHaveBeenCalled();
  });
});

describe("GET/POST /orders/lookup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rateLimitMocks.enforceRateLimit.mockResolvedValue({ ok: true, ipHash: "ip-hash" });
    runtimeConfigMocks.readRuntimeConfig.mockResolvedValue({ turnstileEnabled: false });
    runtimeConfigMocks.mergeRuntimeConfig.mockImplementation((config) => config);
    securityMocks.verifyTurnstile.mockResolvedValue({ ok: true });
    emailAccessMocks.verifyEmailAccessCode.mockResolvedValue(true);
  });

  it("requires mailbox verification before email-scoped lookup", async () => {
    emailAccessMocks.verifyEmailAccessCode.mockResolvedValueOnce(false);

    const res = await createApp().request("https://shop.example.com/api/orders/lookup", {
      method: "POST",
      headers: { "X-Email-Access-Code": "000000", "Content-Type": "application/json" },
      body: JSON.stringify({ email: "buyer@example.com" }),
    }, {
      ADMIN_TOKEN: "admin-secret",
    });

    expect(res.status).toBe(403);
    expect(orderServiceMocks.getOrderSummariesByEmail).not.toHaveBeenCalled();
  });

  it("lists redacted order summaries for the verified mailbox", async () => {
    orderServiceMocks.getOrderSummariesByEmail.mockResolvedValueOnce([
      { orderNo: "ORD-2", status: "issued" },
      { orderNo: "ORD-1", status: "pending" },
    ]);

    const res = await createApp().request("https://shop.example.com/api/orders/lookup", {
      method: "POST",
      headers: { "X-Email-Access-Code": "123456", "Content-Type": "application/json" },
      body: JSON.stringify({ email: "Buyer@example.com" }),
    }, {
      ADMIN_TOKEN: "admin-secret",
    });

    expect(res.status).toBe(200);
    expect(orderServiceMocks.getOrderSummariesByEmail).toHaveBeenCalledWith(expect.anything(), "buyer@example.com", 20);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      orders: [
        { orderNo: "ORD-2", status: "issued" },
        { orderNo: "ORD-1", status: "pending" },
      ],
    });
  });

  it("rejects mailbox lookup when email is missing", async () => {
    const res = await createApp().request("https://shop.example.com/api/orders/lookup", {
      method: "POST",
      headers: { "X-Email-Access-Code": "123456", "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }, {
      ADMIN_TOKEN: "admin-secret",
    });

    expect(res.status).toBe(400);
    expect(orderServiceMocks.getOrderSummariesByEmail).not.toHaveBeenCalled();
  });

  it("does not accept mailbox identity in a GET query string", async () => {
    const res = await createApp().request("https://shop.example.com/api/orders/lookup?email=buyer%40example.com", {
      headers: { "X-Email-Access-Code": "123456" },
    }, {
      ADMIN_TOKEN: "admin-secret",
    });

    expect(res.status).toBe(400);
    expect(emailAccessMocks.verifyEmailAccessCode).not.toHaveBeenCalled();
    expect(orderServiceMocks.getOrderSummariesByEmail).not.toHaveBeenCalled();
  });

  it("does not treat a coupon code as a public order credential", async () => {
    const res = await createApp().request("/api/orders/lookup?code=UNIQUE-COUPON");

    expect(res.status).toBe(400);
    expect(orderServiceMocks.getOrderByToken).not.toHaveBeenCalled();
    expect(orderServiceMocks.getOrderSummariesByEmail).not.toHaveBeenCalled();
  });

  it("uses a valid order token even if unrelated query fields are present", async () => {
    orderServiceMocks.getOrderByToken.mockResolvedValueOnce({ orderNo: "ORD-TOKEN" });

    const res = await createApp().request("https://shop.example.com/api/orders/lookup?token=secure-token&orderNo=WRONG&code=UNRELATED");

    expect(res.status).toBe(200);
    expect(orderServiceMocks.getOrderByToken).toHaveBeenCalledWith(expect.anything(), "secure-token");
    expect(emailAccessMocks.verifyEmailAccessCode).not.toHaveBeenCalled();
  });
});
