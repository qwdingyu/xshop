import { newIdempotencyKey, request, textRequest } from "./http-client.mjs";

/*
 * Core inventory closure smoke.
 *
 * This intentionally exercises the user-facing checkout state machine instead
 * of only checking admin CRUD:
 * - storefront list/detail stock reflects imported inventory
 * - /api/pay/unified rejects quantity greater than live stock
 * - pending offline orders lock all requested cards immediately
 * - locked stock disappears from storefront responses
 * - user cancellation releases stock immediately
 * - the same product can be ordered again after cancellation
 *
 * Required env:
 * - ADMIN_TOKEN
 *
 * Side effects:
 * - creates one smoke product, imports two cards, creates/cancels two orders,
 *   then deactivates the smoke product in finally.
 */

const adminToken = process.env.ADMIN_TOKEN;
if (!adminToken) throw new Error("缺少 ADMIN_TOKEN");

const adminHeaders = { authorization: `Bearer ${adminToken}` };
const stamp = Date.now();
const productId = `inventory-smoke-${stamp}`;
const virtualProductId = `inventory-virtual-smoke-${stamp}`;
const buyerEmail = `inventory-smoke-${stamp}@example.test`;
const createdOrderIds = [];
let originalWechatQr = null;
let originalAlipayQr = null;
const storefrontCatalog = await request("/api/products");
const storefrontId = storefrontCatalog.storefront?.id;
if (!storefrontId) throw new Error(`Product catalog missing storefront identity: ${JSON.stringify(storefrontCatalog)}`);

async function cleanupInventorySmokeData() {
  for (const orderId of createdOrderIds) {
    await request(`/api/admin/orders/${encodeURIComponent(orderId)}/cancel`, {
      method: "POST",
      headers: adminHeaders,
    }).catch(() => {});
  }
  await request(`/api/admin/products/${encodeURIComponent(productId)}`, {
    method: "PATCH",
    headers: adminHeaders,
    body: JSON.stringify({ active: false }),
  }).catch(() => {});
  await request(`/api/admin/products/${encodeURIComponent(virtualProductId)}`, {
    method: "PATCH",
    headers: adminHeaders,
    body: JSON.stringify({ active: false }),
  }).catch(() => {});
  if (originalWechatQr !== null) {
    await request("/api/admin/system-config", {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify({ key: "offline_pay_qr_wechat", value: originalWechatQr }),
    }).catch(() => {});
  }
  if (originalAlipayQr !== null) {
    await request("/api/admin/system-config", {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify({ key: "offline_pay_qr_alipay", value: originalAlipayQr }),
    }).catch(() => {});
  }
}

async function getStorefrontProduct(expectedStock) {
  const [list, detail] = await Promise.all([
    request("/api/products"),
    request(`/api/products/${encodeURIComponent(productId)}`),
  ]);
  const product = list.products?.find((entry) => entry.id === productId);
  if (!product) {
    throw new Error(`Storefront product missing from list: ${JSON.stringify(list)}`);
  }
  const detailProduct = detail.product;
  if (!detailProduct || detailProduct.id !== productId) {
    throw new Error(`Storefront product detail mismatch: ${JSON.stringify(detail)}`);
  }
  if (Number(product.stock) !== expectedStock || Number(detailProduct.stock) !== expectedStock) {
    throw new Error(`Storefront stock mismatch, expected ${expectedStock}, got list=${product.stock}, detail=${detailProduct.stock}`);
  }
  return product;
}

async function assertNoStore(path) {
  const response = await textRequest(path);
  if (response.statusCode !== 200) {
    throw new Error(`${path} returned HTTP ${response.statusCode}: ${response.raw.slice(0, 200)}`);
  }
  const cacheControl = String(response.headers["cache-control"] || "");
  if (!cacheControl.includes("no-store")) {
    throw new Error(`${path} must use no-store live-stock headers, got: ${cacheControl || "<missing>"}`);
  }
}

async function expectUnifiedFailure(quantity, expectedStatus, expectedMessage) {
  const response = await textRequest("/api/pay/unified", {
    method: "POST",
    headers: { "Idempotency-Key": newIdempotencyKey() },
    body: JSON.stringify({
      storefrontId,
      productId,
      buyerEmail: `fail-${quantity}-${buyerEmail}`,
      quantity,
      turnstileToken: process.env.SMOKE_TURNSTILE_TOKEN || "",
    }),
  });

  let data;
  try {
    data = JSON.parse(response.raw || "{}");
  } catch {
    throw new Error(`/api/pay/unified failure returned non-json: ${response.raw.slice(0, 200)}`);
  }
  if (response.statusCode !== expectedStatus || data.ok !== false || !String(data.error || "").includes(expectedMessage)) {
    throw new Error(`Expected unified failure HTTP ${expectedStatus} ${expectedMessage}, got HTTP ${response.statusCode}: ${JSON.stringify(data)}`);
  }
}

async function createOfflineOrder(quantity, suffix) {
  const order = await request("/api/pay/unified", {
    method: "POST",
    headers: { "Idempotency-Key": newIdempotencyKey() },
    body: JSON.stringify({
      storefrontId,
      productId,
      buyerEmail: `${suffix}-${buyerEmail}`,
      quantity,
      turnstileToken: process.env.SMOKE_TURNSTILE_TOKEN || "",
    }),
  });
  if (order.mode !== "offline" || !order.orderId || !order.orderToken || order.quantity !== quantity) {
    throw new Error(`Expected offline order quantity=${quantity}: ${JSON.stringify(order)}`);
  }
  createdOrderIds.push(order.orderId);
  return order;
}

async function createOfflineOrderForProduct(targetProductId, quantity, suffix) {
  const order = await request("/api/pay/unified", {
    method: "POST",
    headers: { "Idempotency-Key": newIdempotencyKey() },
    body: JSON.stringify({
      storefrontId,
      productId: targetProductId,
      buyerEmail: `${suffix}-${buyerEmail}`,
      quantity,
      turnstileToken: process.env.SMOKE_TURNSTILE_TOKEN || "",
    }),
  });
  if (order.mode !== "offline" || !order.orderId || !order.orderToken || order.quantity !== quantity) {
    throw new Error(`Expected offline order for ${targetProductId} quantity=${quantity}: ${JSON.stringify(order)}`);
  }
  createdOrderIds.push(order.orderId);
  return order;
}

async function assertVirtualProductNoInventoryPurchase() {
  await request("/api/admin/products", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      id: virtualProductId,
      title: "Inventory Virtual Smoke 商品",
      description: "virtual product must not depend on card inventory",
      salesCopy: "virtual-smoke-delivery",
      priceCents: 100,
      currency: "CNY",
      issueMode: "manual",
      fulfillmentMode: "virtual",
      purchaseLimit: 2,
      active: true,
    }),
  });

  const detail = await request(`/api/products/${encodeURIComponent(virtualProductId)}`);
  const product = detail.product;
  if (!product || product.fulfillmentMode !== "virtual" || product.requiresInventory !== false || product.canPurchase !== true || product.isOutOfStock !== false) {
    throw new Error(`Virtual product storefront contract invalid: ${JSON.stringify(detail)}`);
  }
  if (Number(product.stock || 0) !== 0 || Number(product.availableStock || 0) !== 0) {
    throw new Error(`Virtual product should expose zero card stock without being sold out: ${JSON.stringify(product)}`);
  }

  const order = await createOfflineOrderForProduct(virtualProductId, 2, "virtual-no-card-stock");
  const canceled = await request("/api/pay/offline/cancel", {
    method: "POST",
    body: JSON.stringify({ orderId: order.orderId, orderToken: order.orderToken }),
  });
  if (!canceled.canceled || Number(canceled.releasedCards) !== 0) {
    throw new Error(`Virtual product cancellation should not release cards: ${JSON.stringify(canceled)}`);
  }
}

try {
  const sysCfg = await request("/api/admin/system-config", { headers: adminHeaders });
  originalWechatQr = sysCfg.config?.offline_pay_qr_wechat || "";
  originalAlipayQr = sysCfg.config?.offline_pay_qr_alipay || "";
  if (!originalWechatQr && !originalAlipayQr) {
    await request("/api/admin/system-config", {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify({ key: "offline_pay_qr_wechat", value: "https://example.test/inventory-smoke-wechat-qr.png" }),
    });
  }

  await request("/api/admin/products", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      id: productId,
      title: "Inventory Closure Smoke 商品",
      description: "inventory closure smoke product",
      priceCents: 100,
      currency: "CNY",
      issueMode: "manual",
      fulfillmentMode: "card",
      active: true,
    }),
  });

  await request("/api/admin/cards/import", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      productId,
      batchName: "inventory closure smoke batch",
      cards: [
        { accountLabel: `${productId}-card-1`, deliverySecret: `${productId}-secret-1`, deliveryNote: "inventory smoke 1" },
        { accountLabel: `${productId}-card-2`, deliverySecret: `${productId}-secret-2`, deliveryNote: "inventory smoke 2" },
      ],
    }),
  });

  await assertNoStore("/api/products");
  await assertNoStore(`/api/products/${encodeURIComponent(productId)}`);
  await getStorefrontProduct(2);

  await expectUnifiedFailure(3, 409, "当前商品库存不足");

  const firstOrder = await createOfflineOrder(2, "first-lock");
  await getStorefrontProduct(0);
  await expectUnifiedFailure(1, 409, "当前商品库存不足");

  const canceled = await request("/api/pay/offline/cancel", {
    method: "POST",
    body: JSON.stringify({ orderId: firstOrder.orderId, orderToken: firstOrder.orderToken }),
  });
  if (!canceled.canceled || Number(canceled.releasedCards) !== 2) {
    throw new Error(`User cancellation did not release both cards: ${JSON.stringify(canceled)}`);
  }
  await getStorefrontProduct(2);

  const secondOrder = await createOfflineOrder(2, "second-lock");
  await getStorefrontProduct(0);
  const adminCanceled = await request(`/api/admin/orders/${encodeURIComponent(secondOrder.orderId)}/cancel`, {
    method: "POST",
    headers: adminHeaders,
  });
  if (Number(adminCanceled.releasedCards) !== 2) {
    throw new Error(`Admin cancellation did not release both cards: ${JSON.stringify(adminCanceled)}`);
  }
  await getStorefrontProduct(2);

  await assertVirtualProductNoInventoryPurchase();

  console.log(`eshop inventory closure smoke passed: ${productId}`);
} finally {
  await cleanupInventorySmokeData();
}
