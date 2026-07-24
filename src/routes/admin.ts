import { Hono, type Context } from "hono";
import { z } from "zod";
import { FULFILLMENT_MODES, type AppEnv } from "../bindings";
import { FULFILLMENT_INPUT_TYPES } from "../../shared/fulfillment-input";
import {
  DELIVERY_VISIBILITIES,
  STOCK_DISPLAY_MODES,
  normalizeOriginalPriceCents,
  validateOriginalPriceCents,
} from "../../shared/product-contract";
import {
  FULFILLMENT_PROGRESS_STAGES,
  fulfillmentProgressStageLabel,
  type FulfillmentProgressMetadata,
} from "../../shared/fulfillment-progress";
import { fail, maskContact, ok, getDb, safeJsonBody } from "../lib/http";
import { and, eq, inArray, sql } from "drizzle-orm";
import { cards, coupons } from "../db/schema";
import { getIpHash } from "../lib/security";
import { enforceRateLimit } from "../lib/rate-limit";
import { writeAdminAudit } from "../services/audit-service";
import { markPaidAndIssue } from "../services/order-service";
import { cleanupExpiredOrders } from "../services/cleanup-service";
import { verifyJwt } from "@usethink/cf-core/auth/jwt";
import { constantTimeEqual } from "@usethink/cf-core/security";
import {
  getAdminSummary,
  getDailyIncomeTrend,
  getOrderList,
  batchDeleteOrders,
  exportOrders,
  exportFinance,
  getOrderDetail,
  importCards,
  getCardList,
  generateGenericCards,
  updateCardStatus,
  getBatchList,
  getCouponList,
  getAdminProducts,
  getAdminProductCategories,
  createProductCategory,
  updateProductCategory,
  deleteProductCategory,
  checkProductExists,
  getProductCommerceState,
  createProduct,
  duplicateProduct,
  updateProduct,
  upsertCoupon,
  generateCoupon,
  updateCoupon,
  getMergedLogs,
  createCouponCode,
  getLowStockProducts,
  batchDisableCards,
  batchDeleteCards,
  cancelOrder,
  getEmailLogList,
  batchDeleteEmailLogs,
  batchDeleteMergedLogs,
  clearAllMergedLogs,
  getCampaignList,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  getReferralCodeList,
  createReferralCode,
  updateReferralCode,
  deleteReferralCode,
  updateCard,
  deleteProduct,
  deleteCoupon,
  getTodayPendingTasks,
  updateCardBatch,
  resendOrderEmail,
  addOrderCompensationNote,
  recordPaidOrderFulfillmentProgress,
  sendLowStockWarningEmailWithDedup,
  CreateProductInput,
  UpdateProductInput,
  CreateCouponInput,
  UpdateCouponInput,
  ProductFilter,
  ProductListResult,
  ProductStorefrontAssignmentError,
} from "../services/admin-service";
import { adminPaymentRoute } from "./admin-payment";
import { mergeRuntimeConfig, readRuntimeConfig } from "../lib/runtime-config";
import { readSystemConfigMap } from "../lib/system-config-registry";
import { adminSystemConfigRoute } from "./admin-system-config";
import { adminVoucherRoute } from "./admin-vouchers";
import { insertProductSchema, insertCouponSchema } from "../db/schema";
import { optionalProductIdSchema, productIdSchema } from "../lib/product-id";
import { CURRENCY_CODES } from "../../shared/money";
import { adminStorefrontRoute } from "./admin-storefronts";
import { adminMediaRoute } from "./media";

export const adminRoute = new Hono<AppEnv>();

// 登录页只需要验证 ADMIN_TOKEN，不应借用 summary 等依赖数据库和业务聚合的接口。
// 该端点由 index.ts 中的 requireAdmin 统一保护；能进入处理器即代表令牌有效。
adminRoute.get("/session", (c) => {
  c.header("Cache-Control", "no-store");
  return ok(c, {});
});

function queryInt(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function optionalQueryInt(value: string | undefined, min: number, max: number) {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

async function lowStockThreshold(db: ReturnType<typeof getDb>, threshold?: number) {
  if (threshold) return threshold;
  const config = await readSystemConfigMap(db, ["inventory_warning_threshold"]);
  const parsed = Number(config.inventory_warning_threshold);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 5;
}

// ── 公开的 admin 路由（不受 requireAdmin 中间件保护）──
// JWT 验证端点：用于 TG Bot 登录链接，此时用户尚无 ADMIN_TOKEN
export const adminPublicRoute = new Hono<AppEnv>();

adminPublicRoute.post("/verify-jwt", async (c) => {
  c.header("Cache-Control", "no-store");
  const limit = await enforceRateLimit(c, "admin_verify_jwt", 5);
  if (!limit.ok) return fail(c, limit.message || "请求过于频繁", limit.status || 429);
  const parsed = z.object({ jwt: z.string().trim().min(1).max(4096) }).safeParse(await safeJsonBody(c));
  if (!parsed.success) return fail(c, "缺少或无效的 jwt 参数", 400);

  // 签名密钥与数据库 Token、Bot Token 严格隔离；任何降级复用都会扩大单个凭据泄漏的影响面。
  const secret = c.env.JWT_SECRET || "";
  if (!secret) return fail(c, "JWT 密钥未配置", 503);
  if (!c.env.TG_OWNER_ID) return fail(c, "TG_OWNER_ID 未配置", 503);
  if (!c.env.ADMIN_TOKEN) return fail(c, "ADMIN_TOKEN 未配置", 503);

  const payload = await verifyJwt(parsed.data.jwt, secret);
  if (!payload) return fail(c, "JWT 验证失败或已过期", 401);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(payload.exp) || payload.exp <= now) return fail(c, "JWT 验证失败或已过期", 401);
  if (!constantTimeEqual(payload.sub, String(c.env.TG_OWNER_ID))) return fail(c, "仅 Telegram 管理员可登录", 403);

  // 验证通过，返回 ADMIN_TOKEN 供前端使用
  // 前端收到后存入 localStorage，后续请求使用 Bearer Token
  return ok(c, { adminToken: c.env.ADMIN_TOKEN });
});

// 管理端：每个 IP 每子路由每分钟最多 10 次，防止单路由被耗尽
// 注意：不同子路由用不同 key，避免互相挤占限额
adminRoute.use('*', async (c, next) => {
  const action = `admin:${new URL(c.req.url).pathname}`;
  const limit = await enforceRateLimit(c, action, 10);
  if (!limit.ok) return fail(c, '请求过于频繁', 429);
  await next();
});

// 管理端第一版只做固定 token，不引入用户系统。
// 目标是让个人开发者能低成本维护订单、商品和卡密，同时通过 WAF/ADMIN_TOKEN/审计日志形成基础闭环。
const importCardsSchema = z.object({
  productId: productIdSchema,
  batchName: z.string().trim().min(1).max(120),
  cards: z.array(z.object({
    accountLabel: z.string().trim().min(1).max(160),
    deliverySecret: z.string().trim().min(1).max(2000),
    deliveryNote: z.string().trim().max(1000).optional().or(z.literal("")),
    expiresAt: z.string().trim().max(40).optional().or(z.literal(""))
  })).min(1).max(200)
});

// 商品封面当前使用外部 HTTPS 地址或未来媒体路由的站内相对地址。
// 不接受 javascript/data 等协议，避免把后台输入直接变成不受控的资源加载入口；
// R2 接入后只需让媒体路由返回相对地址，不需要再次修改商品表结构。
const productCoverUrlSchema = z.string().trim().max(500).refine((value) => {
  if (!value) return true;
  if (value.startsWith('/') && !value.startsWith('//')) return true;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}, '商品图片必须使用 HTTPS URL 或站内相对地址');

// 基于 drizzle-zod 自动生成的 insert schema，在此基础上 extend 添加业务校验。
// schema 与 DB 表结构永远同步，新增/删除字段时无需修改此处。
const purchaseLimitSchema = z.preprocess((value) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : value;
  }
  if (typeof value === "number" && value === 0) return null;
  return value;
}, z.number().int().min(1).max(99999).nullable()).optional();

const productSchema = insertProductSchema.extend({
  id: productIdSchema.optional(),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).default(""),
  salesCopy: z.string().trim().max(2000).default(""),
  coverUrl: productCoverUrlSchema.default(""),
  tagsJson: z.string().trim().max(2000).default("[]"),
  priceCents: z.number().int().min(0).max(999999),
  // 货架对比价：null/省略 = 无促销；0 与空一并规范为 null；有效时必须 > priceCents
  originalPriceCents: z.preprocess(
    (value) => {
      if (value === undefined) return undefined;
      return normalizeOriginalPriceCents(value);
    },
    z.number().int().min(1).max(999999).nullable().optional(),
  ),
  currency: z.preprocess(
    (value) => typeof value === "string" ? value.trim().toUpperCase() : value,
    z.enum(CURRENCY_CODES),
  ).default("CNY"),
  issueMode: z.enum(["direct", "manual"]).default("manual"),
  fulfillmentMode: z.enum(FULFILLMENT_MODES).default("card"),
  active: z.boolean().default(true),
  category: z.string().trim().max(40).default(""),
  sortOrder: z.number().int().min(0).max(99999).default(100),
  purchaseLimit: purchaseLimitSchema,
  purchaseLimitDisplay: z.boolean().default(false),
  deliveryVisibility: z.enum(DELIVERY_VISIBILITIES).default("web_and_email"),
  stockDisplayMode: z.enum(STOCK_DISPLAY_MODES).default("exact"),
  fulfillmentInputType: z.enum(FULFILLMENT_INPUT_TYPES).default("none"),
  fulfillmentInputLabel: z.string().trim().max(80).default(""),
  fulfillmentInputHint: z.string().trim().max(200).default(""),
  fulfillmentInputRequired: z.boolean().default(false),
});
// 注意：不要在 productSchema 上 superRefine——ZodEffects 无法 .extend()/.partial()。
// 创建：createProductSchema 交叉校验；PATCH：路由结合库内 price/original 校验。

const createProductSchema = productSchema.extend({
  // 省略时由服务层绑定当前默认渠道；显式 [] 表示创建未分配草稿。
  storefrontIds: z.array(z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_-]+$/)).max(100).optional(),
}).superRefine((value, ctx) => {
  const storefrontIds = (value as { storefrontIds?: unknown }).storefrontIds;
  if (Array.isArray(storefrontIds) && new Set(storefrontIds).size !== storefrontIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["storefrontIds"], message: "展示渠道不能重复" });
  }
  // 创建时 priceCents 必填；有对比价则必须严格高于现价
  // insertProductSchema 扩展后 superRefine 入参类型偏宽，显式收窄
  const priceCents = Number(value.priceCents);
  const originalPriceCents = value.originalPriceCents as number | null | undefined;
  if (originalPriceCents != null && Number.isFinite(priceCents)) {
    const err = validateOriginalPriceCents(priceCents, originalPriceCents);
    if (err) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["originalPriceCents"], message: err });
    }
  }
});

const orderAttributionQuerySchema = z.object({
  orderSource: z.enum(["storefront", "coupon_redeem", "telegram"]).or(z.literal("")),
  storefrontId: z.string().trim().max(120).regex(/^[A-Za-z0-9_-]+$/).or(z.literal("")),
}).strict();

function parseOrderAttributionQuery(c: Context<AppEnv>) {
  return orderAttributionQuerySchema.safeParse({
    orderSource: c.req.query("orderSource") || "",
    storefrontId: c.req.query("storefrontId") || "",
  });
}

const productCategorySchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9_\-\u4e00-\u9fa5]{1,80}$/).optional(),
  name: z.string().trim().min(1).max(40),
  sortOrder: z.number().int().min(0).max(99999).default(100),
  active: z.boolean().default(true),
});

const couponSchema = insertCouponSchema.extend({
  productId: optionalProductIdSchema,
  code: z.string().trim().min(2).max(40).optional().or(z.literal("")),
  discountType: z.enum(["fixed", "percent"]),
  discountValue: z.number().int().min(1).max(100000),
  maxUses: z.number().int().min(0).max(100000).default(0),
  active: z.boolean().default(true),
  expiresAt: z.string().trim().max(40).optional().or(z.literal(""))
});

const generateCouponSchema = z.object({
  productId: productIdSchema,
  prefix: z.string().trim().max(12).optional().or(z.literal("")),
  discountType: z.enum(["fixed", "percent"]).default("fixed"),
  discountValue: z.number().int().min(1).max(100000, "折扣值至少为 1"),
  maxUses: z.number().int().min(0).max(100000).default(0),
  active: z.boolean().default(true),
  expiresAt: z.string().trim().max(40).optional().or(z.literal("")),
  count: z.number().int().min(1).max(50).default(1)
});

// ── 控制台概览 ──

adminRoute.get("/summary", async (c) => {
  try {
    const db = getDb(c);
    const summary = await getAdminSummary(db);
    // 近7日收入趋势（对标 TGPays dashboard.php 的 ECharts 图表）
    const dailyIncome = await getDailyIncomeTrend(db);
    return ok(c, { summary, dailyIncome });
  } catch (err) {
    console.error("[admin/summary]", (err as Error)?.constructor?.name, (err as Error)?.message, (err as Error)?.stack);
    throw err;
  }
});

// ── 订单管理 ──

adminRoute.get("/orders", async (c) => {
  const attribution = parseOrderAttributionQuery(c);
  if (!attribution.success) return fail(c, "订单归属筛选参数无效", 400, attribution.error.flatten());
  const statusParam = c.req.query("status") || "";
  const status = statusParam.includes(",") ? statusParam.split(",").map((item) => item.trim()).filter(Boolean) : statusParam;
  const productId = c.req.query("productId") || "";
  const q = c.req.query("q") || "";
  const buyerContact = c.req.query("buyerContact") || "";
  const paymentMethod = c.req.query("paymentMethod") || "";
  const page = queryInt(c.req.query("page"), 1, 1, 100000);
  const limit = queryInt(c.req.query("limit"), 20, 1, 100);

  const { total, orders } = await getOrderList(getDb(c), {
    status, productId, q, buyerContact, paymentMethod,
    orderSource: attribution.data.orderSource,
    storefrontId: attribution.data.storefrontId,
    page, limit
  });

  return ok(c, {
    total,
    orders: orders.map((row) => ({
      ...row,
      buyerContact: maskContact(String(row.buyerContact || "")),
      buyerEmail: row.buyerEmail ? maskContact(String(row.buyerEmail)) : ""
    }))
  });
});

adminRoute.post("/orders/batch-delete", async (c) => {
  const body = z.object({
    ids: z.array(z.string().trim().min(1).max(120)).min(1).max(200),
    // 两个开关默认 false，与历史安全删除一致；UI 勾选后才 true。
    force: z.boolean().optional().default(false),
    unlinkRefs: z.boolean().optional().default(false),
  }).safeParse(await safeJsonBody(c));
  if (!body.success) return fail(c, "请求参数无效", 400, body.error.flatten());

  const db = getDb(c);
  const { force, unlinkRefs } = body.data;
  const result = await batchDeleteOrders(db, body.data.ids, { force, unlinkRefs });
  if (result.blocked > 0) {
    // 文案只提示当前未开启的开关，避免 force=true 仍提示「非终态」造成误导。
    const hints: string[] = [];
    if (!force) hints.push("勾选「全部删除」以包含非失败/取消/关闭/过期订单");
    if (!unlinkRefs) hints.push("勾选「解绑卡密引用」以处理仍挂着卡密的订单");
    const hintText = hints.length > 0 ? `。${hints.join("；")}` : "";
    return fail(
      c,
      `包含 ${result.blocked} 个不可删除订单（受状态或卡密引用保护）${hintText}`,
      409,
    );
  }

  await writeAdminAudit(db, {
    action: "batch_delete_orders",
    targetType: "order",
    targetId: "",
    metadata: {
      requested: body.data.ids.length,
      deleted: result.deleted,
      force,
      unlinkRefs,
    },
    ipHash: await getIpHash(c),
  });
  return ok(c, result);
});

adminRoute.get("/orders/export", async (c) => {
  const attribution = parseOrderAttributionQuery(c);
  if (!attribution.success) return fail(c, "订单归属筛选参数无效", 400, attribution.error.flatten());
  const statusParam = c.req.query("status") || "";
  const status = statusParam.includes(",") ? statusParam.split(",").map((item) => item.trim()).filter(Boolean) : statusParam;
  const productId = c.req.query("productId") || "";
  const q = c.req.query("q") || "";
  const paymentMethod = c.req.query("paymentMethod") || "";
  const format = c.req.query("format") || "csv";
  const cursor = c.req.query("cursor") || "";
  const limit = queryInt(c.req.query("limit"), 1000, 1, 5000);

  const { rows, nextCursor, hasMore } = await exportOrders(getDb(c), {
    status, productId, q, paymentMethod,
    orderSource: attribution.data.orderSource,
    storefrontId: attribution.data.storefrontId,
    cursor, limit
  });

  await writeAdminAudit(getDb(c), {
    action: "export_orders",
    targetType: "order",
    targetId: "",
    metadata: { status, productId, paymentMethod, ...attribution.data, format, count: rows.length, hasMore },
    ipHash: await getIpHash(c)
  });

  if (format === "json") {
    return ok(c, { orders: rows, nextCursor, hasMore });
  }

  // CSV format
  // 防止 CSV 公式注入：以 =, +, -, @, TAB, 换行 开头的值会被 Excel 解析为公式，
  // 前置制表符 \t 可安全中和（Excel 会将其视为文本，不影响内容）。
  const safeCsv = (v: string) => {
    const c = v[0];
    if (c && ("=+-@\t\n".includes(c))) return `\t"${v.replace(/"/g, '""')}"`;
    return `"${v.replace(/"/g, '""')}"`;
  };
  const csvHeaders = ["orderNo", "productTitle", "orderSource", "storefrontId", "storefrontNameSnapshot", "storefrontSlugSnapshot", "buyerContact", "buyerEmail", "amountCents", "discountCents", "currency", "status", "paymentProvider", "paymentMethod", "batchId", "accountLabel", "deliveryNote", "createdAt", "paidAt", "issuedAt"];
  const csvRows = rows.map((row) => [
    safeCsv(String(row.orderNo || "")),
    safeCsv(String(row.productTitle || "")),
    safeCsv(String(row.orderSource || "")),
    safeCsv(String(row.storefrontId || "")),
    safeCsv(String(row.storefrontNameSnapshot || "")),
    safeCsv(String(row.storefrontSlugSnapshot || "")),
    safeCsv(maskContact(String(row.buyerContact || ""))),
    safeCsv(row.buyerEmail ? maskContact(String(row.buyerEmail)) : ""),
    safeCsv(String(row.amountCents ?? "")),
    safeCsv(String(row.discountCents ?? "")),
    safeCsv(String(row.currency || "")),
    safeCsv(String(row.status || "")),
    safeCsv(String(row.paymentProvider || "")),
    safeCsv(String(row.paymentMethod || "")),
    safeCsv(String(row.batchId || "")),
    safeCsv(String(row.accountLabel || "")),
    safeCsv(String(row.deliveryNote || "")),
    safeCsv(String(row.createdAt || "")),
    safeCsv(String(row.paidAt || "")),
    safeCsv(String(row.issuedAt || ""))
  ]);

  const csvContent = "\uFEFF" + [
    csvHeaders.join(","),
    ...csvRows.map((r) => r.join(","))
  ].join("\n");

  const responseHeaders = new Headers({
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="orders-${Date.now()}.csv"`,
  });
  if (nextCursor) {
    responseHeaders.set("X-Next-Cursor", nextCursor);
    responseHeaders.set("X-Has-More", "true");
  }
  return new Response(csvContent, { status: 200, headers: responseHeaders });
});

// ── 财务对账导出 ──

adminRoute.get("/finance/export", async (c) => {
  const attribution = parseOrderAttributionQuery(c);
  if (!attribution.success) return fail(c, "订单归属筛选参数无效", 400, attribution.error.flatten());
  const statusParam = c.req.query("status") || "";
  const status = statusParam.includes(",") ? statusParam.split(",").map((item) => item.trim()).filter(Boolean) : statusParam;
  const productId = c.req.query("productId") || "";
  const q = c.req.query("q") || "";
  const paymentMethod = c.req.query("paymentMethod") || "";
  const format = c.req.query("format") || "json";
  const cursor = c.req.query("cursor") || "";
  const limit = queryInt(c.req.query("limit"), 1000, 1, 5000);

  const db = getDb(c);
  const data = await exportFinance(db, {
    status,
    productId,
    q,
    paymentMethod,
    orderSource: attribution.data.orderSource,
    storefrontId: attribution.data.storefrontId,
    cursor,
    limit,
  });

  await writeAdminAudit(db, {
    action: "export_finance",
    targetType: "finance",
    targetId: "",
    metadata: { status, productId, paymentMethod, ...attribution.data, format, orderCount: data.orders.length, balanceTxCount: data.balanceTransactions.length },
    ipHash: await getIpHash(c)
  });

  if (format === "json") {
    return ok(c, data);
  }

  // CSV 仅导出 orders（余额变动请使用 /balance-transactions 单独导出）
  const safeCsv = (v: string) => {
    const ch = v[0];
    if (ch && ("=+-@\t\n".includes(ch))) return `\t"${v.replace(/"/g, '""')}"`;
    return `"${v.replace(/"/g, '""')}"`;
  };

  const orderHeaders = [
    "orderNo", "productTitle", "orderSource", "storefrontId", "storefrontNameSnapshot", "storefrontSlugSnapshot", "buyerContact", "buyerEmail",
    "amountCents", "discountCents", "currency", "status",
    "paymentProvider", "paymentMethod", "batchId", "accountLabel", "deliveryNote",
    "createdAt", "paidAt", "issuedAt"
  ];
  const orderRows = data.orders.map((row) => [
    safeCsv(String(row.orderNo || "")),
    safeCsv(String(row.productTitle || "")),
    safeCsv(String(row.orderSource || "")),
    safeCsv(String(row.storefrontId || "")),
    safeCsv(String(row.storefrontNameSnapshot || "")),
    safeCsv(String(row.storefrontSlugSnapshot || "")),
    safeCsv(maskContact(String(row.buyerContact || ""))),
    safeCsv(row.buyerEmail ? maskContact(String(row.buyerEmail)) : ""),
    safeCsv(String(row.amountCents ?? "")),
    safeCsv(String(row.discountCents ?? "")),
    safeCsv(String(row.currency || "")),
    safeCsv(String(row.status || "")),
    safeCsv(String(row.paymentProvider || "")),
    safeCsv(String(row.paymentMethod || "")),
    safeCsv(String(row.batchId || "")),
    safeCsv(String(row.accountLabel || "")),
    safeCsv(String(row.deliveryNote || "")),
    safeCsv(String(row.createdAt || "")),
    safeCsv(String(row.paidAt || "")),
    safeCsv(String(row.issuedAt || ""))
  ]);

  const currencySummaryRows = Object.entries(data.summary.totalsByCurrency)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, totals]) => [
      safeCsv(currency),
      safeCsv(String(totals.totalIncomeCents)),
      safeCsv(String(totals.totalCardIssuedCents)),
      safeCsv(String(totals.totalBalanceSpentCents)),
      safeCsv(String(totals.totalRefundCents)),
    ].join(","));
  const summarySection = [
    "",
    "# 按币种汇总（金额为对应币种最小单位）",
    `总订单数,${data.orders.length}`,
    "currency,totalIncomeMinor,totalCardIssuedMinor,totalBalanceSpentMinor,totalRefundMinor",
    ...currencySummaryRows,
  ];

  const csvContent = "\uFEFF" + [
    "# 订单",
    orderHeaders.join(","),
    ...orderRows.map((r) => r.join(",")),
    ...summarySection,
  ].join("\n");

  return new Response(csvContent, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="finance-${Date.now()}.csv"`,
    },
  });
});

adminRoute.get("/orders/:id", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c);
  const raw = await getOrderDetail(db, id);
  if (!raw) return fail(c, "订单不存在", 404);

  await writeAdminAudit(db, {
    action: "view_order_detail",
    targetType: "order",
    targetId: id,
    ipHash: await getIpHash(c)
  });

  const order = {
    ...raw,
    buyerContact: maskContact(String(raw.buyerContact || "")),
    buyerEmail: raw.buyerEmail ? maskContact(String(raw.buyerEmail)) : ""
  };
  return ok(c, { order });
});

adminRoute.post("/orders/:id/mark-paid", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c);
  const order = await getOrderDetail(db, id);
  if (!order) return fail(c, "订单不存在", 404);
  if (order.status !== "pending" || order.paymentMethod !== "offline") {
    return fail(c, "仅线下待收款订单允许人工确认收款", 409);
  }
  const dbConfig = await readRuntimeConfig(db, c.env?.CREDENTIALS_ENCRYPTION_KEY);
  const emailEnv = mergeRuntimeConfig(dbConfig, c.env);
  const result = await markPaidAndIssue(db, id, emailEnv, c.get("executionCtx"));
  if (!result.ok) return fail(c, result.message, result.status);
  await writeAdminAudit(db, {
    action: "mark_paid_and_issue",
    targetType: "order",
    targetId: id,
    ipHash: await getIpHash(c)
  });
  return ok(c, { message: "订单已标记为已支付并完成发卡" });
});

adminRoute.post("/orders/:id/retry-fulfillment", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c);
  const order = await getOrderDetail(db, id);
  if (!order) return fail(c, "订单不存在", 404);
  if (order.status !== "paid") {
    return fail(c, "仅已支付但未完成交付的订单允许重试履约", 409);
  }

  const dbConfig = await readRuntimeConfig(db, c.env?.CREDENTIALS_ENCRYPTION_KEY);
  const emailEnv = mergeRuntimeConfig(dbConfig, c.env);
  const result = await markPaidAndIssue(db, id, emailEnv, c.get("executionCtx"));
  if (!result.ok) return fail(c, result.message, result.status);

  await writeAdminAudit(db, {
    action: "retry_order_fulfillment",
    targetType: "order",
    targetId: id,
    ipHash: await getIpHash(c),
  });
  return ok(c, { message: "订单履约已重试并完成" });
});

const fulfillmentProgressSchema = z.object({
  stage: z.enum(FULFILLMENT_PROGRESS_STAGES),
  supplierOrderRef: z.string().trim().max(120).optional().or(z.literal("")),
  note: z.string().trim().max(500).optional().or(z.literal("")),
}).superRefine((value, ctx) => {
  if (!value.supplierOrderRef && !value.note) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["note"], message: "请填写供应商订单号或处理备注" });
  }
});

// 这里只追加运营事实；订单能否继续履约仍由 paid -> issued 的既有状态机决定。
adminRoute.post("/orders/:id/fulfillment-progress", async (c) => {
  const id = c.req.param("id");
  const body = fulfillmentProgressSchema.safeParse(await safeJsonBody(c));
  if (!body.success) return fail(c, "请求参数无效", 400, body.error.flatten());

  const db = getDb(c);

  const details = [
    body.data.supplierOrderRef ? `供应商订单号：${body.data.supplierOrderRef}` : "",
    body.data.note ? `备注：${body.data.note}` : "",
  ].filter(Boolean).join("；");
  const metadata: FulfillmentProgressMetadata = {
    stage: body.data.stage,
    supplierOrderRef: body.data.supplierOrderRef || "",
  };
  let recordResult: "recorded" | "not_found" | "status_conflict";
  try {
    recordResult = await recordPaidOrderFulfillmentProgress(
      db,
      id,
      `${fulfillmentProgressStageLabel(body.data.stage)}：${details}`,
      metadata,
    );
  } catch (error) {
    console.warn("[admin] failed to record fulfillment progress:", error);
    return fail(c, "履约进度保存失败，请重试", 503);
  }
  if (recordResult === "not_found") return fail(c, "订单不存在", 404);
  if (recordResult === "status_conflict") {
    return fail(c, "只有已支付且尚未完成交付的订单可以更新履约进度", 409);
  }
  await writeAdminAudit(db, {
    action: "update_fulfillment_progress",
    targetType: "order",
    targetId: id,
    metadata,
    ipHash: await getIpHash(c),
  });
  return ok(c, { message: "履约进度已记录" });
});

adminRoute.post("/orders/:id/cancel", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c);
  try {
    const result = await cancelOrder(db, id);
    await writeAdminAudit(db, {
      action: "cancel_order",
      targetType: "order",
      targetId: id,
      ipHash: await getIpHash(c)
    });
    return ok(c, { message: "订单已取消", releasedCardId: result.releasedCardId, releasedCards: result.releasedCards });
  } catch (err) {
    return fail(c, err instanceof Error ? err.message : "取消失败", 400);
  }
});

// ── 卡密管理 ──

adminRoute.post("/cards/import", async (c) => {
  const raw = await safeJsonBody(c);
  const body = importCardsSchema.safeParse(raw);
  if (!body.success) return fail(c, "请求参数无效", 400, body.error.flatten());

  try {
    const db = getDb(c);
    const data = body.data as z.infer<typeof importCardsSchema>;
    const result = await importCards(db, data);
    await writeAdminAudit(db, {
      action: "import_cards",
      targetType: "product",
      targetId: data.productId,
      metadata: { batchId: result.batchId, count: result.imported },
      ipHash: await getIpHash(c)
    });
    return ok(c, result, 201);
  } catch (err) {
    return fail(c, err instanceof Error ? err.message : "导入失败", 404);
  }
});

/** 批量生成通用卡密（一卡一密无限次场景） */
const generateGenericCardsSchema = z.object({
  productId: productIdSchema,
  count: z.number().int().min(1).max(5000),
  genericCode: z.string().trim().min(1).max(200),
  batchName: z.string().trim().min(1).max(120),
  expiresAt: z.string().trim().max(40).optional().or(z.literal("")),
});

adminRoute.post("/cards/generate-generic", async (c) => {
  const body = generateGenericCardsSchema.safeParse(await safeJsonBody(c));
  if (!body.success) return fail(c, "请求参数无效", 400, body.error.flatten());

  try {
    const db = getDb(c);
    const result = await generateGenericCards(db, {
      productId: body.data.productId,
      count: body.data.count,
      genericCode: body.data.genericCode,
      batchName: body.data.batchName,
      expiresAt: body.data.expiresAt || null,
    });
    await writeAdminAudit(db, {
      action: "generate_generic_cards",
      targetType: "card",
      targetId: result.batchId,
      metadata: { productId: body.data.productId, count: result.generated, batchName: body.data.batchName },
      ipHash: await getIpHash(c)
    });
    return ok(c, { ...result, message: `已生成 ${result.generated} 张通用卡密` }, 201);
  } catch (err) {
    return fail(c, err instanceof Error ? err.message : "生成失败", 400);
  }
});

// ── 卡密导入 CSV 模板下载 ──
// 防止 CSV 公式注入：以 =, +, -, @, TAB, 换行 开头的值会被 Excel 解析为公式，
// 前置制表符 \t 可安全中和（Excel 会将其视为文本，不影响内容）。
const safeCsv = (v: string) => {
  const ch = v[0];
  if (ch && ("=+-@\t\n".includes(ch))) return `\t"${v.replace(/"/g, '""')}"`;
  return `"${v.replace(/"/g, '""')}"`;
};

adminRoute.get("/cards/import-template", async (c) => {
  const headers = ["accountLabel", "deliverySecret", "deliveryNote", "expiresAt"];
  const sampleRows = [
    ["user001", "secret-abc-123", "备注信息", "2026-12-31"],
    ["user002", "secret-def-456", "", ""],
  ];
  const csvContent = "\uFEFF" + [
    headers.join(","),
    ...sampleRows.map((row) => row.map((cell) => safeCsv(String(cell))).join(",")),
  ].join("\n");

  return new Response(csvContent, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": "attachment; filename=\"cards-import-template.csv\"",
    },
  });
});

adminRoute.get("/cards", async (c) => {
  const productId = c.req.query("productId") || "";
  const batchId = c.req.query("batchId") || "";
  const status = c.req.query("status") || "";
  const buyerEmail = c.req.query("buyerEmail") || "";
  const buyerContact = c.req.query("buyerContact") || "";
  const genericOnly = c.req.query("genericOnly") === "true";
  const page = queryInt(c.req.query("page"), 1, 1, 100000);
  const limit = queryInt(c.req.query("limit"), 20, 1, 100);

  const { total, results } = await getCardList(getDb(c), {
    productId, batchId, status, buyerEmail, buyerContact, genericOnly, page, limit
  });
  return ok(c, { total, results: results || [] });
});

adminRoute.patch("/cards/:id", async (c) => {
  const id = c.req.param("id");
  const body = z.object({
    status: z.enum(["available", "disabled"])
  }).safeParse(await safeJsonBody(c));
  if (!body.success) return fail(c, "请求参数无效", 400, body.error.flatten());

  const db = getDb(c);

  // 只有未售出的 available/disabled 卡密允许人工上下架；locked/issued 必须交给订单状态机处理。
  const [row] = await db.select({ status: cards.status }).from(cards).where(eq(cards.id, id));
  if (!row) return fail(c, "卡密不存在", 404);
  if (!(["available", "disabled"].includes(row.status))) return fail(c, "锁定中或已发卡的卡密不可人工变更状态", 409);

  const result = await updateCardStatus(db, id, body.data.status);
  if (!result) return fail(c, "卡密不存在", 404);

  await writeAdminAudit(db, {
    action: body.data.status === "disabled" ? "disable_card" : "enable_card",
    targetType: "card",
    targetId: id,
    metadata: { status: body.data.status },
    ipHash: await getIpHash(c)
  });
  return ok(c, { id, status: body.data.status });
});

adminRoute.post("/cards/batch-disable", async (c) => {
  const body = z.object({
    ids: z.array(z.string()).min(1).max(200),
    status: z.enum(["available", "disabled"])
  }).safeParse(await safeJsonBody(c));
  if (!body.success) return fail(c, "请求参数无效", 400, body.error.flatten());

  const db = getDb(c);

  // 批量操作只允许未售出的 available/disabled；locked/issued 必须交给订单状态机处理。
  const protectedRows = await db.select({ id: cards.id })
    .from(cards)
    .where(and(inArray(cards.id, body.data.ids), inArray(cards.status, ["locked", "issued"])));
  if (protectedRows.length > 0) return fail(c, `包含 ${protectedRows.length} 张锁定中或已发卡的卡密，不可人工变更状态`, 409);

  const result = await batchDisableCards(db, body.data.ids, body.data.status);

  await writeAdminAudit(db, {
    action: "batch_disable_cards",
    targetType: "card",
    targetId: "",
    metadata: { count: body.data.ids.length, status: body.data.status },
    ipHash: await getIpHash(c)
  });
  return ok(c, { updated: result.updated });
});

adminRoute.post("/cards/batch-delete", async (c) => {
  const body = z.object({
    ids: z.array(z.string().trim().min(1).max(120)).min(1).max(200),
    force: z.boolean().optional().default(false),
    unlinkRefs: z.boolean().optional().default(false),
  }).safeParse(await safeJsonBody(c));
  if (!body.success) return fail(c, "请求参数无效", 400, body.error.flatten());

  const db = getDb(c);
  const { force, unlinkRefs } = body.data;
  const result = await batchDeleteCards(db, body.data.ids, { force, unlinkRefs });
  if (result.blocked > 0) {
    const hints: string[] = [];
    if (!force) hints.push("勾选「全部删除」以包含锁定中/已发卡卡密");
    if (!unlinkRefs) hints.push("勾选「解绑订单引用」以处理仍被订单挂着的卡密");
    const hintText = hints.length > 0 ? `。${hints.join("；")}` : "";
    return fail(
      c,
      `包含 ${result.blocked} 张不可删除卡密（受状态或订单引用保护）${hintText}`,
      409,
    );
  }

  await writeAdminAudit(db, {
    action: "batch_delete_cards",
    targetType: "card",
    targetId: "",
    metadata: {
      requested: body.data.ids.length,
      deleted: result.deleted,
      force,
      unlinkRefs,
    },
    ipHash: await getIpHash(c),
  });
  return ok(c, result);
});

// ── 批次列表 ──

adminRoute.get("/batches", async (c) => {
  const productId = c.req.query("productId") || "";
  const batches = await getBatchList(getDb(c), productId);
  return ok(c, { results: batches });
});

// ── 优惠码列表 ──

adminRoute.get("/coupons", async (c) => {
  const productId = c.req.query("productId") || "";
  const status = c.req.query("status") || "";
  const search = c.req.query("search") || "";
  const page = queryInt(c.req.query("page"), 1, 1, 100000);
  const limit = queryInt(c.req.query("limit"), 20, 1, 100);

  const { total, results } = await getCouponList(getDb(c), { productId, status, search, page, limit });
  return ok(c, { total, results: results || [] });
});

// ── 商品管理 ──

adminRoute.get("/products", async (c) => {
  const q = c.req.query("q") || "";
  const active = c.req.query("active") || "";
  const category = c.req.query("category") || "";
  const stock = c.req.query("stock") || "";
  const storefrontId = c.req.query("storefrontId") || "";
  const page = queryInt(c.req.query("page"), 1, 1, 100000);
  const limit = queryInt(c.req.query("limit"), 20, 1, 100);

  const { total, products } = await getAdminProducts(getDb(c), { q, active, category, stock, storefrontId, page, limit });
  return ok(c, { total, products: products || [] });
});

adminRoute.get("/product-categories", async (c) => {
  const categories = await getAdminProductCategories(getDb(c));
  return ok(c, { categories });
});

adminRoute.post("/product-categories", async (c) => {
  const raw = await safeJsonBody(c);
  let data: z.infer<typeof productCategorySchema>;
  try {
    data = productCategorySchema.parse(raw);
  } catch (e) {
    const error = e as z.ZodError;
    return fail(c, "请求参数无效", 400, error.flatten());
  }

  const db = getDb(c);
  const id = await createProductCategory(db, data);
  await writeAdminAudit(db, {
    action: "create_product_category",
    targetType: "product_category",
    targetId: id,
    ipHash: await getIpHash(c)
  });
  return ok(c, { id }, 201);
});

adminRoute.patch("/product-categories/:id", async (c) => {
  const raw = await safeJsonBody(c);
  let data: Partial<z.infer<typeof productCategorySchema>>;
  try {
    data = productCategorySchema.partial().parse(raw);
  } catch (e) {
    const error = e as z.ZodError;
    return fail(c, "请求参数无效", 400, error.flatten());
  }

  const id = c.req.param("id");
  const db = getDb(c);
  const updated = await updateProductCategory(db, id, data);
  if (!updated) return fail(c, "分类不存在", 404);
  await writeAdminAudit(db, {
    action: "update_product_category",
    targetType: "product_category",
    targetId: id,
    ipHash: await getIpHash(c)
  });
  return ok(c, { id });
});

adminRoute.delete("/product-categories/:id", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c);
  const result = await deleteProductCategory(db, id);
  if (!result.deleted) return fail(c, result.reason || "删除失败", 400);
  await writeAdminAudit(db, {
    action: "delete_product_category",
    targetType: "product_category",
    targetId: id,
    ipHash: await getIpHash(c)
  });
  return ok(c, { deleted: id });
});

adminRoute.post("/products", async (c) => {
  const raw = await safeJsonBody(c);
  let data: CreateProductInput;
  try {
    data = createProductSchema.parse(raw) as CreateProductInput;
  } catch (e) {
    const error = e as z.ZodError;
    return fail(c, "请求参数无效", 400, error.flatten());
  }

  if (data.currency !== "CNY" && data.active) {
    return fail(c, "当前支付链路仅支持 CNY，非 CNY 商品只能保存为下架草稿", 400, {
      code: "PRODUCT_CURRENCY_NOT_SELLABLE",
    });
  }

  const db = getDb(c);
  if (data.id) {
    const exists = await checkProductExists(db, data.id);
    if (exists) return fail(c, "商品 ID 已存在，请使用编辑功能修改", 409);
  }

  let productId: string;
  try {
    productId = await createProduct(db, data);
  } catch (error) {
    if (error instanceof ProductStorefrontAssignmentError) {
      const status = error.code === "STOREFRONT_NOT_FOUND" ? 400 : 409;
      return fail(c, error.message, status, { code: error.code });
    }
    throw error;
  }
  await writeAdminAudit(db, {
    action: "create_product",
    targetType: "product",
    targetId: productId,
    ipHash: await getIpHash(c)
  });
  return ok(c, { productId }, 201);
});

adminRoute.post("/products/:id/duplicate", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c);
  const productId = await duplicateProduct(db, id);
  if (!productId) return fail(c, "商品不存在", 404);

  await writeAdminAudit(db, {
    action: "duplicate_product",
    targetType: "product",
    targetId: productId,
    metadata: { sourceProductId: id },
    ipHash: await getIpHash(c)
  });
  return ok(c, { productId }, 201);
});

adminRoute.patch("/products/:id", async (c) => {
  const raw = await safeJsonBody(c);
  let data: UpdateProductInput;
  try {
    data = productSchema.partial().parse(raw) as UpdateProductInput;
  } catch (e) {
    const error = e as z.ZodError;
    return fail(c, "请求参数无效", 400, error.flatten());
  }
  const id = c.req.param("id");

  const db = getDb(c);
  const state = await getProductCommerceState(db, id);
  if (!state) return fail(c, "商品不存在", 404);
  // partial 更新时对照库内现价/对比价，禁止「现价涨过原价」或「原价≤现价」脏数据
  if (data.priceCents !== undefined || data.originalPriceCents !== undefined) {
    const nextPrice = data.priceCents !== undefined ? data.priceCents : state.priceCents;
    const nextOriginal = data.originalPriceCents !== undefined
      ? (data.originalPriceCents ?? null)
      : state.originalPriceCents;
    const originalErr = validateOriginalPriceCents(nextPrice, nextOriginal);
    if (originalErr) {
      return fail(c, originalErr, 400, { code: "PRODUCT_ORIGINAL_PRICE_INVALID" });
    }
  }
  const nextCurrency = data.currency || state.currency;
  const nextActive = data.active === undefined ? state.active : data.active;
  if (nextCurrency !== "CNY" && nextActive) {
    return fail(c, "当前支付链路仅支持 CNY，非 CNY 商品只能保存为下架草稿", 400, {
      code: "PRODUCT_CURRENCY_NOT_SELLABLE",
    });
  }
  await updateProduct(db, id, data);
  await writeAdminAudit(db, {
    action: "update_product",
    targetType: "product",
    targetId: id,
    ipHash: await getIpHash(c)
  });
  return ok(c, { productId: id });
});

adminRoute.delete("/products/:id", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c);
  const result = await deleteProduct(db, id);
  if (!result.deleted) {
    return fail(c, result.reason || "删除失败", 400);
  }
  await writeAdminAudit(db, {
    action: "delete_product",
    targetType: "product",
    targetId: id,
    ipHash: await getIpHash(c)
  });
  return ok(c, { deleted: id });
});

// ── 优惠码管理 ──

adminRoute.post("/coupons", async (c) => {
  const raw = await safeJsonBody(c);
  let data: CreateCouponInput;
  try {
    data = couponSchema.parse(raw) as CreateCouponInput;
  } catch (e) {
    const error = e as z.ZodError;
    return fail(c, "请求参数无效", 400, error.flatten());
  }

  if (data.discountType === "percent" && data.discountValue > 100) {
    return fail(c, "百分比折扣不能超过 100", 400);
  }

  const db = getDb(c);
  const codeLower = (data.code || "").toLowerCase();

  // 检查是否已存在同名折扣码 — 存在时返回警告而非静默覆盖
  const existing = codeLower ? await db.select({ code: coupons.code }).from(coupons).where(eq(coupons.code, codeLower)).limit(1) : [];
  const isUpdate = existing.length > 0;

  const couponCode = await upsertCoupon(db, {
    code: codeLower,
    productId: data.productId || "",
    discountType: data.discountType,
    discountValue: data.discountValue,
    maxUses: data.maxUses,
    active: data.active,
    expiresAt: data.expiresAt || null,
  });

  await writeAdminAudit(db, {
    action: isUpdate ? "update_coupon" : "create_coupon",
    targetType: "coupon",
    targetId: couponCode,
    ipHash: await getIpHash(c)
  });
  return ok(c, { code: couponCode, warning: isUpdate ? `折扣码 "${couponCode}" 已存在，已覆盖原值` : undefined }, isUpdate ? 200 : 201);
});

adminRoute.post("/coupons/generate", async (c) => {
  const raw = await safeJsonBody(c);
  let data: z.infer<typeof generateCouponSchema>;
  try {
    data = generateCouponSchema.parse(raw);
  } catch (e) {
    const error = e as z.ZodError;
    return fail(c, "请求参数无效", 400, error.flatten());
  }

  if (data.discountType === "percent" && data.discountValue > 100) {
    return fail(c, "百分比折扣不能超过 100", 400);
  }

  const db = getDb(c);
  const exists = await checkProductExists(db, data.productId);
  if (!exists) return fail(c, "商品不存在", 404);

  const codes = await generateCoupon(db, { ...data, count: data.count });

  await writeAdminAudit(db, {
    action: "generate_coupon",
    targetType: "coupon",
    targetId: codes.join(","),
    metadata: { productId: data.productId, count: data.count },
    ipHash: await getIpHash(c)
  });
  return ok(c, { codes, productId: data.productId }, 201);
});

adminRoute.patch("/coupons/:code", async (c) => {
  const raw = await safeJsonBody(c);
  let data: UpdateCouponInput;
  try {
    data = couponSchema.partial().parse(raw) as UpdateCouponInput;
  } catch (e) {
    const error = e as z.ZodError;
    return fail(c, "请求参数无效", 400, error.flatten());
  }
  const code = c.req.param("code").toLowerCase();

  await updateCoupon(getDb(c), code, data);
  await writeAdminAudit(getDb(c), {
    action: "update_coupon",
    targetType: "coupon",
    targetId: code,
    ipHash: await getIpHash(c)
  });
  return ok(c, { code });
});

adminRoute.delete("/coupons/:code", async (c) => {
  const code = c.req.param("code").toLowerCase();
  const db = getDb(c);
  await deleteCoupon(db, code);
  await writeAdminAudit(db, {
    action: "delete_coupon",
    targetType: "coupon",
    targetId: code,
    ipHash: await getIpHash(c)
  });
  return ok(c, { deleted: code });
});

// ── 操作日志 ──

adminRoute.get("/logs", async (c) => {
  const limit = queryInt(c.req.query("limit"), 20, 1, 100);
  const action = c.req.query("action") || undefined;
  const targetType = c.req.query("targetType") || undefined;
  const targetId = c.req.query("targetId") || undefined;
  const snapshotAt = c.req.query("snapshotAt") || undefined;
  const cursor = c.req.query("cursor") || undefined;
  if ((action?.length ?? 0) > 100 || (targetType?.length ?? 0) > 100 || (targetId?.length ?? 0) > 200) {
    return fail(c, "日志筛选条件过长", 400);
  }
  if (!cursor && queryInt(c.req.query("page"), 1, 1, 100000) > 1) {
    return fail(c, "日志分页已改用 cursor；请求下一页时必须提供上一页返回的 nextCursor", 400);
  }

  try {
    const result = await getMergedLogs(getDb(c), limit, { action, targetType, targetId, snapshotAt, cursor });
    return ok(c, {
      total: result.total,
      logs: result.logs || [],
      snapshotAt: result.snapshotAt,
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "InvalidLogCursorError") {
      return fail(c, error.message, 400);
    }
    throw error;
  }
});

adminRoute.post("/logs/batch-delete", async (c) => {
  const body = z.object({
    logs: z.array(z.object({
      type: z.enum(["request", "admin"]),
      id: z.string().trim().min(1).max(120),
    })).min(1).max(200),
  }).safeParse(await safeJsonBody(c));
  if (!body.success) return fail(c, "请求参数无效", 400, body.error.flatten());

  const db = getDb(c);
  const result = await batchDeleteMergedLogs(db, body.data.logs);
  await writeAdminAudit(db, {
    action: "batch_delete_logs",
    targetType: "log",
    targetId: "",
    metadata: { requested: body.data.logs.length, ...result },
    ipHash: await getIpHash(c),
  });
  return ok(c, result);
});

adminRoute.post("/logs/clear", async (c) => {
  const body = z.object({
    // 服务端也校验固定确认短语，防止误调用一个无参数的危险接口。
    confirmation: z.literal("CLEAR_ALL_LOGS"),
  }).safeParse(await safeJsonBody(c));
  if (!body.success) return fail(c, "请明确确认清除全部日志", 400, body.error.flatten());

  const result = await clearAllMergedLogs(getDb(c), await getIpHash(c));
  return ok(c, result);
});

// ── 库存预警 ──

adminRoute.get("/low-stock-products", async (c) => {
  const threshold = optionalQueryInt(c.req.query("threshold"), 1, 1000000);
  const products = await getLowStockProducts(getDb(c), threshold);
  return ok(c, { products });
});

adminRoute.post("/low-stock-products/notify", async (c) => {
  const db = getDb(c);
  const dbConfig = await readRuntimeConfig(db, c.env?.CREDENTIALS_ENCRYPTION_KEY);
  const emailEnv = mergeRuntimeConfig(dbConfig, c.env);

  const threshold = optionalQueryInt(c.req.query("threshold"), 1, 1000000);
  const products = await getLowStockProducts(db, threshold);

  if (products.length === 0) {
    // 前端 AdminNotifyLowStockResult 要求 count 必定存在；
    // 即使没有低库存商品，也返回 0，避免运行时数据契约和 TypeScript 类型不一致。
    return ok(c, { ok: true, message: "当前无低库存商品", sent: false, count: 0 });
  }

  const effectiveThreshold = await lowStockThreshold(db, threshold);
  const result = await sendLowStockWarningEmailWithDedup(db, emailEnv, products, effectiveThreshold, await getIpHash(c));
  return ok(c, {
    ok: result.ok,
    message: result.message,
    sent: result.sent,
    count: result.count,
  });
});

// ── 邮件服务测试 ──

const testEmailSchema = z.object({
  to: z.string().trim().email("请提供有效的邮箱地址")
});

/**
 * POST /admin/test-email
 * 用真实的 RESEND_API_KEY 发一封测试邮件，验证配置是否正确。
 * 不写 email_logs（测试邮件不记业务日志）。
 */
adminRoute.post("/test-email", async (c) => {
  const db = getDb(c);
  const dbConfig = await readRuntimeConfig(db, c.env?.CREDENTIALS_ENCRYPTION_KEY);
  const emailEnv = mergeRuntimeConfig(dbConfig, c.env);
  if (!emailEnv.resendApiKey) {
    return fail(c, "RESEND_API_KEY 未配置，请在后台 system_config 配置 resend_api_key", 400);
  }

  const raw = await safeJsonBody(c);
  const body = testEmailSchema.safeParse(raw);
  if (!body.success) {
    return fail(c, body.error.issues[0]?.message || "请求参数无效", 400, body.error.flatten());
  }

  const data = body.data as z.infer<typeof testEmailSchema>;
  const to = data.to;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${emailEnv.resendApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: emailEnv.emailFrom || "xshop contributors <noreply@users.noreply.github.com>",
        to,
        subject: "📧 eshop 邮件服务测试",
        html: `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><title>邮件测试</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 40px auto; padding: 0 20px; color: #333;">
  <h2 style="color: #1a73e8;">📧 邮件服务测试成功</h2>
  <p>您好，这是一封来自 <strong>eshop</strong> 的测试邮件。</p>
  <p>如果您看到这封邮件，说明 Resend 邮件服务配置正确，可以正常发送订单通知邮件了。</p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;">
  <p style="color: #666; font-size: 13px;">发送时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}（北京时间）</p>
</body>
</html>`
      })
    });

    const data = await res.json() as { id?: string; message?: string };

    if (!res.ok) {
      const db = getDb(c);
      await writeAdminAudit(db, {
        action: "test_email",
        targetType: "email",
        targetId: to,
        metadata: { ok: false, status: res.status, error: data.message },
        ipHash: await getIpHash(c)
      });
      return fail(c, `发送失败：${data.message || `HTTP ${res.status}`}`, 502);
    }

    await writeAdminAudit(getDb(c), {
      action: "test_email",
      targetType: "email",
      targetId: to,
      metadata: { ok: true, resendId: data.id },
      ipHash: await getIpHash(c)
    });

    return ok(c, { ok: true, message: "测试邮件发送成功", resendId: data.id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await writeAdminAudit(getDb(c), {
      action: "test_email",
      targetType: "email",
      targetId: to,
      metadata: { ok: false, error: msg },
      ipHash: await getIpHash(c)
    });
    return fail(c, `发送异常：${msg}`, 502);
  }
});

// ── 邮件日志 ──

adminRoute.get("/email-logs", async (c) => {
  const status = c.req.query("status") || "";
  const search = c.req.query("search") || "";
  const limit = queryInt(c.req.query("limit"), 20, 1, 100);
  const snapshotAt = c.req.query("snapshotAt") || undefined;
  const cursor = c.req.query("cursor") || undefined;
  if (status.length > 50 || search.length > 200) {
    return fail(c, "邮件日志筛选条件过长", 400);
  }
  if (!cursor && queryInt(c.req.query("page"), 1, 1, 100000) > 1) {
    return fail(c, "邮件日志分页已改用 cursor；请求下一页时必须提供上一页返回的 nextCursor", 400);
  }

  try {
    const result = await getEmailLogList(getDb(c), { status, search, limit, snapshotAt, cursor });
    return ok(c, {
      total: result.total,
      results: result.results || [],
      snapshotAt: result.snapshotAt,
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "InvalidLogCursorError") {
      return fail(c, error.message, 400);
    }
    throw error;
  }
});

adminRoute.post("/email-logs/batch-delete", async (c) => {
  const body = z.object({
    ids: z.array(z.string().trim().min(1).max(120)).min(1).max(200),
  }).safeParse(await safeJsonBody(c));
  if (!body.success) return fail(c, "请求参数无效", 400, body.error.flatten());

  const db = getDb(c);
  const result = await batchDeleteEmailLogs(db, body.data.ids);
  await writeAdminAudit(db, {
    action: "batch_delete_email_logs",
    targetType: "email_log",
    targetId: "",
    metadata: { requested: body.data.ids.length, deleted: result.deleted },
    ipHash: await getIpHash(c),
  });
  return ok(c, result);
});

// ── 营销活动管理 ──

adminRoute.get("/campaigns", async (c) => {
  const campaigns = await getCampaignList(getDb(c));
  return ok(c, { campaigns });
});

adminRoute.post("/campaigns", async (c) => {
  const body = z.object({
    code: z.string().trim().min(2).max(40),
    name: z.string().trim().min(1).max(120),
    active: z.boolean().default(true),
    startsAt: z.string().trim().max(40).optional().or(z.literal("")),
    endsAt: z.string().trim().max(40).optional().or(z.literal("")),
    metadataJson: z.string().trim().max(5000).optional().or(z.literal(""))
  }).safeParse(await safeJsonBody(c));
  if (!body.success) return fail(c, "请求参数无效", 400, body.error.flatten());

  const db = getDb(c);
  await createCampaign(db, body.data);
  await writeAdminAudit(db, {
    action: "create_campaign",
    targetType: "campaign",
    targetId: body.data.code,
    ipHash: await getIpHash(c)
  });
  return ok(c, { code: body.data.code }, 201);
});

adminRoute.patch("/campaigns/:code", async (c) => {
  const code = c.req.param("code");
  const body = z.object({
    name: z.string().trim().min(1).max(120).optional(),
    active: z.boolean().optional(),
    startsAt: z.string().trim().max(40).optional().or(z.literal("")),
    endsAt: z.string().trim().max(40).optional().or(z.literal("")),
    metadataJson: z.string().trim().max(5000).optional().or(z.literal(""))
  }).safeParse(await safeJsonBody(c));
  if (!body.success) return fail(c, "请求参数无效", 400, body.error.flatten());

  const db = getDb(c);
  await updateCampaign(db, code, body.data);
  await writeAdminAudit(db, {
    action: "update_campaign",
    targetType: "campaign",
    targetId: code,
    ipHash: await getIpHash(c)
  });
  return ok(c, { code });
});

adminRoute.delete("/campaigns/:code", async (c) => {
  const code = c.req.param("code");
  const db = getDb(c);
  await deleteCampaign(db, code);
  await writeAdminAudit(db, {
    action: "delete_campaign",
    targetType: "campaign",
    targetId: code,
    ipHash: await getIpHash(c)
  });
  return ok(c, { deleted: code });
});

// ── 推荐码管理 ──

adminRoute.get("/referral-codes", async (c) => {
  const codes = await getReferralCodeList(getDb(c));
  return ok(c, { codes });
});

adminRoute.post("/referral-codes", async (c) => {
  const body = z.object({
    code: z.string().trim().min(2).max(40),
    ownerContact: z.string().trim().min(1).max(120),
    rewardType: z.enum(["none", "fixed", "percent"]).default("none"),
    rewardValue: z.number().int().min(0).max(100000).default(0),
    active: z.boolean().default(true)
  }).safeParse(await safeJsonBody(c));
  if (!body.success) return fail(c, "请求参数无效", 400, body.error.flatten());

  const db = getDb(c);
  await createReferralCode(db, body.data);
  await writeAdminAudit(db, {
    action: "create_referral_code",
    targetType: "referral_code",
    targetId: body.data.code,
    ipHash: await getIpHash(c)
  });
  return ok(c, { code: body.data.code }, 201);
});

adminRoute.patch("/referral-codes/:code", async (c) => {
  const code = c.req.param("code");
  const body = z.object({
    ownerContact: z.string().trim().min(1).max(120).optional(),
    rewardType: z.enum(["none", "fixed", "percent"]).optional(),
    rewardValue: z.number().int().min(0).max(100000).optional(),
    active: z.boolean().optional()
  }).safeParse(await safeJsonBody(c));
  if (!body.success) return fail(c, "请求参数无效", 400, body.error.flatten());

  const db = getDb(c);
  await updateReferralCode(db, code, body.data);
  await writeAdminAudit(db, {
    action: "update_referral_code",
    targetType: "referral_code",
    targetId: code,
    ipHash: await getIpHash(c)
  });
  return ok(c, { code });
});

adminRoute.delete("/referral-codes/:code", async (c) => {
  const code = c.req.param("code");
  const db = getDb(c);
  await deleteReferralCode(db, code);
  await writeAdminAudit(db, {
    action: "delete_referral_code",
    targetType: "referral_code",
    targetId: code,
    ipHash: await getIpHash(c)
  });
  return ok(c, { deleted: code });
});

// ── 定时清理过期订单 + 僵尸卡密 ──
// 供 GitHub Actions 定时调用（Free 版无 Cron Trigger CPU 时间不足，用外部调度替代）。
// 也支持管理员手动触发。
adminRoute.post("/cleanup", async (c) => {
  const db = getDb(c);
  const dbConfig = await readRuntimeConfig(db, c.env?.CREDENTIALS_ENCRYPTION_KEY);
  const emailEnv = mergeRuntimeConfig(dbConfig, c.env);
  const result = await cleanupExpiredOrders(
    db,
    emailEnv,
    c.var.executionCtx,
    c.env,
  );
  await writeAdminAudit(db, {
    action: "run_cleanup",
    targetType: "system",
    targetId: "cleanup",
    metadata: result,
    ipHash: await getIpHash(c)
  });
  return ok(c, {
    message: "清理完成",
    reconciledPayments: result.reconciledPayments,
    expiredOrders: result.expiredOrders,
    expiredRechargeOrders: result.expiredRechargeOrders,
    releasedCards: result.releasedCards,
    disabledExpiredCards: result.disabledExpiredCards,
    operationalData: result.operationalData,
  });
});

// ── Phase 3: 运营效率工具 ──────────────────────────────

// ── 今日待处理聚合 ──

adminRoute.get("/pending-tasks", async (c) => {
  const db = getDb(c);
  const tasks = await getTodayPendingTasks(db);
  return ok(c, tasks);
});

// ── 更新卡密批次 ──

const updateCardBatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional().or(z.literal("")),
  source: z.string().trim().max(200).optional().or(z.literal("")),
  costPriceCents: z.number().int().min(0).max(999999).optional().nullable(),
  note: z.string().trim().max(500).optional().or(z.literal(""))
});

adminRoute.patch("/batches/:id", async (c) => {
  const id = c.req.param("id");
  const body = updateCardBatchSchema.safeParse(await safeJsonBody(c));
  if (!body.success) return fail(c, "请求参数无效", 400, body.error.flatten());

  const db = getDb(c);
  const result = await updateCardBatch(db, id, body.data);
  if (!result) return fail(c, "批次不存在", 404);

  await writeAdminAudit(db, {
    action: "update_card_batch",
    targetType: "card_batch",
    targetId: id,
    metadata: body.data,
    ipHash: await getIpHash(c)
  });
  return ok(c, result);
});

// ── 重发订单邮件 ──

adminRoute.post("/orders/:id/resend-email", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c);
  const dbConfig = await readRuntimeConfig(db, c.env?.CREDENTIALS_ENCRYPTION_KEY);
  const emailEnv = mergeRuntimeConfig(dbConfig, c.env);

  const result = await resendOrderEmail(db, emailEnv, id);

  await writeAdminAudit(db, {
    action: "resend_order_email",
    targetType: "order",
    targetId: id,
    metadata: result,
    ipHash: await getIpHash(c)
  });

  if (!result.ok) {
    return fail(c, result.message, 400);
  }
  return ok(c, { message: result.message });
});

// ── 订单补偿备注 ──

const compensationNoteSchema = z.object({
  note: z.string().trim().min(1).max(500)
});

adminRoute.post("/orders/:id/compensation-note", async (c) => {
  const id = c.req.param("id");
  const body = compensationNoteSchema.safeParse(await safeJsonBody(c));
  if (!body.success) return fail(c, "请求参数无效", 400, body.error.flatten());

  const db = getDb(c);
  const result = await addOrderCompensationNote(db, id, body.data.note);

  await writeAdminAudit(db, {
    action: "add_compensation_note",
    targetType: "order",
    targetId: id,
    metadata: { note: body.data.note, ok: result.ok },
    ipHash: await getIpHash(c)
  });

  if (!result.ok) {
    return fail(c, result.message, 400);
  }
  return ok(c, { message: result.message });
});

// ── 系统参数与支付配置管理（Web 管理后台）──
adminRoute.route("/", adminVoucherRoute);
adminRoute.route("/storefronts", adminStorefrontRoute);
adminRoute.route("/system-config", adminSystemConfigRoute);
adminRoute.route("/payment", adminPaymentRoute);
adminRoute.route("/media", adminMediaRoute);
