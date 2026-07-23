import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../bindings";
import { withDbTransaction } from "../db/client";
import { fail, ok, getDb } from "../lib/http";
import { enforceRateLimit, writeRequestLog } from "../lib/rate-limit";
import { verifyTurnstile } from "../lib/security";
import { getCoupon, quoteCoupon, consumeCoupon } from "../services/coupon-service";
import { getProduct } from "../services/product-service";
import { fulfillCardInventory } from "../services/fulfillment-service";
import { writeOrderEvent } from "../services/audit-service";
import { checkProductPurchaseLimitForQuantity, deliveryVisibilityPayload } from "../services/order-service";
import { createOrderNo, createOrderToken, hashOrderToken } from "../lib/token";
import { orders, orderItems } from "../db/schema";
import { readRuntimeConfig, mergeRuntimeConfig } from "../lib/runtime-config";

const redeemSchema = z.object({
  couponCode: z.string().trim().min(2).max(80),
  buyerEmail: z.string().trim().email().max(160),
  turnstileToken: z.string().trim().optional().or(z.literal("")),
});

export const redeemRoute = new Hono<AppEnv>();

class PurchaseLimitExceededError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** 折扣码兑换接口：验证折扣码 → 消耗 → 发卡 → 返回卡密 */
redeemRoute.post("/redeem", async (c) => {
  const limit = await enforceRateLimit(c, "redeem", 5);
  if (!limit.ok) return fail(c, limit.message || "请求过于频繁，请稍后再试", limit.status || 429);

  const body = redeemSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!body.success) {
    await writeRequestLog(c, "redeem", 400, limit.ipHash);
    return fail(c, "请求参数无效", 400);
  }

  const db = getDb(c);
  const dbConfig = await readRuntimeConfig(db, c.env?.CREDENTIALS_ENCRYPTION_KEY);
  const turnstileConfig = mergeRuntimeConfig(dbConfig, c.env);
  const turnstile = await verifyTurnstile(c, body.data.turnstileToken, turnstileConfig);
  if (!turnstile.ok) {
    await writeRequestLog(c, "redeem", 403, limit.ipHash);
    return fail(c, turnstile.message || "安全校验失败", turnstile.status || 403);
  }
  const coupon = await getCoupon(db, body.data.couponCode);
  if (!coupon) {
    return fail(c, "折扣码不存在", 404);
  }
  if (!coupon.productId) {
    return fail(c, "该折扣码未绑定商品，无法兑换", 400);
  }

  const product = await getProduct(db, coupon.productId);
  if (!product) {
    return fail(c, "商品不存在或已下架", 404);
  }
  if (product.fulfillmentMode !== "card") {
    return fail(c, "全额兑换码仅支持卡密商品，请走正常下单流程", 400);
  }

  // 报价验证
  const quote = await quoteCoupon(db, product.priceCents, product.id, body.data.couponCode, product.currency);
  if (!quote.valid) {
    return fail(c, quote.message, 403);
  }
  if (quote.payableCents > 0) {
    return fail(c, "该折扣码不是全额兑换码，请走正常下单支付流程", 402);
  }

  const normalizedBuyerEmail = body.data.buyerEmail.trim().toLowerCase();
  const purchaseLimit = await checkProductPurchaseLimitForQuantity(
    db,
    normalizedBuyerEmail,
    product.id,
    product.purchaseLimit,
    1,
  );
  if (!purchaseLimit.ok) {
    return fail(c, purchaseLimit.message, purchaseLimit.status);
  }

  const emailEnv = mergeRuntimeConfig(dbConfig, c.env);
  const visibilityPayload = deliveryVisibilityPayload({
    deliveryVisibility: product.deliveryVisibility,
    buyerEmail: normalizedBuyerEmail,
    status: "issued",
  });
  // email_only 商品必须先确认邮件服务可用，否则兑换成功后 Web 不返回卡密，用户会失去交付渠道。
  const emailOnly = visibilityPayload.deliveryVisibility === "email_only";
  if (emailOnly && !emailEnv.resendApiKey) {
    return fail(c, "该商品仅通过邮件交付，但邮件服务未配置，请联系管理员", 503, { code: "EMAIL_REQUIRED_FOR_EMAIL_ONLY_DELIVERY" });
  }

  const orderId = crypto.randomUUID();
  const orderNo = createOrderNo();
  const orderToken = createOrderToken();
  const orderTokenHash = await hashOrderToken(orderToken);
  let issuedCard: NonNullable<Awaited<ReturnType<typeof fulfillCardInventory>>>["card"];

  try {
    issuedCard = await withDbTransaction(db, async (tx) => {
      // 全额券兑换必须把限购复查、优惠码消耗、卡密发放、订单快照写入放在同一事务里。
      // 任一环节失败都不能留下“券已用但没发卡”或“已发卡但订单不可查”的半状态。
      const transactionalLimit = await checkProductPurchaseLimitForQuantity(
        tx,
        normalizedBuyerEmail,
        product.id,
        product.purchaseLimit,
        1,
      );
      if (!transactionalLimit.ok) {
        throw new PurchaseLimitExceededError(transactionalLimit.status, transactionalLimit.message);
      }
      const consume = await consumeCoupon(tx, body.data.couponCode);
      if (!consume.success) throw new Error("coupon_consumed");

      const fulfillment = await fulfillCardInventory(tx, orderId, product.id);
      if (!fulfillment?.card) throw new Error("stock_shortage");
      const card = fulfillment.card;
      const nowStr = new Date().toISOString();

      await tx.insert(orders).values({
        id: orderId,
        orderNo,
        productId: product.id,
        orderSource: "coupon_redeem",
        storefrontId: null,
        buyerContact: `redeem:${coupon.code}`,
        buyerEmail: normalizedBuyerEmail,
        quantity: 1,
        amountCents: 0,
        discountCents: product.priceCents,
        currency: product.currency,
        status: "issued",
        fulfillmentMode: "card",
        paymentMethod: "",
        paymentRef: "",
        issueMode: product.issueMode,
        orderTokenHash,
        campaignCode: "",
        referralCode: "",
        couponCode: coupon.code,
        ipHash: limit.ipHash || "",
        userAgent: c.req.header("user-agent") || "",
        createdAt: nowStr,
        paidAt: nowStr,
        issuedAt: nowStr,
        issuedCardId: card.id,
        deliveryVisibility: product.deliveryVisibility,
      });
      await tx.insert(orderItems).values({
        id: crypto.randomUUID(),
        orderId,
        productId: product.id,
        productTitle: product.title,
        fulfillmentMode: "card",
        quantity: 1,
        unitPriceCents: product.priceCents,
        discountCents: product.priceCents,
        amountCents: 0,
        deliveryJson: "",
        createdAt: nowStr,
      });

      return card;
    });
  } catch (orderErr) {
    if (orderErr instanceof PurchaseLimitExceededError) {
      return fail(c, orderErr.message, orderErr.status);
    }
    if (orderErr instanceof Error && orderErr.message === "coupon_consumed") {
      return fail(c, "折扣码已被使用或已过期，请重试", 409);
    }
    if (orderErr instanceof Error && orderErr.message === "stock_shortage") {
      return fail(c, "库存不足，兑换失败", 409);
    }
    console.error("[redeem] transactional redeem failed", orderErr);
    return fail(c, "系统繁忙，兑换失败，请重试", 500);
  }

  await writeOrderEvent(db, orderId, "redeemed", `折扣码兑换发卡成功，卡密: ${issuedCard.id}`);

  if (emailEnv.resendApiKey && normalizedBuyerEmail.includes("@")) {
    const { sendEmail } = await import("../services/email-service");
    const emailPromise = sendEmail(db, emailEnv, {
      to: normalizedBuyerEmail,
      template: "order_issued",
      templateData: {
        orderNo,
        productName: product.title || product.id,
        accountLabel: issuedCard.accountLabel,
        deliverySecret: issuedCard.deliverySecret,
        deliveryNote: issuedCard.deliveryNote || "",
      },
      orderId,
    });
    const executionCtx = c.get("executionCtx");
    if (executionCtx) {
      executionCtx.waitUntil(emailPromise);
    } else {
      emailPromise.catch((e) => console.warn("[email] failed to send redeem notification:", e));
    }
  }

  return ok(c, {
    ok: true,
    orderId,
    orderNo,
    orderToken,
    fulfillmentMode: "card",
    ...visibilityPayload,
    // email_only 不在 API 响应里携带卡密明文，前端只展示邮件交付提示。
    ...(!emailOnly ? { delivery: {
      accountLabel: issuedCard.accountLabel,
      deliverySecret: issuedCard.deliverySecret,
      deliveryNote: issuedCard.deliveryNote || "",
    } } : {}),
  });
});
