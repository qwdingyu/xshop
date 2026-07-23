import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { adminStorefrontRoute } from "./admin-storefronts";

const serviceMocks = vi.hoisted(() => ({
  listAdminStorefronts: vi.fn(),
  getAdminStorefront: vi.fn(),
  createStorefront: vi.fn(),
  updateStorefront: vi.fn(),
  replaceStorefrontProducts: vi.fn(),
  updateStorefrontProductMapping: vi.fn(),
  setDefaultStorefront: vi.fn(),
  deleteStorefront: vi.fn(),
}));
const writeAdminAudit = vi.hoisted(() => vi.fn());

vi.mock("../services/storefront-service", () => ({
  STOREFRONT_SLUG_PATTERN: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
  STOREFRONT_TEMPLATE_KEYS: ["catalog", "compact"],
  listAdminStorefronts: (...args: unknown[]) => serviceMocks.listAdminStorefronts(...args),
  getAdminStorefront: (...args: unknown[]) => serviceMocks.getAdminStorefront(...args),
  createStorefront: (...args: unknown[]) => serviceMocks.createStorefront(...args),
  updateStorefront: (...args: unknown[]) => serviceMocks.updateStorefront(...args),
  replaceStorefrontProducts: (...args: unknown[]) => serviceMocks.replaceStorefrontProducts(...args),
  updateStorefrontProductMapping: (...args: unknown[]) => serviceMocks.updateStorefrontProductMapping(...args),
  setDefaultStorefront: (...args: unknown[]) => serviceMocks.setDefaultStorefront(...args),
  deleteStorefront: (...args: unknown[]) => serviceMocks.deleteStorefront(...args),
}));

vi.mock("../services/audit-service", () => ({
  writeAdminAudit: (...args: unknown[]) => writeAdminAudit(...args),
}));

vi.mock("../lib/security", () => ({
  getIpHash: vi.fn().mockResolvedValue("ip-hash"),
}));

function createApp() {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", {} as never);
    await next();
  });
  app.route("/", adminStorefrontRoute);
  return app;
}

describe("adminStorefrontRoute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    writeAdminAudit.mockResolvedValue(undefined);
    serviceMocks.listAdminStorefronts.mockResolvedValue([]);
    serviceMocks.getAdminStorefront.mockResolvedValue(null);
    serviceMocks.createStorefront.mockResolvedValue("sf_software");
    serviceMocks.updateStorefront.mockResolvedValue({ updated: true });
    serviceMocks.replaceStorefrontProducts.mockResolvedValue({ updated: true, count: 1 });
    serviceMocks.updateStorefrontProductMapping.mockResolvedValue({ updated: true });
    serviceMocks.setDefaultStorefront.mockResolvedValue({ updated: true });
    serviceMocks.deleteStorefront.mockResolvedValue({ deleted: true });
  });

  it("normalizes a valid slug and audits storefront creation", async () => {
    serviceMocks.getAdminStorefront.mockResolvedValueOnce({ storefront: { id: "sf_software" }, products: [] });

    const res = await createApp().request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug: " Software-Tools ",
        name: "Software",
        logoUrl: "https://cdn.example.test/logo.png",
        supportEmail: "Support@Example.test",
      }),
    });

    expect(res.status).toBe(201);
    expect(serviceMocks.createStorefront).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      slug: "software-tools",
      supportEmail: "support@example.test",
      templateKey: "compact",
      active: true,
      sortOrder: 100,
    }));
    expect(writeAdminAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "create_storefront",
      targetId: "sf_software",
      ipHash: "ip-hash",
    }));
  });

  it("rejects unsafe branding and unknown fields before service calls", async () => {
    const res = await createApp().request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "bad slug", name: "Bad", logoUrl: "javascript:alert(1)", isDefault: true }),
    });

    expect(res.status).toBe(400);
    expect(serviceMocks.createStorefront).not.toHaveBeenCalled();
    expect(writeAdminAudit).not.toHaveBeenCalled();
  });

  it("accepts a managed same-origin Logo path", async () => {
    serviceMocks.getAdminStorefront.mockResolvedValueOnce({ storefront: { id: "sf_media" }, products: [] });
    const res = await createApp().request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "media", name: "Media", logoUrl: "/api/media/images/123e4567-e89b-42d3-a456-426614174000.webp" }),
    });
    expect(res.status).toBe(201);
    expect(serviceMocks.createStorefront).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      logoUrl: "/api/media/images/123e4567-e89b-42d3-a456-426614174000.webp",
    }));
  });

  it("rejects an arbitrary storefront template before service calls", async () => {
    const res = await createApp().request("/sf_default", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ templateKey: "custom-html" }),
    });

    expect(res.status).toBe(400);
    expect(serviceMocks.updateStorefront).not.toHaveBeenCalled();
  });

  it("returns a conflict for a duplicate slug", async () => {
    serviceMocks.createStorefront.mockRejectedValueOnce(new Error("UNIQUE constraint failed: storefronts.slug"));

    const res = await createApp().request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "software", name: "Software" }),
    });

    expect(res.status).toBe(409);
    expect(writeAdminAudit).not.toHaveBeenCalled();
  });

  it("keeps default-storefront deactivation protection visible to the client", async () => {
    serviceMocks.updateStorefront.mockResolvedValueOnce({ updated: false, reason: "默认展示渠道不可停用" });

    const res = await createApp().request("/sf_default", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active: false }),
    });

    expect(res.status).toBe(409);
    expect(writeAdminAudit).not.toHaveBeenCalled();
  });

  it("replaces product mappings in one request and audits only metadata", async () => {
    const items = [{ productId: "prod-1", visible: true, sortOrder: 10 }];
    const res = await createApp().request("/sf_software/products", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items }),
    });

    expect(res.status).toBe(200);
    expect(serviceMocks.replaceStorefrontProducts).toHaveBeenCalledWith(expect.anything(), "sf_software", items, false);
    expect(writeAdminAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "replace_storefront_products",
      targetId: "sf_software",
      metadata: { count: 1, visibleCount: 1 },
    }));
  });

  it("rejects duplicate products instead of silently deduplicating the request", async () => {
    const item = { productId: "prod-1", visible: true, sortOrder: 10 };
    const res = await createApp().request("/sf_software/products", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: [item, item] }),
    });

    expect(res.status).toBe(400);
    expect(serviceMocks.replaceStorefrontProducts).not.toHaveBeenCalled();
  });

  it("keeps the backend guard for clearing the default storefront", async () => {
    serviceMocks.replaceStorefrontProducts.mockResolvedValueOnce({
      updated: false,
      reason: "默认展示渠道没有可见商品，请明确确认后再保存",
    });

    const res = await createApp().request("/sf_default/products", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: [] }),
    });

    expect(res.status).toBe(409);
    expect(serviceMocks.replaceStorefrontProducts).toHaveBeenCalledWith(expect.anything(), "sf_default", [], false);
    expect(writeAdminAudit).not.toHaveBeenCalled();
  });

  it("updates one product mapping without replacing the entire storefront catalog", async () => {
    const res = await createApp().request("/sf_software/products/prod-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sortOrder: 5 }),
    });

    expect(res.status).toBe(200);
    expect(serviceMocks.updateStorefrontProductMapping).toHaveBeenCalledWith(expect.anything(), "sf_software", "prod-1", { sortOrder: 5 });
    expect(serviceMocks.replaceStorefrontProducts).not.toHaveBeenCalled();
    expect(writeAdminAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "update_storefront_product",
      targetId: "sf_software",
      metadata: { productId: "prod-1", changedFields: ["sortOrder"] },
    }));
  });

  it("audits a successful default switch", async () => {
    const res = await createApp().request("/sf_software/set-default", { method: "POST" });

    expect(res.status).toBe(200);
    expect(serviceMocks.setDefaultStorefront).toHaveBeenCalledWith(expect.anything(), "sf_software");
    expect(writeAdminAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "set_default_storefront",
      targetId: "sf_software",
    }));
  });

  it("does not audit a storefront deletion rejected by historical-order protection", async () => {
    serviceMocks.deleteStorefront.mockResolvedValueOnce({ deleted: false, reason: "该渠道已有历史订单，只能停用" });

    const res = await createApp().request("/sf_software", { method: "DELETE" });

    expect(res.status).toBe(409);
    expect(writeAdminAudit).not.toHaveBeenCalled();
  });
});
