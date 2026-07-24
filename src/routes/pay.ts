import { Hono } from "hono";
import { z } from "zod";
import { fail, ok, getOrigin, normalizeCode, getDb, safeJsonBody } from "../lib/http";
import { FULFILLMENT_MODES, type AppEnv } from "../bindings";
import { withDbTransaction, type DbType } from "../db/client";
import { getProduct } from "../services/product-service";
import type { DeliveryVisibility } from "../../shared/product-contract";
import { normalizeOrderStatus } from "../../shared/order-status";
import { checkAndExpireOrder, checkBalanceOrderRateLimit, checkFreeClaimOrderRateLimit, checkOrderRateLimit, checkProductPurchaseLimitForQuantity, deliveryVisibilityPayload, markPaidAndIssue, redactItemDeliveries } from "../services/order-service";
import { consumeCoupon, quoteCoupon, releaseCouponReservation } from "../services/coupon-service";
import { writeOrderEvent } from "../services/audit-service";
import { enforceRateLimit, writeRequestLog } from "../lib/rate-limit";
import { createOrderToken, hashOrderToken } from "../lib/token";
import { isAuthorizedSmokeRequest, verifyTurnstile } from "../lib/security";
import { checkIdempotency, clearCachedIdempotentResponse, clearPendingIdempotency, hashIdempotencyRequest, IDEMPOTENCY_PENDING_LEASE_MS, isStrongIdempotencyKey, saveIdempotentResponse } from "../lib/idempotency";
import { releaseLockedCardByOrder } from "../services/issue-service";
import { lockFulfillmentInventoryItems } from "../services/fulfillment-service";
import { orders, cards, orderItems, products as productsTable } from "../db/schema";
import type { FulfillmentMode } from "../bindings";
import { eq, and, inArray, or, sql } from "drizzle-orm";
import { getOrderExpireMinutes, isBalancePaymentEnabled, readSystemConfigMap } from "../lib/system-config-registry";
import {
  createDbProviderRegistry,
  createDbProviderRegistryForCallback,
  selectOnlineProviderForCurrency,
  isValidProviderName,
  EasyPayProviderError,
  isAmbiguousEasyPayProviderError,
  easyPayPayTypeLabel,
  normalizeEasyPayPayType,
  normalizeEasyPayEnabledPayTypes,
} from "../services/payments";
import { deductBalance, getUserBalance, refundBalance } from "../services/voucher-service";
import { mergeRuntimeConfig, readRuntimeConfig, type RuntimeConfig } from "../lib/runtime-config";
import { getEmailAccessSecret, verifyEmailAccessCode } from "../lib/email-access";
import { normalizeSecurePaymentUrl } from "../lib/payment-url";
import { productIdSchema } from "../lib/product-id";
import { getClientIp } from "@usethink/cf-core";
import {
  didPaymentHappenBeforeExpiry,
  inferEasyPayPaidAt,
  reconcileOnlineOrderPayment,
  restoreVerifiedExpiredPayment,
  type TimedPaymentStatus,
} from "../services/payment-reconciliation-service";
import { formatMoney, minorToMajorString, normalizeCurrencyCode, tryNormalizeCurrencyCode } from "../../shared/money";
import {
  getActiveStorefrontById,
  validateStorefrontProductMapping,
  type PublicStorefront,
} from "../services/storefront-service";
import {
  effectivePurchaseLimitForProduct,
  getFreeProductCheckoutViolation,
  hasValidEmailAccessCode,
  isBasePriceFree,
  type FreeProductCheckoutViolation,
} from "../../shared/checkout-policy";
import { serializeFulfillmentInputSnapshot, validateFulfillmentInput } from "../../shared/fulfillment-input";

/**
 * 订单履约模式快照：老订单可能只有 orders.fulfillment_mode，
 * 新订单以 order_items.fulfillment_mode 为准，避免商品后台改模式后重新解释历史订单。
 */
const orderFulfillmentModeSnapshot = sql<string>`COALESCE(
  (SELECT ${orderItems.fulfillmentMode}
   FROM ${orderItems}
   WHERE ${orderItems.orderId} = ${orders.id}
   ORDER BY ${orderItems.createdAt} ASC
   LIMIT 1),
  ${orders.fulfillmentMode}
)`;

/** 合法的发卡模式枚举值 */
export const VALID_ISSUE_MODES = ["direct", "manual"] as const;

/** 统一下单请求体 Schema；线下支付创建也统一经由 /pay/unified。 */
const PayOrderSchema = z.object({
  productId: productIdSchema,
  // 交易必须绑定稳定渠道 ID；URL slug 和“当前默认渠道”都可能在订单恢复期间变化。
  storefrontId: z.string().trim().min(1).max(120),
  quantity: z.coerce.number().int().min(1).max(99).optional().default(1),
  couponCode: z.string().trim().max(80).optional().or(z.literal("")),
  buyerEmail: z.string().trim().email().max(160),
  turnstileToken: z.string().trim().optional().or(z.literal("")),
  campaignCode: z.string().trim().max(80).optional().or(z.literal("")),
  referralCode: z.string().trim().max(80).optional().or(z.literal("")),
  fulfillmentInput: z.string().trim().max(200).optional().or(z.literal("")),
  /** 余额支付标记：为 true 时使用 user_balances 余额支付，跳过外部支付渠道 */
  balancePayment: z.boolean().optional().default(false),
  paymentChannel: z.enum(["alipay", "wxpay", "qqpay"]).optional(),
  emailAccessCode: z.string().trim().regex(/^\d{6}$/).optional().or(z.literal("")),
});

const IDEMPOTENCY_REPLAY_AFTER_FIELD = "_idempotencyReplayAfter";

/**
 * 免费商品请求错误使用稳定代码，前端和 API 调用方可据此清理过期的待恢复请求。
 * 文案集中定义，避免不同分支对同一业务约束给出互相矛盾的提示。
 * 邮箱验证码已改为全商品门禁，不再放在本表。
 */
const FREE_PRODUCT_CHECKOUT_ERRORS: Record<FreeProductCheckoutViolation, { code: string; message: string }> = {
  quantity: {
    code: "FREE_PRODUCT_QUANTITY_INVALID",
    message: "免费商品每次只能领取 1 件",
  },
  coupon: {
    code: "FREE_PRODUCT_COUPON_UNSUPPORTED",
    message: "免费商品无需使用折扣码",
  },
  payment_method: {
    code: "FREE_PRODUCT_PAYMENT_METHOD_UNSUPPORTED",
    message: "免费商品无需选择在线支付或余额支付",
  },
};

class ProductPurchaseLimitError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

class StorefrontProductUnavailableError extends Error {
  constructor() {
    super("商品已不属于当前展示渠道或渠道已停用");
  }
}

async function assertStorefrontProductSellable(
  db: DbType,
  storefrontId: string,
  productId: string,
): Promise<PublicStorefront> {
  const storefront = await validateStorefrontProductMapping(db, storefrontId, productId);
  if (!storefront) throw new StorefrontProductUnavailableError();
  return storefront;
}

async function assertProductPurchaseLimit(
  db: DbType,
  buyerEmail: string,
  product: { id: string; priceCents?: number; purchaseLimit?: number | null },
  quantity: number,
): Promise<void> {
  const effectiveLimit = effectivePurchaseLimitForProduct(product.priceCents ?? 0, product.purchaseLimit);
  if (!effectiveLimit) return;
  const result = await checkProductPurchaseLimitForQuantity(db, buyerEmail, product.id, effectiveLimit, quantity);
  if (!result.ok) throw new ProductPurchaseLimitError(result.status, result.message);
}

function buildPendingDeliveryJson(product: { title: string; salesCopy?: string | null; fulfillmentMode: FulfillmentMode }): string {
  if (product.fulfillmentMode === "card") return "";
  return JSON.stringify({
    accountLabel: product.title,
    deliverySecret: product.salesCopy || "",
    deliveryNote: "已交付",
  });
}

const OFFLINE_PAYMENT_CONFIG_KEYS = [
  "offline_pay_qr_wechat",
  "offline_pay_qr_alipay",
  "offline_pay_hint",
] as const;

/** 线下支付默认提示：仅在后台未配置或历史布尔脏值时兜底，不覆盖管理员自定义文案。 */
const DEFAULT_OFFLINE_PAY_HINT = "请扫码付款，并在转账备注中填写付款备注码。付款后提交微信/支付宝交易单号后 4 位，便于管理员核对。";

async function readOfflinePaymentConfig(db: DbType): Promise<Record<(typeof OFFLINE_PAYMENT_CONFIG_KEYS)[number], string>> {
  return readSystemConfigMap(db, [...OFFLINE_PAYMENT_CONFIG_KEYS]) as Promise<Record<(typeof OFFLINE_PAYMENT_CONFIG_KEYS)[number], string>>;
}

function hasOfflinePaymentQr(config: Record<string, string>): boolean {
  return Boolean(config.offline_pay_qr_wechat?.trim() || config.offline_pay_qr_alipay?.trim());
}

function normalizeOfflinePayHint(value: string | undefined): string {
  const text = (value || "").trim();
  // 兼容早期把 offline_pay_hint 当开关保存成 true/false 的数据，避免前台直接展示布尔字符串。
  if (!text || /^true(?:\s|$)/i.test(text) || /^false(?:\s|$)/i.test(text)) return DEFAULT_OFFLINE_PAY_HINT;
  return text;
}

export function normalizePaymentRedirectUrl(value: string | undefined): string {
  return normalizeSecurePaymentUrl(value);
}

function isSafeQrImageSrc(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  // 只允许常见位图 data URL；不接受 data:image/svg+xml，避免把可执行 SVG 当二维码图片下发到前端。
  if (/^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(trimmed)) return trimmed;
  return normalizePaymentRedirectUrl(trimmed);
}

function stringFromRaw(raw: Record<string, unknown> | undefined, key: string): string {
  const value = raw?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function extractPaymentEntry(payResult: {
  qrCode?: string;
  redirectUrl?: string;
  raw?: Record<string, unknown>;
}): { qrImageUrl: string; qrContent: string; redirectUrl: string } {
  const raw = payResult.raw || {};
  const rawQrContent = stringFromRaw(raw, "qrContent") || stringFromRaw(raw, "qrcode");
  const rawQrImageUrl = stringFromRaw(raw, "qrImageUrl") || stringFromRaw(raw, "img");
  const legacyQrCode = payResult.qrCode?.trim() || "";

  // EasyPay 官方字段语义：img 是二维码图片 URL，qrcode 是二维码内容/链接。
  // 前端 <img> 只接收已确认的图片来源；qrcode 若是 HTTPS 链接，只作为跳转入口兜底。
  const qrImageUrl = isSafeQrImageSrc(rawQrImageUrl)
    || (legacyQrCode && legacyQrCode !== rawQrContent ? isSafeQrImageSrc(legacyQrCode) : "");
  const redirectUrl = normalizePaymentRedirectUrl(payResult.redirectUrl)
    || normalizePaymentRedirectUrl(rawQrContent);

  return {
    qrImageUrl,
    qrContent: rawQrContent,
    redirectUrl,
  };
}

function extractPaymentChannel(providerName: string, payResult: { raw?: Record<string, unknown> }): {
  paymentChannel: string;
  paymentChannelLabel: string;
} {
  if (providerName !== "easypay") return { paymentChannel: "", paymentChannelLabel: "" };
  const payType = normalizeEasyPayPayType(payResult.raw?.payType);
  return {
    paymentChannel: payType,
    paymentChannelLabel: easyPayPayTypeLabel(payType),
  };
}

function publicEasyPayMethodsFromProvider(provider: unknown) {
  const enabledPayTypes = (provider && typeof provider === "object" && "enabledPayTypes" in provider)
    ? (provider as { enabledPayTypes?: unknown }).enabledPayTypes
    : undefined;
  const defaultPayType = (provider && typeof provider === "object" && "defaultPayType" in provider)
    ? (provider as { defaultPayType?: unknown }).defaultPayType
    : "alipay";
  const enabled = normalizeEasyPayEnabledPayTypes(enabledPayTypes, defaultPayType);
  const normalizedDefault = normalizeEasyPayPayType(defaultPayType);
  const ordered = enabled.includes(normalizedDefault)
    ? [normalizedDefault, ...enabled.filter((payType) => payType !== normalizedDefault)]
    : enabled;
  return ordered.map((payType) => ({
    provider: "easypay",
    channel: payType,
    label: easyPayPayTypeLabel(payType),
  }));
}

type PaymentCreationRecoveryInput = {
  provider: string;
  orderId: string;
  orderNo: string;
  orderToken: string;
  amountCents: number;
  productId: string;
  storefrontId?: string;
  productTitle: string;
  quantity: number;
  currency: string;
  fulfillmentMode: FulfillmentMode;
  expiresAt: string;
  expireMinutes: number;
  status: string;
};

export function buildPaymentCreationRecoveryResponse(input: PaymentCreationRecoveryInput) {
  return {
    mode: "online" as const,
    provider: input.provider,
    orderId: input.orderId,
    orderNo: input.orderNo,
    orderToken: input.orderToken,
    amountCents: input.amountCents,
    productId: input.productId,
    storefrontId: input.storefrontId,
    productTitle: input.productTitle,
    quantity: input.quantity,
    currency: input.currency,
    fulfillmentMode: input.fulfillmentMode,
    qrcode: "",
    redirectUrl: "",
    expiresAt: input.expiresAt,
    expireMinutes: input.expireMinutes,
    status: input.status,
    message: input.status === "pending"
      ? "支付渠道响应异常，正在确认订单状态"
      : "订单支付状态已变更，正在查询订单结果",
  };
}

export function parseCachedIdempotentSuccessResponse(cachedResponse: string): Record<string, unknown> {
  const parsed = JSON.parse(cachedResponse) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("幂等响应格式无效");
  }
  return { ...(parsed as Record<string, unknown>), ok: true };
}

async function releaseOrderCouponReservation(db: DbType, orderId: string): Promise<void> {
  const [order] = await db
    .select({ couponCode: orders.couponCode })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  if (order?.couponCode) await releaseCouponReservation(db, order.couponCode);
}

async function failPendingOrderAndRelease(db: DbType, orderId: string, fulfillmentMode: FulfillmentMode) {
  return withDbTransaction(db, async (tx) => {
    const failed = await tx
      .update(orders)
      .set({ status: "failed" })
      .where(and(eq(orders.id, orderId), eq(orders.status, "pending")));
    if (failed.rowsAffected === 0) return { closed: false as const, releasedCards: 0 };

    const releasedCards = fulfillmentMode === "card"
      ? await releaseLockedCardByOrder(tx, orderId)
      : 0;
    await releaseOrderCouponReservation(tx, orderId);
    return { closed: true as const, releasedCards };
  });
}

async function readOrderStatus(db: DbType, orderId: string): Promise<string | null> {
  const [order] = await db
    .select({ status: orders.status })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  return order?.status || null;
}

class BalanceOrderStateConflictError extends Error {}
class BalanceDeductionFailedError extends Error {}

function isInternalSettlementProvider(provider: string | null | undefined): boolean {
  return provider === "balance" || provider === "free";
}

async function chargePendingInternalOrder(
  db: DbType,
  orderId: string,
  buyerEmail: string,
  payableCents: number,
  productTitle: string,
): Promise<void> {
  await withDbTransaction(db, async (tx) => {
    const claimed = await tx
      .update(orders)
      .set({ status: "paid", paidAt: new Date().toISOString() })
      .where(and(
        eq(orders.id, orderId),
        eq(orders.status, "pending"),
        inArray(orders.paymentProvider, ["balance", "free"]),
      ));
    if (claimed.rowsAffected === 0) throw new BalanceOrderStateConflictError();

    const deducted = payableCents === 0 || await deductBalance(tx, buyerEmail, payableCents, {
      referenceType: "order",
      referenceId: orderId,
      note: `余额支付购买 ${productTitle}`,
    });
    if (!deducted) throw new BalanceDeductionFailedError();
  });
}

async function compensateFailedInternalOrder(
  db: DbType,
  orderId: string,
  buyerEmail: string,
  payableCents: number,
  fulfillmentMode: FulfillmentMode,
  issueFailureMessage: string,
) {
  return withDbTransaction(db, async (tx) => {
    const failed = await tx
      .update(orders)
      .set({ status: "failed" })
      .where(and(
        eq(orders.id, orderId),
        eq(orders.status, "paid"),
        inArray(orders.paymentProvider, ["balance", "free"]),
      ));
    if (failed.rowsAffected === 0) return { compensated: false as const, releasedCards: 0 };

    if (payableCents > 0) {
      await refundBalance(tx, buyerEmail, payableCents, {
        referenceType: "order",
        referenceId: orderId,
        note: `余额支付发卡失败退款：${issueFailureMessage}`,
      });
    }
    const releasedCards = fulfillmentMode === "card"
      ? await releaseLockedCardByOrder(tx, orderId)
      : 0;
    await releaseOrderCouponReservation(tx, orderId);
    return { compensated: true as const, releasedCards };
  });
}

async function ensureOfflinePaymentReady(db: DbType): Promise<Record<(typeof OFFLINE_PAYMENT_CONFIG_KEYS)[number], string> | null> {
  const config = await readOfflinePaymentConfig(db);
  config.offline_pay_hint = normalizeOfflinePayHint(config.offline_pay_hint);
  return hasOfflinePaymentQr(config) ? config : null;
}

/**
 * 向 orders 表插入一条订单记录（Drizzle ORM）。
 * 被 /pay/unified（线上/线下降级）共用；履约输入在上层完成校验，
 * 此处只保存不可变快照，不再按商品当前配置解释。
 */
export async function createOrderRecord(
  db: DbType,
  orderId: string,
  orderNo: string,
  productId: string,
  productTitle: string,
  fulfillmentMode: FulfillmentMode,
  buyerContact: string,
  buyerEmail: string,
  quantity: number,
  unitPriceCents: number,
  payableCents: number,
  discountCents: number,
  currency: string,
  paymentMethod: "online" | "offline",
  issueMode: string,
  campaignCode: string | undefined,
  referralCode: string | undefined,
  couponCode: string,
  ipHash: string | undefined,
  userAgent: string,
  orderTokenHash: string,
  expiresAt: string,
  paymentProvider?: string,
  deliveryJson = "",
  deliveryVisibility: DeliveryVisibility = "web_and_email",
  storefront?: PublicStorefront,
  fulfillmentInputJson = "",
) {
  await db.insert(orders).values({
    id: orderId,
    orderNo,
    productId,
    orderSource: "storefront",
    storefrontId: storefront?.id || null,
    storefrontSlugSnapshot: storefront?.slug || "",
    storefrontNameSnapshot: storefront?.name || "",
    buyerContact,
    buyerEmail,
    quantity,
    amountCents: payableCents,
    discountCents,
    currency,
    status: "pending",
    fulfillmentMode,
    paymentMethod,
    paymentProvider: paymentProvider || "",
    issueMode,
    campaignCode: campaignCode || "",
    referralCode: referralCode || "",
    couponCode,
    ipHash: ipHash || "",
    userAgent,
    orderTokenHash,
    expiresAt,
    deliveryJson,
    fulfillmentInputJson,
    deliveryVisibility,
    createdAt: new Date().toISOString(),
  });
  await db.insert(orderItems).values({
    id: crypto.randomUUID(),
    orderId,
    productId,
    productTitle,
    fulfillmentMode,
    quantity,
    unitPriceCents,
    discountCents,
    amountCents: payableCents,
    deliveryJson,
    createdAt: new Date().toISOString(),
  });
}

/**
 * 创建线下支付订单（内部函数，Drizzle ORM）。
 */
type OfflineOrderResult = {
  orderId: string;
  orderNo: string;
  orderToken: string;
  offlineNoteCode: string;
  expiresAt: string;
  expireMinutes: number;
};

export async function createOfflineOrder(
  db: DbType,
  product: { id: string; currency: string; title: string; priceCents: number; fulfillmentMode: FulfillmentMode; salesCopy?: string | null; purchaseLimit?: number | null; deliveryVisibility?: DeliveryVisibility },
  buyerEmail: string,
  quantity: number,
  payableCents: number,
  discountCents: number,
  issueMode: string,
  campaignCode: string | undefined,
  referralCode: string | undefined,
  couponCode: string,
  ipHash: string | undefined,
  userAgent: string,
  env?: RuntimeConfig,
  executionCtx?: ExecutionContext,
  onOrderCreated?: (tx: DbType, result: OfflineOrderResult) => Promise<void>,
  storefront?: PublicStorefront,
  fulfillmentInputJson = "",
): Promise<OfflineOrderResult> {
  const orderId = crypto.randomUUID();
  const orderNo = createPayOrderNo();
  const orderToken = createOrderToken();
  const orderTokenHash = await hashOrderToken(orderToken);
  const expireMinutes = await getOrderExpireMinutes(db);
  const expiresAt = new Date(Date.now() + expireMinutes * 60 * 1000).toISOString();
  const offlineNoteCode = createOfflineNoteCode();
  const deliveryJson = buildPendingDeliveryJson(product);

  try {
    await withDbTransaction(db, async (tx) => {
      const verifiedStorefront = storefront
        ? await assertStorefrontProductSellable(tx, storefront.id, product.id)
        : undefined;
      await assertProductPurchaseLimit(tx, buyerEmail, product, quantity);
      if (couponCode) {
        const couponResult = await consumeCoupon(tx, couponCode);
        if (!couponResult.success) throw new Error("优惠码已被他人使用或已失效，请重试");
      }
      const lockedCard = product.fulfillmentMode !== "card"
        ? { mode: "virtual" as const, inventoryIds: [] }
        : await lockFulfillmentInventoryItems(tx, orderId, product.id, expiresAt, quantity);
      if (!lockedCard) throw new Error("当前商品库存不足");
      await createOrderRecord(
        tx, orderId, orderNo, product.id, product.title, product.fulfillmentMode, offlineNoteCode,
        buyerEmail, quantity, product.priceCents, payableCents, discountCents, product.currency,
        "offline", issueMode, campaignCode, referralCode, couponCode,
        ipHash, userAgent, orderTokenHash, expiresAt, undefined, deliveryJson,
        product.deliveryVisibility || "web_and_email",
        verifiedStorefront,
        fulfillmentInputJson,
      );
      if (onOrderCreated) {
        await onOrderCreated(tx, { orderId, orderNo, orderToken, offlineNoteCode, expiresAt, expireMinutes });
      }
    });
  } catch (err) {
    // 渠道映射可能在用户打开付款弹窗后被后台移除。该领域异常必须原样上抛，
    // 由统一支付入口返回可识别的 409；包装为通用错误会错误升级成 500。
    if (err instanceof StorefrontProductUnavailableError) throw err;
    if (err instanceof ProductPurchaseLimitError) throw err;
    if (err instanceof Error && err.message === "当前商品库存不足") throw err;
    if (err instanceof Error && err.message === "优惠码已被他人使用或已失效，请重试") throw err;
    throw new Error("订单创建失败，请稍后重试");
  }

  await writeOrderEvent(db, orderId, "created", "线下支付订单已创建，等待管理员确认收款");

  // 线下支付下单后发邮件通知买家（异步，不阻塞主流程）
  if (env?.resendApiKey && buyerEmail && buyerEmail.includes("@")) {
    const { sendEmail } = await import("../services/email-service");
    const emailPromise = sendEmail(db, env, {
      to: buyerEmail,
      template: "order_pending",
      templateData: {
        orderNo,
        productName: product.title,
        price: minorToMajorString(payableCents, product.currency),
        currency: product.currency,
      },
      orderId
    });
    if (executionCtx) {
      executionCtx.waitUntil(emailPromise);
    } else {
      emailPromise.catch((e) => console.warn("[email] failed to send offline order notification:", e));
    }
  }

  return { orderId, orderNo, orderToken, offlineNoteCode, expiresAt, expireMinutes };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 站内即时结算处理
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 站内即时结算处理函数，同时承接余额支付和免费订单。
 *
 * balance：查询余额、原子扣减，再进入履约。
 * free：仅把 pending 原子推进为 paid，再进入履约；不得读取或修改用户余额。
 *
 * 设计要点：
 * - 扣减余额与 pending -> paid 在同一事务内提交，避免中断或重试导致重复扣款
 * - 发卡成功后邮件通知（由 markPaidAndIssue 内部处理）
 * - 发卡失败仅通过 paid -> failed CAS 补偿，避免覆盖并发完成的 issued 状态 */
export async function handleInternalSettlement(
  db: DbType,
  orderId: string,
  buyerEmail: string,
  payableCents: number,
  product: { id: string; title: string; fulfillmentMode: FulfillmentMode; deliveryVisibility?: string | null },
  env?: RuntimeConfig,
  executionCtx?: ExecutionContext,
): Promise<{ ok: boolean; status: number; message: string }> {
  const [order] = await db
    .select({
      id: orders.id,
      status: orders.status,
      paymentProvider: orders.paymentProvider,
      buyerEmail: orders.buyerEmail,
      fulfillmentMode: orderFulfillmentModeSnapshot,
    })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!order) return { ok: false, status: 404, message: "订单不存在" };
  if (order.buyerEmail !== buyerEmail) return { ok: false, status: 403, message: "订单归属校验失败" };
  if (!isInternalSettlementProvider(order.paymentProvider)) return { ok: false, status: 400, message: "非站内即时结算订单" };
  const isFreeSettlement = order.paymentProvider === "free";
  const settlementSuccessMessage = isFreeSettlement ? "免费订单领取成功" : "余额支付成功";
  if (isFreeSettlement && payableCents !== 0) {
    return { ok: false, status: 409, message: "免费订单金额异常，请联系管理员" };
  }
  // 站内结算失败时是否释放卡密，必须按订单快照判断，不能按商品当前模式判断。
  const orderFulfillmentMode = FULFILLMENT_MODES.includes(order.fulfillmentMode as FulfillmentMode)
    ? order.fulfillmentMode as FulfillmentMode
    : product.fulfillmentMode;
  if (order.status === "issued") return { ok: true, status: 200, message: settlementSuccessMessage };
  if (!["pending", "paid"].includes(order.status)) return { ok: false, status: 409, message: "订单状态不可站内结算" };

  if (order.status === "pending") {
    if (!isFreeSettlement) {
      const balance = await getUserBalance(db, buyerEmail);
      if (balance.balanceCents < payableCents) {
        const closure = await failPendingOrderAndRelease(db, orderId, orderFulfillmentMode);
        if (closure.closed) {
          await writeOrderEvent(db, orderId, "balance_payment_failed", "余额不足，订单已关闭并释放库存");
          return { ok: false, status: 402, message: `余额不足：当前余额 ${formatMoney(balance.balanceCents, "CNY")}，需要 ${formatMoney(payableCents, "CNY")}` };
        }
      }
    }
    if (isFreeSettlement || (await readOrderStatus(db, orderId)) === "pending") {
      try {
        await chargePendingInternalOrder(db, orderId, buyerEmail, payableCents, product.title);
      } catch (error) {
        if (error instanceof BalanceDeductionFailedError) {
          const closure = await failPendingOrderAndRelease(db, orderId, orderFulfillmentMode);
          if (closure.closed) {
            await writeOrderEvent(db, orderId, "balance_payment_failed", "余额扣减失败，订单已关闭并释放库存");
            return { ok: false, status: 409, message: "余额扣减失败，请重试" };
          }
        } else if (!(error instanceof BalanceOrderStateConflictError)) {
          throw error;
        }
      }
    }

    const currentStatus = await readOrderStatus(db, orderId);
    if (currentStatus === "issued") return { ok: true, status: 200, message: settlementSuccessMessage };
    if (currentStatus !== "paid") return { ok: false, status: 409, message: "订单状态已变更，请刷新后重试" };
  }

  const issueResult = await markPaidAndIssue(db, orderId, env, executionCtx);
  if (issueResult.ok) return { ok: true, status: 200, message: settlementSuccessMessage };

  const compensation = await compensateFailedInternalOrder(
    db,
    orderId,
    buyerEmail,
    payableCents,
    orderFulfillmentMode,
    issueResult.message,
  );
  if (compensation.compensated) {
    await writeOrderEvent(
      db,
      orderId,
      isFreeSettlement ? "free_fulfillment_failed" : "balance_refunded",
      isFreeSettlement
        ? `免费订单交付失败，订单已关闭：${issueResult.message}`
        : `余额支付发卡失败，已自动退回余额：${issueResult.message}`,
    );
    const recoveryMessage = payableCents > 0 ? "余额已自动退回" : "订单已关闭";
    return { ok: false, status: 409, message: `发卡失败：${issueResult.message}。${recoveryMessage}，请稍后重试` };
  }

  const currentStatus = await readOrderStatus(db, orderId);
  if (currentStatus === "issued") return { ok: true, status: 200, message: settlementSuccessMessage };
  if (currentStatus === "failed") {
    const failureClosure = isFreeSettlement ? "订单已关闭" : "余额已自动退回";
    return { ok: false, status: 409, message: `发卡失败：${issueResult.message}。${failureClosure}，请稍后重试` };
  }
  const unresolvedState = isFreeSettlement ? "免费订单状态异常" : "余额已扣减";
  return { ok: false, status: issueResult.status, message: `发卡失败：${issueResult.message}。${unresolvedState}，请联系管理员处理` };
}

export const payRoute = new Hono<AppEnv>();

payRoute.get("/pay/methods", async (c) => {
  c.header("Cache-Control", "no-store, no-cache, must-revalidate");
  c.header("Pragma", "no-cache");
  c.header("Expires", "0");
  const db = getDb(c);
  const registry = await createDbProviderRegistry(c.env, db, c.env.CREDENTIALS_ENCRYPTION_KEY);
  const easyPayProvider = registry.get("easypay");
  return ok(c, {
    methods: easyPayProvider ? publicEasyPayMethodsFromProvider(easyPayProvider) : [],
  });
});

/** 统一下单接口：自动判断线上/线下支付，前端无需感知差异 */
payRoute.post("/pay/unified", async (c) => {
  const body = PayOrderSchema.safeParse(await safeJsonBody(c));
  if (!body.success) {
    const limit = await enforceRateLimit(c, "pay_unified", 8);
    await writeRequestLog(c, "pay_unified", 400, limit.ipHash);
    return fail(c, "请求参数无效", 400, body.error.flatten());
  }

  // 幂等键是“下单、锁库存、创建外部支付”的调用凭证，只接受标准请求头这一处来源。
  // 先校验协议再执行邮箱验证和数据库查询，避免无效创建请求进入任何有状态业务分支。
  const rawIdempotencyKey = c.req.header("Idempotency-Key")?.trim() || "";
  if (!rawIdempotencyKey) {
    const invalidLimit = await enforceRateLimit(c, "pay_unified", 8);
    await writeRequestLog(c, "pay_unified", 400, invalidLimit.ipHash);
    if (!invalidLimit.ok) {
      return fail(c, invalidLimit.message || "请求过于频繁，请稍后再试", invalidLimit.status || 429);
    }
    return fail(c, "缺少 Idempotency-Key 请求头", 400, { code: "IDEMPOTENCY_KEY_REQUIRED" });
  }
  if (rawIdempotencyKey.length > 120) {
    const invalidLimit = await enforceRateLimit(c, "pay_unified", 8);
    await writeRequestLog(c, "pay_unified", 400, invalidLimit.ipHash);
    if (!invalidLimit.ok) {
      return fail(c, invalidLimit.message || "请求过于频繁，请稍后再试", invalidLimit.status || 429);
    }
    return fail(c, "Idempotency-Key 长度不能超过 120 个字符", 400);
  }
  if (!isStrongIdempotencyKey(rawIdempotencyKey)) {
    const invalidLimit = await enforceRateLimit(c, "pay_unified", 8);
    await writeRequestLog(c, "pay_unified", 400, invalidLimit.ipHash);
    if (!invalidLimit.ok) {
      return fail(c, invalidLimit.message || "请求过于频繁，请稍后再试", invalidLimit.status || 429);
    }
    return fail(c, "Idempotency-Key 必须是 UUID 或至少 32 位 URL 安全随机字符串", 400);
  }

  const db = getDb(c);
  // 订单仍存用户填写的小写邮箱；限购/限流在 order-service 内再做 canonical。
  const normalizedBuyerEmail = body.data.buyerEmail.trim().toLowerCase();
  const emailAccessCode = (body.data.emailAccessCode || "").trim();
  // 全商品结账均需邮箱验证码：在幂等缓存读取前完成归属校验，避免未验证邮箱读到含交付内容的缓存。
  if (body.data.balancePayment) {
    const authLimit = await enforceRateLimit(c, "balance_payment_auth", 8);
    if (!authLimit.ok) return fail(c, authLimit.message || "请求过于频繁，请稍后再试", authLimit.status || 429);
    if (!(await isBalancePaymentEnabled(db))) {
      await writeRequestLog(c, "balance_payment_auth", 403, authLimit.ipHash);
      return fail(c, "余额支付未启用，请选择其它支付方式", 403, { code: "BALANCE_PAYMENT_DISABLED" });
    }
  }
  {
    if (!hasValidEmailAccessCode(emailAccessCode)) {
      return fail(c, "请先完成邮箱验证码校验", 403, { code: "EMAIL_VERIFICATION_REQUIRED" });
    }
    const emailAccessSecret = getEmailAccessSecret(c.env.ADMIN_TOKEN, c.req.url);
    if (!emailAccessSecret) {
      return fail(c, "邮箱验证服务未安全配置，请联系管理员", 503, { code: "EMAIL_ACCESS_UNAVAILABLE" });
    }
    const mailboxVerified = await verifyEmailAccessCode(normalizedBuyerEmail, emailAccessCode, emailAccessSecret);
    if (!mailboxVerified) {
      const logAction = body.data.balancePayment ? "balance_payment_auth" : "pay_unified_email_auth";
      await writeRequestLog(c, logAction, 403);
      return fail(c, "邮箱验证码无效或已过期", 403, { code: "EMAIL_VERIFICATION_REQUIRED" });
    }
  }
  // 幂等哈希绑定验证码；成功缓存重放仍会再验码（码过期即拒绝）。
  const idempotencyKey = rawIdempotencyKey;
  // 即使是缓存命中也先经过基础限流，限制对幂等能力凭证的在线猜测。
  const limit = await enforceRateLimit(c, "pay_unified", 8);
  if (!limit.ok) {
    return fail(c, limit.message || "请求过于频繁，请稍后再试", limit.status || 429);
  }

  const requestedSmokePaymentMode = c.req.header("x-smoke-payment-mode") === "offline" ? "offline" : "auto";
  const idempotencyRequestHash = await hashIdempotencyRequest({
    balancePayment: body.data.balancePayment,
    buyerEmail: normalizedBuyerEmail,
    // 将验证码纳入幂等指纹：换码/空码不能复用同一键读取含交付内容的缓存。
    emailAccessCode,
    campaignCode: normalizeCode(body.data.campaignCode),
    couponCode: normalizeCode(body.data.couponCode),
    paymentChannel: body.data.paymentChannel || "",
    productId: body.data.productId,
    storefrontId: body.data.storefrontId,
    quantity: body.data.quantity,
    referralCode: normalizeCode(body.data.referralCode),
    fulfillmentInput: body.data.fulfillmentInput || "",
    ...(requestedSmokePaymentMode === "offline" ? { smokePaymentMode: "offline" } : {}),
  });
  // 幂等租约覆盖“下单 + 锁库存 + 调用支付渠道”的整段流程，防止重复点击生成多笔待付订单。
  const idem = await checkIdempotency(db, idempotencyKey, "pay_unified", idempotencyRequestHash);
  if (idem.requestMismatch) {
    return fail(c, "Idempotency-Key 已用于不同的支付请求", 409, { code: "IDEMPOTENCY_REQUEST_MISMATCH" });
  }
  if (idem.pending) return fail(c, "支付订单正在处理中，请稍后查询结果", 409, { code: "IDEMPOTENCY_PENDING" });
  if (!idem.shouldProceed && idem.cachedResponse) {
    const cached = parseCachedIdempotentSuccessResponse(idem.cachedResponse);
    const replayAfter = typeof cached[IDEMPOTENCY_REPLAY_AFTER_FIELD] === "string"
      ? Date.parse(cached[IDEMPOTENCY_REPLAY_AFTER_FIELD])
      : Number.NaN;
    delete cached[IDEMPOTENCY_REPLAY_AFTER_FIELD];
    if (Number.isFinite(replayAfter) && replayAfter > Date.now()) {
      return fail(c, "支付订单正在处理中，请稍后重试", 409, { code: "IDEMPOTENCY_PENDING" });
    }
    // 入口已先验码；重放再验一次，防止验证码窗口在首次成功后过期仍被缓存重放。
    const emailAccessSecret = getEmailAccessSecret(c.env.ADMIN_TOKEN, c.req.url);
    if (!emailAccessSecret) {
      return fail(c, "邮箱验证服务未安全配置，请联系管理员", 503, { code: "EMAIL_ACCESS_UNAVAILABLE" });
    }
    const mailboxVerified = await verifyEmailAccessCode(normalizedBuyerEmail, emailAccessCode, emailAccessSecret);
    if (!mailboxVerified) {
      await writeRequestLog(c, "pay_unified_idempotency_replay", 403, limit.ipHash);
      return fail(c, "邮箱验证码无效或已过期", 403, { code: "EMAIL_VERIFICATION_REQUIRED" });
    }
    return c.json(cached, 200);
  }
  if (!idem.shouldProceed) {
    return fail(c, "支付订单正在处理中，请稍后查询结果", 409, { code: "IDEMPOTENCY_PENDING" });
  }
  const idempotencyLeaseVersion = idem.leaseVersion;

  const dbConfig = await readRuntimeConfig(db, c.env?.CREDENTIALS_ENCRYPTION_KEY);
  const runtimeConfig = mergeRuntimeConfig(dbConfig, c.env);
  const forceOfflineForSmoke = requestedSmokePaymentMode === "offline" && isAuthorizedSmokeRequest(c, runtimeConfig);
  // Turnstile 校验
  if (!body.data.balancePayment) {
    const turnstile = await verifyTurnstile(c, body.data.turnstileToken, runtimeConfig);
    if (!turnstile.ok) {
      await writeRequestLog(c, "pay_unified", 403, limit.ipHash);
      await clearPendingIdempotency(db, idempotencyKey, "pay_unified", idempotencyRequestHash, idempotencyLeaseVersion);
      return fail(c, turnstile.message || "安全校验失败", turnstile.status || 403);
    }
  }
  // 已有幂等结果在上方直接恢复；只有通过安全校验且真正创建新订单时才检查渠道当前状态。
  // 因此停用渠道会阻止新交易，但不会切断已创建订单的结果恢复。
  const storefront = await getActiveStorefrontById(db, body.data.storefrontId);
  if (!storefront) {
    await clearPendingIdempotency(db, idempotencyKey, "pay_unified", idempotencyRequestHash, idempotencyLeaseVersion);
    return fail(c, "展示渠道不存在或已停用", 404, { code: "STOREFRONT_NOT_FOUND" });
  }
  // 查商品
  const product = await getProduct(db, body.data.productId, storefront.id);
  if (!product) {
    await clearPendingIdempotency(db, idempotencyKey, "pay_unified", idempotencyRequestHash, idempotencyLeaseVersion);
    return fail(c, "商品不属于当前展示渠道或已下架", 404, { code: "PRODUCT_NOT_IN_STOREFRONT" });
  }
  // 已完成的同键请求会在上方直接返回；只有新订单才按商品当前配置校验并生成快照。
  const fulfillmentInput = validateFulfillmentInput({
    type: product.fulfillmentInputType,
    label: product.fulfillmentInputLabel,
    hint: product.fulfillmentInputHint,
    required: product.fulfillmentInputRequired,
  }, body.data.fulfillmentInput);
  if (!fulfillmentInput.ok) {
    await clearPendingIdempotency(db, idempotencyKey, "pay_unified", idempotencyRequestHash, idempotencyLeaseVersion);
    return fail(c, fulfillmentInput.message, 400, { code: "FULFILLMENT_INPUT_INVALID" });
  }
  const fulfillmentInputJson = serializeFulfillmentInputSnapshot(fulfillmentInput.snapshot);
  // 幂等租约必须先于商品读取建立，保证同键重放仍遵守既有恢复协议；
  // 因此免费商品参数校验失败时必须显式释放租约，允许用户修正请求后复用业务流程。
  const basePriceIsFree = isBasePriceFree(product.priceCents);
  const freeCheckoutViolation = getFreeProductCheckoutViolation(product.priceCents, {
    quantity: body.data.quantity,
    couponCode: body.data.couponCode,
    balancePayment: body.data.balancePayment,
    paymentChannel: body.data.paymentChannel,
    emailAccessCode: body.data.emailAccessCode,
  });
  if (freeCheckoutViolation) {
    const error = FREE_PRODUCT_CHECKOUT_ERRORS[freeCheckoutViolation];
    await clearPendingIdempotency(db, idempotencyKey, "pay_unified", idempotencyRequestHash, idempotencyLeaseVersion);
    return fail(c, error.message, 400, { code: error.code });
  }
  if (basePriceIsFree) {
    // 免费领取：邮件服务未配置则无法发码，生产拒绝新领取（验码本身不依赖 Resend）。
    if (!runtimeConfig.resendApiKey) {
      await clearPendingIdempotency(db, idempotencyKey, "pay_unified", idempotencyRequestHash, idempotencyLeaseVersion);
      return fail(c, "免费领取需要邮件服务发送验证码，请联系管理员配置", 503, { code: "EMAIL_REQUIRED_FOR_FREE_CLAIM" });
    }
    // free_claim 仅在入口验码通过后计数，错误码不会消耗「每小时 3 次」配额。
    const freeAuthLimit = await enforceRateLimit(c, "free_claim", 3, {
      windowSeconds: 3600,
      message: "免费领取过于频繁，请一小时后再试",
    });
    if (!freeAuthLimit.ok) {
      await clearPendingIdempotency(db, idempotencyKey, "pay_unified", idempotencyRequestHash, idempotencyLeaseVersion);
      return fail(c, freeAuthLimit.message || "免费领取过于频繁，请稍后再试", freeAuthLimit.status || 429);
    }
  }
  let productCurrency: ReturnType<typeof normalizeCurrencyCode>;
  try {
    productCurrency = normalizeCurrencyCode(product.currency);
  } catch {
    await clearPendingIdempotency(db, idempotencyKey, "pay_unified", idempotencyRequestHash, idempotencyLeaseVersion);
    return fail(c, "商品币种配置异常，请联系管理员", 400, { code: "PRODUCT_CURRENCY_INVALID" });
  }
  if (!FULFILLMENT_MODES.includes(product.fulfillmentMode)) {
    await clearPendingIdempotency(db, idempotencyKey, "pay_unified", idempotencyRequestHash, idempotencyLeaseVersion);
    return fail(c, "商品履约模式配置异常，请联系管理员", 400);
  }
  if (!VALID_ISSUE_MODES.includes(product.issueMode)) {
    await clearPendingIdempotency(db, idempotencyKey, "pay_unified", idempotencyRequestHash, idempotencyLeaseVersion);
    return fail(c, "商品发卡模式配置异常，请联系管理员", 400);
  }
  if (body.data.balancePayment && productCurrency !== "CNY") {
    await clearPendingIdempotency(db, idempotencyKey, "pay_unified", idempotencyRequestHash, idempotencyLeaseVersion);
    return fail(c, "余额仅支持 CNY 商品", 400, { code: "BALANCE_CURRENCY_UNSUPPORTED" });
  }
  const emailOnly = deliveryVisibilityPayload({ deliveryVisibility: product.deliveryVisibility }).deliveryVisibility === "email_only";
  if (emailOnly && !runtimeConfig.resendApiKey) {
    await clearPendingIdempotency(db, idempotencyKey, "pay_unified", idempotencyRequestHash, idempotencyLeaseVersion);
    return fail(c, "该商品仅通过邮件交付，但邮件服务未配置，请联系管理员", 503, { code: "EMAIL_REQUIRED_FOR_EMAIL_ONLY_DELIVERY" });
  }
  const quantity = body.data.quantity || 1;
  if (product.fulfillmentMode === "card" && product.stock !== undefined && Number(product.stock || 0) < quantity) {
    await clearPendingIdempotency(db, idempotencyKey, "pay_unified", idempotencyRequestHash, idempotencyLeaseVersion);
    return fail(c, "当前商品库存不足", 409);
  }

  if (basePriceIsFree) {
    const freeClaimLimit = await checkFreeClaimOrderRateLimit(db, normalizedBuyerEmail, product.id);
    if (!freeClaimLimit.ok) {
      await writeRequestLog(c, "pay_unified", freeClaimLimit.status, limit.ipHash);
      await clearPendingIdempotency(db, idempotencyKey, "pay_unified", idempotencyRequestHash, idempotencyLeaseVersion);
      return fail(c, freeClaimLimit.message, freeClaimLimit.status);
    }
  } else {
    const orderLimit = await checkOrderRateLimit(db, normalizedBuyerEmail, product.id);
    if (!orderLimit.ok) {
      await writeRequestLog(c, "pay_unified", orderLimit.status, limit.ipHash);
      await clearPendingIdempotency(db, idempotencyKey, "pay_unified", idempotencyRequestHash, idempotencyLeaseVersion);
      return fail(c, orderLimit.message, orderLimit.status);
    }
  }
  const effectivePurchaseLimit = effectivePurchaseLimitForProduct(product.priceCents, product.purchaseLimit);
  const purchaseLimit = await checkProductPurchaseLimitForQuantity(
    db,
    normalizedBuyerEmail,
    product.id,
    effectivePurchaseLimit,
    quantity,
  );
  if (!purchaseLimit.ok) {
    await writeRequestLog(c, "pay_unified", purchaseLimit.status, limit.ipHash);
    await clearPendingIdempotency(db, idempotencyKey, "pay_unified", idempotencyRequestHash, idempotencyLeaseVersion);
    return fail(c, purchaseLimit.message, purchaseLimit.status);
  }

  if (body.data.balancePayment) {
    const balanceLimit = await checkBalanceOrderRateLimit(db, normalizedBuyerEmail);
    if (!balanceLimit.ok) {
      await writeRequestLog(c, "pay_unified", balanceLimit.status, limit.ipHash);
      await clearPendingIdempotency(db, idempotencyKey, "pay_unified", idempotencyRequestHash, idempotencyLeaseVersion);
      return fail(c, balanceLimit.message || "余额支付过于频繁，请稍后再试", balanceLimit.status || 429);
    }
  }

  // 基础价格为 0 的商品不进入优惠系统；这与“付费商品经 100% 优惠后应付 0”是两种业务语义。
  // 前者固定免费领取，后者仍需报价并在事务内核销优惠码。
  const couponCode = normalizeCode(body.data.couponCode);
  const baseAmountCents = product.priceCents * quantity;
  const quote = basePriceIsFree
    ? {
        couponCode: "",
        valid: false,
        discountCents: 0,
        payableCents: 0,
        message: "免费商品无需折扣码",
      }
    : await quoteCoupon(db, baseAmountCents, product.id, body.data.couponCode || "", product.currency);
  if (couponCode && !quote.valid) {
    await clearPendingIdempotency(db, idempotencyKey, "pay_unified", idempotencyRequestHash, idempotencyLeaseVersion);
    return fail(c, quote.message, 403);
  }
  const payableCents = quote.valid ? quote.payableCents : baseAmountCents;

  // 创建订单通用参数
  const orderId = crypto.randomUUID();
  const orderNo = createPayOrderNo();
  const orderToken = createOrderToken();
  const orderTokenHash = await hashOrderToken(orderToken);
  const campaignCode = normalizeCode(body.data.campaignCode);
  const referralCode = normalizeCode(body.data.referralCode);
  const issueMode = product.issueMode;
  const userAgent = c.req.header("user-agent") || "";
  const expireMinutes = await getOrderExpireMinutes(db);
  const expiresAt = new Date(Date.now() + expireMinutes * 60 * 1000).toISOString();
  const deliveryJson = buildPendingDeliveryJson(product);

  const internalPaymentProvider = payableCents === 0 ? "free" : "balance";
  // 统一把 0 元订单和余额支付归为站内结算：它们都不需要上游支付入口，也不应触发易支付下单。
  // 区别只在 paymentProvider 记账语义：free 表示全额减免，balance 表示买家余额扣款。
  const shouldSettleInternally = body.data.balancePayment || payableCents === 0;

  // ── 站内即时结算分流 ──
  // 余额支付和 0 元订单都不应进入外部支付渠道；0 元订单只标记 paid 并继续履约，不扣余额。
  if (shouldSettleInternally) {
    const internalRecoveryResponse = {
      mode: internalPaymentProvider === "free" ? "free" : "balance",
      orderId,
      orderNo,
      orderToken,
      amountCents: payableCents,
      productId: product.id,
      productTitle: product.title,
      quantity,
      currency: product.currency,
      fulfillmentMode: product.fulfillmentMode,
      expiresAt,
      expireMinutes,
      status: "pending",
      storefrontId: storefront.id,
    };
    try {
      await withDbTransaction(db, async (tx) => {
        const verifiedStorefront = await assertStorefrontProductSellable(tx, storefront.id, product.id);
        await assertProductPurchaseLimit(tx, normalizedBuyerEmail, product, quantity);
        if (couponCode) {
          const couponResult = await consumeCoupon(tx, couponCode);
          if (!couponResult.success) throw new Error("优惠码已被他人使用或已失效，请重试");
        }
        const lockedCard = product.fulfillmentMode !== "card"
          ? { mode: "virtual" as const, inventoryIds: [] }
          : await lockFulfillmentInventoryItems(tx, orderId, product.id, expiresAt, quantity);
        if (!lockedCard) throw new Error("当前商品库存不足");
        await createOrderRecord(
          tx, orderId, orderNo, product.id, product.title, product.fulfillmentMode, `${internalPaymentProvider}:${normalizedBuyerEmail.slice(0, 8)}`,
          normalizedBuyerEmail, quantity, product.priceCents, payableCents,
          quote.valid ? quote.discountCents : 0, product.currency,
          "online", issueMode, campaignCode, referralCode, couponCode,
          limit.ipHash, userAgent, orderTokenHash, expiresAt,
          internalPaymentProvider, deliveryJson, product.deliveryVisibility,
          verifiedStorefront,
          fulfillmentInputJson,
        );
        await saveIdempotentResponse(
          tx,
          idempotencyKey,
          "pay_unified",
          idempotencyRequestHash,
          idempotencyLeaseVersion,
          orderId,
          internalRecoveryResponse,
        );
      });
    } catch (err) {
      if (err instanceof ProductPurchaseLimitError) {
        await clearPendingIdempotency(db, idempotencyKey, "pay_unified", idempotencyRequestHash, idempotencyLeaseVersion);
        return fail(c, err.message, err.status);
      }
      if (err instanceof StorefrontProductUnavailableError) {
        await clearPendingIdempotency(db, idempotencyKey, "pay_unified", idempotencyRequestHash, idempotencyLeaseVersion);
        return fail(c, err.message, 409, { code: "PRODUCT_NOT_IN_STOREFRONT" });
      }
      if (err instanceof Error && err.message === "当前商品库存不足") {
        await clearPendingIdempotency(db, idempotencyKey, "pay_unified", idempotencyRequestHash, idempotencyLeaseVersion);
        return fail(c, "当前商品库存不足", 409);
      }
      if (err instanceof Error && err.message === "优惠码已被他人使用或已失效，请重试") {
        await clearPendingIdempotency(db, idempotencyKey, "pay_unified", idempotencyRequestHash, idempotencyLeaseVersion);
        return fail(c, "优惠码已被他人使用或已失效，请重试", 409);
      }
      await clearPendingIdempotency(db, idempotencyKey, "pay_unified", idempotencyRequestHash, idempotencyLeaseVersion);
      throw new Error("订单创建失败，请稍后重试");
    }

    await writeOrderEvent(db, orderId, "created", payableCents === 0 ? "0 元订单创建，跳过外部支付" : "余额支付订单创建");
    const settlementResult = await handleInternalSettlement(
      db, orderId, normalizedBuyerEmail, payableCents,
      { ...product, fulfillmentMode: product.fulfillmentMode }, runtimeConfig, c.get("executionCtx"),
    );

    if (!settlementResult.ok) {
      console.error(`[pay_unified] internal settlement failed: ${settlementResult.message}`);
      await clearCachedIdempotentResponse(
        db,
        idempotencyKey,
        "pay_unified",
        idempotencyRequestHash,
        idempotencyLeaseVersion,
        internalRecoveryResponse,
      );
      return fail(c, settlementResult.message, settlementResult.status);
    }

    // 查询已发卡/已交付信息返回给用户。卡密订单必须按 issuedOrderId 读取所有卡，
    // 不能只依赖 orders.issuedCardId，否则多数量余额支付只会展示第一张卡。
    const [orderRows, issuedCards] = await Promise.all([
      db
        .select({
          orderNo: orders.orderNo,
          deliveryJson: orders.deliveryJson,
          deliveryVisibility: orders.deliveryVisibility,
          fulfillmentMode: orderFulfillmentModeSnapshot,
        })
        .from(orders)
        .where(eq(orders.id, orderId))
        .limit(1),
      db
        .select({
          id: cards.id,
          accountLabel: cards.accountLabel,
          deliverySecret: cards.deliverySecret,
          deliveryNote: cards.deliveryNote,
        })
        .from(cards)
        .where(eq(cards.issuedOrderId, orderId)),
    ]);

    const issuedOrder = orderRows[0];
    const responseFulfillmentMode = issuedOrder?.fulfillmentMode || product.fulfillmentMode;
    const responseUsesCards = responseFulfillmentMode === "card";
    const responseBody: Record<string, unknown> = {
      mode: internalPaymentProvider === "free" ? "free" : "balance",
      orderId,
      orderNo,
      orderToken,
      amountCents: payableCents,
      productId: product.id,
      productTitle: product.title,
      quantity,
      currency: product.currency,
      fulfillmentMode: responseFulfillmentMode,
      expiresAt,
      expireMinutes,
      status: "issued",
      ...deliveryVisibilityPayload({
        deliveryVisibility: issuedOrder?.deliveryVisibility,
        buyerEmail: normalizedBuyerEmail,
        status: "issued",
      }),
    };
    const emailOnly = responseBody["deliveryVisibility"] === "email_only";
    if (issuedOrder) {
      const delivery = !responseUsesCards && issuedOrder.deliveryJson
        ? JSON.parse(issuedOrder.deliveryJson)
        : issuedCards[0]
          ? {
            accountLabel: issuedCards[0].accountLabel || "",
            deliverySecret: issuedCards[0].deliverySecret || "",
            deliveryNote: issuedCards[0].deliveryNote || "",
          }
          : undefined;
      if (!emailOnly && delivery) responseBody.delivery = delivery;
      if (!emailOnly && responseUsesCards && issuedCards.length > 0) {
        responseBody.cards = issuedCards.map((card) => ({
          id: card.id,
          accountLabel: card.accountLabel || "",
          deliverySecret: card.deliverySecret || "",
          deliveryNote: card.deliveryNote || "",
          cardData: [card.accountLabel, card.deliverySecret].filter(Boolean).join(" / "),
        }));
      }
    }
    try { await saveIdempotentResponse(db, idempotencyKey, "pay_unified", idempotencyRequestHash, idempotencyLeaseVersion, orderId, responseBody); }
    catch (e) { console.warn("[idempotency] failed to save balance response for key", idempotencyKey, e); }
    return ok(c, responseBody);
  }

  // 尝试线上支付（通过 Provider 抽象层，支持 DB 加密配置）
  const provider = forceOfflineForSmoke
    ? null
    : selectOnlineProviderForCurrency(
        await createDbProviderRegistry(c.env, db, c.env.CREDENTIALS_ENCRYPTION_KEY),
        product.currency,
      );
  if (provider) {
    const initialOnlineRecoveryResponse = {
      ...buildPaymentCreationRecoveryResponse({
        provider: provider.name,
        orderId,
        orderNo,
        orderToken,
        amountCents: payableCents,
        productId: product.id,
        productTitle: product.title,
        quantity,
        currency: product.currency,
        fulfillmentMode: product.fulfillmentMode,
        expiresAt,
        expireMinutes,
        status: "pending",
        storefrontId: storefront.id,
      }),
      [IDEMPOTENCY_REPLAY_AFTER_FIELD]: new Date(Date.now() + IDEMPOTENCY_PENDING_LEASE_MS).toISOString(),
    };
    try {
      await withDbTransaction(db, async (tx) => {
        const verifiedStorefront = await assertStorefrontProductSellable(tx, storefront.id, product.id);
        await assertProductPurchaseLimit(tx, normalizedBuyerEmail, product, quantity);
        if (couponCode) {
          const couponResult = await consumeCoupon(tx, couponCode);
          if (!couponResult.success) throw new Error("优惠码已被他人使用或已失效，请重试");
        }
        const lockedCard = product.fulfillmentMode !== "card"
          ? { mode: "virtual" as const, inventoryIds: [] }
          : await lockFulfillmentInventoryItems(tx, orderId, product.id, expiresAt, quantity);
        if (!lockedCard) throw new Error("当前商品库存不足");
        await createOrderRecord(
          tx, orderId, orderNo, product.id, product.title, product.fulfillmentMode, `pay:${orderNo.slice(-8)}`,
          normalizedBuyerEmail, quantity, product.priceCents, payableCents,
          quote.valid ? quote.discountCents : 0, product.currency,
          "online", issueMode, campaignCode, referralCode, couponCode,
          limit.ipHash, userAgent, orderTokenHash, expiresAt,
          provider.name, deliveryJson, product.deliveryVisibility,
          verifiedStorefront,
          fulfillmentInputJson,
        );
        await saveIdempotentResponse(
          tx,
          idempotencyKey,
          "pay_unified",
          idempotencyRequestHash,
          idempotencyLeaseVersion,
          orderId,
          initialOnlineRecoveryResponse,
        );
      });
    } catch (err) {
      if (err instanceof ProductPurchaseLimitError) {
        await clearPendingIdempotency(db, idempotencyKey, "pay_unified", idempotencyRequestHash, idempotencyLeaseVersion);
        return fail(c, err.message, err.status);
      }
      if (err instanceof StorefrontProductUnavailableError) {
        await clearPendingIdempotency(db, idempotencyKey, "pay_unified", idempotencyRequestHash, idempotencyLeaseVersion);
        return fail(c, err.message, 409, { code: "PRODUCT_NOT_IN_STOREFRONT" });
      }
      if (err instanceof Error && err.message === "当前商品库存不足") {
        await clearPendingIdempotency(db, idempotencyKey, "pay_unified", idempotencyRequestHash, idempotencyLeaseVersion);
        return fail(c, "当前商品库存不足", 409);
      }
      if (err instanceof Error && err.message === "优惠码已被他人使用或已失效，请重试") {
        await clearPendingIdempotency(db, idempotencyKey, "pay_unified", idempotencyRequestHash, idempotencyLeaseVersion);
        return fail(c, err.message, 409);
      }
      await clearPendingIdempotency(db, idempotencyKey, "pay_unified", idempotencyRequestHash, idempotencyLeaseVersion);
      throw new Error("订单创建失败，请稍后重试");
    }

    await writeOrderEvent(db, orderId, "created", "支付订单已创建");

    const origin = getOrigin(c);
    const notifyUrl = `${origin}/api/pay/callback/${provider.name}`;
    // 支付平台异步通知地址按当前站点自动生成；同步跳转只回到公开查询页，
    // 不把 orderToken、订单 ID 等可关联交付内容的凭据暴露给第三方支付平台。
    const returnUrl = `${origin}/lookup`;

    try {
      const paymentMetadata: Record<string, string> = {
        subject: product.title || "商品购买",
        // EasyPay/ZPAY API 下单要求 clientip。Web 场景这里是 Cloudflare 看到的真实访客 IP；
        // 只用于提交给支付网关，不落库保存明文。
        clientIp: getClientIp(c),
      };
      if (provider.name === "easypay" && body.data.paymentChannel) {
        paymentMetadata.payType = body.data.paymentChannel;
      }
      const payResult = await provider.createPayment({
        orderNo,
        amountCents: payableCents,
        currency: product.currency,
        notifyUrl,
        returnUrl,
        metadata: paymentMetadata,
      });
      const paymentEntry = extractPaymentEntry(payResult);
      if (!paymentEntry.qrImageUrl && !paymentEntry.redirectUrl) {
        throw new EasyPayProviderError(
          "deterministic",
          `${provider.name} 未返回可展示的安全付款入口`,
          { providerMessage: "missing_payment_entry" },
        );
      }

      await writeOrderEvent(db, orderId, "pay_ready", "支付入口已生成", {
        provider: provider.name,
        total_fee: payableCents,
      });
      const paymentChannel = extractPaymentChannel(provider.name, payResult);
      const responseBody = {
        mode: "online",
        provider: provider.name,
        ...paymentChannel,
        orderId,
        orderNo,
        orderToken,
        amountCents: payableCents,
        productId: product.id,
        productTitle: product.title,
        quantity,
        currency: product.currency,
        fulfillmentMode: product.fulfillmentMode,
        // qrcode 保持旧前端兼容语义：这里只放图片地址/data 位图，不再混入二维码内容。
        qrcode: paymentEntry.qrImageUrl,
        qrImageUrl: paymentEntry.qrImageUrl,
        qrContent: paymentEntry.qrContent,
        redirectUrl: paymentEntry.redirectUrl,
        expiresAt,
        expireMinutes,
      };
      try { await saveIdempotentResponse(db, idempotencyKey, "pay_unified", idempotencyRequestHash, idempotencyLeaseVersion, orderId, responseBody); }
      catch (e) { console.warn("[idempotency] failed to save response for key", idempotencyKey, e); }
      return ok(c, responseBody);
    } catch (err) {
      const ambiguousCreation = isAmbiguousEasyPayProviderError(err);
      const currentStatus = await readOrderStatus(db, orderId);

      if (!ambiguousCreation) {
        // 已收到明确拒绝、HTTP 4xx 或本地安全校验失败时，上游没有可继续支付的有效入口。
        // 关闭本地 pending 订单并释放库存/优惠券，避免买家被引导去轮询一个必然失败的订单。
        console.warn(`[pay_unified] ${provider.name} 支付创建确定失败:`, err);
        const closure = currentStatus === "pending"
          ? await failPendingOrderAndRelease(db, orderId, product.fulfillmentMode)
          : { closed: false, releasedCards: 0 };
        await clearCachedIdempotentResponse(
          db,
          idempotencyKey,
          "pay_unified",
          idempotencyRequestHash,
          idempotencyLeaseVersion,
          initialOnlineRecoveryResponse,
        );
        await writeOrderEvent(db, orderId, "payment_create_failed", err instanceof Error ? err.message : String(err), {
          provider: provider.name,
          closed: closure.closed,
          releasedCards: closure.releasedCards,
        });
        if (currentStatus && currentStatus !== "pending") {
          const recoveryResponse = buildPaymentCreationRecoveryResponse({
            provider: provider.name,
            orderId,
            orderNo,
            orderToken,
            amountCents: payableCents,
            productId: product.id,
            productTitle: product.title,
            quantity,
            currency: product.currency,
            fulfillmentMode: product.fulfillmentMode,
            expiresAt,
            expireMinutes,
            status: currentStatus,
          });
          return fail(c, "订单支付状态已变更，请查询订单结果", 409, {
            code: "PAYMENT_STATE_CHANGED",
            ...recoveryResponse,
          });
        }
        return fail(c, err instanceof Error ? err.message : "支付渠道创建失败", 502, {
          code: "PAYMENT_CREATION_FAILED",
          provider: provider.name,
          orderId,
          orderNo,
          status: closure.closed ? "failed" : currentStatus || "unknown",
          releasedCards: closure.releasedCards,
        });
      }

      // 网络中断、超时、429 或 5xx 可能出现“上游已建单但响应丢失”。
      // 此时不能关闭订单或降级二次收款，只能保留 pending 等待真实回调/过期收敛。
      console.warn(`[pay_unified] ${provider.name} 支付创建结果不确定:`, err);
      const recoveryResponse = buildPaymentCreationRecoveryResponse({
        provider: provider.name,
        orderId,
        orderNo,
        orderToken,
        amountCents: payableCents,
        productId: product.id,
        productTitle: product.title,
        quantity,
        currency: product.currency,
        fulfillmentMode: product.fulfillmentMode,
        expiresAt,
        expireMinutes,
        status: currentStatus || "pending",
      });
      try { await saveIdempotentResponse(db, idempotencyKey, "pay_unified", idempotencyRequestHash, idempotencyLeaseVersion, orderId, recoveryResponse); }
      catch (e) { console.warn("[idempotency] failed to save payment recovery response for key", idempotencyKey, e); }
      if (currentStatus !== "pending") {
        return fail(c, "订单支付状态已变更，请查询订单结果", 409, {
          code: "PAYMENT_STATE_CHANGED",
          ...recoveryResponse,
        });
      }
      return fail(c, "支付渠道创建结果不确定，请稍后查询订单状态", 503, {
        code: "PAYMENT_CREATION_UNCERTAIN",
        ...recoveryResponse,
      });
    }
  }

  // 线下二维码与站内余额均以人民币“分”记账。非 CNY 订单只能交给明确声明支持该币种的线上渠道，
  // 不能在渠道缺失或创建失败后按相同数字降级收取人民币。
  if (product.currency.trim().toUpperCase() !== "CNY") {
    await clearPendingIdempotency(db, idempotencyKey, "pay_unified", idempotencyRequestHash, idempotencyLeaseVersion);
    return fail(c, "当前商品币种暂无可用支付渠道", 503, { code: "PAYMENT_CURRENCY_UNAVAILABLE" });
  }

  // ── 降级：线下支付 ──
  // 线上支付失败释放卡密后降级到线下支付，coupon 报价可能已失效，
  // 需重新 quoteCoupon 以确保折扣金额与优惠券当前状态一致。
  const offlineQuote = couponCode
    ? await quoteCoupon(db, baseAmountCents, product.id, couponCode, product.currency)
    : quote;
  const offlinePayableCents = offlineQuote.valid ? offlineQuote.payableCents : baseAmountCents;
  const offlineDiscountCents = offlineQuote.valid ? offlineQuote.discountCents : 0;

  const offlineConfig = await ensureOfflinePaymentReady(db);
  if (!offlineConfig) {
    await clearPendingIdempotency(db, idempotencyKey, "pay_unified", idempotencyRequestHash, idempotencyLeaseVersion);
    return fail(c, "线下收款码未配置，请联系管理员", 503, { code: "OFFLINE_PAYMENT_NOT_CONFIGURED" });
  }

  const buildOfflineResponse = (result: OfflineOrderResult) => ({
    mode: "offline",
    orderId: result.orderId,
    orderNo: result.orderNo,
    orderToken: result.orderToken,
    amountCents: offlinePayableCents,
    productId: product.id,
    productTitle: product.title,
    quantity,
    currency: product.currency,
    fulfillmentMode: product.fulfillmentMode,
    storefrontId: storefront.id,
    offlineNoteCode: result.offlineNoteCode,
    wechatQr: offlineConfig.offline_pay_qr_wechat || "",
    alipayQr: offlineConfig.offline_pay_qr_alipay || "",
    offlineHint: offlineConfig.offline_pay_hint || "",
    expiresAt: result.expiresAt,
    expireMinutes: result.expireMinutes,
  });

  let offlineResult: Awaited<ReturnType<typeof createOfflineOrder>>;
  try {
    offlineResult = await createOfflineOrder(
      db, product, normalizedBuyerEmail,
      quantity,
      offlinePayableCents, offlineDiscountCents,
      issueMode, campaignCode, referralCode, couponCode,
      limit.ipHash, userAgent,
      runtimeConfig,
      c.get("executionCtx"),
      idempotencyKey
        ? async (tx, result) => saveIdempotentResponse(
            tx,
            idempotencyKey,
            "pay_unified",
            idempotencyRequestHash,
            idempotencyLeaseVersion,
            result.orderId,
            buildOfflineResponse(result),
          )
        : undefined,
      storefront,
      fulfillmentInputJson,
    );
  } catch (err: unknown) {
    if (err instanceof ProductPurchaseLimitError) {
      await clearPendingIdempotency(db, idempotencyKey, "pay_unified", idempotencyRequestHash, idempotencyLeaseVersion);
      return fail(c, err.message, err.status);
    }
    if (err instanceof StorefrontProductUnavailableError) {
      await clearPendingIdempotency(db, idempotencyKey, "pay_unified", idempotencyRequestHash, idempotencyLeaseVersion);
      return fail(c, err.message, 409, { code: "PRODUCT_NOT_IN_STOREFRONT" });
    }
    if (err instanceof Error && err.message === "当前商品库存不足") {
      await clearPendingIdempotency(db, idempotencyKey, "pay_unified", idempotencyRequestHash, idempotencyLeaseVersion);
      return fail(c, "当前商品库存不足", 409);
    }
    if (err instanceof Error && err.message === "优惠码已被他人使用或已失效，请重试") {
      await clearPendingIdempotency(db, idempotencyKey, "pay_unified", idempotencyRequestHash, idempotencyLeaseVersion);
      return fail(c, "优惠码已被他人使用或已失效，请重试", 409);
    }
    await clearPendingIdempotency(db, idempotencyKey, "pay_unified", idempotencyRequestHash, idempotencyLeaseVersion);
    throw new Error("订单创建失败，请稍后重试");
  }

  const responseBody = buildOfflineResponse(offlineResult);

  return ok(c, responseBody);
});

/** ② 支付成功回调接口（Provider 抽象层统一处理） */
payRoute.all("/pay/callback/:provider", async (c) => {
  // 限流：防日志膨胀和 DoS
  const limit = await enforceRateLimit(c, "pay_callback", 60);
  if (!limit.ok) return c.text("fail", 429);

  const providerName = c.req.param("provider");

  // 白名单校验 provider 名称
  if (!isValidProviderName(providerName)) {
    return c.text("invalid provider", 400);
  }

  const db = getDb(c);

  // 回调验签不能复用“新下单可用渠道”过滤。管理员禁用渠道后，已创建订单仍可能收到上游通知；
  // 这里使用回调专用注册表读取已保存凭据，但不会让禁用渠道参与后续新订单选择。
  const registry = await createDbProviderRegistryForCallback(c.env, db, c.env.CREDENTIALS_ENCRYPTION_KEY);
  const provider = registry.get(providerName);
  if (!provider) {
    return c.text("provider not configured", 500);
  }

  // 1. 解析回调参数，再交给 Provider 验签。
  //    易支付/ZPAY 官方通知为 GET，部分兼容网关也会 POST 表单；两种方式统一验签处理。
  let callbackResult;
  try {
    const method = c.req.method;
    let params: Record<string, string>;

    if (method === "GET") {
      // 易支付 GET 回调：参数在 URL 查询字符串中。
      const queryObj = c.req.queries();
      params = Object.fromEntries(
        Object.entries(queryObj).map(([k, v]) => [k, v[0] || ""]),
      );
    } else {
      // 兼容易支付 POST 回调：参数在 x-www-form-urlencoded 请求体中。
      const bodyText = await c.req.text();
      params = Object.fromEntries(new URLSearchParams(bodyText).entries());
    }

    callbackResult = await provider.verifyCallback(params);
  } catch (err) {
    console.warn(`[pay_callback] ${providerName} 验签失败:`, err);
    return c.text("fail", 400);
  }

  const orderNo = callbackResult.orderNo;

  // 2. 查订单（Drizzle ORM）— 包含 amountCents 用于金额校验
  const [order] = await db
    .select({
      id: orders.id,
      status: orders.status,
      productId: orders.productId,
      buyerEmail: orders.buyerEmail,
      amountCents: orders.amountCents,
      currency: orders.currency,
      paymentProvider: orders.paymentProvider,
      paymentRef: orders.paymentRef,
      createdAt: orders.createdAt,
      expiresAt: orders.expiresAt,
    })
    .from(orders)
    .where(eq(orders.orderNo, orderNo))
    .limit(1);

  if (!order) return c.text("order not found", 404);

  // 支付渠道是创建订单时写入的不可变快照。空值或不一致都表示无法证明回调归属，必须拒绝。
  if (order.paymentProvider !== providerName) {
    await writeOrderEvent(db, order.id, "callback_rejected", "回调渠道与订单支付渠道不一致", {
      expected: order.paymentProvider,
      received: providerName,
    });
    return c.text("fail", 400);
  }

  // 金额校验：回调金额必须与订单实际金额一致，防止支付平台篡改或中间人攻击
  if (callbackResult.amountCents !== order.amountCents) {
    await writeOrderEvent(db, order.id, "callback_amount_mismatch", "回调金额与订单金额不一致", {
      expected: order.amountCents,
      received: callbackResult.amountCents,
    });
    return c.text("fail", 400);
  }

  const callbackCurrency = tryNormalizeCurrencyCode(callbackResult.currency);
  const orderCurrency = tryNormalizeCurrencyCode(order.currency);
  if (!callbackCurrency || !orderCurrency || callbackCurrency !== orderCurrency) {
    await writeOrderEvent(db, order.id, "callback_currency_mismatch", "回调币种与订单币种不一致", {
      expected: orderCurrency || "",
      received: callbackCurrency || "",
    });
    return c.text("fail", 400);
  }

  // expired 只有在后续证明实际付款时间早于到期时间时才允许恢复；其他失败终态直接拒绝。
  const orderStatus = normalizeOrderStatus(order.status);
  if (!["pending", "paid", "issued", "expired"].includes(orderStatus)) {
    const message = orderStatus === "canceled"
      ? "订单已取消，拒绝回调"
      : "订单状态不可接收支付回调";
    await writeOrderEvent(db, order.id, "callback_rejected", message, {
      status: orderStatus || order.status,
    });
    return c.text("fail", 400);
  }

  let effectivePaidAt = callbackResult.paidAt;
  const callbackArrivedAfterExpiry = Boolean(
    order.expiresAt && Date.parse(order.expiresAt) < Date.now(),
  );
  // 易支付回调可能不带可靠付款时间；当回调到达时订单已过期，不能直接按“当前时间”拒绝或恢复。
  // 此时通过 api.php 查单拿 addtime/endtime，推断真实付款是否发生在订单有效期内。
  if (
    ["pending", "expired"].includes(order.status) &&
    providerName === "easypay" &&
    callbackArrivedAfterExpiry &&
    !didPaymentHappenBeforeExpiry(effectivePaidAt, order.expiresAt)
  ) {
    let timingStatus: TimedPaymentStatus | null = null;
    try {
      timingStatus = provider.queryStatus
        ? await provider.queryStatus(orderNo)
        : null;
    } catch (error) {
      console.warn("[pay_callback] 易支付订单时间查询失败:", error);
    }
    const inferredPaidAt = timingStatus
      ? inferEasyPayPaidAt(timingStatus, order.createdAt, callbackResult.providerTradeNo)
      : null;
    if (!inferredPaidAt) {
      await writeOrderEvent(db, order.id, "callback_timing_unverified", "易支付回调到达时订单已过期，暂时无法核实实际付款时间", {
        provider: providerName,
        trade_no: callbackResult.providerTradeNo,
      });
      return c.text("fail", 503);
    }
    effectivePaidAt = inferredPaidAt;
  }

  const paymentBeforeExpiry = didPaymentHappenBeforeExpiry(effectivePaidAt, order.expiresAt);
  if (order.status === "expired" && !paymentBeforeExpiry) {
    await writeOrderEvent(db, order.id, "callback_rejected", "订单已过期且付款时间不在有效期内", {
      status: "expired",
      provider: providerName,
      trade_no: callbackResult.providerTradeNo,
    });
    return c.text("fail", 400);
  }

  if (order.status === "pending" && !paymentBeforeExpiry) {
    const expiration = await checkAndExpireOrder(db, order.id, order.expiresAt, order.status);
    if (expiration.expired) {
      await writeOrderEvent(db, order.id, "callback_rejected", "订单已到期，拒绝迟到的支付回调", {
        status: "expired",
      });
      return c.text("fail", 400);
    }
  }

  const nowStr = effectivePaidAt || new Date().toISOString();
  const readCurrentPaymentState = async () => {
    const [currentOrder] = await db
      .select({
        status: orders.status,
        paymentProvider: orders.paymentProvider,
        paymentRef: orders.paymentRef,
      })
      .from(orders)
      .where(eq(orders.id, order.id))
      .limit(1);
    return currentOrder;
  };

  // 幂等：只有已完成发卡且支付流水一致才算回调处理完成。
  if (order.status === "issued") {
    if (order.paymentRef && order.paymentRef !== callbackResult.providerTradeNo) {
      await writeOrderEvent(db, order.id, "callback_state_conflict", "支付回调流水与已完成订单不一致", {
        provider: providerName,
        trade_no: callbackResult.providerTradeNo,
        recorded_trade_no: order.paymentRef,
        status: order.status,
      });
      return c.text("fail", 409);
    }
    if (order.paymentRef === callbackResult.providerTradeNo) return c.text("success");

    const backfilled = await db
      .update(orders)
      .set({ paymentProvider: providerName, paymentRef: callbackResult.providerTradeNo })
      .where(and(
        eq(orders.id, order.id),
        eq(orders.status, "issued"),
        eq(orders.paymentProvider, providerName),
        eq(orders.paymentRef, ""),
      ))
      .returning({ id: orders.id });
    if (backfilled.length > 0) return c.text("success");

    const currentOrder = await readCurrentPaymentState();
    const samePayment = currentOrder?.status === "issued"
      && currentOrder.paymentProvider === providerName
      && currentOrder.paymentRef === callbackResult.providerTradeNo;
    if (samePayment) return c.text("success");

    await writeOrderEvent(db, order.id, "callback_state_conflict", "已完成订单的支付流水回填发生冲突", {
      provider: providerName,
      trade_no: callbackResult.providerTradeNo,
      recorded_trade_no: currentOrder?.paymentRef || "",
      status: currentOrder?.status || "missing",
    });
    return c.text("fail", 409);
  }

  // 3. 保存支付平台流水。支付状态与发卡状态统一交给 markPaidAndIssue 收敛，
  // 避免回调层先改 paid 后让服务层误入恢复分支。
  let paymentStateRecorded = false;
  let shouldWritePaidEvent = false;
  if (order.status === "expired") {
    paymentStateRecorded = await restoreVerifiedExpiredPayment(
      db,
      order.id,
      providerName,
      callbackResult.providerTradeNo,
      nowStr,
    );
    shouldWritePaidEvent = paymentStateRecorded;
  } else {
    const updated = await db
      .update(orders)
      .set({ status: "paid", paymentProvider: providerName, paymentRef: callbackResult.providerTradeNo, paidAt: nowStr })
      .where(and(
        eq(orders.id, order.id),
        eq(orders.paymentProvider, providerName),
        or(eq(orders.paymentRef, callbackResult.providerTradeNo), eq(orders.paymentRef, "")),
        inArray(orders.status, ["pending", "paid"]),
      ))
      .returning({ id: orders.id });
    paymentStateRecorded = updated.length > 0;
    shouldWritePaidEvent = paymentStateRecorded;
  }

  if (!paymentStateRecorded) {
    const currentOrder = await readCurrentPaymentState();
    const samePayment = currentOrder?.paymentProvider === providerName
      && currentOrder.paymentRef === callbackResult.providerTradeNo;

    if (currentOrder?.status === "issued" && samePayment) {
      return c.text("success");
    }
    const recoveredExpired = currentOrder?.status === "expired" && paymentBeforeExpiry
      ? await restoreVerifiedExpiredPayment(
          db,
          order.id,
          providerName,
          callbackResult.providerTradeNo,
          nowStr,
        )
      : false;
    if (recoveredExpired) {
      shouldWritePaidEvent = true;
    } else if (currentOrder?.status !== "paid" || !samePayment) {
      await writeOrderEvent(db, order.id, "callback_state_conflict", "支付回调写入时订单状态已变更", {
        provider: providerName,
        trade_no: callbackResult.providerTradeNo,
        status: currentOrder?.status || "missing",
        recorded_trade_no: currentOrder?.paymentRef || "",
      });
      return c.text("fail", 409);
    } else {
      shouldWritePaidEvent = false;
    }
  }

  if (shouldWritePaidEvent) {
    await writeOrderEvent(db, order.id, "paid", "在线支付成功回调", {
      provider: providerName,
      trade_no: callbackResult.providerTradeNo,
    });
  }

  // 4. 执行自动发卡逻辑。发卡失败时返回 fail，让支付平台重试回调；
  // paid 状态会保留，管理员也可以从后台重试履约。
  const dbConfig = await readRuntimeConfig(db, c.env?.CREDENTIALS_ENCRYPTION_KEY);
  const emailEnv = mergeRuntimeConfig(dbConfig, c.env);
  try {
    const issueResult = await markPaidAndIssue(db, order.id, emailEnv, c.get("executionCtx"));
    if (!issueResult.ok) {
      await writeOrderEvent(db, order.id, "callback_issue_failed", issueResult.message, {
        provider: providerName,
        trade_no: callbackResult.providerTradeNo,
      });
      const status = (issueResult.status === 409 || issueResult.status === 410) ? issueResult.status : 500;
      return c.text("fail", status);
    }

    return c.text("success");
  } catch (err) {
    console.error("[pay_callback] markPaidAndIssue threw:", err);
    await writeOrderEvent(db, order.id, "callback_issue_exception", String(err), {
      provider: providerName,
      trade_no: callbackResult.providerTradeNo,
    });
    return c.text("fail", 500);
  }
});

async function getPayStatusOrder(db: DbType, orderId: string, tokenHash: string) {
  const [order] = await db
    .select({
      id: orders.id,
      orderNo: orders.orderNo,
      productId: orders.productId,
      status: orders.status,
      issuedCardId: orders.issuedCardId,
      expiresAt: orders.expiresAt,
      buyerEmail: orders.buyerEmail,
      buyerContact: orders.buyerContact,
      quantity: orders.quantity,
      createdAt: orders.createdAt,
      productTitle: productsTable.title,
      amountCents: orders.amountCents,
      currency: orders.currency,
      paymentProvider: orders.paymentProvider,
      paymentRef: orders.paymentRef,
      paidAt: orders.paidAt,
      issuedAt: orders.issuedAt,
      accountLabel: cards.accountLabel,
      deliverySecret: cards.deliverySecret,
      deliveryNote: cards.deliveryNote,
      deliveryJson: orders.deliveryJson,
      deliveryVisibility: orders.deliveryVisibility,
      fulfillmentMode: orderFulfillmentModeSnapshot,
    })
    .from(orders)
    .leftJoin(productsTable, eq(productsTable.id, orders.productId))
    .leftJoin(cards, eq(cards.id, orders.issuedCardId))
    .where(and(eq(orders.id, orderId), eq(orders.orderTokenHash, tokenHash)))
    .limit(1);
  return order || null;
}

/** ③ 轮询支付状态 — 必须传入 token 参数，防止通过 UUID 枚举窃取卡密 */
payRoute.get("/pay/status/:orderId", async (c) => {
  c.header("Cache-Control", "no-store, no-cache, must-revalidate");
  c.header("Pragma", "no-cache");
  c.header("Expires", "0");
  // 限流：前端每 2.5s 轮询一次，每 IP 每分钟最多 30 次
  const limit = await enforceRateLimit(c, "pay_status", 30);
  if (!limit.ok) return fail(c, limit.message || "请求过于频繁，请稍后再试", limit.status || 429);

  const db = getDb(c);
  const orderId = c.req.param("orderId");
  const token = c.req.query("token");

  if (!token) return fail(c, "缺少 token 参数", 400);

  // 用 token hash 验证订单归属，防止 UUID 枚举（Drizzle ORM）
  const tokenHash = await hashOrderToken(token);
  let order = await getPayStatusOrder(db, orderId, tokenHash);

  if (!order) return fail(c, "订单不存在", 404);

  const dbConfig = await readRuntimeConfig(db, c.env?.CREDENTIALS_ENCRYPTION_KEY);
  const emailEnv = mergeRuntimeConfig(dbConfig, c.env);

  // 回调丢失补偿：持有 orderToken 的状态轮询在过期释放库存前，先向上游查单。
  // 只有金额、币种、支付渠道和付款时间全部核对通过时，才会把 pending/expired 推进到 paid/issued。
  const reconciliation = await reconcileOnlineOrderPayment(
    db,
    c.env,
    order,
    emailEnv,
    c.get("executionCtx"),
  );
  if (reconciliation.reconciled) {
    order = await getPayStatusOrder(db, orderId, tokenHash) || order;
  }

  // 若过期自动触发作废
  const { expired: wasExpired } = await checkAndExpireOrder(db, orderId, order.expiresAt, order.status, emailEnv, { orderNo: order.orderNo || "", productTitle: order.productTitle || "", buyerEmail: order.buyerEmail || "" }, c.get("executionCtx"));
  if (wasExpired) {
    return ok(c, { orderId, orderNo: order.orderNo, status: "expired" });
  }

  // 站内结算订单在“状态提交后、HTTP 响应前”中断时会安全停在 pending/paid。
  // balance 需要恢复扣款/履约；free 只能是 0 元订单，只恢复状态与履约，绝不能因脏数据扣余额。
  // 持有 orderToken 的幂等重试可通过轮询继续同一状态机，避免重复建单或永久卡在已支付状态。
  const recoverableInternalSettlement = order.paymentProvider === "balance"
    || (order.paymentProvider === "free" && Number(order.amountCents || 0) === 0);
  if (
    recoverableInternalSettlement &&
    ["pending", "paid"].includes(order.status) &&
    FULFILLMENT_MODES.includes(order.fulfillmentMode as FulfillmentMode)
  ) {
    try {
      await handleInternalSettlement(
        db,
        order.id,
        order.buyerEmail || "",
        order.amountCents || 0,
        {
          id: order.productId,
          title: order.productTitle || "余额支付订单",
          fulfillmentMode: order.fulfillmentMode as FulfillmentMode,
          deliveryVisibility: order.deliveryVisibility,
        },
        emailEnv,
        c.get("executionCtx"),
      );
      order = await getPayStatusOrder(db, orderId, tokenHash) || order;
    } catch (error) {
      console.error(`[pay_status] internal settlement recovery failed for ${orderId}:`, error);
    }
  }

  const responseBody: Record<string, unknown> = {
    orderId,
    orderNo: order.orderNo,
    status: order.status,
    productTitle: order.productTitle || "",
    quantity: order.quantity || 1,
    amountCents: order.amountCents || 0,
    currency: order.currency || "CNY",
    fulfillmentMode: order.fulfillmentMode || "card",
    buyerEmail: order.buyerEmail || "",
    buyerContact: order.buyerContact || "",
    paymentRef: order.paymentRef || "",
    paidAt: order.paidAt || "",
    issuedAt: order.issuedAt || "",
    ...deliveryVisibilityPayload({
      deliveryVisibility: order.deliveryVisibility,
      buyerEmail: order.buyerEmail,
      status: order.status,
    }),
  };

  const [itemRows, cardRows] = await Promise.all([
    db
      .select({
        id: orderItems.id,
        productId: orderItems.productId,
        productTitle: orderItems.productTitle,
        fulfillmentMode: orderItems.fulfillmentMode,
        quantity: orderItems.quantity,
        unitPriceCents: orderItems.unitPriceCents,
        discountCents: orderItems.discountCents,
        amountCents: orderItems.amountCents,
        deliveryJson: orderItems.deliveryJson,
      })
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId)),
    db
      .select({
        id: cards.id,
        accountLabel: cards.accountLabel,
        deliverySecret: cards.deliverySecret,
        deliveryNote: cards.deliveryNote,
      })
      .from(cards)
      .where(eq(cards.issuedOrderId, orderId)),
  ]);
  const emailOnly = responseBody["deliveryVisibility"] === "email_only";
  responseBody["items"] = emailOnly ? redactItemDeliveries(itemRows) : itemRows;
  if (!emailOnly && order.status === "issued" && cardRows.length > 0) {
    responseBody["cards"] = cardRows.map((card) => ({
      id: card.id,
      accountLabel: card.accountLabel || "",
      deliverySecret: card.deliverySecret || "",
      deliveryNote: card.deliveryNote || "",
      cardData: [card.accountLabel, card.deliverySecret].filter(Boolean).join(" / "),
    }));
    responseBody["delivery"] = {
      accountLabel: cardRows[0].accountLabel || "",
      deliverySecret: cardRows[0].deliverySecret || "",
      deliveryNote: cardRows[0].deliveryNote || "",
    };
  } else if (!emailOnly && order.status === "issued") {
    const deliveryJson = itemRows.find((item) => item.deliveryJson)?.deliveryJson || order.deliveryJson;
    if (deliveryJson) responseBody["delivery"] = JSON.parse(deliveryJson);
  }

  return ok(c, responseBody);
});

/** ③-2 线下支付确认：用户填写付款流水号后四位 + 订单凭证 token（防恶击知识证明） */
payRoute.post("/pay/offline/confirm", async (c) => {
  // 限流：每 IP 每分钟最多 5 次，防止暴力枚举 4 位流水号（仅 10000 种组合）
  const limit = await enforceRateLimit(c, "pay_offline_confirm", 5);
  if (!limit.ok) return fail(c, limit.message || "请求过于频繁，请稍后再试", limit.status || 429);

  const db = getDb(c);
  const schema = z.object({
    orderId: z.string().uuid(),
    orderToken: z.string().min(1).max(200),
    payRefLast4: z.string().regex(/^\d{4}$/, "请输入4位纯数字"),
  });

  const body = schema.safeParse(await safeJsonBody(c));
  if (!body.success) return fail(c, "请求参数无效", 400, body.error.flatten());

  // 用 token hash 验证订单归属，防止仅凭 orderId (UUID) 枚举确认付款
  const tokenHash = await hashOrderToken(body.data.orderToken);
  const [order] = await db
    .select({ id: orders.id, orderNo: orders.orderNo, productId: orders.productId, buyerEmail: orders.buyerEmail, status: orders.status, paymentMethod: orders.paymentMethod, expiresAt: orders.expiresAt })
    .from(orders)
    .where(and(eq(orders.id, body.data.orderId), eq(orders.orderTokenHash, tokenHash)))
    .limit(1);

  if (!order) return fail(c, "订单不存在或凭证无效", 404);
  if (order.paymentMethod !== "offline") return fail(c, "非线下支付订单", 400);
  const { expired } = await checkAndExpireOrder(db, order.id, order.expiresAt, order.status);
  if (expired) return fail(c, "订单已过期，请重新下单", 410);
  if (!["pending", "paid"].includes(order.status)) return fail(c, "订单状态不可更改", 409);

  // 保存付款流水号后四位到 payment_ref；pending/paid 都允许写入，便于确认与管理员已标记付款的并发场景收敛。
  const updated = await db
    .update(orders)
    .set({ paymentRef: `last4:${body.data.payRefLast4}` })
    .where(and(
      eq(orders.id, body.data.orderId),
      eq(orders.paymentMethod, "offline"),
      inArray(orders.status, ["pending", "paid"]),
    ));
  if (updated.rowsAffected === 0) return fail(c, "订单状态已变更，请刷新后重试", 409);

  await writeOrderEvent(db, body.data.orderId, "offline_confirm", `用户确认付款，流水号后四位: ${body.data.payRefLast4}`);
  return ok(c, { confirmed: true });
});

/** ③-3 用户主动取消线下待支付订单：释放软锁库存，避免关闭弹窗后库存被占用到过期 */
payRoute.post("/pay/offline/cancel", async (c) => {
  const limit = await enforceRateLimit(c, "pay_offline_cancel", 10);
  if (!limit.ok) return fail(c, limit.message || "请求过于频繁，请稍后再试", limit.status || 429);

  const db = getDb(c);
  const schema = z.object({
    orderId: z.string().uuid(),
    orderToken: z.string().min(1).max(200),
  });

  const body = schema.safeParse(await safeJsonBody(c));
  if (!body.success) return fail(c, "请求参数无效", 400, body.error.flatten());

  const tokenHash = await hashOrderToken(body.data.orderToken);
  const [order] = await db
    .select({ id: orders.id, status: orders.status, paymentMethod: orders.paymentMethod, paymentRef: orders.paymentRef })
    .from(orders)
    .where(and(eq(orders.id, body.data.orderId), eq(orders.orderTokenHash, tokenHash)))
    .limit(1);

  if (!order) return fail(c, "订单不存在或凭证无效", 404);
  if (order.paymentMethod !== "offline") return fail(c, "非线下支付订单", 400);
  const offlineStatus = normalizeOrderStatus(order.status);
  if (offlineStatus === "canceled") return ok(c, { canceled: true, releasedCards: 0 });
  if (offlineStatus !== "pending") return fail(c, "订单状态不可取消", 409);
  if (order.paymentRef?.startsWith("last4:")) return fail(c, "已提交付款确认，不能直接取消，请联系管理员核对", 409);

  // 取消使用 status + payment_ref 双条件 CAS，防止“用户取消”和“用户刚提交付款确认”同时成功。
  const cancellation = await withDbTransaction(db, async (tx) => {
    const updated = await tx
      .update(orders)
      .set({ status: "canceled" })
      .where(and(
        eq(orders.id, body.data.orderId),
        eq(orders.status, "pending"),
        eq(orders.paymentMethod, "offline"),
        eq(orders.paymentRef, order.paymentRef || ""),
      ));
    if (updated.rowsAffected === 0) return null;

    const releasedCards = await releaseLockedCardByOrder(tx, body.data.orderId);
    await releaseOrderCouponReservation(tx, body.data.orderId);
    return { releasedCards };
  });
  if (!cancellation) return fail(c, "订单状态已变更，请刷新重试", 409);

  const { releasedCards } = cancellation;
  await writeOrderEvent(db, body.data.orderId, "canceled", "用户关闭线下支付并取消订单，已释放库存", { releasedCards });
  return ok(c, { canceled: true, releasedCards });
});

/* ===== 工具函数 ===== */

export function createPayOrderNo(): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
  return `P${ts}${rand}`;
}

/** 生成 6 位纯数字付款备注码，用于线下支付对账（6 位空间 900,000，低频场景碰撞概率极低） */
export function createOfflineNoteCode(): string {
  const array = new Uint8Array(4);
  crypto.getRandomValues(array);
  const val = ((array[0] << 24) | (array[1] << 16) | (array[2] << 8) | array[3]) >>> 0;
  return String((val % 900000) + 100000);
}
