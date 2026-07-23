import type { Context } from "hono";
import { FULFILLMENT_MODES, type AppEnv, type IssueMode, type FulfillmentMode } from "../bindings";
import { withDbTransaction, type DbType, type DbWriteScope } from "../db/client";
import { getDb, getOrigin, normalizeCode } from "../lib/http";
import { createOrderNo, createOrderToken, hashOrderToken } from "../lib/token";
import { getProduct } from "./product-service";
import { consumeCoupon, getCoupon, quoteCoupon, releaseCouponReservation } from "./coupon-service";
import { releaseLockedCardByOrder } from "./issue-service";
import type { IssuedCard } from "./issue-service";
import { fulfillCardInventoryItems, lockFulfillmentInventoryItems, toVirtualFulfillmentResult } from "./fulfillment-service";
import { writeOrderEvent } from "./audit-service";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { orders, orderItems, products, cards, referralEvents } from "../db/schema";
import { getOrderExpiresAt, getOrderRateLimitConfig } from "../lib/system-config-registry";
import { type RuntimeConfig, mergeRuntimeConfig, readRuntimeConfig } from "../lib/runtime-config";
import type { DeliveryVisibility } from "../../shared/product-contract";
import { minorToMajorString } from "../../shared/money";
import { serializeFulfillmentInputSnapshot, validateFulfillmentInput } from "../../shared/fulfillment-input";

const DEFAULT_DELIVERY_VISIBILITY: DeliveryVisibility = "web_and_email";

function isFulfillmentMode(value: unknown): value is FulfillmentMode {
  // 外部输入和历史数据都先收敛到白名单，避免后续按未知履约模式走错分支。
  return typeof value === "string" && (FULFILLMENT_MODES as readonly string[]).includes(value);
}

function normalizeDeliveryVisibility(value: unknown): DeliveryVisibility {
  // 只有 email_only 触发后端脱敏；其他空值/历史脏值都降级为 Web + 邮件双展示。
  return value === "email_only" ? "email_only" : DEFAULT_DELIVERY_VISIBILITY;
}

export function buildDeliveryMessage(buyerEmail?: string | null): string {
  const target = buyerEmail && buyerEmail.includes("@") ? buyerEmail : "下单邮箱";
  return `卡密已生成并将发送到 ${target}，邮件可能延迟；如未收到，请检查垃圾邮件或联系售后。`;
}

/**
 * 后端交付可见性是安全边界：email_only 商品只允许邮件承载卡密，
 * API 与 Web 页面均不返回 delivery/cards，避免前端漏隐藏导致注册码外泄。
 */
export function deliveryVisibilityPayload(input: {
  deliveryVisibility?: string | null;
  buyerEmail?: string | null;
  status?: string | null;
}): { deliveryVisibility: DeliveryVisibility; deliveryMessage?: string } {
  const deliveryVisibility = normalizeDeliveryVisibility(input.deliveryVisibility);
  if (deliveryVisibility !== "email_only") return { deliveryVisibility };
  if (input.status !== "issued") return { deliveryVisibility };
  return {
    deliveryVisibility,
    deliveryMessage: buildDeliveryMessage(input.buyerEmail),
  };
}

function isEmailOnlyDelivery(row: { deliveryVisibility?: string | null }): boolean {
  return normalizeDeliveryVisibility(row.deliveryVisibility) === "email_only";
}

/**
 * 检查并作废过期订单。
 * 幂等操作：使用 Drizzle ORM 条件 UPDATE + RETURNING 只在当前仍为 pending 时才作废，
 * 防止并发覆盖已发卡状态。
 * 被 /pay/status 轮询、markPaidAndIssue 和 cleanup-service 共用。
 *
 * @returns { expired, releasedCards } — expired 为 true 表示本次调用成功将订单标记为 expired；
 *        releasedCards 为释放的卡密数量（仅在 expired=true 时非零）
 */
export async function checkAndExpireOrder(
  db: DbType,
  orderId: string,
  expiresAt: string | null,
  currentStatus: string,
  env?: RuntimeConfig,
  orderInfo?: { orderNo: string; productTitle: string; buyerEmail: string },
  executionCtx?: ExecutionContext
): Promise<{ expired: boolean; releasedCards: number }> {
  // 已付款/已发卡/已交付订单不应再回滚为 expired：支付事实成立后必须进入履约/人工处理，不能释放库存和优惠权益。
  // 只允许未支付 pending 订单过期并释放未使用的软锁。
  if (!expiresAt || new Date(expiresAt).getTime() >= Date.now() || currentStatus !== "pending") {
    return { expired: false, releasedCards: 0 };
  }

  // 状态迁移、库存释放和优惠券释放必须同事务提交。
  // 这样已验证的迟到回调只能在清理完整提交后恢复 expired -> paid，不会撞上半完成的释放流程。
  const expiration = await withDbTransaction(db, async (tx) => {
    const result = await tx
      .update(orders)
      .set({ status: "expired" })
      .where(and(eq(orders.id, orderId), eq(orders.status, "pending")))
      .returning({ id: orders.id, couponCode: orders.couponCode });
    const expiredOrder = result[0];
    if (!expiredOrder) return { expired: false as const, releasedCards: 0 };

    const releasedCards = await releaseLockedCardByOrder(tx, orderId);
    if (expiredOrder.couponCode) {
      await releaseCouponReservation(tx, expiredOrder.couponCode);
    }
    return { expired: true as const, releasedCards };
  });

  if (expiration.expired) {
    await writeOrderEvent(db, orderId, "expired", "订单已过期，系统自动作废");
    const emailEnv = env ?? await readRuntimeConfig(db);
    if (emailEnv.resendApiKey && orderInfo?.buyerEmail && orderInfo.buyerEmail.includes("@")) {
      const { sendEmail } = await import("./email-service");
      const emailPromise = sendEmail(db, emailEnv, {
        to: orderInfo.buyerEmail,
        template: "order_expired",
        templateData: {
          orderNo: orderInfo.orderNo || "",
          productName: orderInfo.productTitle || "",
        },
        orderId,
      });
      if (executionCtx) {
        executionCtx.waitUntil(emailPromise);
      } else {
        emailPromise.catch((e) => console.warn("[email] failed to send expired notification:", e));
      }
    }
    return expiration;
  }
  return { expired: false, releasedCards: 0 };
}

export type CreateOrderInput = {
  productId?: string;
  buyerContact?: string;
  buyerEmail: string;  // 下单时必填（Zod 强制非空）
  fulfillmentInput?: string;
  quantity?: number;
  couponCode?: string;
  campaignCode?: string;
  referralCode?: string;
};

export type OrderSummaryRow = {
  id: string;
  orderNo: string;
  productId: string;
  productTitle: string;
  orderSource?: string;
  storefrontId?: string | null;
  storefrontSlugSnapshot?: string;
  storefrontNameSnapshot?: string;
  /**
   * 买家联系方式。用途因支付渠道而异：
   * - 线上支付：格式为 `pay:{orderNo后8位}`，用于支付回调对账
   * - 线下支付：格式为 6 位纯数字备注码，用于管理员确认收款时对账
   * - 直接发卡（/orders）：用户填写的联系方式，用于买家沟通
  */
  buyerContact: string;
  buyerEmail: string;
  quantity: number;
  amountCents: number;
  discountCents: number;
  currency: string;
  status: string;
  fulfillmentMode: string;
  issueMode: IssueMode;
  issuedCardId: string | null;
  campaignCode: string;
  referralCode: string;
  couponCode: string;
  createdAt: string;
  paidAt: string | null;
  issuedAt: string | null;
  // 卡密交付字段（通过 LEFT JOIN cards 获取）
  accountLabel: string | null;
  deliverySecret: string | null;
  deliveryNote: string | null;
  deliveryJson: string | null;
  deliveryVisibility: DeliveryVisibility;
  cards?: Array<{
    id: string;
    accountLabel: string;
    deliverySecret: string;
    deliveryNote: string;
  }>;
  items?: Array<{
    id: string;
    productId: string;
    productTitle: string;
    fulfillmentMode: string;
    quantity: number;
    unitPriceCents: number;
    discountCents: number;
    amountCents: number;
    deliveryJson: string;
  }>;
};

function normalizeQuantity(value: unknown): number {
  const quantity = Number(value ?? 1);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) return 1;
  return quantity;
}

class ProductPurchaseLimitError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function assertProductPurchaseLimit(
  db: DbType,
  buyerEmail: string,
  product: { id: string; purchaseLimit?: number | null },
  quantity: number,
): Promise<void> {
  if (typeof product.purchaseLimit !== "number" || product.purchaseLimit <= 0) return;
  const result = await checkProductPurchaseLimitForQuantity(db, buyerEmail, product.id, product.purchaseLimit, quantity);
  if (!result.ok) throw new ProductPurchaseLimitError(result.status, result.message);
}

async function insertSingleOrderItem(
  db: DbWriteScope,
  input: {
    orderId: string;
    productId: string;
    productTitle: string;
    fulfillmentMode: FulfillmentMode;
    quantity: number;
    unitPriceCents: number;
    discountCents: number;
    amountCents: number;
    deliveryJson?: string;
  },
) {
  await db.insert(orderItems).values({
    id: crypto.randomUUID(),
    orderId: input.orderId,
    productId: input.productId,
    productTitle: input.productTitle,
    fulfillmentMode: input.fulfillmentMode,
    quantity: input.quantity,
    unitPriceCents: input.unitPriceCents,
    discountCents: input.discountCents,
    amountCents: input.amountCents,
    deliveryJson: input.deliveryJson || "",
    createdAt: new Date().toISOString(),
  });
}

export function publicOrder(row: OrderSummaryRow, delivery?: unknown) {
  const visibilityPayload = deliveryVisibilityPayload(row);
  type OrderItem = NonNullable<OrderSummaryRow["items"]>[number];
  // email_only 的脱敏必须在后端完成，前端即使误渲染 items 也拿不到 deliveryJson 明文。
  const items: Array<Omit<OrderItem, "deliveryJson"> & { deliveryJson?: string }> | undefined = row.items && isEmailOnlyDelivery(row)
    ? redactItemDeliveries(row.items)
    : row.items;
  // 履约模式优先取订单明细快照，商品当前模式只作为旧数据兜底。
  const fulfillmentMode = row.items?.find((item) => item.fulfillmentMode)?.fulfillmentMode || row.fulfillmentMode;
  return {
    id: row.id,
    orderNo: row.orderNo,
    productId: row.productId,
    productTitle: row.productTitle,
    orderSource: row.orderSource || "storefront",
    storefrontId: row.storefrontId || null,
    storefrontSlugSnapshot: row.storefrontSlugSnapshot || "",
    storefrontNameSnapshot: row.storefrontNameSnapshot || "",
    buyerContact: row.buyerContact,
    buyerEmail: row.buyerEmail,
    quantity: row.quantity,
    amountCents: row.amountCents,
    discountCents: row.discountCents,
    currency: row.currency,
    status: row.status,
    fulfillmentMode,
    issueMode: row.issueMode,
    campaignCode: row.campaignCode,
    referralCode: row.referralCode,
    couponCode: row.couponCode,
    createdAt: row.createdAt,
    paidAt: row.paidAt,
    issuedAt: row.issuedAt,
    ...visibilityPayload,
    ...(items ? { items } : {}),
    ...(!isEmailOnlyDelivery(row) && row.cards ? { cards: row.cards.map((card) => ({
      id: card.id,
      accountLabel: card.accountLabel,
      deliverySecret: card.deliverySecret,
      deliveryNote: card.deliveryNote,
      cardData: [card.accountLabel, card.deliverySecret].filter(Boolean).join(" / "),
    })) } : {}),
    ...(!isEmailOnlyDelivery(row) && delivery ? { delivery } : {})
  };
}

type PublicOrder = ReturnType<typeof publicOrder>;

export function redactItemDeliveries<T extends object>(items: T[]) {
  return items.map((item) => {
    const { deliveryJson: _deliveryJson, ...safeItem } = item as T & { deliveryJson?: unknown };
    return safeItem;
  });
}

/**
 * 公开查单摘要：保留订单状态和跳转所需字段，但不暴露虚拟资料交付内容。
 * Token 查询仍使用 publicOrder 完整响应；邮箱/订单号查询必须走摘要，避免把查单入口变成交付凭据。
 */
export function publicOrderSummary(order: PublicOrder): PublicOrder {
  const {
    delivery: _delivery,
    cards: _cards,
    buyerContact: _buyerContact,
    buyerEmail: _buyerEmail,
    campaignCode: _campaignCode,
    referralCode: _referralCode,
    couponCode: _couponCode,
    deliveryMessage: _deliveryMessage,
    items,
    ...summary
  } = order;
  return {
    ...summary,
    ...(summary.deliveryVisibility === "email_only" && summary.status === "issued"
      ? { deliveryMessage: buildDeliveryMessage() }
      : {}),
    ...(items ? { items: redactItemDeliveries(items) } : {}),
  } as PublicOrder;
}

/** 订单查询公共 select 投影（含卡密交付字段） */
const orderSummarySelect = {
  id: orders.id,
  orderNo: orders.orderNo,
  productId: orders.productId,
  productTitle: products.title,
  orderSource: orders.orderSource,
  storefrontId: orders.storefrontId,
  storefrontSlugSnapshot: orders.storefrontSlugSnapshot,
  storefrontNameSnapshot: orders.storefrontNameSnapshot,
  buyerContact: orders.buyerContact,
  buyerEmail: orders.buyerEmail,
  quantity: orders.quantity,
  amountCents: orders.amountCents,
  discountCents: orders.discountCents,
  currency: orders.currency,
  status: orders.status,
  fulfillmentMode: orders.fulfillmentMode,
  issueMode: orders.issueMode,
  issuedCardId: orders.issuedCardId,
  campaignCode: orders.campaignCode,
  referralCode: orders.referralCode,
  couponCode: orders.couponCode,
  createdAt: orders.createdAt,
  paidAt: orders.paidAt,
  issuedAt: orders.issuedAt,
  accountLabel: cards.accountLabel,
  deliverySecret: cards.deliverySecret,
  deliveryNote: cards.deliveryNote,
  deliveryJson: orders.deliveryJson,
  deliveryVisibility: orders.deliveryVisibility,
};

/**
 * 构建订单查询：JOIN products + LEFT JOIN cards，返回 OrderSummaryRow。
 * 调用方通过回调添加额外的 join / where / orderBy / limit。
 */
function selectOrderSummary(db: DbType) {
  return db
    .select(orderSummarySelect)
    .from(orders)
    .innerJoin(products, eq(products.id, orders.productId))
    .leftJoin(cards, and(eq(cards.id, orders.issuedCardId), eq(cards.issuedOrderId, orders.id)));
}

/** 从查询结果提取第一行并转为公开订单对象 */
function firstOrder(rows: Record<keyof OrderSummaryRow, OrderSummaryRow[keyof OrderSummaryRow] | null>[]): ReturnType<typeof publicOrder> | null {
  const row = rows[0];
  if (!row) return null;
  const hasCardDelivery = row.issuedCardId && (row.accountLabel !== null || row.deliverySecret !== null || row.deliveryNote !== null);
  const delivery = row.status === "issued"
    ? (hasCardDelivery
      ? {
        accountLabel: row.accountLabel || "",
        deliverySecret: row.deliverySecret || "",
        deliveryNote: row.deliveryNote || "",
      }
      : (row.deliveryJson ? JSON.parse((row.deliveryJson as string | null) || "{}") : undefined))
    : undefined;
  return publicOrder(row as OrderSummaryRow, delivery);
}

async function hydratePublicOrder(db: DbType, row: OrderSummaryRow | null): Promise<ReturnType<typeof publicOrder> | null> {
  if (!row) return null;
  const [items, issuedCards] = await Promise.all([
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
      .where(eq(orderItems.orderId, row.id)),
    db
      .select({
        id: cards.id,
        accountLabel: cards.accountLabel,
        deliverySecret: cards.deliverySecret,
        deliveryNote: cards.deliveryNote,
      })
      .from(cards)
      .where(eq(cards.issuedOrderId, row.id)),
  ]);

  const cardsForOrder = issuedCards
    .filter((card) => Boolean(card.accountLabel || card.deliverySecret || card.deliveryNote))
    .map((card) => ({
    id: card.id,
    accountLabel: card.accountLabel || "",
    deliverySecret: card.deliverySecret || "",
    deliveryNote: card.deliveryNote || "",
  }));
  const virtualItem = items.find((item) => item.deliveryJson);
  // 多数量卡密通过 cards 数组完整返回；delivery 仅保留第一条，兼容旧前端只读 delivery 的路径。
  const delivery = row.status === "issued"
    ? (cardsForOrder.length > 0
      ? {
        accountLabel: cardsForOrder[0].accountLabel,
        deliverySecret: cardsForOrder[0].deliverySecret,
        deliveryNote: cardsForOrder[0].deliveryNote,
      }
      : (virtualItem?.deliveryJson ? JSON.parse(virtualItem.deliveryJson) : (row.deliveryJson ? JSON.parse(row.deliveryJson) : undefined)))
    : undefined;

  return publicOrder({
    ...row,
    fulfillmentMode: items.find((item) => item.fulfillmentMode)?.fulfillmentMode || row.fulfillmentMode,
    items: items.map((item) => ({
      id: item.id,
      productId: item.productId,
      productTitle: item.productTitle,
      fulfillmentMode: item.fulfillmentMode,
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
      discountCents: item.discountCents,
      amountCents: item.amountCents,
      deliveryJson: item.deliveryJson,
    })),
    cards: cardsForOrder,
  }, delivery);
}

type RateLimitResult =
  | { ok: true }
  | { ok: false; status: number; message: string };

/**
 * 单邮箱限购：同一邮箱对同一商品，在配置时间窗口内最多 N 笔 pending/paid 订单。
 * 只对提供 buyerEmail 的订单生效，防止恶意批量下单和余额盗刷。
 */
export async function checkOrderRateLimit(db: DbType, buyerEmail: string, productId: string): Promise<RateLimitResult> {
  const { windowSeconds, maxOrders } = await getOrderRateLimitConfig(db);
  const windowStart = new Date(Date.now() - windowSeconds * 1000).toISOString();
  const result = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(orders)
    .where(and(
      eq(sql`lower(${orders.buyerEmail})`, buyerEmail.trim().toLowerCase()),
      eq(orders.productId, productId),
      or(eq(orders.status, 'pending'), eq(orders.status, 'paid')),
      sql`${orders.createdAt} >= ${windowStart}`
    ));
  const count = Number(result[0]?.count || 0);
  if (count >= maxOrders) {
    return { ok: false, status: 429, message: `该邮箱购买过于频繁，请 ${windowSeconds / 60} 分钟后再试` };
  }
  return { ok: true };
}

/**
 * 余额支付全局限购：同一邮箱在配置时间窗口内最多 N 笔余额支付的 pending/paid 订单。
 * 防止余额盗刷：攻击者即使拿到用户密码，也无法在短时间内批量余额支付。
 */
export async function checkBalanceOrderRateLimit(db: DbType, buyerEmail: string): Promise<RateLimitResult> {
  const { windowSeconds, maxOrders } = await getOrderRateLimitConfig(db);
  const windowStart = new Date(Date.now() - windowSeconds * 1000).toISOString();
  const result = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(orders)
    .where(and(
      eq(sql`lower(${orders.buyerEmail})`, buyerEmail.trim().toLowerCase()),
      eq(orders.paymentProvider, "balance"),
      or(eq(orders.status, 'pending'), eq(orders.status, 'paid')),
      sql`${orders.createdAt} >= ${windowStart}`
    ));
  const count = Number(result[0]?.count || 0);
  if (count >= maxOrders) {
    return { ok: false, status: 429, message: `该邮箱余额支付过于频繁，请 ${windowSeconds / 60} 分钟后再试` };
  }
  return { ok: true };
}

/**
 * 商品级限购：同一邮箱对同一商品的总 pending/paid/issued 件数不得超过商品限购数量。
 * 不限购商品（purchaseLimit 为空或 <= 0）不做限制。
 */
export async function checkProductPurchaseLimit(db: DbType, buyerEmail: string, productId: string, purchaseLimit: number | null | undefined): Promise<RateLimitResult> {
  return checkProductPurchaseLimitForQuantity(db, buyerEmail, productId, purchaseLimit, 1);
}

export async function checkProductPurchaseLimitForQuantity(
  db: DbType,
  buyerEmail: string,
  productId: string,
  purchaseLimit: number | null | undefined,
  quantity: number,
): Promise<RateLimitResult> {
  const effectiveLimit = typeof purchaseLimit === 'number' && purchaseLimit > 0 ? purchaseLimit : null;
  if (!effectiveLimit) {
    return { ok: true };
  }
  const requestedQuantity = Number.isInteger(quantity) && quantity > 0 ? quantity : 1;
  const result = await db
    .select({ count: sql<number>`COALESCE(SUM(${orders.quantity}), 0)` })
    .from(orders)
    .where(and(
      eq(sql`lower(${orders.buyerEmail})`, buyerEmail.trim().toLowerCase()),
      eq(orders.productId, productId),
      or(eq(orders.status, 'pending'), eq(orders.status, 'paid'), eq(orders.status, 'issued'))
    ));
  const count = Number(result[0]?.count || 0);
  if (count + requestedQuantity > effectiveLimit) {
    return { ok: false, status: 429, message: `该商品每人限购 ${effectiveLimit} 件，您已达到上限` };
  }
  return { ok: true };
}

export type CreateOrderResult =
  | { ok: true; order: Record<string, unknown> }
  | { ok: false; status: number; message: string };

export async function createOrder(c: Context<AppEnv>, input: CreateOrderInput, ipHash: string): Promise<CreateOrderResult> {
  const db = getDb(c);
  const ctx = c.get("executionCtx") as ExecutionContext | undefined;
  const dbConfig = await readRuntimeConfig(db, c.env?.CREDENTIALS_ENCRYPTION_KEY);
  const emailEnv = mergeRuntimeConfig(dbConfig, c.env);
  // 订单主流程必须保持非常薄：先确认商品，再校验折扣码，最后按发卡模式进入 direct/manual。
  const coupon = await getCoupon(db, input.couponCode);
  const userProvidedCode = !!input.couponCode?.trim();
  const resolvedProductId = input.productId || coupon?.productId || "";
  if (!resolvedProductId) {
    // 区分三种场景：折扣码不存在 / 折扣码未绑定商品 / 根本没传商品和折扣码
    if (userProvidedCode && !coupon) {
      return { ok: false as const, status: 400, message: "折扣码不存在" };
    }
    if (coupon && !coupon.productId) {
      return { ok: false as const, status: 400, message: "该折扣码未绑定商品" };
    }
    return { ok: false as const, status: 400, message: "请选择商品" };
  }
  const product = await getProduct(db, resolvedProductId);
  if (!product) return { ok: false as const, status: 404, message: "商品不存在或已下架" };
  // 校验发卡模式枚举值，防止数据库中存入非法值导致后续逻辑异常
  const validIssueModes: IssueMode[] = ["direct", "manual"];
  if (!product.issueMode || !validIssueModes.includes(product.issueMode)) {
    return { ok: false as const, status: 400, message: "商品发卡模式配置异常，请联系管理员" };
  }
  // 校验履约模式枚举值
  if (!isFulfillmentMode(product.fulfillmentMode)) {
    return { ok: false as const, status: 400, message: "商品履约模式配置异常，请联系管理员" };
  }
  const issueMode = product.issueMode;
  const fulfillmentMode = product.fulfillmentMode;
  const deliveryVisibility = normalizeDeliveryVisibility(product.deliveryVisibility);
  const fulfillmentInput = validateFulfillmentInput({
    type: product.fulfillmentInputType,
    label: product.fulfillmentInputLabel,
    hint: product.fulfillmentInputHint,
    required: product.fulfillmentInputRequired,
  }, input.fulfillmentInput);
  if (!fulfillmentInput.ok) {
    return { ok: false as const, status: 400, message: fulfillmentInput.message };
  }
  const fulfillmentInputJson = serializeFulfillmentInputSnapshot(fulfillmentInput.snapshot);
  const quantity = normalizeQuantity(input.quantity);
  if (fulfillmentMode === "card" && product.stock !== undefined && Number(product.stock || 0) < quantity) {
    return { ok: false as const, status: 409, message: "当前商品库存不足" };
  }
  const baseAmountCents = product.priceCents * quantity;
  const quote = await quoteCoupon(db, baseAmountCents, product.id, input.couponCode, product.currency);
  if (!quote.valid) return { ok: false as const, status: 403, message: quote.message };
  if (issueMode === "direct" && quote.payableCents > 0) {
    return { ok: false as const, status: 400, message: "付费商品不能使用直接发卡模式，请改用支付下单" };
  }
  if (deliveryVisibility === "email_only" && !emailEnv.resendApiKey) {
    return { ok: false as const, status: 503, message: "该商品仅通过邮件交付，但邮件服务未配置，请联系管理员" };
  }

  // ── 单邮箱限购：直发和待支付路径都必须遵守商品总限购 ──
  const normalizedBuyerEmail = (input.buyerEmail || "").trim().toLowerCase();
  if (normalizedBuyerEmail && normalizedBuyerEmail.includes("@")) {
    if (issueMode !== "direct") {
      const rateLimit = await checkOrderRateLimit(db, normalizedBuyerEmail, product.id);
      if (!rateLimit.ok) {
        return { ok: false as const, status: rateLimit.status, message: rateLimit.message };
      }
    }
    const purchaseLimit = await checkProductPurchaseLimitForQuantity(db, normalizedBuyerEmail, product.id, product.purchaseLimit, quantity);
    if (!purchaseLimit.ok) {
      return { ok: false as const, status: purchaseLimit.status, message: purchaseLimit.message };
    }
  }
  const orderId = crypto.randomUUID();
  const orderNo = createOrderNo();
  const orderToken = createOrderToken();
  const orderTokenHash = await hashOrderToken(orderToken);
  const userAgent = c.req.header("user-agent") || "";
  const campaignCode = normalizeCode(input.campaignCode);
  const referralCode = normalizeCode(input.referralCode);
  const couponCode = normalizeCode(quote.couponCode);
  const buyerContact = input.buyerContact?.trim() || (couponCode ? `redeem:${couponCode}` : "");
  const status = issueMode === "direct" ? "issued" : "pending";
  const origin = getOrigin(c);

  // ── 虚拟资料直接交付（非 card + direct） ──
  // 不经过 cards 表，不锁库存，直接写入 delivery_json 并标记 issued。
  if (fulfillmentMode !== "card" && issueMode === "direct") {
    const deliveryJson = JSON.stringify({
      accountLabel: product.title,
      deliverySecret: product.salesCopy,
      deliveryNote: "虚拟资料直接交付"
    });
    const nowStr = new Date().toISOString();
    try {
      await withDbTransaction(db, async (tx) => {
        await assertProductPurchaseLimit(tx, normalizedBuyerEmail, product, quantity);
        if (couponCode) {
          const couponResult = await consumeCoupon(tx, couponCode);
          if (!couponResult.success) throw new Error("优惠码已被他人使用或已失效，请重试");
        }
        await tx.insert(orders).values({
          id: orderId,
          orderNo,
          productId: product.id,
          buyerContact,
          buyerEmail: normalizedBuyerEmail,
          quantity,
          amountCents: quote.payableCents,
          discountCents: quote.discountCents,
          currency: product.currency,
          status: "issued",
          fulfillmentMode,
          paymentMethod: "",
          paymentRef: "",
          issueMode,
          orderTokenHash,
          campaignCode,
          referralCode,
          couponCode,
          ipHash,
          userAgent,
          createdAt: nowStr,
          issuedAt: nowStr,
          deliveryJson,
          fulfillmentInputJson,
          deliveryVisibility,
        });
        await insertSingleOrderItem(tx, {
          orderId,
          productId: product.id,
          productTitle: product.title,
          fulfillmentMode,
          quantity,
          unitPriceCents: product.priceCents,
          discountCents: quote.discountCents,
          amountCents: quote.payableCents,
          deliveryJson,
        });
      });
    } catch (error) {
      if (error instanceof ProductPurchaseLimitError) {
        return { ok: false as const, status: error.status, message: error.message };
      }
      if (error instanceof Error && error.message === "优惠码已被他人使用或已失效，请重试") {
        return { ok: false as const, status: 409, message: error.message };
      }
      console.error("[createOrder] virtual direct insert failed", error);
      throw new Error("订单创建失败，请稍后重试");
    }

    await writeOrderEvent(db, orderId, "issued", "虚拟资料订单创建并完成自动交付", { fulfillmentMode });
    if (referralCode) {
      await db.insert(referralEvents).values({
        id: crypto.randomUUID(),
        referralCode,
        orderId,
        buyerContact,
        status: "created",
        createdAt: new Date().toISOString(),
      });
    }

    const buyerEmail = normalizedBuyerEmail;
    if (emailEnv.resendApiKey && buyerEmail && buyerEmail.includes("@")) {
      const { sendEmail } = await import("./email-service");
      c.get("executionCtx").waitUntil(
        sendEmail(db, emailEnv, {
          to: buyerEmail,
          template: "order_issued",
          templateData: {
            orderNo,
            productName: product.title,
            accountLabel: product.title,
            deliverySecret: product.salesCopy,
            deliveryNote: "虚拟资料直接交付"
          },
          orderId
        }).catch((e) => console.warn("[email] failed to send virtual direct notification:", e))
      );
    }

    const visibilityPayload = deliveryVisibilityPayload({
      deliveryVisibility,
      buyerEmail: normalizedBuyerEmail,
      status: "issued",
    });
    return {
      ok: true as const,
      order: {
        id: orderId,
        orderNo,
        status,
        issueMode,
        fulfillmentMode,
        quantity,
        amountCents: quote.payableCents,
        currency: product.currency,
        orderToken,
        lookupUrl: `${origin}/lookup?token=${encodeURIComponent(orderToken)}`,
        ...visibilityPayload,
        ...(deliveryVisibility !== "email_only" ? {
          delivery: {
            accountLabel: product.title,
            deliverySecret: product.salesCopy,
            deliveryNote: "虚拟资料直接交付"
          },
        } : {}),
      }
    };
  }

  if (issueMode !== "direct") {
    // manual/webhook 只创建待处理订单，不提前发卡；后续由管理员或支付回调触发原子发卡。
    const expiresAtStr = await getOrderExpiresAt(db);
    const deliveryJson = fulfillmentMode !== "card" ? JSON.stringify({
      accountLabel: product.title,
      deliverySecret: product.salesCopy,
      deliveryNote: "虚拟资料待交付"
    }) : "";

    try {
      const nowStr = new Date().toISOString();
      await withDbTransaction(db, async (tx) => {
        // 数量购买的防超卖边界：锁库存、写订单、写 order_items 必须同事务完成。
        await assertProductPurchaseLimit(tx, normalizedBuyerEmail, product, quantity);
        if (couponCode) {
          const couponResult = await consumeCoupon(tx, couponCode);
          if (!couponResult.success) throw new Error("优惠码已被他人使用或已失效，请重试");
        }
        const lockedCard = fulfillmentMode !== "card"
          ? { mode: "virtual" as const, inventoryIds: [] }
          : await lockFulfillmentInventoryItems(tx, orderId, product.id, expiresAtStr, quantity);
        if (!lockedCard) throw new Error("当前商品库存不足");

        await tx.insert(orders).values({
          id: orderId,
          orderNo,
          productId: product.id,
          buyerContact,
          buyerEmail: normalizedBuyerEmail,
          quantity,
          amountCents: quote.payableCents,
          discountCents: quote.discountCents,
          currency: product.currency,
          status,
          fulfillmentMode,
          paymentMethod: "",
          paymentRef: "",
          issueMode,
          orderTokenHash,
          campaignCode,
          referralCode,
          couponCode,
          ipHash,
          userAgent,
          createdAt: nowStr,
          expiresAt: expiresAtStr,
          deliveryJson,
          fulfillmentInputJson,
          deliveryVisibility: normalizeDeliveryVisibility(product.deliveryVisibility),
        });
        await insertSingleOrderItem(tx, {
          orderId,
          productId: product.id,
          productTitle: product.title,
          fulfillmentMode,
          quantity,
          unitPriceCents: product.priceCents,
          discountCents: quote.discountCents,
          amountCents: quote.payableCents,
          deliveryJson,
        });
      });
    } catch (err) {
      if (err instanceof ProductPurchaseLimitError) {
        return { ok: false as const, status: err.status, message: err.message };
      }
      if (err instanceof Error && err.message === "当前商品库存不足") {
        return { ok: false as const, status: 409, message: "当前商品库存不足" };
      }
      if (err instanceof Error && err.message === "优惠码已被他人使用或已失效，请重试") {
        return { ok: false as const, status: 409, message: "优惠码已被他人使用或已失效，请重试" };
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[createOrder] manual insert failed", msg, (err as Error)?.stack);
      throw new Error("订单创建失败，请稍后重试: " + msg);
    }

    // 优惠码已在待支付订单创建事务中预留；管理员拒绝/取消/过期时释放预留。
    await writeOrderEvent(db, orderId, "created", "订单已创建，等待确认发卡");
    // manual 模式下单后发邮件通知买家（异步，不阻塞主流程）
    const buyerEmail = normalizedBuyerEmail;
    if (emailEnv.resendApiKey && buyerEmail && buyerEmail.includes("@")) {
      const { sendEmail } = await import("./email-service");
      c.get("executionCtx").waitUntil(
        sendEmail(db, emailEnv, {
          to: buyerEmail,
          template: "order_pending",
          templateData: {
            orderNo,
            productName: product.title,
            price: minorToMajorString(quote.payableCents, product.currency),
            currency: product.currency,
          },
          orderId
        }).catch((e) => console.warn("[email] failed to send pending notification:", e))
      );
    }
    return {
      ok: true as const,
      order: {
        id: orderId,
        orderNo,
        status,
        issueMode,
        fulfillmentMode,
        quantity,
        amountCents: quote.payableCents,
        currency: product.currency,
        orderToken,
        lookupUrl: `${origin}/lookup?token=${encodeURIComponent(orderToken)}`,
        nextAction: "请按页面说明完成付款或联系管理员"
      }
    };
  }

  // card + direct 模式只用于免单/演示/低风险商品。
  // 未上线阶段不保留“先发卡后补偿写订单”的旧做法：优惠码消耗、发卡、订单、order_items 同事务提交。
  const directResult = await withDbTransaction(db, async (tx) => {
    const nowStr = new Date().toISOString();
    await assertProductPurchaseLimit(tx, normalizedBuyerEmail, product, quantity);
    if (couponCode) {
      const couponResult = await consumeCoupon(tx, couponCode);
      if (!couponResult.success) throw new Error("优惠码已被他人使用或已失效，请重试");
    }

    const fulfillment = await fulfillCardInventoryItems(tx, orderId, product.id, quantity, normalizedBuyerEmail, buyerContact);
    if (!fulfillment?.cards?.length || fulfillment.cards.length < quantity) throw new Error("当前商品库存不足");
    const issued = fulfillment.cards[0];

    await tx.insert(orders).values({
      id: orderId,
      orderNo,
      productId: product.id,
      buyerContact,
      buyerEmail: normalizedBuyerEmail,
      quantity,
      amountCents: quote.payableCents,
      discountCents: quote.discountCents,
      currency: product.currency,
      status: "issued",
      fulfillmentMode,
      paymentMethod: "",
      paymentRef: "",
      issueMode,
      orderTokenHash,
      issuedCardId: issued.id,
      campaignCode,
      referralCode,
      couponCode,
      ipHash,
      userAgent,
      createdAt: nowStr,
      issuedAt: nowStr,
      fulfillmentInputJson,
      deliveryVisibility,
    });
    await insertSingleOrderItem(tx, {
      orderId,
      productId: product.id,
      productTitle: product.title,
      fulfillmentMode,
      quantity,
      unitPriceCents: product.priceCents,
      discountCents: quote.discountCents,
      amountCents: quote.payableCents,
    });
    return { fulfillment, issued };
  }).catch((error) => {
    if (error instanceof ProductPurchaseLimitError) {
      return { error: "purchase_limit" as const, status: error.status, message: error.message };
    }
    if (error instanceof Error && error.message === "当前商品库存不足") {
      return { error: "stock" as const };
    }
    if (error instanceof Error && error.message === "优惠码已被他人使用或已失效，请重试") {
      return { error: "coupon" as const };
    }
    throw new Error("订单创建失败，请稍后重试");
  });

  if ("error" in directResult) {
    if (directResult.error === "purchase_limit") {
      return { ok: false as const, status: directResult.status, message: directResult.message };
    }
    return directResult.error === "stock"
      ? { ok: false as const, status: 409, message: "当前商品库存不足" }
      : { ok: false as const, status: 409, message: "优惠码已被他人使用或已失效，请重试" };
  }
  const { fulfillment, issued } = directResult;
  await writeOrderEvent(db, orderId, "issued", "订单创建并完成自动发卡", { cardId: issued.id });
  if (referralCode) {
    await db.insert(referralEvents).values({
      id: crypto.randomUUID(),
      referralCode,
      orderId,
      buyerContact,
      status: "created",
      createdAt: new Date().toISOString(),
    });
  }

  // direct 模式发卡成功后发邮件通知（异步，不阻塞主流程）
  const buyerEmail = normalizedBuyerEmail;
  if (emailEnv.resendApiKey && buyerEmail && buyerEmail.includes("@")) {
    const { buildIssuedDeliveryTemplateData, sendEmail } = await import("./email-service");
    c.get("executionCtx").waitUntil(
      sendEmail(db, emailEnv, {
        to: buyerEmail,
        template: "order_issued",
        templateData: {
          orderNo,
          productName: product.title,
          ...buildIssuedDeliveryTemplateData(fulfillment.cards || [issued]),
        },
        orderId
      }).catch((e) => console.warn("[email] failed to send direct issue notification:", e))
    );
  }

  const visibilityPayload = deliveryVisibilityPayload({
    deliveryVisibility,
    buyerEmail: normalizedBuyerEmail,
    status: "issued",
  });
  return {
    ok: true as const,
    order: {
      id: orderId,
      orderNo,
      status,
      issueMode,
      fulfillmentMode,
      quantity,
      amountCents: quote.payableCents,
      currency: product.currency,
      orderToken,
      lookupUrl: `${origin}/lookup?token=${encodeURIComponent(orderToken)}`,
      ...visibilityPayload,
      ...(deliveryVisibility !== "email_only" ? {
        delivery: {
          accountLabel: issued.accountLabel,
          deliverySecret: issued.deliverySecret,
          deliveryNote: issued.deliveryNote
        },
        cards: fulfillment.cards?.map((card) => ({
          id: card.id,
          accountLabel: card.accountLabel,
          deliverySecret: card.deliverySecret,
          deliveryNote: card.deliveryNote,
          cardData: [card.accountLabel, card.deliverySecret].filter(Boolean).join(" / "),
        })),
      } : {}),
    }
  };
}

export async function getOrderByToken(db: DbType, token: string) {
  const tokenHash = await hashOrderToken(token);
  const rows = await selectOrderSummary(db)
    .where(eq(orders.orderTokenHash, tokenHash));
  return hydratePublicOrder(db, rows[0] as OrderSummaryRow | null);
}

export type EmailOrderSummary = {
  id: string;
  orderNo: string | null;
  productId: string;
  productTitle: string;
  orderSource: string;
  storefrontId: string | null;
  storefrontSlugSnapshot: string;
  storefrontNameSnapshot: string;
  quantity: number;
  amountCents: number;
  discountCents: number;
  currency: string;
  status: string;
  fulfillmentMode: string;
  createdAt: string;
  paidAt: string | null;
  issuedAt: string | null;
  expiresAt: string | null;
  deliveryVisibility: DeliveryVisibility;
};

/**
 * 按已验证邮箱列出订单摘要。
 *
 * 查询投影和返回映射都使用字段白名单，禁止返回 buyerEmail、orderToken、卡密、联系方式及交付 JSON。
 * 商品名称优先使用 order_items 中的下单快照，避免后台改名后历史订单显示漂移。
 */
export async function getOrderSummariesByEmail(
  db: DbType,
  email: string,
  limit = 20,
): Promise<EmailOrderSummary[]> {
  const normalizedEmail = email.trim().toLowerCase();
  const safeLimit = Math.min(50, Math.max(1, Math.trunc(limit) || 20));
  const rows = await db
    .select({
      id: orders.id,
      orderNo: orders.orderNo,
      productId: orders.productId,
      productTitle: sql<string>`COALESCE(
        NULLIF((SELECT ${orderItems.productTitle} FROM ${orderItems} WHERE ${orderItems.orderId} = ${orders.id} ORDER BY ${orderItems.id} LIMIT 1), ''),
        NULLIF(${products.title}, ''),
        ${orders.productId}
      )`,
      orderSource: orders.orderSource,
      storefrontId: orders.storefrontId,
      storefrontSlugSnapshot: orders.storefrontSlugSnapshot,
      storefrontNameSnapshot: orders.storefrontNameSnapshot,
      quantity: orders.quantity,
      amountCents: orders.amountCents,
      discountCents: orders.discountCents,
      currency: orders.currency,
      status: orders.status,
      fulfillmentMode: orders.fulfillmentMode,
      createdAt: orders.createdAt,
      paidAt: orders.paidAt,
      issuedAt: orders.issuedAt,
      expiresAt: orders.expiresAt,
      deliveryVisibility: orders.deliveryVisibility,
    })
    .from(orders)
    // 订单摘要以订单和下单快照为事实来源。商品当前行只用于兼容没有 order_items 的旧订单，
    // 因此必须 LEFT JOIN，不能让商品归档或历史数据缺口导致用户已验证邮箱后仍查不到订单。
    .leftJoin(products, eq(products.id, orders.productId))
    .where(eq(sql`lower(${orders.buyerEmail})`, normalizedEmail))
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(safeLimit);

  return rows.map((row) => ({
    id: row.id,
    orderNo: row.orderNo,
    productId: row.productId,
    productTitle: row.productTitle,
    orderSource: row.orderSource,
    storefrontId: row.storefrontId,
    storefrontSlugSnapshot: row.storefrontSlugSnapshot,
    storefrontNameSnapshot: row.storefrontNameSnapshot,
    quantity: Number(row.quantity || 1),
    amountCents: Number(row.amountCents || 0),
    discountCents: Number(row.discountCents || 0),
    currency: row.currency,
    status: row.status,
    fulfillmentMode: row.fulfillmentMode,
    createdAt: row.createdAt,
    paidAt: row.paidAt,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    deliveryVisibility: normalizeDeliveryVisibility(row.deliveryVisibility),
  }));
}

/** 标记订单已支付并执行发卡（支付回调/管理员确认共用） */
export async function markPaidAndIssue(
  db: DbType,
  orderId: string,
  env?: RuntimeConfig,
  executionCtx?: ExecutionContext
) {
  // 查订单 + 商品信息
  const orderRows = await db
    .select({
      id: orders.id,
      orderNo: orders.orderNo,
      productId: orders.productId,
      buyerContact: orders.buyerContact,
      buyerEmail: orders.buyerEmail,
      status: orders.status,
      quantity: orders.quantity,
      expiresAt: orders.expiresAt,
      couponCode: orders.couponCode,
      productTitle: products.title,
      fulfillmentMode: orders.fulfillmentMode,
      productFulfillmentMode: products.fulfillmentMode,
      deliveryJson: orders.deliveryJson,
    })
    .from(orders)
    .innerJoin(products, eq(products.id, orders.productId))
    .where(eq(orders.id, orderId));

  const order = orderRows[0];
  if (!order) return { ok: false as const, status: 404, message: "订单不存在" };
  const itemRows = await db
    .select({ quantity: orderItems.quantity, fulfillmentMode: orderItems.fulfillmentMode })
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id));
  const rawItemFulfillmentMode = itemRows.find((item) => item.fulfillmentMode)?.fulfillmentMode;
  if (rawItemFulfillmentMode !== undefined && !isFulfillmentMode(rawItemFulfillmentMode)) {
    return { ok: false as const, status: 409, message: "订单履约模式快照异常，请联系管理员" };
  }
  const itemFulfillmentMode = rawItemFulfillmentMode as FulfillmentMode | undefined;
  const rawFulfillmentMode = itemFulfillmentMode
    || order.fulfillmentMode
    || order.productFulfillmentMode
    || "card";
  if (!isFulfillmentMode(rawFulfillmentMode)) {
    return { ok: false as const, status: 409, message: "订单履约模式快照异常，请联系管理员" };
  }
  const fulfillmentMode = rawFulfillmentMode;

  // 检查是否已过期（使用公共函数，与 /pay/status 轮询逻辑一致）
  const { expired: wasExpired } = await checkAndExpireOrder(db, order.id, order.expiresAt, order.status, env, { orderNo: order.orderNo || "", productTitle: order.productTitle, buyerEmail: order.buyerEmail }, executionCtx);
  if (wasExpired) {
    return { ok: false as const, status: 410, message: "订单已过期" };
  }

  if (order.status === "issued") {
    // 已发订单：对非 card 模式直接返回 deliveryJson；card 模式继续走已有卡密校验。
    if (fulfillmentMode !== "card" && order.deliveryJson) {
      return { ok: true as const, alreadyIssued: true, delivery: JSON.parse(order.deliveryJson) };
    }
    return { ok: true as const, alreadyIssued: true };
  }
  if (!["pending", "paid"].includes(order.status)) return { ok: false as const, status: 409, message: "当前订单状态不可发卡" };

  // ── 虚拟资料交付（非 card） ──
  // 不使用卡密库存，直接读取 orders.deliveryJson 完成交付。
  if (fulfillmentMode !== "card") {
    if (!order.deliveryJson) {
      await writeOrderEvent(db, order.id, "issue_failed", "虚拟商品缺少 delivery_json，需要管理员处理");
      return { ok: false as const, status: 409, message: "虚拟商品内容缺失，请联系管理员" };
    }

    // 消耗优惠码、确认支付事实、标记 issued 必须是同一个业务事实。
    // 优惠码被并发消耗时不能继续交付，否则会形成“优惠未扣但已发货”的账实不一致。
    const nowStr = new Date().toISOString();
    const delivery = JSON.parse(order.deliveryJson);
    const virtualIssue = await withDbTransaction(db, async (tx) => {
      if (order.status === "pending") {
        const locked = await tx
          .update(orders)
          .set({ status: "paid", paidAt: nowStr })
          .where(and(eq(orders.id, order.id), eq(orders.status, "pending")))
          .returning({ id: orders.id });
        if (locked.length === 0) throw new Error("当前订单状态不可发卡");
      }

      const issuedRows = await tx
        .update(orders)
        .set({ status: "issued", issuedAt: nowStr })
        .where(and(eq(orders.id, order.id), eq(orders.status, "paid")))
        .returning({ id: orders.id });
      if (issuedRows.length === 0) throw new Error("当前订单状态不可发卡");

      return { ok: true as const };
    }).catch((err) => {
      if (err instanceof Error && err.message === "当前订单状态不可发卡") {
        return { error: "state_conflict" as const };
      }
      if (err instanceof Error && err.message === "优惠码已被他人使用或已失效，请重试") {
        return { error: "coupon" as const };
      }
      throw err;
    });

    if ("error" in virtualIssue) {
      return virtualIssue.error === "coupon"
        ? { ok: false as const, status: 409, message: "优惠码已被他人使用或已失效，请重试" }
        : { ok: false as const, status: 409, message: "当前订单状态不可发卡" };
    }

    await writeOrderEvent(db, order.id, "issued", "虚拟资料订单交付完成", { fulfillmentMode });

    if (env?.resendApiKey && order.buyerEmail && order.buyerEmail.includes("@")) {
      const { sendEmail } = await import("./email-service");
      const emailPromise = sendEmail(db, env, {
        to: order.buyerEmail,
        template: "order_issued",
        templateData: {
          orderNo: order.orderNo || "",
          productName: order.productTitle,
          accountLabel: delivery.accountLabel || order.productTitle,
          deliverySecret: delivery.deliverySecret || "",
          deliveryNote: delivery.deliveryNote || "虚拟资料直接交付"
        },
        orderId: order.id
      });
      if (executionCtx) {
        executionCtx.waitUntil(emailPromise);
      } else {
        emailPromise.catch((e) => console.warn("[email] failed to send virtual issue notification:", e));
      }
    }

    return { ok: true as const, delivery };
  }

  // ── 先确认支付事实，再发卡 ──
  // pending 订单进入履约前先原子标记为 paid；paid 订单代表支付事实已经成立，
  // 只能继续尝试履约，不能回滚为 pending，否则会丢失收款语义。
  const nowStr = new Date().toISOString();
  const quantity = itemRows.length > 0
    ? itemRows.reduce((sum, item) => sum + Math.max(1, Number(item.quantity || 1)), 0)
    : Math.max(1, Number(order.quantity || 1));

  const existingCardsRaw = await db
    .select({ id: cards.id, accountLabel: cards.accountLabel, deliverySecret: cards.deliverySecret, deliveryNote: cards.deliveryNote })
    .from(cards)
    .where(eq(cards.issuedOrderId, order.id));
  const existingCards = existingCardsRaw.filter((card) => Boolean(card.accountLabel || card.deliverySecret || card.deliveryNote));
  if (existingCards.length >= quantity) {
    const existingIssue = await withDbTransaction(db, async (tx) => {
      const issuedResult = await tx
        .update(orders)
        .set({
          status: "issued",
          issuedCardId: existingCards[0].id,
          issuedAt: nowStr,
          ...(order.status === "pending" ? { paidAt: nowStr } : {}),
        })
        .where(and(
          eq(orders.id, order.id),
          inArray(orders.status, ["pending", "paid"]),
        ));
      if (typeof issuedResult?.rowsAffected === "number" && issuedResult.rowsAffected === 0) {
        throw new Error("当前订单状态不可发卡");
      }
      return { ok: true as const };
    }).catch((err) => {
      if (err instanceof Error && err.message === "当前订单状态不可发卡") {
        return { error: "state_conflict" as const };
      }
      if (err instanceof Error && err.message === "优惠码已被他人使用或已失效，请重试") {
        return { error: "coupon" as const };
      }
      throw err;
    });
    if ("error" in existingIssue) {
      return existingIssue.error === "coupon"
        ? { ok: false as const, status: 409, message: "优惠码已被他人使用或已失效，请重试" }
        : { ok: false as const, status: 409, message: "当前订单状态不可发卡" };
    }
    if (env?.resendApiKey && order.buyerEmail && order.buyerEmail.includes("@")) {
      const { buildIssuedDeliveryTemplateData, sendEmail } = await import("./email-service");
      const emailPromise = sendEmail(db, env, {
        to: order.buyerEmail,
        template: "order_issued",
        templateData: {
          orderNo: order.orderNo || "",
          productName: order.productTitle,
          ...buildIssuedDeliveryTemplateData(existingCards),
        },
        orderId: order.id,
      });
      if (executionCtx) {
        executionCtx.waitUntil(emailPromise);
      } else {
        emailPromise.catch((e) => console.warn("[email] failed to send recovered issue notification:", e));
      }
    }
    return { ok: true as const, alreadyIssued: true, card: existingCards[0] as IssuedCard, cards: existingCards as IssuedCard[] };
  }
  const remainingQuantity = quantity - existingCards.length;

  if (order.status === "pending") {
    // pending -> paid 是收款事实的原子确认；若并发已改状态，不能继续发卡。
    const paidRows = await db
      .update(orders)
      .set({ status: "paid", paidAt: nowStr })
      .where(and(eq(orders.id, order.id), eq(orders.status, "pending")))
      .returning({ id: orders.id });
    if (paidRows.length === 0) {
      return { ok: false as const, status: 409, message: "当前订单状态不可发卡" };
    }
  }

  const fulfillment = await withDbTransaction(db, async (tx) => {
    const result = await fulfillCardInventoryItems(tx, order.id, order.productId, remainingQuantity, order.buyerEmail, order.buyerContact);
    if (!result?.cards?.length || result.cards.length < remainingQuantity) {
      throw new Error("当前商品库存不足");
    }
    const allCards = [...(existingCards as IssuedCard[]), ...result.cards];

    const issueUpdate = await tx
      .update(orders)
      .set({ status: "issued", issuedCardId: allCards[0].id, issuedAt: nowStr })
      .where(and(eq(orders.id, order.id), eq(orders.status, "paid")));
    if (typeof issueUpdate?.rowsAffected === "number" && issueUpdate.rowsAffected === 0) {
      throw new Error("当前订单状态不可发卡");
    }
    return { ...result, card: allCards[0], cards: allCards, delivery: {
      accountLabel: allCards[0].accountLabel,
      deliverySecret: allCards[0].deliverySecret,
      deliveryNote: allCards[0].deliveryNote,
    } };
  }).catch(async (err) => {
    if (err instanceof Error && err.message === "当前订单状态不可发卡") {
      return { error: "state_conflict" as const };
    }
    if (err instanceof Error && err.message === "当前商品库存不足") {
      await writeOrderEvent(db, order.id, "issue_failed", "订单已支付但当前没有足够可发卡密，需要管理员处理");
      return null;
    }
    if (err instanceof Error && err.message === "优惠码已被他人使用或已失效，请重试") {
      return { error: "coupon" as const };
    }
    throw err;
  });

  if (fulfillment && "error" in fulfillment) {
    return fulfillment.error === "coupon"
      ? { ok: false as const, status: 409, message: "优惠码已被他人使用或已失效，请重试" }
      : { ok: false as const, status: 409, message: "当前订单状态不可发卡" };
  }
  if (!fulfillment?.cards?.length) {
    return { ok: false as const, status: 409, message: "当前商品库存不足" };
  }
  const issued = fulfillment.cards[0];

  await writeOrderEvent(db, order.id, "issued", "管理员确认付款并发卡", { cardId: issued.id, cardIds: fulfillment.cards.map((card) => card.id), quantity });

  // 发卡成功后发邮件通知（异步，不阻塞主流程）
  if (env?.resendApiKey && order.buyerEmail && order.buyerEmail.includes("@")) {
    const { buildIssuedDeliveryTemplateData, sendEmail } = await import("./email-service");
    const emailPromise = sendEmail(db, env, {
      to: order.buyerEmail,
      template: "order_issued",
      templateData: {
        orderNo: order.orderNo || "",
        productName: order.productTitle,
        ...buildIssuedDeliveryTemplateData(fulfillment.cards),
      },
      orderId: order.id
    });
    if (executionCtx) {
      executionCtx.waitUntil(emailPromise);
    } else {
      emailPromise.catch((e) => console.warn("[email] failed to send issue notification:", e));
    }
  }

  return { ok: true as const, card: issued, cards: fulfillment.cards };
}
