import { Hono } from "hono";
import { z } from "zod";
import { fail, ok, getDb, safeJsonBody } from "../lib/http";
import type { AppEnv } from "../bindings";
import { enforceRateLimit } from "../lib/rate-limit";
import { getOrderByToken, getOrderSummariesByEmail } from "../services/order-service";
import { getProduct } from "../services/product-service";
import { quoteCoupon } from "../services/coupon-service";
import { getEmailAccessSecret, verifyEmailAccessCode } from "../lib/email-access";
import { productIdSchema } from "../lib/product-id";
import { getActiveStorefrontById } from "../services/storefront-service";
import { isBasePriceFree } from "../../shared/checkout-policy";

const quoteSchema = z.object({
  productId: productIdSchema,
  storefrontId: z.string().trim().min(1).max(120),
  quantity: z.coerce.number().int().min(1).max(99).optional().default(1),
  couponCode: z.string().trim().max(40).optional().or(z.literal(""))
});

export const orderRoute = new Hono<AppEnv>();

orderRoute.post("/coupons/quote", async (c) => {
  // 折扣码报价接口增加限流，防止暴力枚举折扣码
  const limit = await enforceRateLimit(c, "coupon_quote", 20);
  if (!limit.ok) return fail(c, limit.message || "请求过于频繁，请稍后再试", limit.status || 429);

  const body = quoteSchema.safeParse(await safeJsonBody(c));
  if (!body.success) return fail(c, "请求参数无效", 400, body.error.flatten());
  const db = getDb(c);
  const storefront = await getActiveStorefrontById(db, body.data.storefrontId);
  if (!storefront) return fail(c, "展示渠道不存在或已停用", 404, { code: "STOREFRONT_NOT_FOUND" });
  const product = await getProduct(db, body.data.productId, storefront.id);
  if (!product) return fail(c, "商品不存在或已下架", 404);
  // 报价接口与统一下单必须采用同一免费商品边界，避免前端显示“优惠码有效”后又被下单接口拒绝。
  if (isBasePriceFree(product.priceCents)) {
    return fail(c, "免费商品无需使用折扣码", 400, { code: "FREE_PRODUCT_COUPON_UNSUPPORTED" });
  }
  const baseAmountCents = product.priceCents * body.data.quantity;
  const quote = await quoteCoupon(db, baseAmountCents, product.id, body.data.couponCode, product.currency);
  return ok(c, { storefrontId: storefront.id, priceCents: product.priceCents, quantity: body.data.quantity, ...quote });
});

orderRoute.post("/orders", async (c) => {
  await enforceRateLimit(c, "create_order", 8);
  return fail(c, "旧下单接口已停用，请使用统一支付接口 /api/pay/unified", 410, { code: "LEGACY_ORDER_DISABLED" });
});

orderRoute.get("/orders/lookup", async (c) => {
  c.header("Cache-Control", "no-store");
  // Token 是单笔订单的高熵 Bearer 凭据；GET 只服务安全链接，不能再接收邮箱等身份信息。
  const limit = await enforceRateLimit(c, "order_lookup", 10);
  if (!limit.ok) return fail(c, limit.message || "请求过于频繁，请稍后再试", limit.status || 429);

  const token = c.req.query("token")?.trim();
  if (token) {
    const order = await getOrderByToken(getDb(c), token);
    if (!order) return fail(c, "订单不存在，或安全链接已失效", 404);
    return ok(c, { order });
  }

  return fail(c, "请使用订单安全链接", 400);
});

orderRoute.post("/orders/lookup", async (c) => {
  c.header("Cache-Control", "no-store");
  const emailLookupLimit = await enforceRateLimit(c, "order_lookup_email", 5);
  if (!emailLookupLimit.ok) return fail(c, emailLookupLimit.message || "请求过于频繁，请稍后再试", emailLookupLimit.status || 429);

  // 邮箱放在 JSON 请求体而不是 URL，避免进入浏览器历史、Referrer 和常规访问日志。
  const body = z.object({
    email: z.string().trim().email().max(160),
  }).safeParse(await safeJsonBody(c));
  if (!body.success) return fail(c, "邮箱格式无效", 400, body.error.flatten());

  const normalizedEmail = body.data.email.toLowerCase();
  const emailAccessSecret = getEmailAccessSecret(c.env.ADMIN_TOKEN, c.req.url);
  if (!emailAccessSecret) {
    return fail(c, "邮箱验证服务未安全配置，请联系管理员", 503, { code: "EMAIL_ACCESS_UNAVAILABLE" });
  }
  const mailboxVerified = await verifyEmailAccessCode(
    normalizedEmail,
    c.req.header("x-email-access-code")?.trim(),
    emailAccessSecret,
  );
  if (!mailboxVerified) {
    return fail(c, "邮箱验证码无效或已过期", 403, { code: "EMAIL_VERIFICATION_REQUIRED" });
  }

  // 邮箱验证码已经证明邮箱归属，订单号不再充当低熵的伪第二因子。
  // 服务层只选择摘要字段，不能把该入口升级成卡密交付凭据。
  const orders = await getOrderSummariesByEmail(getDb(c), normalizedEmail, 20);
  return ok(c, { orders });
});
