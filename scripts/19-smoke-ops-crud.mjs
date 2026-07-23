import { newIdempotencyKey, request, textRequest } from "./http-client.mjs";

/*
 * 后台运营 CRUD smoke。
 *
 * 覆盖：
 * - 商品编辑
 * - 卡密导入模板、卡密列表、单条禁用/启用、批量禁用/启用
 * - 批次列表和批次编辑
 * - 优惠码生成、编辑、删除
 * - 订单取消、订单导出、财务导出
 * - pending tasks、logs 基础可读
 *
 * 必填环境变量：ADMIN_TOKEN。
 */

const adminToken = process.env.ADMIN_TOKEN;
if (!adminToken) throw new Error("缺少 ADMIN_TOKEN");

const headers = { authorization: `Bearer ${adminToken}` };
const stamp = Date.now();
const productId = `ops-smoke-${stamp}`;
let couponCode = "";
let orderId = "";

async function cleanupOpsData() {
  if (orderId) {
    await request(`/api/admin/orders/${encodeURIComponent(orderId)}/cancel`, { method: "POST", headers }).catch(() => {});
  }
  if (couponCode) {
    await request(`/api/admin/coupons/${encodeURIComponent(couponCode)}`, { method: "DELETE", headers }).catch(() => {});
  }
  await request(`/api/admin/products/${encodeURIComponent(productId)}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ active: false }),
  }).catch(() => {});
}

try {

const storefrontCatalog = await request("/api/products");
const storefrontId = storefrontCatalog.storefront?.id;
if (!storefrontId) throw new Error(`Product catalog missing storefront identity: ${JSON.stringify(storefrontCatalog)}`);

await request("/api/admin/products", {
  method: "POST",
  headers,
  body: JSON.stringify({
    id: productId,
    title: "Ops Smoke 商品",
    description: "ops smoke product",
    priceCents: 100,
    currency: "CNY",
    issueMode: "manual",
    active: true,
  }),
});

await request(`/api/admin/products/${encodeURIComponent(productId)}`, {
  method: "PATCH",
  headers,
  body: JSON.stringify({ title: "Ops Smoke 商品 已编辑", purchaseLimit: 2 }),
});
const editedProducts = await request(`/api/admin/products?q=${encodeURIComponent(productId)}`, { headers });
const editedProduct = editedProducts.products?.find((entry) => entry.id === productId);
if (!editedProduct || editedProduct.title !== "Ops Smoke 商品 已编辑" || editedProduct.purchaseLimit !== 2) {
  throw new Error(`Product patch did not persist: ${JSON.stringify(editedProducts)}`);
}

const template = await textRequest("/api/admin/cards/import-template", { headers });
if (template.statusCode !== 200 || !template.raw.includes("accountLabel")) {
  throw new Error(`Card import template invalid: HTTP ${template.statusCode}`);
}

const imported = await request("/api/admin/cards/import", {
  method: "POST",
  headers,
  body: JSON.stringify({
    productId,
    batchName: "ops smoke batch",
    cards: [
      { accountLabel: `${productId}-card-1`, deliverySecret: `${productId}-secret-1`, deliveryNote: "ops smoke 1" },
      { accountLabel: `${productId}-card-2`, deliverySecret: `${productId}-secret-2`, deliveryNote: "ops smoke 2" },
    ],
  }),
});
if (!imported.batchId || imported.imported !== 2) {
  throw new Error(`Card import unexpected: ${JSON.stringify(imported)}`);
}

const cards = await request(`/api/admin/cards?productId=${encodeURIComponent(productId)}&limit=20`, { headers });
if (!Array.isArray(cards.results) || cards.results.length < 2) {
  throw new Error(`Cards list missing imported cards: ${JSON.stringify(cards)}`);
}
const cardIds = cards.results.slice(0, 2).map((entry) => entry.id).filter(Boolean);
if (cardIds.length < 2) throw new Error(`Imported card ids missing: ${JSON.stringify(cards.results)}`);

await request(`/api/admin/cards/${encodeURIComponent(cardIds[0])}`, {
  method: "PATCH",
  headers,
  body: JSON.stringify({ status: "disabled" }),
});
await request("/api/admin/cards/batch-disable", {
  method: "POST",
  headers,
  body: JSON.stringify({ ids: cardIds, status: "available" }),
});

const batches = await request(`/api/admin/batches?productId=${encodeURIComponent(productId)}`, { headers });
const batch = batches.results?.find((entry) => entry.id === imported.batchId);
if (!batch) throw new Error(`Batch list missing imported batch: ${JSON.stringify(batches)}`);
await request(`/api/admin/batches/${encodeURIComponent(imported.batchId)}`, {
  method: "PATCH",
  headers,
  body: JSON.stringify({ name: "ops smoke batch edited", note: "ops smoke note" }),
});

const coupon = await request("/api/admin/coupons/generate", {
  method: "POST",
  headers,
  body: JSON.stringify({ productId, prefix: "OPS", discountType: "fixed", discountValue: 1, maxUses: 1, active: true }),
});
couponCode = coupon.codes?.[0] || "";
if (!couponCode) throw new Error(`Coupon generation failed: ${JSON.stringify(coupon)}`);
await request(`/api/admin/coupons/${encodeURIComponent(couponCode)}`, {
  method: "PATCH",
  headers,
  body: JSON.stringify({ maxUses: 2, active: true }),
});
const coupons = await request(`/api/admin/coupons?productId=${encodeURIComponent(productId)}`, { headers });
if (!coupons.results?.some((entry) => entry.code === couponCode && entry.maxUses === 2)) {
  throw new Error(`Coupon patch/list failed: ${JSON.stringify(coupons)}`);
}

const order = await request("/api/pay/unified", {
  method: "POST",
  headers: { "Idempotency-Key": newIdempotencyKey() },
  body: JSON.stringify({
    storefrontId,
    productId,
    buyerEmail: "ops-smoke@example.test",
    couponCode,
    turnstileToken: process.env.SMOKE_TURNSTILE_TOKEN || "",
  }),
});
if (order.mode !== "offline" || !order.orderId || !order.orderToken) {
  throw new Error(`Expected pending manual order: ${JSON.stringify(order)}`);
}
orderId = order.orderId;
await request(`/api/admin/orders/${encodeURIComponent(order.orderId)}/cancel`, { method: "POST", headers });
const canceled = await request(`/api/admin/orders/${encodeURIComponent(order.orderId)}`, { headers });
if (canceled.order?.status !== "canceled") {
  throw new Error(`Order cancel failed: ${JSON.stringify(canceled)}`);
}

const ordersExport = await textRequest(`/api/admin/orders/export?productId=${encodeURIComponent(productId)}&format=csv`, { headers });
if (ordersExport.statusCode !== 200 || !ordersExport.raw.includes("orderNo")) {
  throw new Error(`Orders export invalid: HTTP ${ordersExport.statusCode}`);
}
const financeExport = await textRequest(`/api/admin/finance/export?format=csv`, { headers });
if (financeExport.statusCode !== 200 || !financeExport.raw.includes("orderNo")) {
  throw new Error(`Finance export invalid: HTTP ${financeExport.statusCode}`);
}

await request("/api/admin/pending-tasks", { headers });
const logs = await request(`/api/admin/logs?targetId=${encodeURIComponent(productId)}&limit=5`, { headers });
if (!Array.isArray(logs.logs)) {
  throw new Error(`Logs endpoint invalid: ${JSON.stringify(logs)}`);
}

const verifiedCouponCode = couponCode;
await request(`/api/admin/coupons/${encodeURIComponent(couponCode)}`, { method: "DELETE", headers });
couponCode = "";

console.log(`eshop ops crud smoke passed: ${productId} / ${imported.batchId} / ${verifiedCouponCode}`);
} finally {
  await cleanupOpsData();
}
