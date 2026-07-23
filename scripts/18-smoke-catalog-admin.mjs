import { request } from "./http-client.mjs";

/*
 * 目录/后台录入体验 smoke。
 *
 * 覆盖：
 * - 商品分类配置 CRUD 基础链路
 * - /api/products 返回 categories 契约
 * - 新建商品不传 id，由后端生成 productId
 * - 新建优惠码不传 code，由后端生成 code
 *
 * 必填环境变量：ADMIN_TOKEN。
 */

const adminToken = process.env.ADMIN_TOKEN;
if (!adminToken) throw new Error("缺少 ADMIN_TOKEN");

const headers = { authorization: `Bearer ${adminToken}` };
const stamp = Date.now();
const categoryName = `smoke-category-${stamp}`;
let createdCategoryId = "";
let productId = "";
let couponCode = "";

async function cleanupSmokeData() {
  if (couponCode) {
    await request(`/api/admin/coupons/${encodeURIComponent(couponCode)}`, { method: "DELETE", headers }).catch(() => {});
  }
  if (productId) {
    await request(`/api/admin/products/${encodeURIComponent(productId)}`, { method: "DELETE", headers }).catch(() => {});
  }
  if (createdCategoryId) {
    await request(`/api/admin/product-categories/${encodeURIComponent(createdCategoryId)}`, { method: "DELETE", headers }).catch(() => {});
  }
}

try {

const createdCategory = await request("/api/admin/product-categories", {
  method: "POST",
  headers,
  body: JSON.stringify({ name: categoryName, sortOrder: 7, active: true }),
});
if (!createdCategory.id) {
  throw new Error(`Category creation did not return id: ${JSON.stringify(createdCategory)}`);
}
createdCategoryId = createdCategory.id;

const product = await request("/api/admin/products", {
  method: "POST",
  headers,
  body: JSON.stringify({
    title: `Smoke Auto ID Product ${stamp}`,
    description: "catalog admin smoke product",
    priceCents: 123,
    currency: "CNY",
    fulfillmentMode: "virtual",
    issueMode: "direct",
    salesCopy: "catalog-admin-smoke-delivery",
    category: categoryName,
    active: true,
  }),
});
productId = product.productId;
if (!productId || productId.length < 2) {
  throw new Error(`Product auto id did not look generated: ${JSON.stringify(product)}`);
}

const adminProducts = await request(`/api/admin/products?q=${encodeURIComponent(productId)}`, { headers });
if (!adminProducts.products?.some((entry) => entry.id === productId && entry.category === categoryName)) {
  throw new Error(`Generated product not visible in admin products: ${JSON.stringify(adminProducts)}`);
}

const coupon = await request("/api/admin/coupons", {
  method: "POST",
  headers,
  body: JSON.stringify({
    productId,
    discountType: "fixed",
    discountValue: 1,
    maxUses: 1,
    active: true,
  }),
});
if (!coupon.code) {
  throw new Error(`Coupon auto code did not return code: ${JSON.stringify(coupon)}`);
}
couponCode = coupon.code;

const storefront = await request("/api/products");
if (!Array.isArray(storefront.categories)) {
  throw new Error(`/api/products missing categories array: ${JSON.stringify(storefront)}`);
}
if (!storefront.categories.some((entry) => entry.name === categoryName && Number(entry.count) >= 1)) {
  throw new Error(`Storefront categories missing created category: ${JSON.stringify(storefront.categories)}`);
}

await request(`/api/admin/product-categories/${encodeURIComponent(createdCategory.id)}`, {
  method: "PATCH",
  headers,
  body: JSON.stringify({ sortOrder: 8, active: true }),
});
const categories = await request("/api/admin/product-categories", { headers });
const configured = categories.categories?.find((entry) => entry.id === createdCategory.id);
if (!configured || configured.sortOrder !== 8 || configured.active !== true) {
  throw new Error(`Category patch did not persist: ${JSON.stringify(categories)}`);
}

console.log(`eshop catalog admin smoke passed: ${productId} / ${categoryName} / ${coupon.code}`);
} finally {
  await cleanupSmokeData();
}
