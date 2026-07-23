import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { productRoute } from "./products";

const getStorefrontCatalog = vi.fn();
const resolvePublicStorefront = vi.fn();
const getSellableStorefrontProduct = vi.fn();

vi.mock("../services/product-service", () => ({
  toStorefrontProduct: (product: Record<string, unknown>) => ({ ...product, storefront: true }),
}));
vi.mock("../services/storefront-service", () => ({
  getStorefrontCatalog: (...args: unknown[]) => getStorefrontCatalog(...args),
  resolvePublicStorefront: (...args: unknown[]) => resolvePublicStorefront(...args),
  getSellableStorefrontProduct: (...args: unknown[]) => getSellableStorefrontProduct(...args),
}));

const defaultStorefront = { id: "sf_default", slug: "shop", name: "Shop", logoUrl: "", supportEmail: "", isDefault: true, homePath: "/shop" };

function createApp() {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", {} as never);
    await next();
  });
  app.route("/api", productRoute);
  return app;
}

describe("productRoute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getStorefrontCatalog.mockResolvedValue({ storefront: defaultStorefront, products: [], categories: [] });
    resolvePublicStorefront.mockResolvedValue(defaultStorefront);
  });

  it("does not import or touch Workers Cache API for product responses", async () => {
    const cache = {
      match: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };
    vi.stubGlobal("caches", { default: cache });
    getStorefrontCatalog.mockResolvedValueOnce({ storefront: defaultStorefront, products: [{ id: "prod-1", title: "Product 1", stock: 5, priceCents: 100 }], categories: [] });
    getSellableStorefrontProduct.mockResolvedValueOnce({ storefront: defaultStorefront, product: { id: "prod-1", slug: "demo-product", stock: 5, priceCents: 100 } });

    const app = createApp();
    await app.request("/api/products");
    await app.request("/api/products/demo-product");

    expect(cache.match).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
    expect(cache.delete).not.toHaveBeenCalled();
  });

  it("returns product list with live stock on every request", async () => {
    getStorefrontCatalog.mockResolvedValueOnce({ storefront: defaultStorefront, products: [{ id: "prod-1", title: "Product 1" }], categories: [{ id: "cat-1", name: "类别1", count: 1 }] });

    const res = await createApp().request("/api/products");
    const body = await res.json() as { products: Array<{ id: string; storefront?: boolean }>; categories: Array<{ name: string }> };

    expect(res.status).toBe(200);
    expect(body.products).toEqual([{ id: "prod-1", title: "Product 1", storefront: true }]);
    expect(body.categories).toEqual([{ id: "cat-1", name: "类别1", count: 1 }]);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    expect(body).toHaveProperty("storefront", defaultStorefront);
    expect(getStorefrontCatalog).toHaveBeenCalledTimes(1);
  });

  it("does not reuse stale product list stock or price between requests", async () => {
    getStorefrontCatalog
      .mockResolvedValueOnce({ storefront: defaultStorefront, products: [{ id: "prod-1", title: "Product 1", stock: 99, priceCents: 9900 }], categories: [] })
      .mockResolvedValueOnce({ storefront: defaultStorefront, products: [{ id: "prod-1", title: "Product 1", stock: 1, priceCents: 100 }], categories: [] });

    const app = createApp();
    const first = await app.request("/api/products");
    const second = await app.request("/api/products");
    const firstBody = await first.json() as { products: Array<{ stock: number; priceCents: number }> };
    const secondBody = await second.json() as { products: Array<{ stock: number; priceCents: number }> };

    expect(firstBody.products[0].stock).toBe(99);
    expect(firstBody.products[0].priceCents).toBe(9900);
    expect(secondBody.products[0].stock).toBe(1);
    expect(secondBody.products[0].priceCents).toBe(100);
    expect(getStorefrontCatalog).toHaveBeenCalledTimes(2);
  });

  it("returns product detail with live stock on every request", async () => {
    getSellableStorefrontProduct.mockResolvedValueOnce({ storefront: defaultStorefront, product: { id: "prod-1", slug: "demo-product" } });

    const res = await createApp().request("/api/products/demo-product");
    const body = await res.json() as { product: { id: string; storefront?: boolean } };

    expect(res.status).toBe(200);
    expect(body.product).toEqual({ id: "prod-1", slug: "demo-product", storefront: true });
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    expect(getSellableStorefrontProduct).toHaveBeenCalledWith(expect.anything(), "sf_default", "demo-product");
    expect(getSellableStorefrontProduct).toHaveBeenCalledTimes(1);
  });

  it("does not reuse stale product detail stock or price between requests", async () => {
    getSellableStorefrontProduct
      .mockResolvedValueOnce({ storefront: defaultStorefront, product: { id: "prod-1", slug: "demo-product", stock: 99, priceCents: 9900 } })
      .mockResolvedValueOnce({ storefront: defaultStorefront, product: { id: "prod-1", slug: "demo-product", stock: 1, priceCents: 100 } });

    const app = createApp();
    const first = await app.request("/api/products/demo-product");
    const second = await app.request("/api/products/demo-product");
    const firstBody = await first.json() as { product: { stock: number; priceCents: number } };
    const secondBody = await second.json() as { product: { stock: number; priceCents: number } };

    expect(firstBody.product.stock).toBe(99);
    expect(firstBody.product.priceCents).toBe(9900);
    expect(secondBody.product.stock).toBe(1);
    expect(secondBody.product.priceCents).toBe(100);
    expect(getSellableStorefrontProduct).toHaveBeenCalledTimes(2);
  });

  it("returns 404 instead of falling back when a named storefront is inactive or unknown", async () => {
    getStorefrontCatalog.mockResolvedValueOnce(null);
    const res = await createApp().request("/api/products?storefront=missing");
    const body = await res.json() as { details?: { code?: string } };
    expect(res.status).toBe(404);
    expect(body.details?.code).toBe("STOREFRONT_NOT_FOUND");
  });
});
