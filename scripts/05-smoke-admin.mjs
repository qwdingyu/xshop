import { newIdempotencyKey, request } from "./http-client.mjs";
import { normalizeOfflinePayHintForSmoke } from "./smoke-system-config.mjs";

/*
 * eshop 管理端 smoke。
 *
 * 用途：
 * - 验证 ADMIN_TOKEN、管理概览、商品创建、卡密导入、manual 订单和管理员确认发卡。
 *
 * 必填环境变量：
 * - ADMIN_TOKEN：与 Worker 环境中的 ADMIN_TOKEN 一致。
 *
 * 可选环境变量：
 * - BASE_URL：目标地址，默认 http://127.0.0.1:8790。
 * - RESOLVE_IP：强制 HTTPS 请求使用指定 IP，只用于排障。
 *
 * 常用命令：
 * - ADMIN_TOKEN="dev-only-change-me" npm run smoke:admin
 */

const adminToken = process.env.ADMIN_TOKEN;
if (!adminToken) throw new Error("缺少 ADMIN_TOKEN");

const headers = { authorization: `Bearer ${adminToken}` };
// Turnstile bypass：如果 Worker 设置了 ALLOW_TURNSTILE_BYPASS_FOR_SMOKE=true，
// 则传入 x-smoke-admin-token（匹配 ADMIN_TOKEN）可绕过人机验证
headers["x-smoke-admin-token"] = adminToken;
const offlineSmokeHeaders = () => ({
  "idempotency-key": newIdempotencyKey(),
  "x-smoke-payment-mode": "offline"
});
const productId = `manual-smoke-${Date.now()}`;
const cardLabel = `${productId}-card`;
const createdOrderIds = [];
const generatedCouponCodes = [];
let productCreated = false;
const storefrontCatalog = await request("/api/products");
const storefrontId = storefrontCatalog.storefront?.id;
if (!storefrontId) throw new Error(`Product catalog missing storefront identity: ${JSON.stringify(storefrontCatalog)}`);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function storefrontStockFor(productId) {
  const storefront = await request("/api/products");
  const product = storefront.products?.find((entry) => entry.id === productId);
  if (!product) throw new Error(`Storefront product missing: ${productId}`);
  return Number(product.stock || 0);
}

await request("/api/admin/summary", { headers });

// 验证管理员系统参数
const sysCfg = await request("/api/admin/system-config", { headers });
if (typeof sysCfg.config?.offline_pay_hint !== "string") {
  throw new Error(`Unexpected admin system-config: ${JSON.stringify(sysCfg)}`);
}
const originalHint = sysCfg.config.offline_pay_hint;
const originalWechatQr = sysCfg.config.offline_pay_qr_wechat || "";
const smokeSafeHint = normalizeOfflinePayHintForSmoke(originalHint);
let systemConfigWechatQrDirty = false;
async function restoreSystemConfig() {
  // 只恢复本脚本为离线支付临时补充的二维码，减少管理端固定窗口限流计数。
  if (systemConfigWechatQrDirty) {
    await request("/api/admin/system-config", {
      method: "PUT",
      headers,
      body: JSON.stringify({ key: "offline_pay_qr_wechat", value: originalWechatQr })
    });
  }
}

async function cleanupSmokeData() {
  for (const code of generatedCouponCodes) {
    await request(`/api/admin/coupons/${encodeURIComponent(code)}`, { method: "DELETE", headers }).catch(() => {});
  }
  for (const orderId of createdOrderIds) {
    await request(`/api/admin/orders/${encodeURIComponent(orderId)}/cancel`, { method: "POST", headers }).catch(() => {});
  }
  if (productCreated) {
    await request(`/api/admin/products/${encodeURIComponent(productId)}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ active: false })
    });
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const storefront = await request("/api/products");
      const stillActive = storefront.products?.some((entry) => entry.id === productId);
      if (!stillActive) return;
      if (attempt < 5) await sleep(500);
    }
    throw new Error(`Smoke product still active after cleanup: ${productId}`);
  }
}
await request("/api/admin/system-config", {
  method: "PUT",
  headers,
  body: JSON.stringify({ key: "offline_pay_hint", value: smokeSafeHint })
});
if (!originalWechatQr) {
  await request("/api/admin/system-config", {
    method: "PUT",
    headers,
    body: JSON.stringify({ key: "offline_pay_qr_wechat", value: "https://example.test/smoke-wechat-qr.png" })
  });
  systemConfigWechatQrDirty = true;
}

try {
const sysCfg2 = await request("/api/admin/system-config", { headers });
if (sysCfg2.config?.offline_pay_hint !== smokeSafeHint || !sysCfg2.config?.offline_pay_qr_wechat) {
  throw new Error("System config update did not persist");
}
// 验证管理员商品列表（含下架商品）
const adminProducts = await request("/api/admin/products", { headers });
if (!Array.isArray(adminProducts.products)) {
  throw new Error(`Admin products should return array: ${JSON.stringify(adminProducts)}`);
}

await request("/api/admin/products", {
  method: "POST",
  headers,
  body: JSON.stringify({
    id: productId,
    title: "Manual Smoke 商品",
    description: "管理端 smoke 自动创建的 manual 商品",
    priceCents: 100,
    currency: "CNY",
    issueMode: "manual",
    active: true
  })
});
productCreated = true;

await request("/api/admin/cards/import", {
  method: "POST",
  headers,
  body: JSON.stringify({
    productId,
    batchName: "admin smoke batch",
    cards: [
      {
        accountLabel: cardLabel,
        deliverySecret: "admin-smoke-secret",
        deliveryNote: "admin smoke note"
      },
      {
        accountLabel: `${cardLabel}-quantity-2-a`,
        deliverySecret: "admin-smoke-secret-quantity-2-a",
        deliveryNote: "admin smoke quantity 2 a"
      },
      {
        accountLabel: `${cardLabel}-quantity-2-b`,
        deliverySecret: "admin-smoke-secret-quantity-2-b",
        deliveryNote: "admin smoke quantity 2 b"
      }
    ]
  })
});

const stockBeforeUnified = await storefrontStockFor(productId);
if (stockBeforeUnified !== 3) {
  throw new Error(`Storefront stock should be 3 after import: ${stockBeforeUnified}`);
}

const unified = await request("/api/pay/unified", {
  method: "POST",
  headers: offlineSmokeHeaders(),
  body: JSON.stringify({
    storefrontId,
    productId,
    buyerEmail: "admin-smoke-quantity-2@example.test",
    quantity: 2,
    turnstileToken: process.env.SMOKE_TURNSTILE_TOKEN || ""
  })
});
if (unified.mode !== "offline" || unified.quantity !== 2 || !unified.orderId) {
  throw new Error(`Unified quantity=2 order failed: ${JSON.stringify(unified)}`);
}
createdOrderIds.push(unified.orderId);

const stockAfterUnified = await storefrontStockFor(productId);
if (stockAfterUnified !== 1) {
  throw new Error(`Storefront stock should update to 1 after quantity=2 lock: ${stockAfterUnified}`);
}

const canceledByUser = await request("/api/pay/offline/cancel", {
  method: "POST",
  body: JSON.stringify({ orderId: unified.orderId, orderToken: unified.orderToken })
});
if (!canceledByUser.canceled || Number(canceledByUser.releasedCards || 0) < 1) {
  throw new Error(`User offline cancel did not release stock: ${JSON.stringify(canceledByUser)}`);
}

const stockAfterCancel = await storefrontStockFor(productId);
if (stockAfterCancel !== 3) {
  throw new Error(`Storefront stock should return to 3 after cancel: ${stockAfterCancel}`);
}

const multiCardOrder = await request("/api/pay/unified", {
  method: "POST",
  headers: offlineSmokeHeaders(),
  body: JSON.stringify({
    storefrontId,
    productId,
    buyerEmail: "admin-smoke-quantity-2-issue@example.test",
    quantity: 2,
    turnstileToken: process.env.SMOKE_TURNSTILE_TOKEN || ""
  })
});
if (multiCardOrder.mode !== "offline" || multiCardOrder.quantity !== 2 || !multiCardOrder.orderId || !multiCardOrder.orderToken) {
  throw new Error(`Unified quantity=2 issue order failed: ${JSON.stringify(multiCardOrder)}`);
}
createdOrderIds.push(multiCardOrder.orderId);

await request(`/api/admin/orders/${multiCardOrder.orderId}/mark-paid`, {
  method: "POST",
  headers
});

const multiCardLookup = await request(`/api/orders/lookup?token=${encodeURIComponent(multiCardOrder.orderToken)}`);
const multiCardSecrets = (multiCardLookup.order?.cards || []).map((card) => card.deliverySecret).sort();
const importedSecrets = new Set([
  "admin-smoke-secret",
  "admin-smoke-secret-quantity-2-a",
  "admin-smoke-secret-quantity-2-b"
]);
if (multiCardLookup.order?.status !== "issued" || multiCardSecrets.length !== 2) {
  throw new Error(`Quantity=2 issued order did not return two cards: ${JSON.stringify(multiCardLookup)}`);
}
if (new Set(multiCardSecrets).size !== 2 || !multiCardSecrets.every((secret) => importedSecrets.has(secret))) {
  throw new Error(`Quantity=2 issued cards are not unique imported cards: ${JSON.stringify(multiCardLookup.order.cards)}`);
}

const stockAfterMultiCardIssue = await storefrontStockFor(productId);
if (stockAfterMultiCardIssue !== 1) {
  throw new Error(`Storefront stock should be 1 after quantity=2 issue: ${stockAfterMultiCardIssue}`);
}

const coupon = await request("/api/admin/coupons/generate", {
  method: "POST",
  headers,
  body: JSON.stringify({
    productId,
    prefix: "SMOKE",
    discountType: "fixed",
    discountValue: 1,
    maxUses: 1,
    active: true
  })
});
const couponCode = coupon.codes?.[0];
if (!couponCode) {
  throw new Error(`Coupon generation did not return a code: ${JSON.stringify(coupon)}`);
}
generatedCouponCodes.push(couponCode);

const created = await request("/api/pay/unified", {
  method: "POST",
  headers: offlineSmokeHeaders(),
  body: JSON.stringify({
    storefrontId,
    productId,
    buyerEmail: "admin-smoke@example.test",
    couponCode,
    turnstileToken: process.env.SMOKE_TURNSTILE_TOKEN || ""
  })
});
if (created.mode !== "offline" || !created.orderId || !created.orderToken) {
  throw new Error(`Offline order should be pending: ${JSON.stringify(created)}`);
}
createdOrderIds.push(created.orderId);

await request(`/api/admin/orders/${created.orderId}/mark-paid`, {
  method: "POST",
  headers
});

// 验证订单详情 API 返回正确的字段名（camelCase + buyerEmail）
const detail = await request(`/api/admin/orders/${created.orderId}`, { headers });
if (!detail.order || !detail.order.buyerEmail || !detail.order.buyerContact || !detail.order.createdAt) {
  throw new Error(`Order detail missing fields: ${JSON.stringify(detail.order)}`);
}
if (!detail.order.productTitle) {
  throw new Error(`Order detail missing productTitle: ${JSON.stringify(detail.order)}`);
}

const lookup = await request(`/api/orders/lookup?token=${encodeURIComponent(created.orderToken)}`);
if (lookup.order.status !== "issued" || !lookup.order.delivery?.deliverySecret) {
  throw new Error(`Admin issue failed: ${JSON.stringify(lookup)}`);
}

console.log(`eshop admin smoke passed: ${created.orderNo} -> ${lookup.order.delivery.accountLabel}`);
} finally {
  let cleanupError;
  try {
    await cleanupSmokeData();
  } catch (error) {
    cleanupError = error;
  }
  await restoreSystemConfig();
  if (cleanupError) throw cleanupError;
}
