/**
 * admin-service.ts — Admin 专用数据访问层
 *
 * 职责：
 *   1. 封装 admin.ts 中所有数据库查询
 *   2. 函数签名只接受 DbType + 纯参数，不依赖 Hono Context
 *   3. 不处理 HTTP 响应；普通操作由路由层写审计日志
 *   4. 唯一例外是“清空全部日志”：删除和保留凭证必须在同一事务内完成，避免清空成功但审计写入失败
 *
 * 全面使用 Drizzle ORM，不再依赖原始 SQL。
 * 仅在 ORM 不支持的场景（UNION ALL、UPDATE...RETURNING 原子操作）使用 db.run(sql)。
 */

import { withDbTransaction, type DbType, type DbWriteScope } from "../db/client";
import { FULFILLMENT_MODES } from "../bindings";
import { parseFulfillmentInputSnapshot, type FulfillmentInputType } from "../../shared/fulfillment-input";
import { fulfillmentProgressEventType, type FulfillmentProgressMetadata } from "../../shared/fulfillment-progress";
import type { DeliveryVisibility, StockDisplayMode } from "../../shared/product-contract";
import {
  expandOrderStatusFilter,
  isSafeDeleteOrderStatus,
  SAFE_DELETE_ORDER_STATUSES,
} from "../../shared/order-status";
import {
  products,
  productCategories,
  cards,
  cardBatches,
  cardLogs,
  orders,
  orderItems,
  orderEvents,
  coupons,
  emailLogs,
  campaigns,
  referralCodes,
  referralEvents,
  requestLogs,
  adminAuditLogs,
  systemConfig,
  idempotencyKeys,
  rateLimitWindows,
  voucherCodes,
  userBalances,
  balanceTransactions,
  balanceRechargeOrders,
  storefrontProducts,
  storefronts,
} from "../db/schema";
import { eq, and, or, like, sql, asc, desc, count, inArray, lt, lte, ne } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { getAvailableStockMap } from "./stock-service";
import { PAYMENT_PROVIDER_DISABLED_VALUE, isValidProviderName } from "./payments";
import { decryptSecretConfigValue, encryptSecretConfigValue } from "../lib/secret-config";
import { releaseLockedCardByOrder } from "./issue-service";
import { releaseCouponReservation } from "./coupon-service";
import { buildIssuedDeliveryTemplateData, sendEmail, getTemplate, interpolate, escapeHtml } from "./email-service";
import { writeAdminAudit } from "./audit-service";
import {
  SYSTEM_CONFIG_KEYS,
  buildSystemConfigMap,
  isSensitiveSystemConfigKey,
  readSystemConfigMap,
} from "../lib/system-config-registry";

// ── 类型定义 ──────────────────────────────────────

export type AdminSummary = {
  products: number;
  totalCards: number;
  availableCards: number;
  totalOrders: number;
  pendingOrders: number;
  lowStockCount: number;
  ordersToday: number;
  issuedToday: number;
  totalIncomeCents: number;
  todayIncomeCents: number;
  todayAlipayCents: number;
  todayEasyPayCents: number;
};

/** 近7日每日收入（用于趋势图，对标 TGPays dashboard.php 的 ECharts 图表） */
export type DailyIncomeRow = {
  date: string;       // "06-16" 格式
  amountCents: number;
};

/**
 * 收入归属时间：收入不是订单创建这个事实，而是收款完成这个事实。
 * 优先按 paid_at 统计；历史/直发订单若没有 paid_at，则降级到 issued_at，再降级到 created_at。
 * NULLIF 兼容旧数据中可能存在的空字符串，避免空字符串被 COALESCE 误当作有效时间。
 */
const orderIncomeAt = sql<string>`COALESCE(NULLIF(${orders.paidAt}, ''), NULLIF(${orders.issuedAt}, ''), ${orders.createdAt})`;

export async function getDailyIncomeTrend(db: DbType): Promise<DailyIncomeRow[]> {
  const results: DailyIncomeRow[] = [];
  for (let i = 6; i >= 0; i--) {
    const day = new Date(Date.now() - i * 86400000);
    const dateStr = `${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate()).toISOString();
    const dayEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).toISOString();

    const [row] = await db
      .select({ total: sql<number>`COALESCE(SUM(${orders.amountCents}), 0)` })
      .from(orders)
      .where(and(
        or(eq(orders.status, "paid"), eq(orders.status, "issued")),
        eq(orders.currency, "CNY"),
        sql`${orderIncomeAt} >= ${dayStart}`,
        sql`${orderIncomeAt} < ${dayEnd}`,
      ));

    results.push({ date: dateStr, amountCents: Number(row?.total || 0) });
  }
  return results;
}

export type OrderFilter = {
  status: string | string[];
  productId: string;
  q: string;
  buyerContact: string;
  paymentMethod: string;
  orderSource?: string;
  storefrontId?: string;
  page: number;
  limit: number;
};

export type OrderListResult = {
  total: number;
  orders: Record<string, unknown>[];
};

export type ExportParams = {
  status: string | string[];
  productId: string;
  q: string;
  paymentMethod?: string;
  orderSource?: string;
  storefrontId?: string;
  cursor: string;
  limit: number;
};

export type CardFilter = {
  productId: string;
  batchId: string;
  status: string;
  buyerEmail?: string;
  buyerContact?: string;
  genericOnly?: boolean;
  page: number;
  limit: number;
};

export type CouponFilter = {
  productId: string;
  status: string;    // 'active', 'inactive', or '' (all)
  search: string;     // code 模糊搜索
  page: number;
  limit: number;
};

export type CreateProductInput = {
  id?: string;
  title: string;
  description: string;
  salesCopy: string;
  coverUrl: string;
  tagsJson: string;
  priceCents: number;
  currency: string;
  issueMode: string;
  fulfillmentMode: string;
  active: boolean;
  category: string;
  sortOrder: number;
  purchaseLimit?: number | null;
  purchaseLimitDisplay?: boolean;
  deliveryVisibility?: DeliveryVisibility;
  stockDisplayMode?: StockDisplayMode;
  fulfillmentInputType?: FulfillmentInputType;
  fulfillmentInputLabel?: string;
  fulfillmentInputHint?: string;
  fulfillmentInputRequired?: boolean;
  /** undefined 绑定当前默认渠道；空数组明确创建未分配草稿。 */
  storefrontIds?: string[];
};

export type UpdateProductInput = Partial<CreateProductInput>;

type FulfillmentInputStorageFields = Pick<
  CreateProductInput,
  "fulfillmentInputType" | "fulfillmentInputLabel" | "fulfillmentInputHint" | "fulfillmentInputRequired"
>;

/**
 * 商品配置保留空标签，前台和服务端校验再通过共享契约提供类型默认文案。
 * 类型为 none 时四个字段必须一起清空，防止旧配置在重新启用时意外复活。
 */
function toStoredFulfillmentInputFields(input: FulfillmentInputStorageFields) {
  const fulfillmentInputType = input.fulfillmentInputType || "none";
  if (fulfillmentInputType === "none") {
    return {
      fulfillmentInputType,
      fulfillmentInputLabel: "",
      fulfillmentInputHint: "",
      fulfillmentInputRequired: 0,
    };
  }
  return {
    fulfillmentInputType,
    fulfillmentInputLabel: input.fulfillmentInputLabel || "",
    fulfillmentInputHint: input.fulfillmentInputHint || "",
    fulfillmentInputRequired: input.fulfillmentInputRequired ? 1 : 0,
  };
}

function activeFlag(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

async function getPurchasedCountMap(db: DbType, productIds: string[]): Promise<Map<string, number>> {
  const ids = Array.from(new Set(productIds.filter(Boolean)));
  if (ids.length === 0) return new Map();

  const rows = await db
    .select({
      productId: orders.productId,
      purchasedCount: sql<number>`COALESCE(SUM(CASE WHEN ${orders.quantity} > 0 THEN ${orders.quantity} ELSE 1 END), 0)`,
    })
    .from(orders)
    .where(and(inArray(orders.productId, ids), inArray(orders.status, ["paid", "issued"])))
    .groupBy(orders.productId);

  return new Map(rows.map((row) => [row.productId, Number(row.purchasedCount || 0)]));
}

export type CreateCouponInput = {
  productId?: string;
  code?: string;
  discountType: "fixed" | "percent";
  discountValue: number;
  maxUses: number;
  active: boolean;
  expiresAt?: string | null;
};

export type GenerateCouponInput = {
  productId: string;
  discountType: "fixed" | "percent";
  discountValue: number;
  maxUses: number;
  active: boolean;
  expiresAt?: string | null;
  prefix?: string;
  count?: number;
};

export type UpdateCouponInput = Partial<Omit<CreateCouponInput, "code">>;

export type ImportCardsInput = {
  productId: string;
  batchName: string;
  cards: { accountLabel: string; deliverySecret: string; deliveryNote?: string; expiresAt?: string }[];
};

export type ImportCardsResult = {
  batchId: string;
  imported: number;
};

// ── 工具函数 ──────────────────────────────────────

export function createCouponCode(prefix = "") {
  const chars = "abcdefghijkmnpqrstuvwxyz23456789";
  const arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  const body = Array.from(arr, (v) => chars[v % chars.length]).join("");
  return prefix ? `${prefix}-${body}` : body;
}

// ── Drizzle 动态 WHERE 构建辅助 ──
// 用于可选过滤条件：空字符串表示不过滤

type SharedOrderFilter = {
  status?: string | string[];
  productId?: string;
  q?: string;
  buyerContact?: string;
  paymentMethod?: string;
  orderSource?: string;
  storefrontId?: string;
};

/**
 * 订单列表和两类导出共用同一组业务筛选，避免后台所见与导出结果发生口径漂移。
 * 游标只属于导出分页，因此由导出函数在这些基础条件之后追加。
 */
function buildOrderConditions(filter: SharedOrderFilter): SQL<unknown>[] {
  const conditions: SQL<unknown>[] = [];
  const statuses = Array.isArray(filter.status) ? filter.status : filter.status ? [filter.status] : [];
  // 筛选时展开 canceled/cancelled，避免历史英式拼写被漏查；规范写入仍是 canceled。
  const expandedStatuses = expandOrderStatusFilter(statuses);
  if (expandedStatuses.length > 0) {
    conditions.push(inArray(orders.status, expandedStatuses));
  }
  if (filter.productId) conditions.push(eq(orders.productId, filter.productId));
  if (filter.q) {
    conditions.push(
      or(
        like(orders.orderNo, `%${filter.q}%`),
        like(orders.buyerContact, `%${filter.q}%`),
        like(orders.buyerEmail, `%${filter.q}%`)
      )!
    );
  }
  if (filter.buyerContact) {
    conditions.push(like(orders.buyerContact, `%${filter.buyerContact}%`));
  }
  if (filter.paymentMethod) {
    conditions.push(eq(orders.paymentMethod, filter.paymentMethod));
  }
  if (filter.orderSource) {
    conditions.push(eq(orders.orderSource, filter.orderSource));
  }
  if (filter.storefrontId) {
    conditions.push(eq(orders.storefrontId, filter.storefrontId));
  }
  return conditions;
}

function buildOrderWhere(filter: SharedOrderFilter) {
  const conditions = buildOrderConditions(filter);
  return conditions.length > 0 ? and(...conditions) : undefined;
}

function buildCardWhere(filter: CardFilter) {
  const conditions = [];
  if (filter.productId) conditions.push(eq(cards.productId, filter.productId));
  if (filter.batchId) conditions.push(eq(cards.batchId, filter.batchId));
  if (filter.status) conditions.push(eq(cards.status, filter.status));
  if (filter.buyerEmail) conditions.push(like(cards.buyerEmail, `%${filter.buyerEmail}%`));
  if (filter.buyerContact) conditions.push(like(cards.buyerContact, `%${filter.buyerContact}%`));
  if (filter.genericOnly) {
    conditions.push(eq(cards.deliverySecret, ""));
    conditions.push(ne(cards.deliveryNote, ""));
  }
  return conditions.length > 0 ? and(...conditions) : undefined;
}

function buildCouponWhere(filter: CouponFilter) {
  const conditions = [];
  if (filter.productId) conditions.push(eq(coupons.productId, filter.productId));
  if (filter.status === "active") conditions.push(eq(coupons.active, 1));
  else if (filter.status === "inactive") conditions.push(eq(coupons.active, 0));
  if (filter.search) conditions.push(like(coupons.code, `%${filter.search}%`));
  return conditions.length > 0 ? and(...conditions) : undefined;
}

// ── 订单/卡密 SELECT 列定义（复用） ──

/**
 * 后台订单标题读模型：tg_custom 是 Telegram 纯收款订单，没有 products 行，
 * 但运营仍必须能在订单列表/导出/详情中看到它。
 */
const orderProductTitle = sql<string>`COALESCE(
  ${products.title},
  CASE
    WHEN ${orders.productId} = 'tg_custom' THEN 'Telegram 自定义收款'
    ELSE ${orders.productId}
  END
)`;

/**
 * 履约模式展示必须读订单明细快照；商品缺失的 tg_custom 订单不伪装成 card。
 */
const orderFulfillmentModeSnapshot = sql<string>`CASE
  WHEN ${products.id} IS NULL THEN ''
  ELSE COALESCE(
    (SELECT ${orderItems.fulfillmentMode}
     FROM ${orderItems}
     WHERE ${orderItems.orderId} = ${orders.id}
     ORDER BY ${orderItems.createdAt} ASC
     LIMIT 1),
    ${orders.fulfillmentMode}
  )
END`;

const orderSelectFields = {
  id: orders.id,
  orderNo: sql<string>`COALESCE(${orders.orderNo}, ${orders.id})`,
  productId: orders.productId,
  productTitle: orderProductTitle,
  orderSource: orders.orderSource,
  storefrontId: orders.storefrontId,
  storefrontSlugSnapshot: orders.storefrontSlugSnapshot,
  storefrontNameSnapshot: orders.storefrontNameSnapshot,
  buyerContact: orders.buyerContact,
  buyerEmail: orders.buyerEmail,
  amountCents: orders.amountCents,
  discountCents: orders.discountCents,
  currency: orders.currency,
  status: orders.status,
  issueMode: orders.issueMode,
  fulfillmentMode: orderFulfillmentModeSnapshot,
  paymentMethod: orders.paymentMethod,
  paymentProvider: orders.paymentProvider,
  paymentRef: orders.paymentRef,
  issuedCardId: orders.issuedCardId,
  campaignCode: orders.campaignCode,
  referralCode: orders.referralCode,
  couponCode: orders.couponCode,
  createdAt: orders.createdAt,
  paidAt: orders.paidAt,
  issuedAt: orders.issuedAt,
  expiresAt: orders.expiresAt,
  deliveryJson: orders.deliveryJson,
  batchId: cards.batchId,
  accountLabel: cards.accountLabel,
  deliveryNote: cards.deliveryNote,
  cardExpiresAt: cards.expiresAt,
};

// ── G1: 概览 ──────────────────────────────────────

export async function getAdminSummary(
  db: DbType,
): Promise<AdminSummary | null> {
  // 收入口径和近 7 日趋势保持同一日界线，避免“趋势图显示今天有收入，但今日收入为 0”的后台误判。
  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString();
  const todayEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).toISOString();

  const sumTodayIncomeByProvider = async (provider: string): Promise<number> => {
    const [row] = await db
      .select({ total: sql<number>`COALESCE(SUM(${orders.amountCents}), 0)` })
      .from(orders)
      .where(and(
        or(eq(orders.status, "paid"), eq(orders.status, "issued")),
        eq(orders.currency, "CNY"),
        sql`${orderIncomeAt} >= ${todayStart}`,
        sql`${orderIncomeAt} < ${todayEnd}`,
        eq(orders.paymentProvider, provider),
      ));
    return Number(row?.total || 0);
  };

  const [
    productsRows,
    totalCardsRows,
    availableCardsRows,
    totalOrdersRows,
    pendingOrdersRows,
    ordersTodayRows,
    issuedTodayRows,
    totalIncomeRows,
    todayIncomeRows,
    [todayAlipayCents, todayEasyPayCents],
    lowStockProducts,
  ] = await Promise.all([
    db
      .select({ count: count() })
      .from(products),
    db
      .select({ count: count() })
      .from(cards),
    db
      .select({ count: count() })
      .from(cards)
      .where(and(
        eq(cards.status, "available"),
        or(sql`${cards.expiresAt} IS NULL`, sql`${cards.expiresAt} > replace(datetime('now'), ' ', 'T') || 'Z'`),
      )),
    db
      .select({ count: count() })
      .from(orders),
    db
      .select({ count: count() })
      .from(orders)
      .where(or(eq(orders.status, "pending"), eq(orders.status, "paid"))),
    db
      .select({ count: count() })
      .from(orders)
      .where(sql`date(${orders.createdAt}) = date('now')`),
    db
      .select({ count: count() })
      .from(orders)
      .where(and(
        eq(orders.status, "issued"),
        sql`date(${orders.issuedAt}) = date('now')`
      )),
    db
      .select({ total: sql<number>`COALESCE(SUM(${orders.amountCents}), 0)` })
      .from(orders)
      .where(and(
        or(eq(orders.status, "paid"), eq(orders.status, "issued")),
        eq(orders.currency, "CNY"),
      )),
    db
      .select({ total: sql<number>`COALESCE(SUM(${orders.amountCents}), 0)` })
      .from(orders)
      .where(and(
        or(eq(orders.status, "paid"), eq(orders.status, "issued")),
        eq(orders.currency, "CNY"),
        sql`${orderIncomeAt} >= ${todayStart}`,
        sql`${orderIncomeAt} < ${todayEnd}`,
      )),
    Promise.all([
      sumTodayIncomeByProvider("alipay"),
      sumTodayIncomeByProvider("easypay"),
    ]).catch(() => [0, 0] as [number, number]),
    getLowStockProducts(db),
  ]);

  const [productsRow] = productsRows;
  const [totalCardsRow] = totalCardsRows;
  const [availableCardsRow] = availableCardsRows;
  const [totalOrdersRow] = totalOrdersRows;
  const [pendingOrdersRow] = pendingOrdersRows;
  const [ordersTodayRow] = ordersTodayRows;
  const [issuedTodayRow] = issuedTodayRows;
  const [totalIncomeRow] = totalIncomeRows;
  const [todayIncomeRow] = todayIncomeRows;
  const todayIncomeCents = Number(todayIncomeRow?.total || 0);

  return {
    products: productsRow?.count ?? 0,
    totalCards: totalCardsRow?.count ?? 0,
    availableCards: availableCardsRow?.count ?? 0,
    totalOrders: totalOrdersRow?.count ?? 0,
    pendingOrders: pendingOrdersRow?.count ?? 0,
    ordersToday: ordersTodayRow?.count ?? 0,
    issuedToday: issuedTodayRow?.count ?? 0,
    totalIncomeCents: Number(totalIncomeRow?.total || 0),
    todayIncomeCents,
    todayAlipayCents,
    todayEasyPayCents,
    lowStockCount: lowStockProducts.length,
  };
}
// ── G2: 订单列表 ──────────────────────────────────

export async function getOrderList(
  db: DbType,
  filter: OrderFilter,
): Promise<OrderListResult> {
  const { page, limit } = filter;
  const offset = (page - 1) * limit;

  const where = buildOrderWhere(filter);

  // COUNT 查询
  const [countRow] = await db
    .select({ count: count() })
    .from(orders)
    .leftJoin(products, eq(products.id, orders.productId))
    .where(where);
  const total = countRow?.count ?? 0;

  // 数据查询
  const results = await db
    .select(orderSelectFields)
    .from(orders)
    .leftJoin(products, eq(products.id, orders.productId))
    .leftJoin(cards, eq(cards.id, orders.issuedCardId))
    .where(where)
    .orderBy(desc(orders.createdAt))
    .limit(limit)
    .offset(offset);

  return { total, orders: results as unknown as Record<string, unknown>[] };
}

/** 与 shared SAFE_DELETE_ORDER_STATUSES 对齐；DB 删除 WHERE 用 expand 覆盖历史 cancelled。 */
const DELETABLE_ORDER_STATUSES = expandOrderStatusFilter([...SAFE_DELETE_ORDER_STATUSES]);
const SAFE_CARD_DELETE_STATUSES = ["available", "disabled"] as const;

/**
 * 批量删除选项（两个开关彼此独立，默认均为 false → 与历史安全行为一致）：
 *
 * - force：是否允许删除「非安全集合」
 *   - 订单：非失败/取消/关闭/过期
 *   - 卡密：锁定中 / 已发卡
 * - unlinkRefs：是否在删除前主动解绑订单↔卡密交叉引用
 *   - 删订单：locked 卡回库并清 locked_order_id；issued 卡仅清 issued_order_id（不回库）
 *   - 删卡密：清空 orders.issued_card_id；卡自身 order 字段随行删除
 *
 * 组合语义（有阻则整批不删，保持历史 all-or-nothing）：
 * 1. force=0 unlink=0 — 仅安全集合，且无交叉引用
 * 2. force=0 unlink=1 — 仅安全集合，但可先解绑再删（例如过期订单仍挂着 locked 卡）
 * 3. force=1 unlink=0 — 任意状态，但仍要求无交叉引用，否则 409
 * 4. force=1 unlink=1 — 任意状态 + 先解绑再删
 */
export type BatchDeleteOptions = {
  force?: boolean;
  unlinkRefs?: boolean;
};

export type BatchDeleteResult = {
  deleted: number;
  blocked: number;
  force: boolean;
  unlinkRefs: boolean;
};

async function unlinkOrderCardRefs(
  tx: DbWriteScope,
  orderIds: string[],
): Promise<void> {
  if (orderIds.length === 0) return;

  // 锁定中：回库存（测试/运维清单后库存应可再售）
  await tx
    .update(cards)
    .set({
      status: "available",
      lockedOrderId: null,
      lockExpiresAt: null,
    })
    .where(and(
      inArray(cards.lockedOrderId, orderIds),
      eq(cards.status, "locked"),
    ));

  // 兜底：非 locked 状态仍写着 locked_order_id 的脏数据只清引用
  await tx
    .update(cards)
    .set({
      lockedOrderId: null,
      lockExpiresAt: null,
    })
    .where(inArray(cards.lockedOrderId, orderIds));

  // 已发卡：只解绑订单关联，不把已售密改回 available（禁止重卖）
  await tx
    .update(cards)
    .set({
      issuedOrderId: null,
    })
    .where(inArray(cards.issuedOrderId, orderIds));

  // 单向引用兜底：orders.issued_card_id 指向卡，但 cards.issued_order_id 已空/不一致时，
  // 仍须切断卡上可能残留的 locked 字段；issued 状态保持 issued（禁止重卖）。
  const issuedCardRows = await tx
    .select({ issuedCardId: orders.issuedCardId })
    .from(orders)
    .where(inArray(orders.id, orderIds));
  const issuedCardIds = Array.from(new Set(
    issuedCardRows
      .map((row) => row.issuedCardId)
      .filter((id): id is string => Boolean(id)),
  ));
  if (issuedCardIds.length > 0) {
    await tx
      .update(cards)
      .set({
        lockedOrderId: null,
        lockExpiresAt: null,
        issuedOrderId: null,
      })
      .where(inArray(cards.id, issuedCardIds));
  }
}

async function deleteOrderDependents(
  tx: DbWriteScope,
  orderIds: string[],
): Promise<void> {
  if (orderIds.length === 0) return;
  await tx.delete(orderEvents).where(inArray(orderEvents.orderId, orderIds));
  await tx.delete(orderItems).where(inArray(orderItems.orderId, orderIds));
  await tx.delete(emailLogs).where(inArray(emailLogs.orderId, orderIds));
  await tx.delete(referralEvents).where(inArray(referralEvents.orderId, orderIds));
  // card_logs.order_id 无 FK，删单时清掉避免脏引用
  await tx.delete(cardLogs).where(inArray(cardLogs.orderId, orderIds));

  // 余额流水无 FK，但 order_spend/refund 等会挂 reference_type=order + reference_id=orderId。
  // 删单后若保留悬空 reference_id，后台按订单号筛流水会误命中「幽灵订单」。
  // 策略：清空 reference 字段，保留流水本行（账本金额仍可对，只是不再链到已删订单）。
  // 仅切断 reference_type=order，绝不碰 voucher/recharge/admin 等其它引用。
  await tx
    .update(balanceTransactions)
    .set({
      referenceType: "",
      referenceId: "",
      note: sql`CASE
        WHEN trim(coalesce(${balanceTransactions.note}, '')) = ''
          THEN '原关联订单已删除'
        WHEN ${balanceTransactions.note} LIKE '%原关联订单已删除%'
          THEN ${balanceTransactions.note}
        ELSE ${balanceTransactions.note} || '（原关联订单已删除）'
      END`,
    })
    .where(and(
      eq(balanceTransactions.referenceType, "order"),
      inArray(balanceTransactions.referenceId, orderIds),
    ));
}

export async function batchDeleteOrders(
  db: DbType,
  ids: string[],
  options: BatchDeleteOptions = {},
): Promise<BatchDeleteResult> {
  const force = options.force === true;
  const unlinkRefs = options.unlinkRefs === true;
  const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
  if (uniqueIds.length === 0) {
    return { deleted: 0, blocked: 0, force, unlinkRefs };
  }

  return withDbTransaction(db, async (tx) => {
    const existing = await tx
      .select({ id: orders.id, status: orders.status })
      .from(orders)
      .where(inArray(orders.id, uniqueIds));
    if (existing.length === 0) {
      return { deleted: 0, blocked: 0, force, unlinkRefs };
    }

    // 1) 状态门槛：未 force 时，非安全终态整批拒绝（cancelled 归一到 canceled 再判）
    if (!force) {
      const statusBlocked = existing.filter((row) => !isSafeDeleteOrderStatus(row.status)).length;
      if (statusBlocked > 0) {
        return { deleted: 0, blocked: statusBlocked, force, unlinkRefs };
      }
    }

    const candidateIds = existing.map((row) => row.id);

    // 2) 交叉引用门槛：未 unlink 时，仍挂卡密的订单拒绝
    //    双向检查：cards → order 与 orders.issued_card_id → cards
    if (!unlinkRefs) {
      const referencedCards = await tx
        .select({ lockedOrderId: cards.lockedOrderId, issuedOrderId: cards.issuedOrderId })
        .from(cards)
        .where(or(
          inArray(cards.lockedOrderId, candidateIds),
          inArray(cards.issuedOrderId, candidateIds),
        ));
      const referencedOrderIds = new Set(referencedCards.flatMap((row) => (
        [row.lockedOrderId, row.issuedOrderId].filter((id): id is string => Boolean(id))
      )));
      const ordersWithIssuedCard = await tx
        .select({ id: orders.id })
        .from(orders)
        .where(and(
          inArray(orders.id, candidateIds),
          sql`${orders.issuedCardId} IS NOT NULL AND ${orders.issuedCardId} != ''`,
        ));
      for (const row of ordersWithIssuedCard) referencedOrderIds.add(row.id);
      const refBlocked = candidateIds.filter((id) => referencedOrderIds.has(id)).length;
      if (refBlocked > 0) {
        return { deleted: 0, blocked: refBlocked, force, unlinkRefs };
      }
    } else {
      await unlinkOrderCardRefs(tx, candidateIds);
    }

    await deleteOrderDependents(tx, candidateIds);

    const result = force
      ? await tx.delete(orders).where(inArray(orders.id, candidateIds))
      : await tx
        .delete(orders)
        .where(and(
          inArray(orders.id, candidateIds),
          inArray(orders.status, DELETABLE_ORDER_STATUSES),
        ));

    return {
      deleted: result.rowsAffected ?? candidateIds.length,
      blocked: 0,
      force,
      unlinkRefs,
    };
  });
}

// ── G3: 订单导出 ──────────────────────────────────

export async function exportOrders(
  db: DbType,
  params: ExportParams,
): Promise<{ rows: Record<string, unknown>[]; nextCursor: string; hasMore: boolean }> {
  const { cursor, limit } = params;

  const conditions = buildOrderConditions(params);
  if (cursor) {
    // cursor 格式: "createdAt::id"，解析后精确游标分页
    const parts = cursor.split("::");
    const cursorDate = parts[0];
    const cursorId = parts[1] || "";
    conditions.push(
      or(
        lt(orders.createdAt, cursorDate),
        and(
          eq(orders.createdAt, cursorDate),
          lt(orders.id, cursorId)
        )
      )!
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  // 多取一条判断 hasMore
  const rows = await db
    .select(orderSelectFields)
    .from(orders)
    .leftJoin(products, eq(products.id, orders.productId))
    .leftJoin(cards, eq(cards.id, orders.issuedCardId))
    .where(where)
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const resultRows = hasMore ? rows.slice(0, limit) : rows;

  const lastRow = resultRows[resultRows.length - 1];
  const nextCursor = hasMore && lastRow ? `${lastRow.createdAt || ""}::${lastRow.id || ""}` : "";

  return { rows: resultRows as unknown as Record<string, unknown>[], nextCursor, hasMore };
}

// ── G4: 订单详情 ──────────────────────────────────

export async function getOrderDetail(
  db: DbType,
  id: string,
): Promise<Record<string, unknown> | null> {
  const rows = await db
    .select({
      id: orders.id,
      orderNo: sql<string>`COALESCE(${orders.orderNo}, ${orders.id})`,
      productId: orders.productId,
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
      issueMode: orders.issueMode,
      paymentMethod: orders.paymentMethod,
      paymentRef: orders.paymentRef,
      issuedCardId: orders.issuedCardId,
      couponCode: orders.couponCode,
      campaignCode: orders.campaignCode,
      referralCode: orders.referralCode,
      createdAt: orders.createdAt,
      paidAt: orders.paidAt,
      issuedAt: orders.issuedAt,
      ipHash: orders.ipHash,
      userAgent: orders.userAgent,
      expiresAt: orders.expiresAt,
      productTitle: orderProductTitle,
      fulfillmentMode: orderFulfillmentModeSnapshot,
      accountLabel: cards.accountLabel,
      deliverySecret: cards.deliverySecret,
      deliveryNote: cards.deliveryNote,
      deliveryJson: orders.deliveryJson,
      fulfillmentInputJson: orders.fulfillmentInputJson,
    })
    .from(orders)
    .leftJoin(products, eq(products.id, orders.productId))
    .leftJoin(cards, eq(cards.id, orders.issuedCardId))
    .where(eq(orders.id, id));

  const order = rows[0] as Record<string, unknown> | undefined;
  if (!order) return null;

  const [items, issuedCards, events] = await Promise.all([
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
      .where(eq(orderItems.orderId, id)),
    db
      .select({
        id: cards.id,
        accountLabel: cards.accountLabel,
        deliverySecret: cards.deliverySecret,
        deliveryNote: cards.deliveryNote,
      })
      .from(cards)
      .where(eq(cards.issuedOrderId, id)),
    db
      .select({
        id: orderEvents.id,
        type: orderEvents.type,
        message: orderEvents.message,
        createdAt: orderEvents.createdAt,
      })
      .from(orderEvents)
      .where(eq(orderEvents.orderId, id))
      .orderBy(desc(orderEvents.createdAt))
      .limit(50),
  ]);

  order.items = items;
  const itemFulfillmentMode = items.find((item) => item.fulfillmentMode)?.fulfillmentMode;
  if (itemFulfillmentMode) order.fulfillmentMode = itemFulfillmentMode;
  order.cards = issuedCards.map((card) => ({
    id: card.id,
    accountLabel: card.accountLabel || "",
    deliverySecret: card.deliverySecret || "",
    deliveryNote: card.deliveryNote || "",
    cardData: [card.accountLabel, card.deliverySecret].filter(Boolean).join(" / "),
  }));
  order.events = events;
  // 履约输入含买家提供的数据，只在管理端订单详情解析；不向调用方暴露原始 JSON。
  order.fulfillmentInput = parseFulfillmentInputSnapshot(order.fulfillmentInputJson);
  delete order.fulfillmentInputJson;
  return order;
}

// ── G3b: 财务对账导出 ──────────────────────────────
// 输出：订单 + 余额变动 + 汇总，支持 JSON / CSV。
// CSV 仅导出 orders；balanceTransactions 单独走 /balance-transactions。

export async function exportFinance(
  db: DbType,
  params: { status?: string | string[]; productId?: string; q?: string; paymentMethod?: string; orderSource?: string; storefrontId?: string; cursor?: string; limit: number },
): Promise<{
  orders: Record<string, unknown>[];
  balanceTransactions: Record<string, unknown>[];
  summary: {
    currency: "CNY";
    totalIncomeCents: number;
    totalCardIssuedCents: number;
    totalBalanceSpentCents: number;
    totalRefundCents: number;
    totalsByCurrency: Record<string, {
      totalIncomeCents: number;
      totalCardIssuedCents: number;
      totalBalanceSpentCents: number;
      totalRefundCents: number;
    }>;
  };
  nextCursor: string;
  hasMore: boolean;
}> {
  const { cursor, limit } = params;

  const conditions = buildOrderConditions(params);
  if (cursor) {
    const parts = cursor.split("::");
    const cursorDate = parts[0];
    const cursorId = parts[1] || "";
    conditions.push(
      or(
        lt(orders.createdAt, cursorDate),
        and(
          eq(orders.createdAt, cursorDate),
          lt(orders.id, cursorId)
        )
      )!
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select(orderSelectFields)
    .from(orders)
    .leftJoin(products, eq(products.id, orders.productId))
    .leftJoin(cards, eq(cards.id, orders.issuedCardId))
    .where(where)
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const resultRows = hasMore ? rows.slice(0, limit) : rows;
  const lastRow = resultRows[resultRows.length - 1];
  const nextCursor = hasMore && lastRow ? `${lastRow.createdAt || ""}::${lastRow.id || ""}` : "";

  const orderRows = resultRows as unknown as Record<string, unknown>[];

  // 汇总统计只在同一币种内相加。旧标量字段继续表示 CNY，兼容现有调用方。
  const totalsByCurrency: Record<string, {
    totalIncomeCents: number;
    totalCardIssuedCents: number;
    totalBalanceSpentCents: number;
    totalRefundCents: number;
  }> = {};
  for (const row of orderRows) {
    // 迁移前订单夹具/历史 API 可能缺字段；DB 的历史默认币种就是 CNY。
    const currency = String(row.currency || "CNY").trim().toUpperCase() || "CNY";
    const amountCents = Number(row.amountCents || 0);
    const totals = totalsByCurrency[currency] || {
      totalIncomeCents: 0,
      totalCardIssuedCents: 0,
      totalBalanceSpentCents: 0,
      totalRefundCents: 0,
    };
    totals.totalIncomeCents += amountCents;
    if (row.batchId && row.accountLabel) totals.totalCardIssuedCents += amountCents;
    if (row.paymentMethod === "balance") totals.totalBalanceSpentCents += amountCents;
    if (row.status === "refunded") totals.totalRefundCents += amountCents;
    totalsByCurrency[currency] = totals;
  }
  const cnyTotals = totalsByCurrency.CNY || {
    totalIncomeCents: 0,
    totalCardIssuedCents: 0,
    totalBalanceSpentCents: 0,
    totalRefundCents: 0,
  };

  // 全量余额变动（作为对账参照）
  const balanceTxRows = await db
    .select({
      id: balanceTransactions.id,
      email: balanceTransactions.email,
      type: balanceTransactions.type,
      amountCents: balanceTransactions.amountCents,
      balanceAfterCents: balanceTransactions.balanceAfterCents,
      referenceType: balanceTransactions.referenceType,
      referenceId: balanceTransactions.referenceId,
      note: balanceTransactions.note,
      createdAt: balanceTransactions.createdAt,
    })
    .from(balanceTransactions)
    .orderBy(desc(balanceTransactions.createdAt), desc(balanceTransactions.id))
    .limit(limit);

  return {
    orders: orderRows,
    balanceTransactions: balanceTxRows as unknown as Record<string, unknown>[],
    summary: {
      currency: "CNY",
      ...cnyTotals,
      totalsByCurrency,
    },
    nextCursor,
    hasMore,
  };
}

// ── G5: 标记付款 ── 不抽取，只调 markPaidAndIssue ──

// ── G6: 导入卡密 ──────────────────────────────────

export async function importCards(
  db: DbType,
  input: ImportCardsInput,
): Promise<ImportCardsResult> {
  // 检查商品是否存在
  const [product] = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.id, input.productId))
    .limit(1);
  if (!product) {
    throw new Error("商品不存在");
  }

  const batchId = crypto.randomUUID();

  // 先收集卡密数据（含 trim 清洗），计算有效数量
  const cardRows: { id: string; label: string; secret: string; note: string; expiresAt?: string }[] = [];
  const seenSecrets = new Set<string>();
  for (const card of input.cards) {
    const label = card.accountLabel.trim();
    const secret = card.deliverySecret.trim();
    const note = (card.deliveryNote || "").trim();
    if (!label || !secret) continue; // 跳过空标签/空密码的脏数据
    const secretKey = secret.toLowerCase();
    if (seenSecrets.has(secretKey)) {
      throw new Error(`导入数据包含重复卡密：${label}`);
    }
    seenSecrets.add(secretKey);
    const rawExpiresAt = (card as { expiresAt?: string }).expiresAt?.trim();
    cardRows.push({ id: crypto.randomUUID(), label, secret, note, expiresAt: rawExpiresAt || undefined });
  }

  if (cardRows.length === 0) {
    throw new Error("没有有效的卡密数据，请检查账号和密码是否填写完整");
  }

  // 导入前检查同商品下是否已有相同 delivery_secret，避免重复库存导致多名买家拿到同一份虚拟资料。
  const existingCards = await db
    .select({ deliverySecret: cards.deliverySecret })
    .from(cards)
    .where(and(
      eq(cards.productId, input.productId),
      inArray(cards.deliverySecret, cardRows.map((row) => row.secret))
    ));
  if (existingCards.length > 0) {
    throw new Error(`已有 ${existingCards.length} 张相同卡密，已拒绝导入`);
  }

  const now = new Date().toISOString();
  await withDbTransaction(db, async (tx) => {
    // 批次和卡密必须同事务写入，避免 libSQL 写入中断后留下“空批次”。
    await tx.insert(cardBatches).values({
      id: batchId,
      productId: input.productId,
      name: input.batchName,
      totalCount: cardRows.length,
      createdAt: now,
    });

    await tx.insert(cards).values(
      cardRows.map((row) => ({
        id: row.id,
        productId: input.productId,
        batchId,
        accountLabel: row.label,
        deliverySecret: row.secret,
        deliveryNote: row.note,
        expiresAt: row.expiresAt,
        status: "available" as const,
        createdAt: now,
      }))
    );
  });

  return { batchId, imported: cardRows.length };
}

// ── G7: 卡密列表 ──────────────────────────────────

export async function getCardList(
  db: DbType,
  filter: CardFilter,
): Promise<{ total: number; results: Record<string, unknown>[] }> {
  const { page, limit } = filter;
  const offset = (page - 1) * limit;
  const where = buildCardWhere(filter);

  // COUNT 查询
  const [countRow] = await db
    .select({ count: count() })
    .from(cards)
    .where(where);
  const total = countRow?.count ?? 0;

  // 数据查询
  const results = await db
    .select({
      id: cards.id,
      productId: cards.productId,
      productTitle: products.title,
      batchId: cards.batchId,
      accountLabel: cards.accountLabel,
      deliverySecret: cards.deliverySecret,
      deliveryNote: cards.deliveryNote,
      status: cards.status,
      issuedOrderId: cards.issuedOrderId,
      buyerEmail: cards.buyerEmail,
      buyerContact: cards.buyerContact,
      expiresAt: cards.expiresAt,
      createdAt: cards.createdAt,
      batchName: cardBatches.name,
    })
    .from(cards)
    .leftJoin(cardBatches, eq(cardBatches.id, cards.batchId))
    .leftJoin(products, eq(products.id, cards.productId))
    .where(where)
    .orderBy(desc(cards.createdAt))
    .limit(limit)
    .offset(offset);

  return { total, results: results as unknown as Record<string, unknown>[] };
}

// ── G8: 卡密操作（启用/禁用）───────────────────────

/** 合法卡密状态转换表：key=当前状态，value=允许转换到的状态列表 */
const VALID_CARD_TRANSITIONS: Record<string, string[]> = {
  available: ["disabled"],
  locked: [],
  issued: [],
  disabled: ["available"],
};

export async function updateCardStatus(
  db: DbType,
  id: string,
  status: string,
): Promise<{ id: string; status: string } | null> {
  // 先读取当前状态
  const [card] = await db
    .select({ id: cards.id, status: cards.status })
    .from(cards)
    .where(eq(cards.id, id))
    .limit(1);
  if (!card) return null;

  // 校验状态转换合法性，防止误把已发卡密改回 available 造成重复发卡
  const allowed = VALID_CARD_TRANSITIONS[card.status];
  if (!allowed || !allowed.includes(status)) {
    throw new Error(`不允许从 ${card.status} 转换到 ${status}`);
  }

  // 原子更新：WHERE 中包含当前状态，防止并发修改导致非法转换
  const result = await db
    .update(cards)
    .set({ status })
    .where(and(eq(cards.id, id), eq(cards.status, card.status)));

  if (result.rowsAffected === 0) {
    throw new Error("卡密状态已被其他操作修改，请刷新重试");
  }

  return { id, status };
}

export async function batchDisableCards(
  db: DbType,
  ids: string[],
  status: string,
): Promise<{ updated: number }> {
  // 校验目标状态合法性，防止批量操作误把已发卡密改回 available 造成重复发卡
  if (!Object.keys(VALID_CARD_TRANSITIONS).some((k) => VALID_CARD_TRANSITIONS[k].includes(status))) {
    throw new Error(`非法目标状态: ${status}`);
  }
  const allowedSourceStatus = status === "disabled" ? "available" : "disabled";
  const result = await db
    .update(cards)
    .set({ status })
    .where(and(inArray(cards.id, ids), eq(cards.status, allowedSourceStatus)));
  return { updated: result.rowsAffected ?? ids.length };
}

export async function batchDeleteCards(
  db: DbType,
  ids: string[],
  options: BatchDeleteOptions = {},
): Promise<BatchDeleteResult> {
  const force = options.force === true;
  const unlinkRefs = options.unlinkRefs === true;
  const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
  if (uniqueIds.length === 0) {
    return { deleted: 0, blocked: 0, force, unlinkRefs };
  }

  return withDbTransaction(db, async (tx) => {
    const existing = await tx
      .select({
        id: cards.id,
        status: cards.status,
        lockedOrderId: cards.lockedOrderId,
        issuedOrderId: cards.issuedOrderId,
      })
      .from(cards)
      .where(inArray(cards.id, uniqueIds));
    if (existing.length === 0) {
      return { deleted: 0, blocked: 0, force, unlinkRefs };
    }

    // 1) 状态门槛：未 force 时 locked/issued 整批拒绝
    if (!force) {
      const statusBlocked = existing.filter((row) => (
        row.status === "locked" || row.status === "issued"
      )).length;
      if (statusBlocked > 0) {
        return { deleted: 0, blocked: statusBlocked, force, unlinkRefs };
      }
    }

    const candidateIds = existing.map((row) => row.id);

    // 2) 交叉引用门槛：未 unlink 时，订单仍挂着这些卡密则拒绝
    //    - cards.locked_order_id / issued_order_id 非空
    //    - 或 orders.issued_card_id 指向候选卡
    // blocked 始终按「受阻的卡密张数」计，避免用订单数误导 UI/错误文案。
    if (!unlinkRefs) {
      const blockedCardIds = new Set(
        existing
          .filter((row) => Boolean(row.lockedOrderId) || Boolean(row.issuedOrderId))
          .map((row) => row.id),
      );

      const orderRefs = await tx
        .select({ issuedCardId: orders.issuedCardId })
        .from(orders)
        .where(inArray(orders.issuedCardId, candidateIds));
      for (const row of orderRefs) {
        if (row.issuedCardId) blockedCardIds.add(row.issuedCardId);
      }

      if (blockedCardIds.size > 0) {
        return { deleted: 0, blocked: blockedCardIds.size, force, unlinkRefs };
      }
    } else {
      // 切断订单 → 卡密 的 issued_card_id；卡行上的 order 字段随 DELETE 消失
      await tx
        .update(orders)
        .set({ issuedCardId: null })
        .where(inArray(orders.issuedCardId, candidateIds));
    }

    await tx.delete(cardLogs).where(inArray(cardLogs.cardId, candidateIds));

    const result = force
      ? await tx.delete(cards).where(inArray(cards.id, candidateIds))
      : await tx
        .delete(cards)
        .where(and(
          inArray(cards.id, candidateIds),
          inArray(cards.status, [...SAFE_CARD_DELETE_STATUSES]),
        ));

    return {
      deleted: result.rowsAffected ?? candidateIds.length,
      blocked: 0,
      force,
      unlinkRefs,
    };
  });
}

// ── G9: 批次列表 ──────────────────────────────────

export async function getBatchList(
  db: DbType,
  productId: string,
): Promise<Record<string, unknown>[]> {
  const where = productId ? eq(cardBatches.productId, productId) : undefined;

  const results = await db
    .select({
      id: cardBatches.id,
      productId: cardBatches.productId,
      productTitle: products.title,
      name: cardBatches.name,
      totalCount: cardBatches.totalCount,
      createdAt: cardBatches.createdAt,
      availableCount: sql<number>`(SELECT COUNT(*) FROM cards WHERE batch_id = ${cardBatches.id} AND status = 'available')`,
      issuedCount: sql<number>`(SELECT COUNT(*) FROM cards WHERE batch_id = ${cardBatches.id} AND status = 'issued')`,
      disabledCount: sql<number>`(SELECT COUNT(*) FROM cards WHERE batch_id = ${cardBatches.id} AND status = 'disabled')`,
    })
    .from(cardBatches)
    .leftJoin(products, eq(products.id, cardBatches.productId))
    .where(where)
    .orderBy(desc(cardBatches.createdAt));

  return results as unknown as Record<string, unknown>[];
}

// ── G10: 折扣码列表 ──────────────────────────────

export async function getCouponList(
  db: DbType,
  filter: CouponFilter,
): Promise<{ total: number; results: Record<string, unknown>[] }> {
  const { page, limit } = filter;
  const offset = (page - 1) * limit;
  const where = buildCouponWhere(filter);

  // COUNT 查询
  const [countRow] = await db
    .select({ count: count() })
    .from(coupons)
    .where(where);
  const total = countRow?.count ?? 0;

  // 数据查询
  const rows = await db
    .select({
      code: coupons.code,
      productId: coupons.productId,
      productTitle: products.title,
      discountType: coupons.discountType,
      discountValue: coupons.discountValue,
      maxUses: coupons.maxUses,
      usedCount: coupons.usedCount,
      active: sql<number>`CASE WHEN ${coupons.active} = 1 THEN 1 ELSE 0 END`,
      expiresAt: coupons.expiresAt,
      createdAt: coupons.createdAt,
    })
    .from(coupons)
    .leftJoin(products, eq(products.id, coupons.productId))
    .where(where)
    .orderBy(desc(coupons.createdAt))
    .limit(limit)
    .offset(offset);

  // 将 active 字段从 0/1 转为 boolean，方便前端直接使用
  const results = rows.map((r) => ({
    ...r,
    active: r.active === 1,
  })) as unknown as Record<string, unknown>[];

  return { total, results: results as unknown as Record<string, unknown>[] };
}

// ── G11: 商品列表（管理端含下架）────────────────────

export type ProductFilter = {
  q: string;
  active: string;
  category: string;
  stock?: string;
  storefrontId?: string;
  page: number;
  limit: number;
};

export type ProductListResult = {
  total: number;
  products: Record<string, unknown>[];
};

export type ProductCategoryInput = {
  id?: string;
  name: string;
  sortOrder?: number;
  active?: boolean;
};

export type AdminProductCategory = {
  id: string;
  name: string;
  sortOrder: number;
  active: boolean;
  productCount: number;
  createdAt: string;
  updatedAt: string | null;
};

function categoryIdFromName(name: string) {
  const normalized = name.trim().toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || `cat-${Date.now()}`;
}

export async function getAdminProductCategories(db: DbType): Promise<AdminProductCategory[]> {
  const rows = await db
    .select({
      id: productCategories.id,
      name: productCategories.name,
      sortOrder: productCategories.sortOrder,
      active: productCategories.active,
      productCount: sql<number>`COUNT(${products.id})`,
      createdAt: productCategories.createdAt,
      updatedAt: productCategories.updatedAt,
    })
    .from(productCategories)
    .leftJoin(products, eq(products.category, productCategories.name))
    .groupBy(productCategories.id, productCategories.name, productCategories.sortOrder, productCategories.active, productCategories.createdAt, productCategories.updatedAt)
    .orderBy(productCategories.sortOrder, productCategories.name);

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    sortOrder: Number(row.sortOrder || 0),
    active: row.active === 1,
    productCount: Number(row.productCount || 0),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

export async function createProductCategory(db: DbType, input: ProductCategoryInput): Promise<string> {
  const now = new Date().toISOString();
  const name = input.name.trim();
  const id = (input.id || categoryIdFromName(name)).trim();
  await db.insert(productCategories).values({
    id,
    name,
    sortOrder: input.sortOrder ?? 100,
    active: input.active === false ? 0 : 1,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

export async function updateProductCategory(db: DbType, id: string, input: Partial<ProductCategoryInput>): Promise<boolean> {
  const existing = await db.select({ name: productCategories.name }).from(productCategories).where(eq(productCategories.id, id)).limit(1);
  if (!existing[0]) return false;

  const setValues: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (input.name !== undefined) setValues.name = input.name.trim();
  if (input.sortOrder !== undefined) setValues.sortOrder = input.sortOrder;
  if (input.active !== undefined) setValues.active = input.active ? 1 : 0;
  await db.update(productCategories).set(setValues).where(eq(productCategories.id, id));

  if (input.name !== undefined && input.name.trim() !== existing[0].name) {
    await db.update(products).set({ category: input.name.trim(), updatedAt: new Date().toISOString() }).where(eq(products.category, existing[0].name));
  }
  return true;
}

export async function deleteProductCategory(db: DbType, id: string): Promise<{ deleted: boolean; reason?: string }> {
  const rows = await db.select({ name: productCategories.name }).from(productCategories).where(eq(productCategories.id, id)).limit(1);
  const category = rows[0];
  if (!category) return { deleted: false, reason: "分类不存在" };
  const [usage] = await db.select({ count: count() }).from(products).where(eq(products.category, category.name));
  if ((usage?.count || 0) > 0) return { deleted: false, reason: "分类仍有关联商品，不能删除" };
  await db.delete(productCategories).where(eq(productCategories.id, id));
  return { deleted: true };
}

// ── G11: 商品列表（管理端含下架）────────────────────

export async function getAdminProducts(
  db: DbType,
  filter: ProductFilter,
): Promise<ProductListResult> {
  const { page, limit } = filter;
  const offset = (page - 1) * limit;
  const where = buildProductWhere(filter);

  if (filter.stock !== "low") {
    const [countRow] = await db
      .select({ count: count() })
      .from(products)
      .where(where);
    const total = countRow?.count ?? 0;

    const results = await db
      .select({
        id: products.id,
        slug: products.slug,
        title: products.title,
        description: products.description,
        priceCents: products.priceCents,
        currency: products.currency,
        issueMode: products.issueMode,
        fulfillmentMode: products.fulfillmentMode,
        active: products.active,
        sortOrder: products.sortOrder,
        createdAt: products.createdAt,
        updatedAt: products.updatedAt,
        salesCopy: products.salesCopy,
        coverUrl: products.coverUrl,
        tagsJson: products.tagsJson,
        category: products.category,
        purchaseLimit: products.purchaseLimit,
        purchaseLimitDisplay: products.purchaseLimitDisplay,
        deliveryVisibility: products.deliveryVisibility,
        stockDisplayMode: products.stockDisplayMode,
        fulfillmentInputType: products.fulfillmentInputType,
        fulfillmentInputLabel: products.fulfillmentInputLabel,
        fulfillmentInputHint: products.fulfillmentInputHint,
        fulfillmentInputRequired: products.fulfillmentInputRequired,
      })
      .from(products)
      .where(where)
      .orderBy(...adminProductOrderBy(filter))
      .limit(limit)
      .offset(offset);
    const stockMap = await getAvailableStockMap(db, results.map((row) => row.id));
    const purchasedCountMap = await getPurchasedCountMap(db, results.map((row) => row.id));

    return {
      total,
      products: await attachStorefrontBadges(db, results.map((row) => ({
        ...row,
        active: activeFlag(row.active),
        purchaseLimitDisplay: activeFlag(row.purchaseLimitDisplay),
        fulfillmentInputRequired: row.fulfillmentInputRequired === 1,
        stock: Number(stockMap.get(row.id) || 0),
        purchasedCount: Number(purchasedCountMap.get(row.id) || 0),
      }))),
    };
  }

  const config = await readSystemConfigMap(db, ["inventory_warning_threshold"]);
  const parsed = Number(config.inventory_warning_threshold);
  const lowStockThreshold = Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 5;

  const allRows = await db
    .select({
      id: products.id,
      slug: products.slug,
      title: products.title,
      description: products.description,
      priceCents: products.priceCents,
      currency: products.currency,
      issueMode: products.issueMode,
      fulfillmentMode: products.fulfillmentMode,
      active: products.active,
      sortOrder: products.sortOrder,
      createdAt: products.createdAt,
      updatedAt: products.updatedAt,
      salesCopy: products.salesCopy,
      coverUrl: products.coverUrl,
      tagsJson: products.tagsJson,
      category: products.category,
      purchaseLimit: products.purchaseLimit,
      purchaseLimitDisplay: products.purchaseLimitDisplay,
      deliveryVisibility: products.deliveryVisibility,
      stockDisplayMode: products.stockDisplayMode,
      fulfillmentInputType: products.fulfillmentInputType,
      fulfillmentInputLabel: products.fulfillmentInputLabel,
      fulfillmentInputHint: products.fulfillmentInputHint,
      fulfillmentInputRequired: products.fulfillmentInputRequired,
    })
    .from(products)
    .where(where)
    .orderBy(...adminProductOrderBy(filter));
  const stockMap = await getAvailableStockMap(db, allRows.map((row) => row.id));
  const filteredRows = filter.stock === "low"
    ? allRows.filter((row) => row.fulfillmentMode === "card" && Number(stockMap.get(row.id) || 0) < lowStockThreshold)
    : allRows;
  const results = filteredRows.slice(offset, offset + limit);
  const purchasedCountMap = await getPurchasedCountMap(db, results.map((row) => row.id));

  return {
    total: filteredRows.length,
    products: await attachStorefrontBadges(db, results.map((r) => ({
      ...r,
      active: activeFlag(r.active),
      purchaseLimitDisplay: activeFlag(r.purchaseLimitDisplay),
      fulfillmentInputRequired: r.fulfillmentInputRequired === 1,
      stock: Number(stockMap.get(r.id) || 0),
      purchasedCount: Number(purchasedCountMap.get(r.id) || 0),
    }))),
  };
}

/**
 * 商品仍是全局事实；这里附加的渠道数组只是后台定位与发布状态读模型。
 * visible=false 的映射也必须返回，否则后台会把“已分配但暂时隐藏”误判为未分配。
 */
async function attachStorefrontBadges<T extends { id: string }>(db: DbType, rows: T[]): Promise<Record<string, unknown>[]> {
  if (rows.length === 0) return [];
  const assignments = await db
    .select({
      productId: storefrontProducts.productId,
      id: storefronts.id,
      slug: storefronts.slug,
      name: storefronts.name,
      active: storefronts.active,
      isDefault: storefronts.isDefault,
      visible: storefrontProducts.visible,
      sortOrder: storefrontProducts.sortOrder,
    })
    .from(storefrontProducts)
    .innerJoin(storefronts, eq(storefronts.id, storefrontProducts.storefrontId))
    .where(inArray(storefrontProducts.productId, rows.map((row) => row.id)))
    .orderBy(asc(storefronts.sortOrder), asc(storefronts.name));

  const byProduct = new Map<string, Array<Record<string, unknown>>>();
  for (const assignment of assignments) {
    const badges = byProduct.get(assignment.productId) || [];
    badges.push({
      id: assignment.id,
      slug: assignment.slug,
      name: assignment.name,
      active: assignment.active === 1,
      isDefault: assignment.isDefault === 1,
      visible: assignment.visible === 1,
      sortOrder: assignment.sortOrder,
    });
    byProduct.set(assignment.productId, badges);
  }

  return rows.map((row) => {
    const productStorefronts = byProduct.get(row.id) || [];
    return {
      ...row,
      storefrontIds: productStorefronts.map((storefront) => storefront.id),
      storefronts: productStorefronts,
      storefrontCount: productStorefronts.length,
      publishedStorefrontCount: productStorefronts.filter((storefront) => storefront.active && storefront.visible).length,
    };
  });
}

function buildProductWhere(filter: ProductFilter): SQL | undefined {
  const conditions: SQL[] = [];
  if (filter.active !== "") {
    conditions.push(eq(products.active, filter.active === "true" ? 1 : 0));
  }
  if (filter.category) {
    conditions.push(eq(products.category, filter.category));
  }
  if (filter.storefrontId) {
    conditions.push(sql`EXISTS (
      SELECT 1 FROM ${storefrontProducts}
      WHERE ${storefrontProducts.productId} = ${products.id}
        AND ${storefrontProducts.storefrontId} = ${filter.storefrontId}
    )`);
  }
  if (filter.q) {
    conditions.push(
      or(
        like(products.id, `%${filter.q}%`),
        like(products.title, `%${filter.q}%`),
        like(products.category, `%${filter.q}%`)
      )!
    );
  }
  return conditions.length > 0 ? and(...conditions) : undefined;
}

function adminProductOrderBy(filter: ProductFilter): SQL[] {
  if (!filter.storefrontId) return [sql`${products.sortOrder}`, sql`${products.createdAt}`];
  return [
    sql`(SELECT ${storefrontProducts.sortOrder} FROM ${storefrontProducts}
      WHERE ${storefrontProducts.productId} = ${products.id}
        AND ${storefrontProducts.storefrontId} = ${filter.storefrontId}
      LIMIT 1)`,
    sql`${products.sortOrder}`,
    sql`${products.createdAt}`,
  ];
}

function slugifyIdentifier(value: string, fallbackPrefix: string) {
  // 新商品 ID 必须和各业务接口的 URL/JSON 入参保持一致。
  // 历史版本会保留中文，导致自动生成的商品 ID 被卡密导入/支付接口拒绝；
  // 现在只从标题中提取 ASCII 安全片段，中文标题则回退到 product/product-2。
  const normalized = value
    .trim()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return normalized || fallbackPrefix;
}

async function nextAvailableProductId(db: DbType, title: string) {
  const base = slugifyIdentifier(title, "product");
  for (let attempt = 0; attempt < 10; attempt++) {
    const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
    const candidate = `${base}${suffix}`.slice(0, 80);
    if (!(await checkProductExists(db, candidate))) return candidate;
  }
  return `${base}-${crypto.randomUUID().slice(0, 8)}`.slice(0, 80);
}

export async function checkProductExists(
  db: DbType,
  id: string,
): Promise<boolean> {
  const [existing] = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.id, id))
    .limit(1);
  return !!existing;
}

export async function getProductCommerceState(
  db: DbType,
  id: string,
): Promise<{ currency: string; active: boolean } | null> {
  const [row] = await db
    .select({ currency: products.currency, active: products.active })
    .from(products)
    .where(eq(products.id, id))
    .limit(1);
  if (!row) return null;
  return { currency: row.currency, active: activeFlag(row.active) };
}

export async function createProduct(
  db: DbType,
  input: CreateProductInput,
): Promise<string> {
  return withDbTransaction(db, async (tx) => {
    const now = new Date().toISOString();
    const id = input.id || await nextAvailableProductId(tx, input.title);
    const fulfillmentInputFields = toStoredFulfillmentInputFields(input);
    let targetStorefrontIds: string[];

    if (input.storefrontIds === undefined) {
      const [defaultStorefront] = await tx
        .select({ id: storefronts.id })
        .from(storefronts)
        .where(eq(storefronts.isDefault, 1))
        .limit(1);
      if (!defaultStorefront) {
        throw new ProductStorefrontAssignmentError("DEFAULT_STOREFRONT_MISSING", "默认展示渠道不存在，无法创建商品");
      }
      targetStorefrontIds = [defaultStorefront.id];
    } else {
      targetStorefrontIds = Array.from(new Set(input.storefrontIds));
      if (targetStorefrontIds.length > 0) {
        const existingStorefronts = await tx
          .select({ id: storefronts.id })
          .from(storefronts)
          .where(inArray(storefronts.id, targetStorefrontIds));
        if (existingStorefronts.length !== targetStorefrontIds.length) {
          throw new ProductStorefrontAssignmentError("STOREFRONT_NOT_FOUND", "包含不存在的展示渠道");
        }
      }
    }

    await tx.insert(products).values({
      id,
      slug: id,
      title: input.title,
      description: input.description,
      salesCopy: input.salesCopy,
      coverUrl: input.coverUrl,
      tagsJson: input.tagsJson,
      priceCents: input.priceCents,
      currency: input.currency,
      fulfillmentMode: input.fulfillmentMode || "card",
      issueMode: input.issueMode,
      active: input.active ? 1 : 0,
      category: input.category || "",
      sortOrder: input.sortOrder,
      purchaseLimit: input.purchaseLimit ?? null,
      purchaseLimitDisplay: input.purchaseLimitDisplay && Number(input.purchaseLimit || 0) > 0 ? 1 : 0,
      deliveryVisibility: input.deliveryVisibility || "web_and_email",
      stockDisplayMode: input.stockDisplayMode || "exact",
      ...fulfillmentInputFields,
      createdAt: now,
      updatedAt: now,
    });

    if (targetStorefrontIds.length > 0) {
      await tx.insert(storefrontProducts).values(targetStorefrontIds.map((storefrontId) => ({
        storefrontId,
        productId: id,
        visible: 1,
        sortOrder: input.sortOrder,
        createdAt: now,
        updatedAt: now,
      })));
    }
    return id;
  });
}

export class ProductStorefrontAssignmentError extends Error {
  constructor(
    readonly code: "DEFAULT_STOREFRONT_MISSING" | "STOREFRONT_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "ProductStorefrontAssignmentError";
  }
}

// ── G13: 更新商品 ──────────────────────────────────

export async function updateProduct(
  db: DbType,
  id: string,
  input: UpdateProductInput,
): Promise<void> {
  const updatedAt = new Date().toISOString();
  // Drizzle ORM: 只 set 非undefined的字段
  const setValues: Record<string, unknown> = { updatedAt };
  if (input.title !== undefined) setValues["title"] = input.title;
  if (input.description !== undefined) setValues["description"] = input.description;
  if (input.salesCopy !== undefined) setValues["salesCopy"] = input.salesCopy;
  if (input.coverUrl !== undefined) setValues["coverUrl"] = input.coverUrl;
  if (input.tagsJson !== undefined) setValues["tagsJson"] = input.tagsJson;
  if (input.priceCents !== undefined) setValues["priceCents"] = input.priceCents;
  if (input.currency !== undefined) setValues["currency"] = input.currency;
  if (input.issueMode !== undefined) setValues["issueMode"] = input.issueMode;
  if (input.fulfillmentMode !== undefined) setValues["fulfillmentMode"] = input.fulfillmentMode;
  if (input.active !== undefined) setValues["active"] = input.active ? 1 : 0;
  if (input.category !== undefined) setValues["category"] = input.category;
  if (input.sortOrder !== undefined) setValues["sortOrder"] = input.sortOrder;
  if (input.purchaseLimit !== undefined) setValues["purchaseLimit"] = input.purchaseLimit ?? null;
  if (input.purchaseLimitDisplay !== undefined || input.purchaseLimit !== undefined) {
    const nextLimit = input.purchaseLimit === undefined ? undefined : Number(input.purchaseLimit || 0);
    setValues["purchaseLimitDisplay"] = input.purchaseLimitDisplay && nextLimit !== 0 ? 1 : 0;
  }
  if (input.deliveryVisibility !== undefined) setValues["deliveryVisibility"] = input.deliveryVisibility || "web_and_email";
  if (input.stockDisplayMode !== undefined) setValues["stockDisplayMode"] = input.stockDisplayMode || "exact";
  if (input.fulfillmentInputType !== undefined) {
    Object.assign(setValues, toStoredFulfillmentInputFields(input));
  } else {
    if (input.fulfillmentInputLabel !== undefined) setValues["fulfillmentInputLabel"] = input.fulfillmentInputLabel;
    if (input.fulfillmentInputHint !== undefined) setValues["fulfillmentInputHint"] = input.fulfillmentInputHint;
    if (input.fulfillmentInputRequired !== undefined) setValues["fulfillmentInputRequired"] = input.fulfillmentInputRequired ? 1 : 0;
  }

  await db.update(products).set(setValues).where(eq(products.id, id));
}

export async function duplicateProduct(
  db: DbType,
  id: string,
): Promise<string | null> {
  return withDbTransaction(db, async (tx) => {
    const [source] = await tx
      .select({
        id: products.id,
        title: products.title,
        description: products.description,
        priceCents: products.priceCents,
        currency: products.currency,
        issueMode: products.issueMode,
        fulfillmentMode: products.fulfillmentMode,
        sortOrder: products.sortOrder,
        salesCopy: products.salesCopy,
        coverUrl: products.coverUrl,
        tagsJson: products.tagsJson,
        category: products.category,
        purchaseLimit: products.purchaseLimit,
        purchaseLimitDisplay: products.purchaseLimitDisplay,
        deliveryVisibility: products.deliveryVisibility,
        stockDisplayMode: products.stockDisplayMode,
        fulfillmentInputType: products.fulfillmentInputType,
        fulfillmentInputLabel: products.fulfillmentInputLabel,
        fulfillmentInputHint: products.fulfillmentInputHint,
        fulfillmentInputRequired: products.fulfillmentInputRequired,
      })
      .from(products)
      .where(eq(products.id, id))
      .limit(1);
    if (!source) return null;

    const now = new Date().toISOString();
    const newId = await nextAvailableProductId(tx, `${source.id}-copy`);
    await tx.insert(products).values({
      id: newId,
      slug: newId,
      title: `${source.title} 副本`,
      description: source.description,
      salesCopy: source.salesCopy,
      coverUrl: source.coverUrl,
      tagsJson: source.tagsJson,
      priceCents: source.priceCents,
      currency: source.currency,
      fulfillmentMode: source.fulfillmentMode || "card",
      issueMode: source.issueMode,
      active: 0,
      category: source.category || "",
      sortOrder: Number(source.sortOrder || 100) + 1,
      purchaseLimit: source.purchaseLimit ?? null,
      purchaseLimitDisplay: activeFlag(source.purchaseLimitDisplay) ? 1 : 0,
      deliveryVisibility: (source.deliveryVisibility as DeliveryVisibility) || "web_and_email",
      stockDisplayMode: (source.stockDisplayMode as StockDisplayMode) || "exact",
      fulfillmentInputType: source.fulfillmentInputType || "none",
      fulfillmentInputLabel: source.fulfillmentInputLabel || "",
      fulfillmentInputHint: source.fulfillmentInputHint || "",
      fulfillmentInputRequired: activeFlag(source.fulfillmentInputRequired) ? 1 : 0,
      createdAt: now,
      updatedAt: now,
    });

    const assignments = await tx
      .select({
        storefrontId: storefrontProducts.storefrontId,
        visible: storefrontProducts.visible,
        sortOrder: storefrontProducts.sortOrder,
      })
      .from(storefrontProducts)
      .where(eq(storefrontProducts.productId, id));
    if (assignments.length > 0) {
      await tx.insert(storefrontProducts).values(assignments.map((assignment) => ({
        storefrontId: assignment.storefrontId,
        productId: newId,
        visible: assignment.visible,
        sortOrder: assignment.sortOrder,
        createdAt: now,
        updatedAt: now,
      })));
    }
    return newId;
  });
}

// ── G14: 创建折扣码 ────────────────────────────────

export async function upsertCoupon(
  db: DbType,
  input: CreateCouponInput,
): Promise<string> {
  const code = (input.code || createCouponCode(input.productId || "coupon")).toLowerCase();
  // Drizzle ORM onConflictDoUpdate：INSERT ... ON CONFLICT(code) DO UPDATE
  await db
    .insert(coupons)
    .values({
      code,
      productId: input.productId || "",
      discountType: input.discountType,
      discountValue: input.discountValue,
      maxUses: input.maxUses,
      active: input.active ? 1 : 0,
      expiresAt: input.expiresAt || null,
      createdAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: coupons.code,
      set: {
        productId: input.productId || "",
        discountType: input.discountType,
        discountValue: input.discountValue,
        maxUses: input.maxUses,
        active: input.active ? 1 : 0,
        expiresAt: input.expiresAt || null,
      },
    });
  return code;
}

// ── G15: 生成折扣码 ────────────────────────────────

export async function generateCoupon(
  db: DbType,
  input: GenerateCouponInput,
): Promise<string[]> {
  const total = input.count ?? 1;
  const maxRetries = 3;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const codes: string[] = [];
    const values = [];
    const now = new Date().toISOString();
    for (let i = 0; i < total; i++) {
      const code = createCouponCode(input.prefix || input.productId).toLowerCase();
      codes.push(code);
      values.push({
        code,
        productId: input.productId,
        discountType: input.discountType,
        discountValue: input.discountValue,
        maxUses: input.maxUses,
        active: input.active ? 1 : 0,
        expiresAt: input.expiresAt || null,
        createdAt: now,
      });
    }
    try {
      await db.insert(coupons).values(values);
      return codes;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE constraint failed") && attempt < maxRetries) continue;
      throw err;
    }
  }

  throw new Error(`生成折扣码冲突，已重试 ${maxRetries} 次仍失败，请稍后重试`);
}

// ── G16: 更新折扣码 ────────────────────────────────

export async function updateCoupon(
  db: DbType,
  code: string,
  input: UpdateCouponInput,
): Promise<void> {
  const setValues: Record<string, unknown> = {};
  if (input.discountType !== undefined) setValues["discountType"] = input.discountType;
  if (input.discountValue !== undefined) setValues["discountValue"] = input.discountValue;
  if (input.maxUses !== undefined) setValues["maxUses"] = input.maxUses;
  if (input.active !== undefined) setValues["active"] = input.active ? 1 : 0;
  if (input.expiresAt !== undefined) setValues["expiresAt"] = input.expiresAt;

  await db
    .update(coupons)
    .set(setValues)
    .where(eq(coupons.code, code));
}

// ── G17: 日志列表（合并 request_logs + admin_audit_logs）─

type LogCursorKind = "merged_logs" | "email_logs";

type LogCursorPayload = {
  v: 1;
  kind: LogCursorKind;
  snapshotAt: string;
  createdAt: string;
  id: string;
  scope: string;
  total: number;
  type?: "request" | "admin";
};

export class InvalidLogCursorError extends Error {
  constructor() {
    super("日志分页游标无效或与当前筛选条件不匹配");
    this.name = "InvalidLogCursorError";
  }
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): string {
  if (!value || value.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new InvalidLogCursorError();
  }
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - base64.length % 4) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeLogCursor(payload: LogCursorPayload): string {
  return encodeBase64Url(JSON.stringify(payload));
}

function decodeLogCursor(cursor: string, kind: LogCursorKind, scope: string): LogCursorPayload {
  try {
    const payload = JSON.parse(decodeBase64Url(cursor)) as Partial<LogCursorPayload>;
    const validType = kind === "merged_logs"
      ? payload.type === "request" || payload.type === "admin"
      : payload.type === undefined;
    if (
      payload.v !== 1
      || payload.kind !== kind
      || payload.scope !== scope
      || typeof payload.snapshotAt !== "string"
      || !Number.isFinite(Date.parse(payload.snapshotAt))
      || typeof payload.createdAt !== "string"
      || !Number.isFinite(Date.parse(payload.createdAt))
      || typeof payload.id !== "string"
      || payload.id.length === 0
      || !Number.isInteger(payload.total)
      || (payload.total ?? -1) < 0
      || !validType
    ) {
      throw new InvalidLogCursorError();
    }
    return payload as LogCursorPayload;
  } catch (error) {
    if (error instanceof InvalidLogCursorError) throw error;
    throw new InvalidLogCursorError();
  }
}

function normalizedSnapshotAt(value?: string): string | undefined {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
}

function assertCursorSnapshot(cursor: LogCursorPayload | undefined, requestedSnapshot?: string): string {
  const normalizedRequested = normalizedSnapshotAt(requestedSnapshot);
  if (cursor && normalizedRequested && normalizedRequested !== cursor.snapshotAt) {
    throw new InvalidLogCursorError();
  }
  return cursor?.snapshotAt || normalizedRequested || new Date().toISOString();
}

type MergedLogFilter = {
  action?: string;
  targetType?: string;
  targetId?: string;
  snapshotAt?: string;
  cursor?: string;
};

export async function getMergedLogs(
  db: DbType,
  limit: number,
  filter: MergedLogFilter = {},
): Promise<{
  total: number;
  logs: Record<string, unknown>[];
  snapshotAt: string;
  nextCursor: string;
  hasMore: boolean;
}> {
  const action = filter.action?.trim() || "";
  const targetType = filter.targetType?.trim() || "";
  const targetId = filter.targetId?.trim() || "";
  const scope = JSON.stringify([action, targetType, targetId]);
  const cursor = filter.cursor ? decodeLogCursor(filter.cursor, "merged_logs", scope) : undefined;
  const snapshotAt = assertCursorSnapshot(cursor, filter.snapshotAt);
  const actionPattern = action ? `%${action}%` : "%";
  const targetTypePattern = targetType ? `%${targetType}%` : "%";
  const targetIdPattern = targetId ? `%${targetId}%` : "%";

  let total = cursor?.total;
  if (total === undefined) {
    const countResult = await db.run(sql`
      SELECT COUNT(*) AS count FROM (
        SELECT action, '' AS targetType, '' AS targetId, created_at AS createdAt FROM request_logs
        UNION ALL
        SELECT action, target_type AS targetType, target_id AS targetId, created_at AS createdAt FROM admin_audit_logs
      )
      WHERE createdAt <= ${snapshotAt}
        AND action LIKE ${actionPattern}
        AND targetType LIKE ${targetTypePattern}
        AND targetId LIKE ${targetIdPattern}
    `);
    total = Number((countResult.rows?.[0] as { count?: unknown } | undefined)?.count ?? 0);
  }
  const cursorCondition = cursor ? sql`
    AND (
      createdAt < ${cursor.createdAt}
      OR (createdAt = ${cursor.createdAt} AND type < ${cursor.type})
      OR (createdAt = ${cursor.createdAt} AND type = ${cursor.type} AND id < ${cursor.id})
    )
  ` : sql``;

  // UNION ALL 合并请求日志和管理员审计日志（Drizzle 不支持 UNION ALL，使用 sql）
  const result = await db.run(sql`
    SELECT * FROM (
      SELECT
        'request' AS type,
        id,
        method,
        path,
        action,
        '' AS targetType,
        '' AS targetId,
        NULL AS metadata,
        ip_hash AS ipHash,
        status_code AS statusCode,
        created_at AS createdAt
      FROM request_logs
      UNION ALL
      SELECT
        'admin' AS type,
        id,
        NULL AS method,
        NULL AS path,
        action,
        target_type AS targetType,
        target_id AS targetId,
        metadata_json AS metadata,
        ip_hash AS ipHash,
        NULL AS statusCode,
        created_at AS createdAt
      FROM admin_audit_logs
    )
    WHERE createdAt <= ${snapshotAt}
      AND action LIKE ${actionPattern}
      AND targetType LIKE ${targetTypePattern}
      AND targetId LIKE ${targetIdPattern}
    ${cursorCondition}
    ORDER BY createdAt DESC, type DESC, id DESC
    LIMIT ${limit + 1}
  `);

  const rows = result.rows as unknown as Record<string, unknown>[];
  const hasMore = rows.length > limit;
  const logs = rows.slice(0, limit).map((row) => {
    const sensitiveSystemConfigUpdate = row.action === "update_system_config"
      && typeof row.targetId === "string"
      && isSensitiveSystemConfigKey(row.targetId);
    if (sensitiveSystemConfigUpdate) {
      return { ...row, metadata: { key: row.targetId } };
    }
    if (typeof row.metadata !== "string" || !row.metadata) return row;
    try {
      const metadata = JSON.parse(row.metadata) as unknown;
      return metadata && typeof metadata === "object" && !Array.isArray(metadata)
        ? { ...row, metadata }
        : row;
    } catch {
      return row;
    }
  });
  const lastLog = logs.at(-1);
  const nextCursor = hasMore && lastLog
    ? encodeLogCursor({
      v: 1,
      kind: "merged_logs",
      snapshotAt,
      createdAt: String(lastLog.createdAt),
      type: lastLog.type as "request" | "admin",
      id: String(lastLog.id),
      scope,
      total,
    })
    : "";
  return { total, logs, snapshotAt, nextCursor, hasMore };
}

// ── G18: 读取系统配置 ──────────────────────────────

export async function getSystemConfig(
  db: DbType,
  encryptionKey?: string,
): Promise<Record<string, string>> {
  const rows = await db
    .select({ key: systemConfig.key, value: systemConfig.value })
    .from(systemConfig)
    .where(inArray(systemConfig.key, SYSTEM_CONFIG_KEYS));

  const config = buildSystemConfigMap(rows);
  for (const key of SYSTEM_CONFIG_KEYS) {
    if (isSensitiveSystemConfigKey(key) && config[key]) {
      config[key] = await decryptSecretConfigValue(config[key], encryptionKey);
    }
  }
  return config;
}

// ── G19: 更新系统配置 ──────────────────────────────

export async function upsertSystemConfig(
  db: DbType,
  key: string,
  value: string,
  encryptionKey?: string,
): Promise<void> {
  const updatedAt = new Date().toISOString();
  const storedValue = isSensitiveSystemConfigKey(key)
    ? await encryptSecretConfigValue(value, encryptionKey || "")
    : value;
  await db
    .insert(systemConfig)
    .values({ key, value: storedValue, updatedAt })
    .onConflictDoUpdate({
      target: systemConfig.key,
      set: { value: storedValue, updatedAt },
    });
}

// ── G20: 删除系统配置 ──────────────────────────────

export async function deleteSystemConfig(
  db: DbType,
  key: string,
): Promise<void> {
  await db.delete(systemConfig).where(eq(systemConfig.key, key));
}

// ═══════════════════════════════════════════════════════════════
// 支付配置管理（加密存储）
// ═══════════════════════════════════════════════════════════════

/** systemConfig 中支付配置的前缀 */
const PAYMENT_PROVIDER_PREFIX = "payment_provider:";

function isValidPaymentConfigEncryptionKey(value: string | undefined): value is string {
  return Boolean(value && /^[a-fA-F0-9]{64}$/.test(value));
}

/**
 * 从 systemConfig 读取所有支付配置（加密形式）。
 * 返回原始加密值（不做解密），供管理前端展示状态使用。
 */
export async function getPaymentProviderConfigs(
  db: DbType,
  encryptionKey?: string,
): Promise<Record<string, { enabled: boolean; configured: boolean; config: Record<string, string> }>> {
  const prefix = PAYMENT_PROVIDER_PREFIX;
  const rows = await db
    .select({ key: systemConfig.key, value: systemConfig.value })
    .from(systemConfig)
    .where(sql`${systemConfig.key} LIKE ${prefix + "%"}`);

  const result: Record<string, { enabled: boolean; configured: boolean; config: Record<string, string> }> = {};
  for (const row of rows) {
    const providerName = row.key.slice(prefix.length);
    // 未上线前已将服务商品牌和协议通道彻底拆开：只有 catalog 中的 provider 才能进入后台状态。
    // 旧的未知 provider 脏数据既不展示，也不参与运行时选择，避免运营误以为仍可配置。
    if (!isValidProviderName(providerName)) continue;
    const configured = row.value.startsWith("enc:");
    // 管理端状态必须和运行时一致地 fail closed：只要密文不存在、密钥不可用或解密失败，
    // UI 就不能显示“已启用”，否则会造成后台状态与真实收款能力相互矛盾。
    let enabled = false;
    let config: Record<string, string> = {};
    if (configured && isValidPaymentConfigEncryptionKey(encryptionKey)) {
      try {
        const { decrypt: aesDecrypt } = await import("@usethink/cf-core");
        const decrypted = await aesDecrypt(row.value.slice(4), encryptionKey);
        const payload = decrypted as unknown as { enabled?: boolean; config?: Record<string, string> };
        // enabled 必须显式为 true 才算启用。旧格式或半写入配置只展示为“已配置、未启用”。
        enabled = payload.enabled === true;
        config = payload.config || {};
      } catch {
        enabled = false;
      }
    }
    result[providerName] = { enabled, configured, config };
  }
  return result;
}

/**
 * 统计仍依赖当前 Provider 凭据完成回调验签或主动查单的订单。
 * pending/paid 永不按时间忽略；expired 保留 7 天迟到回调窗口。
 */
export async function countProviderOrdersRequiringCredentials(
  db: DbType,
  providerName: string,
): Promise<number> {
  const expiredGraceStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const [row] = await db
    .select({ count: count() })
    .from(orders)
    .where(and(
      eq(orders.paymentProvider, providerName),
      or(
        inArray(orders.status, ["pending", "paid"]),
        and(eq(orders.status, "expired"), sql`datetime(${orders.createdAt}) >= datetime(${expiredGraceStart})`),
      ),
    ));
  const [rechargeRow] = await db
    .select({ count: count() })
    .from(balanceRechargeOrders)
    .where(and(
      eq(balanceRechargeOrders.paymentProvider, providerName),
      or(
        eq(balanceRechargeOrders.status, "pending"),
        and(eq(balanceRechargeOrders.status, "expired"), sql`datetime(${balanceRechargeOrders.createdAt}) >= datetime(${expiredGraceStart})`),
      ),
    ));
  return Number(row?.count || 0) + Number(rechargeRow?.count || 0);
}

/**
 * 加密并保存支付配置到 systemConfig。
 *
 * @param db - Drizzle ORM 实例
 * @param providerName - Provider 名称（如 "easypay", "alipay"）
 * @param config - 明文配置键值对（如 { EASYPAY_PID: "xxx", EASYPAY_KEY: "xxx" }）
 * @param encryptionKey - CREDENTIALS_ENCRYPTION_KEY（64 字符 hex）
 */
export async function upsertPaymentProviderConfig(
  db: DbType,
  providerName: string,
  config: Record<string, string>,
  encryptionKey: string,
): Promise<boolean> {
  // 配置保存必须和“读取当前启用状态”处在同一个短事务内：
  // 否则并发的启用/禁用操作可能在路由读取旧状态后，被一次普通编辑覆盖。
  // 首次保存、禁用墓碑或解密失败均 fail closed 为 false；只有当前密文明确为 enabled=true 才保持启用。
  const { decrypt: aesDecrypt, encrypt: aesEncrypt } = await import("@usethink/cf-core");
  return withDbTransaction(db, async (tx) => {
    const key = `${PAYMENT_PROVIDER_PREFIX}${providerName}`;
    const [current] = await tx
      .select({ value: systemConfig.value })
      .from(systemConfig)
      .where(eq(systemConfig.key, key))
      .limit(1);

    let enabled = false;
    if (current?.value?.startsWith("enc:") && isValidPaymentConfigEncryptionKey(encryptionKey)) {
      try {
        const decrypted = await aesDecrypt(current.value.slice(4), encryptionKey);
        const payload = decrypted as unknown as { enabled?: boolean };
        enabled = payload.enabled === true;
      } catch {
        enabled = false;
      }
    }

    const payload = { enabled, config };
    // AES-256-GCM 加密在事务内完成，不涉及网络或其它外部 I/O。
    const encrypted = await aesEncrypt(payload, encryptionKey);
    const encryptedValue = `enc:${encrypted}`;
    const updatedAt = new Date().toISOString();

    await tx
      .insert(systemConfig)
      .values({ key, value: encryptedValue, updatedAt })
      .onConflictDoUpdate({
        target: systemConfig.key,
        set: { value: encryptedValue, updatedAt },
      });
    return enabled;
  });
}

export async function setPaymentProviderEnabled(
  db: DbType,
  providerName: string,
  enabled: boolean,
  encryptionKey: string,
): Promise<boolean> {
  // 启用/禁用与配置保存必须使用同一事务边界，避免两个后台操作互相覆盖最后一次状态。
  const { decrypt: aesDecrypt, encrypt: aesEncrypt } = await import("@usethink/cf-core");
  return withDbTransaction(db, async (tx) => {
    const key = `${PAYMENT_PROVIDER_PREFIX}${providerName}`;
    const [row] = await tx
      .select({ value: systemConfig.value })
      .from(systemConfig)
      .where(eq(systemConfig.key, key))
      .limit(1);

    const current = row?.value || "";
    if (!current.startsWith("enc:")) return false;

    const decrypted = await aesDecrypt(current.slice(4), encryptionKey);
    const payload = decrypted as unknown as { enabled?: boolean; config?: Record<string, string> };
    const nextPayload = {
      enabled,
      config: payload.config || {},
    };
    const encrypted = await aesEncrypt(nextPayload, encryptionKey);
    await tx
      .update(systemConfig)
      .set({ value: `enc:${encrypted}`, updatedAt: new Date().toISOString() })
      .where(eq(systemConfig.key, key));
    return true;
  });
}

/**
 * 删除支付配置时保留禁用墓碑，防止环境变量中的旧凭据重新启用渠道。
 */
export async function deletePaymentProviderConfig(
  db: DbType,
  providerName: string,
): Promise<void> {
  const key = `${PAYMENT_PROVIDER_PREFIX}${providerName}`;
  const updatedAt = new Date().toISOString();
  await db
    .insert(systemConfig)
    .values({ key, value: PAYMENT_PROVIDER_DISABLED_VALUE, updatedAt })
    .onConflictDoUpdate({
      target: systemConfig.key,
      set: { value: PAYMENT_PROVIDER_DISABLED_VALUE, updatedAt },
    });
}

// ── G21: 库存预警 ──────────────────────────────

export type LowStockProduct = {
  id: string;
  title: string;
  category: string;
  stock: number;
};

/**
 * 查询库存低于阈值的商品列表。
 * threshold 从 system_config 读取，默认 5。
 * 如果 inventory_warning_enabled = 'false'，返回空数组。
 */
export async function getLowStockProducts(
  db: DbType,
  threshold?: number,
): Promise<LowStockProduct[]> {
  const config = await readSystemConfigMap(db, ["inventory_warning_enabled", "inventory_warning_threshold"]);
  if (config.inventory_warning_enabled === "false") {
    return [];
  }

  // 显式 threshold 用于本次查询/通知；未传时才读取系统配置。
  const parsed = parseInt(config.inventory_warning_threshold, 10);
  const configThreshold = Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
  const effectiveThreshold = threshold ?? configThreshold;

  // 低库存是“当前可售商品”的运营预警：下架商品即使库存为 0 也不应进入
  // 首页统计、待处理列表或通知邮件。先筛选在售 card 商品，再统一计算库存。
  const productRows = await db
    .select({
      id: products.id,
      title: products.title,
      category: products.category,
    })
    .from(products)
    .where(and(eq(products.fulfillmentMode, "card"), eq(products.active, 1)))
    .orderBy(asc(products.title));
  const stockMap = await getAvailableStockMap(db, productRows.map((row) => row.id));
  const results = productRows
    .map((row) => ({
      ...row,
      stock: Number(stockMap.get(row.id) || 0),
    }))
    .filter((row) => row.stock < effectiveThreshold)
    .sort((a, b) => a.stock - b.stock || a.title.localeCompare(b.title));

  return results as LowStockProduct[];
}

/**
 * 发送低库存预警邮件。
 * 如果 inventory_warning_email_to 未配置，直接跳过。
 */
export async function sendLowStockWarningEmail(
  db: DbType,
  env: { resendApiKey: string; emailFrom: string },
  products: LowStockProduct[],
  threshold: number,
): Promise<{ ok: boolean; message: string }> {
  const emailTo = (await readSystemConfigMap(db, ["inventory_warning_email_to"])).inventory_warning_email_to;
  if (!emailTo) {
    return { ok: false, message: "未配置库存预警通知邮箱" };
  }

  const tpl = getTemplate("low_stock_warning");
  if (!tpl) {
    return { ok: false, message: "未知邮件模板: low_stock_warning" };
  }

  const productsTable = products
    .map(
      (p) =>
        `<tr><td>${escapeHtml(p.title)}</td><td>${escapeHtml(p.id)}</td><td style="text-align: right;">${escapeHtml(String(p.stock))}</td><td style="text-align: right;">${escapeHtml(String(threshold))}</td></tr>`,
    )
    .join("\n      ");

  const html = interpolate(tpl.html, {
    productsTable,
  });

  return sendEmail(db, env, {
    to: emailTo,
    template: "low_stock_warning",
    templateData: {
      productsTable,
    },
  });
}

// ── G22: 取消订单 ──────────────────────────────────

export async function cancelOrder(
  db: DbType,
  id: string,
): Promise<{ id: string; releasedCardId: string | null; releasedCards: number }> {
  // 只允许取消未支付 pending 订单。paid 代表支付事实已经成立，必须走履约/退款人工流程，不能直接释放库存和优惠权益。
  const [order] = await db
    .select({ id: orders.id, status: orders.status, issuedCardId: orders.issuedCardId, couponCode: orders.couponCode })
    .from(orders)
    .where(eq(orders.id, id))
    .limit(1);
  if (!order) throw new Error("订单不存在");
  if (order.status !== "pending") {
    throw new Error(`状态为 ${order.status} 的订单不可取消`);
  }

  const releasedCards = await withDbTransaction(db, async (tx) => {
    const result = await tx
      .update(orders)
      .set({ status: "canceled" })
      .where(and(eq(orders.id, id), eq(orders.status, order.status)));
    if (result.rowsAffected === 0) {
      throw new Error("订单状态已变更，请刷新重试");
    }

    // 状态变更、库存释放和优惠券释放必须同生共死，避免取消成功后资源仍被占用。
    const released = await releaseLockedCardByOrder(tx, id);
    if (order.couponCode) await releaseCouponReservation(tx, order.couponCode);
    return released;
  });

  return { id, releasedCardId: null, releasedCards };
}

// ── G23: 邮件日志列表 ──────────────────────────────

export type EmailLogFilter = {
  status: string;   // 'sent', 'failed', 'pending', '' (all)
  search: string;
  limit: number;
  snapshotAt?: string;
  cursor?: string;
};

function buildEmailLogWhere(filter: EmailLogFilter, cursor?: LogCursorPayload): SQL | undefined {
  const conditions: SQL[] = [];
  if (filter.status) conditions.push(eq(emailLogs.status, filter.status));
  if (filter.search) conditions.push(like(emailLogs.toEmail, `%${filter.search}%`));
  if (filter.snapshotAt) conditions.push(lte(emailLogs.createdAt, filter.snapshotAt));
  if (cursor) {
    conditions.push(or(
      lt(emailLogs.createdAt, cursor.createdAt),
      and(eq(emailLogs.createdAt, cursor.createdAt), lt(emailLogs.id, cursor.id)),
    ) as SQL);
  }
  return conditions.length > 0 ? and(...conditions) : undefined;
}

export async function getEmailLogList(
  db: DbType,
  filter: EmailLogFilter,
): Promise<{
  total: number;
  results: Record<string, unknown>[];
  snapshotAt: string;
  nextCursor: string;
  hasMore: boolean;
}> {
  const status = filter.status.trim();
  const search = filter.search.trim();
  const scope = JSON.stringify([status, search]);
  const cursor = filter.cursor ? decodeLogCursor(filter.cursor, "email_logs", scope) : undefined;
  const snapshotAt = assertCursorSnapshot(cursor, filter.snapshotAt);
  const normalizedFilter = { ...filter, status, search, snapshotAt };
  const countWhere = buildEmailLogWhere(normalizedFilter);
  const where = buildEmailLogWhere(normalizedFilter, cursor);

  let total = cursor?.total;
  if (total === undefined) {
    const [countRow] = await db.select({ count: count() }).from(emailLogs).where(countWhere);
    total = countRow?.count ?? 0;
  }

  const rows = await db
    .select({
      id: emailLogs.id,
      orderId: emailLogs.orderId,
      toEmail: emailLogs.toEmail,
      template: emailLogs.template,
      status: emailLogs.status,
      provider: emailLogs.provider,
      errorMessage: emailLogs.errorMessage,
      createdAt: emailLogs.createdAt,
      sentAt: emailLogs.sentAt,
    })
    .from(emailLogs)
    .where(where)
    .orderBy(desc(emailLogs.createdAt), desc(emailLogs.id))
    .limit(filter.limit + 1);

  const hasMore = rows.length > filter.limit;
  const results = (rows as unknown as Record<string, unknown>[]).slice(0, filter.limit);
  const lastLog = results.at(-1);
  const nextCursor = hasMore && lastLog
    ? encodeLogCursor({
      v: 1,
      kind: "email_logs",
      snapshotAt,
      createdAt: String(lastLog.createdAt),
      id: String(lastLog.id),
      scope,
      total,
    })
    : "";
  return { total, results, snapshotAt, nextCursor, hasMore };
}

// ── G24: 营销活动管理 ──────────────────────────────

export async function getCampaignList(
  db: DbType,
): Promise<Record<string, unknown>[]> {
  const results = await db
    .select({
      code: campaigns.code,
      name: campaigns.name,
      active: sql<number>`CASE WHEN ${campaigns.active} = 1 THEN 1 ELSE 0 END`,
      startsAt: campaigns.startsAt,
      endsAt: campaigns.endsAt,
      metadataJson: campaigns.metadataJson,
      createdAt: campaigns.createdAt,
    })
    .from(campaigns)
    .orderBy(desc(campaigns.createdAt));

  return results.map((r) => ({
    ...r,
    active: r.active === 1,
  })) as unknown as Record<string, unknown>[];
}

export type CreateCampaignInput = {
  code: string;
  name: string;
  active: boolean;
  startsAt?: string | null;
  endsAt?: string | null;
  metadataJson?: string;
};

export async function createCampaign(
  db: DbType,
  input: CreateCampaignInput,
): Promise<void> {
  await db.insert(campaigns).values({
    code: input.code,
    name: input.name,
    active: input.active ? 1 : 0,
    startsAt: input.startsAt || null,
    endsAt: input.endsAt || null,
    metadataJson: input.metadataJson || "{}",
    createdAt: new Date().toISOString(),
  });
}

export async function updateCampaign(
  db: DbType,
  code: string,
  input: Partial<CreateCampaignInput>,
): Promise<void> {
  const setValues: Record<string, unknown> = {};
  if (input.name !== undefined) setValues["name"] = input.name;
  if (input.active !== undefined) setValues["active"] = input.active ? 1 : 0;
  if (input.startsAt !== undefined) setValues["startsAt"] = input.startsAt;
  if (input.endsAt !== undefined) setValues["endsAt"] = input.endsAt;
  if (input.metadataJson !== undefined) setValues["metadataJson"] = input.metadataJson;
  await db.update(campaigns).set(setValues).where(eq(campaigns.code, code));
}

export async function deleteCampaign(
  db: DbType,
  code: string,
): Promise<void> {
  await db.delete(campaigns).where(eq(campaigns.code, code));
}

// ── G25: 推荐码管理 ──────────────────────────────

export async function getReferralCodeList(
  db: DbType,
): Promise<Record<string, unknown>[]> {
  const results = await db
    .select({
      code: referralCodes.code,
      ownerContact: referralCodes.ownerContact,
      rewardType: referralCodes.rewardType,
      rewardValue: referralCodes.rewardValue,
      active: sql<number>`CASE WHEN ${referralCodes.active} = 1 THEN 1 ELSE 0 END`,
      createdAt: referralCodes.createdAt,
      useCount: sql<number>`(SELECT COUNT(*) FROM referral_events WHERE referral_code = ${referralCodes.code})`,
    })
    .from(referralCodes)
    .orderBy(desc(referralCodes.createdAt));

  return results.map((r) => ({
    ...r,
    active: r.active === 1,
  })) as unknown as Record<string, unknown>[];
}

export type CreateReferralCodeInput = {
  code: string;
  ownerContact: string;
  rewardType: string;
  rewardValue: number;
  active: boolean;
};

export async function createReferralCode(
  db: DbType,
  input: CreateReferralCodeInput,
): Promise<void> {
  await db.insert(referralCodes).values({
    code: input.code,
    ownerContact: input.ownerContact,
    rewardType: input.rewardType || "none",
    rewardValue: input.rewardValue || 0,
    active: input.active ? 1 : 0,
    createdAt: new Date().toISOString(),
  });
}

export async function updateReferralCode(
  db: DbType,
  code: string,
  input: Partial<CreateReferralCodeInput>,
): Promise<void> {
  const setValues: Record<string, unknown> = {};
  if (input.ownerContact !== undefined) setValues["ownerContact"] = input.ownerContact;
  if (input.rewardType !== undefined) setValues["rewardType"] = input.rewardType;
  if (input.rewardValue !== undefined) setValues["rewardValue"] = input.rewardValue;
  if (input.active !== undefined) setValues["active"] = input.active ? 1 : 0;
  await db.update(referralCodes).set(setValues).where(eq(referralCodes.code, code));
}

export async function deleteReferralCode(
  db: DbType,
  code: string,
): Promise<void> {
  await db.delete(referralCodes).where(eq(referralCodes.code, code));
}

// ── G26: 编辑卡密 ──────────────────────────────────

export async function updateCard(
  db: DbType,
  id: string,
  input: { accountLabel?: string; deliverySecret?: string; deliveryNote?: string },
): Promise<{ id: string } | null> {
  const [card] = await db
    .select({ id: cards.id })
    .from(cards)
    .where(eq(cards.id, id))
    .limit(1);
  if (!card) return null;

  const setValues: Record<string, unknown> = {};
  if (input.accountLabel !== undefined) setValues["accountLabel"] = input.accountLabel.trim();
  if (input.deliverySecret !== undefined) setValues["deliverySecret"] = input.deliverySecret.trim();
  if (input.deliveryNote !== undefined) setValues["deliveryNote"] = input.deliveryNote.trim();

  if (Object.keys(setValues).length > 0) {
    await db.update(cards).set(setValues).where(eq(cards.id, id));
  }
  return { id };
}

// ── G27: 删除商品 ──────────────────────────────────

export async function deleteProduct(
  db: DbType,
  id: string,
): Promise<{ deleted: boolean; reason?: string }> {
  // 检查是否有关联订单
  const [orderRow] = await db
    .select({ count: count() })
    .from(orders)
    .where(eq(orders.productId, id));
  if ((orderRow?.count ?? 0) > 0) {
    return { deleted: false, reason: `该商品有 ${orderRow?.count} 个关联订单，不可删除` };
  }

  // 检查是否有关联卡密
  const [cardRow] = await db
    .select({ count: count() })
    .from(cards)
    .where(eq(cards.productId, id));
  if ((cardRow?.count ?? 0) > 0) {
    return { deleted: false, reason: `该商品有 ${cardRow?.count} 张关联卡密，请先处理卡密` };
  }

  await db.delete(products).where(eq(products.id, id));
  return { deleted: true };
}

// ── G28: 删除折扣码 ──────────────────────────────────

export async function deleteCoupon(
  db: DbType,
  code: string,
): Promise<void> {
  await db.delete(coupons).where(eq(coupons.code, code));
}

export async function batchDeleteEmailLogs(
  db: DbType,
  ids: string[],
): Promise<{ deleted: number }> {
  const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
  if (uniqueIds.length === 0) return { deleted: 0 };
  const result = await db.delete(emailLogs).where(inArray(emailLogs.id, uniqueIds));
  return { deleted: result.rowsAffected ?? 0 };
}

export type AdminMergedLogDeleteTarget = {
  type: "request" | "admin";
  id: string;
};

export async function batchDeleteMergedLogs(
  db: DbType,
  targets: AdminMergedLogDeleteTarget[],
): Promise<{ deleted: number; request: number; admin: number }> {
  const requestIds = Array.from(new Set(
    targets.filter((item) => item.type === "request").map((item) => item.id).filter(Boolean),
  ));
  const adminIds = Array.from(new Set(
    targets.filter((item) => item.type === "admin").map((item) => item.id).filter(Boolean),
  ));

  let requestDeleted = 0;
  let adminDeleted = 0;
  if (requestIds.length > 0) {
    const result = await db.delete(requestLogs).where(inArray(requestLogs.id, requestIds));
    requestDeleted = result.rowsAffected ?? 0;
  }
  if (adminIds.length > 0) {
    const result = await db.delete(adminAuditLogs).where(inArray(adminAuditLogs.id, adminIds));
    adminDeleted = result.rowsAffected ?? 0;
  }
  return { deleted: requestDeleted + adminDeleted, request: requestDeleted, admin: adminDeleted };
}

/**
 * 清空操作日志，并在同一事务内保留一条不可丢失的清理凭证。
 *
 * 这里不能复用路由层的 best-effort writeAdminAudit：如果先提交 DELETE、随后审计 INSERT 失败，
 * 系统会留下无法追责的空日志。事务中的计数只统计清理前记录，不包含新写入的保留凭证。
 */
export async function clearAllMergedLogs(
  db: DbType,
  ipHash: string,
): Promise<{ deleted: number; request: number; admin: number; retainedAuditId: string }> {
  return withDbTransaction(db, async (tx) => {
    const requestResult = await tx.delete(requestLogs);
    const adminResult = await tx.delete(adminAuditLogs);
    const requestDeleted = requestResult.rowsAffected ?? 0;
    const adminDeleted = adminResult.rowsAffected ?? 0;
    const deleted = requestDeleted + adminDeleted;
    const retainedAuditId = crypto.randomUUID();

    await tx.insert(adminAuditLogs).values({
      id: retainedAuditId,
      action: "clear_all_logs",
      targetType: "log",
      targetId: "all",
      metadataJson: JSON.stringify({ deleted, request: requestDeleted, admin: adminDeleted }),
      ipHash,
      createdAt: new Date().toISOString(),
    });

    return { deleted, request: requestDeleted, admin: adminDeleted, retainedAuditId };
  });
}

/**
 * 数据维护清理档位（固定档位，禁止自由组合表，避免对账灾难）。
 *
 * - runtime：只清日志与瞬态状态，不动交易/库存/账本/目录
 * - keep_trade：清账本+营销+日志；保留商品、渠道、卡密、订单（及订单子表/卡密日志）
 * - keep_catalog：清交易+库存(S1 全清卡密)+账本+营销+日志；保留商品与展示渠道
 * - full：与历史「清除所有业务数据」一致（仍保留 system_config / 分类 / api_keys / 迁移 / storefronts）
 */
export type ClearBusinessDataProfile = "runtime" | "keep_trade" | "keep_catalog" | "full";

export type ClearBusinessDataResult = {
  deleted: number;
  tables: Record<string, number>;
  reservedTables: string[];
  retainedAuditId: string;
  profile: ClearBusinessDataProfile;
  cardStrategy: "none" | "clear_all";
};

/** 各档确认短语：服务端与 UI 必须一致，禁止用布尔开关替代。 */
export const CLEAR_BUSINESS_DATA_CONFIRMATIONS: Record<ClearBusinessDataProfile, string> = {
  runtime: "清除运行态与日志",
  keep_trade: "清除账本营销保留交易",
  keep_catalog: "清除交易数据保留商品",
  full: "清除所有业务数据",
};

const CLEAR_BUSINESS_DATA_BASE_RESERVED = [
  "system_config",
  "product_categories",
  "api_keys",
  "schema_migrations",
] as const;

const CLEAR_BUSINESS_DATA_TRADE_RESERVED = [
  "products",
  "storefronts",
  "storefront_products",
  "orders",
  "order_items",
  "order_events",
  "cards",
  "card_batches",
  "card_logs",
] as const;

/** runtime 除交易库存外，还保留账本与营销（仅清日志/瞬态）。 */
const CLEAR_BUSINESS_DATA_WALLET_MARKETING_RESERVED = [
  "user_balances",
  "balance_transactions",
  "balance_recharge_orders",
  "voucher_codes",
  "campaigns",
  "referral_codes",
  "referral_events",
  "coupons",
] as const;

const CLEAR_BUSINESS_DATA_RESERVED_BY_PROFILE: Record<ClearBusinessDataProfile, readonly string[]> = {
  runtime: [
    ...CLEAR_BUSINESS_DATA_BASE_RESERVED,
    ...CLEAR_BUSINESS_DATA_TRADE_RESERVED,
    ...CLEAR_BUSINESS_DATA_WALLET_MARKETING_RESERVED,
  ],
  keep_trade: [
    ...CLEAR_BUSINESS_DATA_BASE_RESERVED,
    ...CLEAR_BUSINESS_DATA_TRADE_RESERVED,
  ],
  keep_catalog: [
    ...CLEAR_BUSINESS_DATA_BASE_RESERVED,
    "products",
    "storefronts",
    "storefront_products",
  ],
  // storefronts 故意保留（历史行为 + 渠道定义属配置侧）；full 仍清商品与映射。
  full: [...CLEAR_BUSINESS_DATA_BASE_RESERVED, "storefronts"],
};

export type ClearBusinessDataOptions = {
  /** 默认 full，兼容旧调用与运维脚本语义 */
  profile?: ClearBusinessDataProfile;
};

/**
 * 按档位清空验收/运维数据，始终保留配置与系统参数。
 *
 * 安全边界：
 * - 不提供「清订单但原样保留 issued 卡密」——keep_catalog / full 清交易时卡密策略固定为 clear_all（S1）。
 * - keep_trade 保留订单与卡密，只清账本/营销/运行态，cardStrategy=none。
 * - 不删除 storefronts（full 档亦然，与历史行为一致；keep_catalog/keep_trade 保留渠道与商品映射，full 显式清映射后再清商品）。
 * - 清除旧 admin_audit_logs，只写回本次清理凭证。
 * - 同步清理 rate_limit_windows / idempotency_keys，避免清库后被旧幂等/限流污染。
 */
export async function clearBusinessDataPreservingConfig(
  db: DbType,
  ipHash: string,
  options: ClearBusinessDataOptions = {},
): Promise<ClearBusinessDataResult> {
  const profile: ClearBusinessDataProfile = options.profile ?? "full";
  if (
    profile !== "runtime"
    && profile !== "keep_trade"
    && profile !== "keep_catalog"
    && profile !== "full"
  ) {
    throw new Error("不支持的数据清理档位");
  }

  const reservedTables = [...CLEAR_BUSINESS_DATA_RESERVED_BY_PROFILE[profile]];
  // 仅在会删除订单/卡密的档位使用 clear_all；runtime / keep_trade 不动库存与订单。
  const cardStrategy: ClearBusinessDataResult["cardStrategy"] =
    profile === "keep_catalog" || profile === "full" ? "clear_all" : "none";
  const clearWalletAndMarketing = profile === "keep_trade" || profile === "keep_catalog" || profile === "full";
  const clearTradeAndInventory = profile === "keep_catalog" || profile === "full";
  const clearCatalogProducts = profile === "full";

  return withDbTransaction(db, async (tx) => {
    const tables: Record<string, number> = {};
    const recordDelete = (table: string, result: { rowsAffected?: number | null }) => {
      tables[table] = result.rowsAffected ?? 0;
    };

    // 交易 / 库存：仅 keep_catalog 与 full。
    // 删除顺序：先子表与引用，再订单与卡密，保证不留下 issued 卡指向已删订单。
    if (clearTradeAndInventory) {
      recordDelete("order_items", await tx.delete(orderItems));
      recordDelete("order_events", await tx.delete(orderEvents));
      recordDelete("card_logs", await tx.delete(cardLogs));
      recordDelete("orders", await tx.delete(orders));
      // S1：与订单一并清空全部卡密与批次，禁止留下悬空 issued/locked 引用。
      recordDelete("cards", await tx.delete(cards));
      recordDelete("card_batches", await tx.delete(cardBatches));
    }

    // 账本 / 营销：keep_trade 及以上。keep_trade 不清订单与卡密，避免对账链路断裂。
    if (clearWalletAndMarketing) {
      recordDelete("referral_events", await tx.delete(referralEvents));
      recordDelete("balance_transactions", await tx.delete(balanceTransactions));
      recordDelete("balance_recharge_orders", await tx.delete(balanceRechargeOrders));
      recordDelete("user_balances", await tx.delete(userBalances));
      recordDelete("voucher_codes", await tx.delete(voucherCodes));
      recordDelete("campaigns", await tx.delete(campaigns));
      recordDelete("referral_codes", await tx.delete(referralCodes));
      recordDelete("coupons", await tx.delete(coupons));
    }

    if (clearCatalogProducts) {
      // full 才删商品。渠道定义 storefronts 始终保留。
      // 映射必须显式 DELETE：SQLite/libSQL 连接默认不一定开启 foreign_keys，不能依赖 ON DELETE CASCADE。
      // 尚未应用 0011 的库没有 storefront_products：Drizzle 会把 SQLITE_ERROR 包一层 “Failed query”，需沿 cause 链识别。
      try {
        recordDelete("storefront_products", await tx.delete(storefrontProducts));
      } catch (error) {
        const chain: string[] = [];
        for (let current: unknown = error; current; current = (current as { cause?: unknown }).cause) {
          chain.push(current instanceof Error ? current.message : String(current));
          if (chain.length > 6) break;
        }
        if (!/no such table/i.test(chain.join("\n"))) throw error;
      }
      recordDelete("products", await tx.delete(products));
    }

    // 各档均清理日志与瞬态状态，并轮转审计凭证。
    recordDelete("request_logs", await tx.delete(requestLogs));
    recordDelete("email_logs", await tx.delete(emailLogs));
    recordDelete("rate_limit_windows", await tx.delete(rateLimitWindows));
    recordDelete("idempotency_keys", await tx.delete(idempotencyKeys));
    recordDelete("admin_audit_logs", await tx.delete(adminAuditLogs));

    const deleted = Object.values(tables).reduce((sum, value) => sum + value, 0);
    const retainedAuditId = crypto.randomUUID();
    await tx.insert(adminAuditLogs).values({
      id: retainedAuditId,
      action: "clear_business_data",
      targetType: "database",
      targetId: profile,
      metadataJson: JSON.stringify({
        profile,
        cardStrategy,
        deleted,
        tables,
        reservedTables,
      }),
      ipHash,
      createdAt: new Date().toISOString(),
    });

    return {
      deleted,
      tables,
      reservedTables,
      retainedAuditId,
      profile,
      cardStrategy,
    };
  });
}

// ── Phase 3: 运营效率工具 ──────────────────────────────

// ── G29: 今日待处理聚合 ──────────────────────────────

export type TodayPendingTasks = {
  pendingOfflinePayments: Record<string, unknown>[];
  paidButNotIssued: Record<string, unknown>[];
  lowStockProducts: LowStockProduct[];
};

export async function getTodayPendingTasks(
  db: DbType,
): Promise<TodayPendingTasks> {
  // 运营待办不能只看「今日创建」：跨日未确认的线下款、已付未发都必须露出。
  // 列表上限 50，前端对满额显示「50+」，避免把截断当成真实 0/精确计数。
  // 1. 待确认线下付款：pending + offline（任意创建日）
  const pendingOfflinePayments = await db
    .select(orderSelectFields)
    .from(orders)
    .leftJoin(products, eq(products.id, orders.productId))
    .leftJoin(cards, eq(cards.id, orders.issuedCardId))
    .where(and(
      eq(orders.status, "pending"),
      eq(orders.paymentMethod, "offline"),
    ))
    .orderBy(desc(orders.createdAt))
    .limit(50);

  // 2. 已付未发：status=paid（尚未 issued/履约完成）
  const paidButNotIssued = await db
    .select(orderSelectFields)
    .from(orders)
    .leftJoin(products, eq(products.id, orders.productId))
    .leftJoin(cards, eq(cards.id, orders.issuedCardId))
    .where(eq(orders.status, "paid"))
    .orderBy(desc(orders.createdAt))
    .limit(50);

  // 3. 低库存（复用已有函数；与 summary.lowStockCount 同源）
  const lowStockProducts = await getLowStockProducts(db);

  return {
    pendingOfflinePayments: pendingOfflinePayments as unknown as Record<string, unknown>[],
    paidButNotIssued: paidButNotIssued as unknown as Record<string, unknown>[],
    lowStockProducts,
  };
}

// ── G30: 更新卡密批次 ──────────────────────────────

export async function updateCardBatch(
  db: DbType,
  id: string,
  input: { name?: string; source?: string; costPriceCents?: number | null; note?: string | null },
): Promise<{ id: string } | null> {
  const [batch] = await db
    .select({ id: cardBatches.id })
    .from(cardBatches)
    .where(eq(cardBatches.id, id))
    .limit(1);
  if (!batch) return null;

  const setValues: Record<string, unknown> = {};
  if (input.name !== undefined) setValues["name"] = input.name.trim();
  if (input.source !== undefined) setValues["source"] = input.source.trim();
  if (input.costPriceCents !== undefined) setValues["costPriceCents"] = input.costPriceCents;
  if (input.note !== undefined) setValues["note"] = input.note?.trim() || "";

  if (Object.keys(setValues).length > 0) {
    await db.update(cardBatches).set(setValues).where(eq(cardBatches.id, id));
  }
  return { id };
}

// ── G31: 重发订单邮件 ──────────────────────────────

export async function resendOrderEmail(
  db: DbType,
  env: { resendApiKey: string; emailFrom: string },
  orderId: string,
): Promise<{ ok: boolean; message: string }> {
  const [order] = await db
    .select({
      id: orders.id,
      orderNo: orders.orderNo,
      buyerEmail: orders.buyerEmail,
      status: orders.status,
      productTitle: products.title,
      fulfillmentMode: orders.fulfillmentMode,
      productFulfillmentMode: products.fulfillmentMode,
      deliveryJson: orders.deliveryJson,
    })
    .from(orders)
    .innerJoin(products, eq(products.id, orders.productId))
    .where(eq(orders.id, orderId))
    .limit(1);

  if (!order) {
    return { ok: false, message: "订单不存在" };
  }

  if (order.status !== "issued") {
    return { ok: false, message: "订单尚未完成交付，不能重发交付邮件" };
  }

  if (!order.buyerEmail) {
    return { ok: false, message: "订单没有买家邮箱，无法发送邮件" };
  }

  const [snapshotItems, issuedCards] = await Promise.all([
    db
      .select({ fulfillmentMode: orderItems.fulfillmentMode })
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId))
      .limit(1),
    db
      .select({
        accountLabel: cards.accountLabel,
        deliverySecret: cards.deliverySecret,
        deliveryNote: cards.deliveryNote,
      })
      .from(cards)
      .where(eq(cards.issuedOrderId, orderId))
      .orderBy(asc(cards.issuedAt), asc(cards.id)),
  ]);
  const fulfillmentMode = snapshotItems[0]?.fulfillmentMode || order.fulfillmentMode || order.productFulfillmentMode || "card";
  if (!(FULFILLMENT_MODES as readonly string[]).includes(fulfillmentMode)) {
    return { ok: false, message: "订单履约模式快照异常，请联系管理员" };
  }
  const deliverableCards = issuedCards.filter((item) => Boolean(item.accountLabel || item.deliverySecret || item.deliveryNote));

  if (fulfillmentMode === "card" && deliverableCards.length === 0) {
    return { ok: false, message: "订单没有可交付内容" };
  }
  if (fulfillmentMode !== "card" && !order.deliveryJson) {
    return { ok: false, message: "订单没有可交付内容" };
  }

  let delivery: { accountLabel?: string; deliverySecret?: string; deliveryNote?: string } | null = null;
  if (order.deliveryJson) {
    try {
      delivery = JSON.parse(order.deliveryJson) as { accountLabel?: string; deliverySecret?: string; deliveryNote?: string };
    } catch {
      return { ok: false, message: "订单交付内容格式异常" };
    }
  }

  const emailResult = await sendEmail(db, env, {
    to: order.buyerEmail,
    template: "order_issued",
    templateData: {
      orderNo: order.orderNo || order.id.slice(0, 8),
      productTitle: order.productTitle,
      productName: order.productTitle,
      ...(fulfillmentMode === "card"
        ? buildIssuedDeliveryTemplateData(deliverableCards)
        : buildIssuedDeliveryTemplateData([{
          accountLabel: delivery?.accountLabel || order.productTitle,
          deliverySecret: delivery?.deliverySecret || "",
          deliveryNote: delivery?.deliveryNote || "",
        }])),
    },
  });

  if (!emailResult.ok) {
    return { ok: false, message: `邮件发送失败：${emailResult.message}` };
  }

  return { ok: true, message: "邮件已发送" };
}

// ── G32: 订单补偿备注 ──────────────────────────────

export async function addOrderCompensationNote(
  db: DbType,
  orderId: string,
  note: string,
): Promise<{ ok: boolean; message: string }> {
  if (!note.trim()) {
    return { ok: false, message: "备注内容不能为空" };
  }

  const [order] = await db
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!order) {
    return { ok: false, message: "订单不存在" };
  }

  // 写入订单事件作为补偿记录
  await db.insert(orderEvents).values({
    id: crypto.randomUUID(),
    orderId,
    type: "compensation_note",
    message: note.trim(),
    metadataJson: JSON.stringify({ operator: "admin", createdAt: new Date().toISOString() }),
    createdAt: new Date().toISOString(),
  });

  return { ok: true, message: "备注已添加" };
}

/**
 * 仅当订单在写入瞬间仍处于 paid 时追加人工履约进度。
 * 单条 INSERT ... SELECT 避免“先查 paid、并发发卡、再写处理中事件”的竞态；
 * 阶段和供应商单号写入机器可读的 metadata_json，人工备注只保留在 message。
 */
export async function recordPaidOrderFulfillmentProgress(
  db: DbType,
  orderId: string,
  message: string,
  metadata: FulfillmentProgressMetadata,
): Promise<"recorded" | "not_found" | "status_conflict"> {
  const now = new Date().toISOString();
  const eventType = fulfillmentProgressEventType(metadata.stage);
  const metadataJson = JSON.stringify(metadata);
  const result = await db.run(sql`
    INSERT INTO order_events (id, order_id, type, message, metadata_json, created_at)
    SELECT ${crypto.randomUUID()}, ${orderId}, ${eventType}, ${message}, ${metadataJson}, ${now}
    FROM orders
    WHERE id = ${orderId} AND status = 'paid'
  `);
  if (Number(result.rowsAffected ?? 0) === 1) return "recorded";

  const statusResult = await db.run(sql`
    SELECT status FROM orders WHERE id = ${orderId} LIMIT 1
  `);
  return statusResult.rows.length === 0 ? "not_found" : "status_conflict";
}

// ── G33: 低库存预警邮件去重 ──────────────────────────

export async function sendLowStockWarningEmailWithDedup(
  db: DbType,
  env: { resendApiKey: string; emailFrom: string },
  products: LowStockProduct[],
  threshold: number,
  ipHash = "",
): Promise<{ ok: boolean; message: string; sent: boolean; count: number }> {
  const emailTo = (await readSystemConfigMap(db, ["inventory_warning_email_to"])).inventory_warning_email_to;
  if (!emailTo) {
    return { ok: false, message: "未配置库存预警通知邮箱", sent: false, count: 0 };
  }

  // 24h 去重：检查近期是否已发送过相同商品的预警
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const recentLogs = await db
    .select({ targetId: adminAuditLogs.targetId })
    .from(adminAuditLogs)
    .where(and(
      eq(adminAuditLogs.action, "low_stock_notify"),
      sql`${adminAuditLogs.createdAt} >= ${oneDayAgo}`,
    ))
    .limit(100);

  // 解析 targetId 获取已发送的商品 ID 列表
  const notifiedProductIds = new Set<string>();
  for (const log of recentLogs) {
    try {
      const metadata = JSON.parse(log.targetId || "{}");
      if (metadata.productIds && Array.isArray(metadata.productIds)) {
        metadata.productIds.forEach((pid: string) => notifiedProductIds.add(pid));
      }
    } catch {
      // 忽略无法解析的日志
    }
  }

  // 过滤掉 24h 内已通知的商品
  const newProducts = products.filter((p) => !notifiedProductIds.has(p.id));
  if (newProducts.length === 0) {
    return { ok: true, message: "所有低库存商品 24h 内已通知过，跳过", sent: false, count: 0 };
  }

  const result = await sendLowStockWarningEmail(db, env, newProducts, threshold);

  // 记录已发送的商品 ID，用于后续去重
  const notifiedIds = newProducts.map((p) => p.id);
  await writeAdminAudit(db, {
    action: "low_stock_notify",
    targetType: "low_stock",
    targetId: JSON.stringify({ productIds: notifiedIds }),
    metadata: { ok: result.ok, message: result.message, count: newProducts.length, dedup: true },
    ipHash,
  });

  return { ok: result.ok, message: result.message, sent: result.ok, count: newProducts.length };
}

// ── G34: 批量生成通用卡密 ──────────────────────────

/**
 * 批量生成通用卡密（"一卡一密无限次"场景）。
 *
 * 业务背景：
 *   - 某些活动场景下，同一张卡密需要被多个买家重复使用（如激活码、兑换码）。
 *   - 传统 cards 表要求 delivery_secret 唯一，无法直接表达"一个卡密无限次"。
 *   - 本函数通过批量生成多行 available 卡密，并将统一卡密内容写入 delivery_note，
 *     实现"多行库存、同一交付内容"的效果。
 *
 * 实现要点：
 *   - delivery_secret 留空，绕过唯一索引 idx_cards_product_delivery_secret_unique；
 *   - delivery_note 存放统一卡密内容，用户下单后返回的 deliveryNote 即为该值；
 *   - account_label 使用自动编号（card-001 ~ card-N），用于后台区分不同行；
 *   - 每行仍然是独立卡密，拥有独立 id 和生命周期，不影响现有原子发卡逻辑。
 */
export async function generateGenericCards(
  db: DbType,
  input: {
    productId: string;
    count: number;
    genericCode: string;
    batchName: string;
    expiresAt?: string | null;
  }
): Promise<{ batchId: string; generated: number }> {
  // 检查商品是否存在
  const [product] = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.id, input.productId))
    .limit(1);
  if (!product) {
    throw new Error("商品不存在");
  }

  const batchId = crypto.randomUUID();
  const now = new Date().toISOString();
  const cardRows: { id: string; accountLabel: string; deliverySecret: string; deliveryNote: string; expiresAt?: string }[] = [];

  // 批量生成卡密行：accountLabel 为 card-001 ~ card-N，deliverySecret 留空，deliveryNote 存放统一卡密内容
  for (let i = 0; i < input.count; i++) {
    const seq = String(i + 1).padStart(3, "0");
    cardRows.push({
      id: crypto.randomUUID(),
      accountLabel: `card-${seq}`,
      deliverySecret: "", // 留空以绕过 delivery_secret 唯一索引
      deliveryNote: input.genericCode,
      expiresAt: input.expiresAt || undefined,
    });
  }

  await withDbTransaction(db, async (tx) => {
    // 批次和库存行是一个不可拆分的业务事实，必须同事务提交。
    await tx.insert(cardBatches).values({
      id: batchId,
      productId: input.productId,
      name: input.batchName,
      source: "generated",
      totalCount: cardRows.length,
      createdAt: now,
    });

    await tx.insert(cards).values(
      cardRows.map((row) => ({
        id: row.id,
        productId: input.productId,
        batchId,
        accountLabel: row.accountLabel,
        deliverySecret: row.deliverySecret,
        deliveryNote: row.deliveryNote,
        expiresAt: row.expiresAt,
        status: "available" as const,
        createdAt: now,
      }))
    );
  });

  return { batchId, generated: cardRows.length };
}
