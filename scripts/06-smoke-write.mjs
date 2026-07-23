import { newIdempotencyKey, request } from "./http-client.mjs";

/*
 * eshop 写入 smoke。
 *
 * 用途：
 * - 验证商品读取、创建订单、幂等键、订单 token 查询和 direct 发卡闭环。
 *
 * 必填环境变量：
 * - 无。默认 BASE_URL=http://127.0.0.1:8790。
 *
 * 可选环境变量：
 * - BASE_URL：目标地址。
 * - RESOLVE_IP：强制 HTTPS 请求使用指定 IP，只用于排障。
 * - ADMIN_TOKEN：当 direct 库存耗尽时，允许脚本创建 smoke 商品、导入卡密并生成折扣码。
 *
 * 注意：
 * - 本脚本会真实创建订单。
 * - 如果商品是 direct 模式，会消耗一条 available 卡密库存。
 */

const health = await request("/api/health");
if (health.service !== "eshop" || (health.storage !== "d1" && health.storage !== "turso")) {
  throw new Error(`Unexpected health response: ${JSON.stringify(health)}`);
}

let couponCode = ""; // 空字符串 = 无优惠码，不依赖特定优惠券存在
let createdProductId = "";
let adminHeaders = null;

async function cleanupSmokeData() {
  if (!adminHeaders) return;
  if (couponCode) {
    await request(`/api/admin/coupons/${encodeURIComponent(couponCode)}`, { method: "DELETE", headers: adminHeaders }).catch(() => {});
  }
  if (createdProductId) {
    await request(`/api/admin/products/${encodeURIComponent(createdProductId)}`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ active: false }),
    }).catch(() => {});
  }
}

async function createFullDiscountCoupon(productId, priceCents) {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) {
    throw new Error("Direct paid product requires ADMIN_TOKEN to create a full-discount smoke coupon.");
  }
  adminHeaders = { authorization: `Bearer ${adminToken}` };
  const generated = await request("/api/admin/coupons/generate", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      productId,
      prefix: "DIRECT",
      discountType: "fixed",
      discountValue: Math.max(1, Number(priceCents) || 1),
      maxUses: 1,
      active: true
    })
  });
  const code = generated.codes?.[0];
  if (!code) {
    throw new Error(`Coupon generation did not return a code: ${JSON.stringify(generated)}`);
  }
  return code;
}

try {
  const products = await request("/api/products");
  const storefrontId = products.storefront?.id;
  if (!storefrontId) throw new Error(`Product catalog missing storefront identity: ${JSON.stringify(products)}`);
  let available = products.products.find((product) => Number(product.stock) > 0 && product.issueMode === "direct");

  if (!available) {
    const adminToken = process.env.ADMIN_TOKEN;
    if (!adminToken) {
      throw new Error("No direct product with available stock for smoke test. Provide ADMIN_TOKEN to create a smoke fixture.");
    }
    const headers = { authorization: `Bearer ${adminToken}` };
    adminHeaders = headers;
    const productId = `direct-smoke-${Date.now()}`;
    await request("/api/admin/products", {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: productId,
        title: "Direct Smoke 商品",
        description: "写入 smoke 自动创建的 direct 商品",
        priceCents: 100,
        currency: "CNY",
        issueMode: "direct",
        active: true
      })
    });
    createdProductId = productId;
    await request("/api/admin/cards/import", {
      method: "POST",
      headers,
      body: JSON.stringify({
        productId,
        batchName: "direct smoke batch",
        cards: [
          {
            accountLabel: `${productId}-card`,
            deliverySecret: "direct-smoke-secret",
            deliveryNote: "direct smoke note"
          }
        ]
      })
    });
    available = { id: productId, priceCents: 100 };
  }

  if (Number(available.priceCents) > 0) {
    couponCode = await createFullDiscountCoupon(available.id, available.priceCents);
  }

  const idempotencyKey = newIdempotencyKey();
  const buyerEmail = `smoke-${Date.now()}@example.test`;
  const paymentBody = {
    storefrontId,
    productId: available.id,
    buyerEmail,
    couponCode,
    campaignCode: "launch",
    referralCode: "demo",
    turnstileToken: process.env.SMOKE_TURNSTILE_TOKEN || ""
  };
  const order = await request("/api/pay/unified", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(paymentBody)
  });

  if (!order.orderToken) {
    throw new Error(`Order did not return token: ${JSON.stringify(order)}`);
  }
  const immediateDeliverySecret = order.delivery?.deliverySecret || (order.cards || []).find((card) => card.deliverySecret)?.deliverySecret;

  const repeated = await request("/api/pay/unified", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(paymentBody)
  });
  if (repeated.orderId !== order.orderId) {
    throw new Error("Idempotency-Key did not return the original order");
  }

  let mismatchRejected = false;
  try {
    await request("/api/pay/unified", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ ...paymentBody, buyerEmail: "repeat@example.test" })
    });
  } catch (error) {
    mismatchRejected = String(error?.message || error).includes("IDEMPOTENCY_REQUEST_MISMATCH");
  }
  if (!mismatchRejected) {
    throw new Error("Idempotency-Key must reject a changed buyer or payment request");
  }

  if (!immediateDeliverySecret) {
    if (order.mode !== "offline") {
      throw new Error(`Unified order did not return delivery: ${JSON.stringify(order)}`);
    }
    if (!adminHeaders) {
      const adminToken = process.env.ADMIN_TOKEN;
      if (!adminToken) throw new Error("Offline unified smoke order requires ADMIN_TOKEN to confirm payment and issue delivery.");
      adminHeaders = { authorization: `Bearer ${adminToken}` };
    }
    await request(`/api/admin/orders/${encodeURIComponent(order.orderId)}/mark-paid`, {
      method: "POST",
      headers: adminHeaders,
    });
  }

  const lookup = await request(`/api/orders/lookup?token=${encodeURIComponent(order.orderToken)}`);
  if (lookup.order.orderNo !== order.orderNo || !lookup.order.delivery?.deliverySecret) {
    throw new Error(`Lookup did not return issued delivery: ${JSON.stringify(lookup)}`);
  }

  console.log(`eshop write smoke passed: ${order.orderNo} -> ${lookup.order.delivery.accountLabel}`);
} finally {
  await cleanupSmokeData();
}
