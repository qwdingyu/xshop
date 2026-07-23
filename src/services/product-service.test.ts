import { describe, it, expect } from "vitest";
import { toPublicProduct, toStorefrontProduct } from "./product-service";
import type { ProductRow } from "./product-service";

// Note: listProducts and getProduct depend on Drizzle ORM and D1,
// so we only test the pure functions (toPublicProduct, parseTags) here.

// parseTags is not exported, but toPublicProduct uses it internally.
// We test it through toPublicProduct.

describe("toPublicProduct", () => {
  const baseRow: ProductRow = {
    id: "prod-1",
    slug: "my-product",
    title: "Test Product",
    description: "A test product",
    salesCopy: "Buy now!",
    coverUrl: "https://example.com/cover.jpg",
    tagsJson: '["tag1","tag2"]',
    priceCents: 5000,
    currency: "CNY",
    issueMode: "manual",
    fulfillmentMode: "card",
    active: 1,
    stock: 10,
    category: "software",
    purchaseLimit: null,
    purchaseLimitDisplay: 0,
    deliveryVisibility: "web_and_email",
    stockDisplayMode: "exact",
  };

  it("maps all fields correctly", () => {
    const result = toPublicProduct(baseRow);
    expect(result.id).toBe("prod-1");
    expect(result.slug).toBe("my-product");
    expect(result.title).toBe("Test Product");
    expect(result.priceCents).toBe(5000);
    expect(result.currency).toBe("CNY");
    expect(result.issueMode).toBe("manual");
    expect(result.fulfillmentMode).toBe("card");
    expect(result.stock).toBe(10);
    expect(result.active).toBe(true);
    expect(result.category).toBe("software");
    expect(result.purchaseLimitDisplay).toBe(false);
    expect(result.deliveryVisibility).toBe("web_and_email");
  });

  it("publishes the purchase-limit display switch separately from the limit value", () => {
    const result = toPublicProduct({ ...baseRow, purchaseLimit: 2, purchaseLimitDisplay: 1 });

    expect(result.purchaseLimit).toBe(2);
    expect(result.purchaseLimitDisplay).toBe(true);
  });

  it("exposes email-only delivery visibility without changing stock semantics", () => {
    const result = toPublicProduct({ ...baseRow, deliveryVisibility: "email_only" });
    expect(result.deliveryVisibility).toBe("email_only");
    expect(result.canPurchase).toBe(true);
  });

  it("publishes a normalized generic fulfillment input configuration", () => {
    const result = toStorefrontProduct(toPublicProduct({
      ...baseRow,
      fulfillmentInputType: "account",
      fulfillmentInputLabel: "充值账号",
      fulfillmentInputHint: "请勿填写密码",
      fulfillmentInputRequired: 1,
    }));

    expect(result).toMatchObject({
      fulfillmentInputType: "account",
      fulfillmentInputLabel: "充值账号",
      fulfillmentInputHint: "请勿填写密码",
      fulfillmentInputRequired: true,
    });
    expect(result).not.toHaveProperty("salesCopy");
  });

  it("keeps existing products backward compatible with no fulfillment input", () => {
    expect(toPublicProduct(baseRow)).toMatchObject({
      fulfillmentInputType: "none",
      fulfillmentInputLabel: "",
      fulfillmentInputHint: "",
      fulfillmentInputRequired: false,
    });
  });

  it("uses id as slug when slug is null", () => {
    const row = { ...baseRow, slug: null };
    const result = toPublicProduct(row);
    expect(result.slug).toBe("prod-1");
  });

  it("parses tagsJson correctly", () => {
    const result = toPublicProduct(baseRow);
    expect(result.tags).toEqual(["tag1", "tag2"]);
  });

  it("handles empty tagsJson", () => {
    const row = { ...baseRow, tagsJson: "[]" };
    const result = toPublicProduct(row);
    expect(result.tags).toEqual([]);
  });

  it("handles invalid tagsJson gracefully", () => {
    const row = { ...baseRow, tagsJson: "not-json" };
    const result = toPublicProduct(row);
    expect(result.tags).toEqual([]);
  });

  it("filters non-string tags", () => {
    const row = { ...baseRow, tagsJson: '[1, "valid", null, {"key":"val"}, "also-valid"]' };
    const result = toPublicProduct(row);
    expect(result.tags).toEqual(["valid", "also-valid"]);
  });

  it("converts active=0 to false", () => {
    const row = { ...baseRow, active: 0 };
    const result = toPublicProduct(row);
    expect(result.active).toBe(false);
  });

  it("converts stock to number", () => {
    const row = { ...baseRow, stock: "5" as unknown as number };
    const result = toPublicProduct(row);
    expect(result.stock).toBe(5);
  });

  it("handles zero stock", () => {
    const row = { ...baseRow, stock: 0 };
    const result = toPublicProduct(row);
    expect(result.stock).toBe(0);
    expect(result.availableStock).toBe(0);
    expect(result.requiresInventory).toBe(true);
    expect(result.canPurchase).toBe(false);
    expect(result.isOutOfStock).toBe(true);
  });

  it("keeps non-card products purchasable without card inventory", () => {
    const row = { ...baseRow, fulfillmentMode: "virtual" as const, stock: 0 };
    const result = toPublicProduct(row);

    expect(result.stock).toBe(0);
    expect(result.availableStock).toBe(0);
    expect(result.requiresInventory).toBe(false);
    expect(result.canPurchase).toBe(true);
    expect(result.isOutOfStock).toBe(false);
    expect(result.isLowStock).toBe(false);
  });

  it("defaults empty category", () => {
    const row = { ...baseRow, category: "" };
    const result = toPublicProduct(row);
    expect(result.category).toBe("");
  });

  it("removes delivery-only salesCopy from storefront responses", () => {
    const publicProduct = toPublicProduct({
      ...baseRow,
      salesCopy: "https://example.test/private-download",
      fulfillmentMode: "virtual",
    });
    const storefrontProduct = toStorefrontProduct(publicProduct);

    expect(storefrontProduct).not.toHaveProperty("salesCopy");
    expect(storefrontProduct.title).toBe("Test Product");
  });

  it("removes exact stock fields in availability-only mode", () => {
    const storefrontProduct = toStorefrontProduct(toPublicProduct({
      ...baseRow,
      stock: 2,
      stockDisplayMode: "availability_only",
    }));

    expect(storefrontProduct.stockDisplayMode).toBe("availability_only");
    expect(storefrontProduct).not.toHaveProperty("stock");
    expect(storefrontProduct).not.toHaveProperty("availableStock");
    expect(storefrontProduct.canPurchase).toBe(true);
    expect(storefrontProduct).toHaveProperty("isLowStock", true);
  });

  it("removes stock and low-stock signals in hidden mode but keeps purchase availability", () => {
    const storefrontProduct = toStorefrontProduct(toPublicProduct({
      ...baseRow,
      stock: 2,
      stockDisplayMode: "hidden",
    }));

    expect(storefrontProduct.stockDisplayMode).toBe("hidden");
    expect(storefrontProduct).not.toHaveProperty("stock");
    expect(storefrontProduct).not.toHaveProperty("availableStock");
    expect(storefrontProduct).not.toHaveProperty("isLowStock");
    expect(storefrontProduct.canPurchase).toBe(true);
    expect(storefrontProduct.isOutOfStock).toBe(false);
  });
});
