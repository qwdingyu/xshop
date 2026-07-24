import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { adminRoute } from "./admin";
import { markPaidAndIssue } from "../services/order-service";
import { requireAdmin } from "../lib/security";

const getOrderList = vi.fn();
const exportOrders = vi.fn();
const exportFinance = vi.fn();
const getOrderDetail = vi.fn();
const importCards = vi.fn();
const getAdminSummary = vi.fn();
const getDailyIncomeTrend = vi.fn();
const getCardList = vi.fn();
const getCouponList = vi.fn();
const getAdminProducts = vi.fn();
const getAdminProductCategories = vi.fn();
const createProductCategory = vi.fn();
const checkProductExists = vi.fn();
const getProductCommerceState = vi.fn();
const createProduct = vi.fn();
const updateProduct = vi.fn();
const duplicateProduct = vi.fn();
const upsertCoupon = vi.fn();
const getMergedLogs = vi.fn();
const getLowStockProducts = vi.fn();
const getTodayPendingTasks = vi.fn();
const cancelOrder = vi.fn();
const getEmailLogList = vi.fn();
const batchDeleteOrders = vi.fn();
const batchDeleteCards = vi.fn();
const batchDeleteEmailLogs = vi.fn();
const batchDeleteMergedLogs = vi.fn();
const clearAllMergedLogs = vi.fn();
const sendLowStockWarningEmailWithDedup = vi.fn();
const mockReadRuntimeConfig = vi.fn();
const mockMergeRuntimeConfig = vi.fn();
const writeAdminAudit = vi.fn();
const recordPaidOrderFulfillmentProgress = vi.fn();

vi.mock("../services/admin-service", () => ({
  getAdminSummary: (...args: unknown[]) => getAdminSummary(...args),
  getDailyIncomeTrend: (...args: unknown[]) => getDailyIncomeTrend(...args),
  getOrderList: (...args: unknown[]) => getOrderList(...args),
  exportOrders: (...args: unknown[]) => exportOrders(...args),
  exportFinance: (...args: unknown[]) => exportFinance(...args),
  getOrderDetail: (...args: unknown[]) => getOrderDetail(...args),
  importCards: (...args: unknown[]) => importCards(...args),
  getCardList: (...args: unknown[]) => getCardList(...args),
  generateGenericCards: vi.fn(),
  updateCardStatus: vi.fn(),
  getBatchList: vi.fn(),
  getCouponList: (...args: unknown[]) => getCouponList(...args),
  getAdminProducts: (...args: unknown[]) => getAdminProducts(...args),
  getAdminProductCategories: (...args: unknown[]) => getAdminProductCategories(...args),
  createProductCategory: (...args: unknown[]) => createProductCategory(...args),
  updateProductCategory: vi.fn(),
  deleteProductCategory: vi.fn(),
  checkProductExists: (...args: unknown[]) => checkProductExists(...args),
  getProductCommerceState: (...args: unknown[]) => getProductCommerceState(...args),
  createProduct: (...args: unknown[]) => createProduct(...args),
  duplicateProduct: (...args: unknown[]) => duplicateProduct(...args),
  updateProduct: (...args: unknown[]) => updateProduct(...args),
  upsertCoupon: (...args: unknown[]) => upsertCoupon(...args),
  generateCoupon: vi.fn(),
  updateCoupon: vi.fn(),
  getMergedLogs: (...args: unknown[]) => getMergedLogs(...args),
  createCouponCode: vi.fn(),
  getLowStockProducts: (...args: unknown[]) => getLowStockProducts(...args),
  sendLowStockWarningEmail: vi.fn(),
  batchDisableCards: vi.fn(),
  batchDeleteCards: (...args: unknown[]) => batchDeleteCards(...args),
  cancelOrder: (...args: unknown[]) => cancelOrder(...args),
  getEmailLogList: (...args: unknown[]) => getEmailLogList(...args),
  batchDeleteOrders: (...args: unknown[]) => batchDeleteOrders(...args),
  batchDeleteEmailLogs: (...args: unknown[]) => batchDeleteEmailLogs(...args),
  batchDeleteMergedLogs: (...args: unknown[]) => batchDeleteMergedLogs(...args),
  clearAllMergedLogs: (...args: unknown[]) => clearAllMergedLogs(...args),
  getCampaignList: vi.fn(),
  createCampaign: vi.fn(),
  updateCampaign: vi.fn(),
  deleteCampaign: vi.fn(),
  getReferralCodeList: vi.fn(),
  createReferralCode: vi.fn(),
  updateReferralCode: vi.fn(),
  deleteReferralCode: vi.fn(),
  updateCard: vi.fn(),
  deleteProduct: vi.fn(),
  deleteCoupon: vi.fn(),
  getTodayPendingTasks: (...args: unknown[]) => getTodayPendingTasks(...args),
  updateCardBatch: vi.fn(),
  resendOrderEmail: vi.fn(),
  addOrderCompensationNote: vi.fn(),
  recordPaidOrderFulfillmentProgress: (...args: unknown[]) => recordPaidOrderFulfillmentProgress(...args),
  sendLowStockWarningEmailWithDedup: (...args: unknown[]) => sendLowStockWarningEmailWithDedup(...args),
}));

vi.mock("../services/order-service", () => ({
  markPaidAndIssue: vi.fn(),
}));

vi.mock("../services/cleanup-service", () => ({
  cleanupExpiredOrders: vi.fn(),
}));

vi.mock("../services/audit-service", () => ({
  writeAdminAudit: (...args: unknown[]) => writeAdminAudit(...args),
}));

vi.mock("../lib/rate-limit", () => ({
  enforceRateLimit: vi.fn().mockResolvedValue({ ok: true, ipHash: "ip-hash" }),
}));

vi.mock("../lib/runtime-config", () => ({
  readRuntimeConfig: (...args: unknown[]) => mockReadRuntimeConfig(...args),
  mergeRuntimeConfig: (...args: unknown[]) => mockMergeRuntimeConfig(...args),
}));

vi.mock("../lib/security", async () => {
  const actual = await vi.importActual("../lib/security");
  return {
    ...actual,
    getIpHash: vi.fn().mockResolvedValue("ip-hash"),
  };
});

vi.mock("./admin-payment", () => ({
  adminPaymentRoute: new Hono<AppEnv>(),
}));

vi.mock("./admin-system-config", () => ({
  adminSystemConfigRoute: new Hono<AppEnv>(),
}));

vi.mock("./admin-vouchers", () => ({
  adminVoucherRoute: new Hono<AppEnv>(),
}));

function createApp() {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", {} as never);
    c.set("executionCtx", { waitUntil: vi.fn() } as unknown as ExecutionContext<unknown>);
    await next();
  });
  app.route("/api/admin", adminRoute);
  return app;
}

function createProtectedApp() {
  const app = new Hono<AppEnv>();
  app.route("/api/admin", new Hono<AppEnv>().use("*", requireAdmin).route("/", adminRoute));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  getAdminSummary.mockResolvedValue({ products: 0, availableCards: 0, totalCards: 0, totalOrders: 0, pendingOrders: 0, lowStockCount: 0, ordersToday: 0, issuedToday: 0, totalIncomeCents: 0, todayIncomeCents: 0, todayAlipayCents: 0, todayEasyPayCents: 0 });
  getDailyIncomeTrend.mockResolvedValue([]);
  getOrderList.mockResolvedValue({ total: 0, orders: [] });
  getOrderDetail.mockResolvedValue(null);
  importCards.mockResolvedValue({ batchId: "batch-1", imported: 1, skipped: 0, errors: [] });
  getCardList.mockResolvedValue({ total: 0, results: [] });
  getCouponList.mockResolvedValue({ total: 0, results: [] });
  getAdminProducts.mockResolvedValue({ total: 0, products: [] });
  duplicateProduct.mockResolvedValue("copied-product");
  getMergedLogs.mockResolvedValue({ total: 0, logs: [] });
  getEmailLogList.mockResolvedValue({ total: 0, results: [], snapshotAt: "", nextCursor: "", hasMore: false });
  batchDeleteOrders.mockResolvedValue({ deleted: 0, blocked: 0, force: false, unlinkRefs: false });
  batchDeleteCards.mockResolvedValue({ deleted: 0, blocked: 0, force: false, unlinkRefs: false });
  batchDeleteEmailLogs.mockResolvedValue({ deleted: 0 });
  batchDeleteMergedLogs.mockResolvedValue({ deleted: 0, request: 0, admin: 0 });
  clearAllMergedLogs.mockResolvedValue({ deleted: 0, request: 0, admin: 0, retainedAuditId: "audit-clear" });
  getLowStockProducts.mockResolvedValue([]);
  sendLowStockWarningEmailWithDedup.mockResolvedValue({ ok: true, message: "sent", sent: true, count: 1 });
  getTodayPendingTasks.mockResolvedValue({ pendingOfflinePayments: [], paidButNotIssued: [], lowStockProducts: [] });
  mockReadRuntimeConfig.mockResolvedValue({});
  mockMergeRuntimeConfig.mockImplementation((dbConfig: Record<string, unknown>) => dbConfig);
  recordPaidOrderFulfillmentProgress.mockResolvedValue("recorded");
  writeAdminAudit.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("admin session endpoint", () => {
  it("accepts only a matching ADMIN_TOKEN without requiring database work", async () => {
    const app = createProtectedApp();

    const rejected = await app.request("/api/admin/session", {
      headers: { Authorization: "Bearer wrong-token" },
    }, { ADMIN_TOKEN: "correct-token" });
    expect(rejected.status).toBe(401);

    const accepted = await app.request("/api/admin/session", {
      headers: { Authorization: "Bearer correct-token" },
    }, { ADMIN_TOKEN: "correct-token" });
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("Cache-Control")).toBe("no-store");
    await expect(accepted.json()).resolves.toEqual({ ok: true });
  });
});

describe("adminRoute export endpoints", () => {
  it("returns real CSV content for order export", async () => {
    exportOrders.mockResolvedValue({
      rows: [
        {
          orderNo: "ORD-001",
          productTitle: "Test Product",
          buyerContact: "buyer",
          buyerEmail: "buyer@example.com",
          amountCents: 1000,
          discountCents: 0,
          currency: "CNY",
          status: "paid",
          paymentProvider: "easypay",
          paymentMethod: "online",
          batchId: "",
          accountLabel: "",
          deliveryNote: "",
          createdAt: "2026-01-01T00:00:00Z",
          paidAt: "2026-01-01T00:01:00Z",
          issuedAt: "2026-01-01T00:02:00Z",
        },
      ],
      nextCursor: "",
      hasMore: false,
    });

    const res = await createApp().request("/api/admin/orders/export?format=csv", {
      headers: { Authorization: "Bearer token" },
    }, { ADMIN_TOKEN: "token" });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const body = await res.text();
    expect(body).toContain("orderNo,productTitle");
    expect(body).toContain("ORD-001");
  });

  it("returns real CSV content for finance export", async () => {
    exportFinance.mockResolvedValue({
      orders: [
        {
          orderNo: "FIN-001",
          productTitle: "Finance Product",
          buyerContact: "buyer",
          buyerEmail: "buyer@example.com",
          amountCents: 2000,
          discountCents: 100,
          currency: "CNY",
          status: "issued",
          paymentProvider: "easypay",
          paymentMethod: "online",
          batchId: "",
          accountLabel: "",
          deliveryNote: "",
          createdAt: "2026-01-01T00:00:00Z",
          paidAt: "2026-01-01T00:01:00Z",
          issuedAt: "2026-01-01T00:02:00Z",
        },
      ],
      balanceTransactions: [],
      summary: {
        currency: "CNY",
        totalIncomeCents: 2000,
        totalCardIssuedCents: 2000,
        totalBalanceSpentCents: 0,
        totalRefundCents: 0,
        totalsByCurrency: {
          CNY: {
            totalIncomeCents: 2000,
            totalCardIssuedCents: 2000,
            totalBalanceSpentCents: 0,
            totalRefundCents: 0,
          },
          JPY: {
            totalIncomeCents: 500,
            totalCardIssuedCents: 0,
            totalBalanceSpentCents: 0,
            totalRefundCents: 0,
          },
        },
      },
      nextCursor: "",
      hasMore: false,
    });

    const res = await createApp().request("/api/admin/finance/export?format=csv", {
      headers: { Authorization: "Bearer token" },
    }, { ADMIN_TOKEN: "token" });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const body = await res.text();
    expect(body).toContain("# 订单");
    expect(body).toContain("FIN-001");
    expect(body).toContain("# 按币种汇总（金额为对应币种最小单位）");
    expect(body).toContain("currency,totalIncomeMinor,totalCardIssuedMinor,totalBalanceSpentMinor,totalRefundMinor");
    expect(body).toContain('"CNY","2000","2000","0","0"');
    expect(body).toContain('"JPY","500","0","0","0"');
    expect(body).not.toContain("（分）");
  });

  it("returns real CSV content for card import template download", async () => {
    const res = await createApp().request("/api/admin/cards/import-template", {
      headers: { Authorization: "Bearer token" },
    }, { ADMIN_TOKEN: "token" });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const body = await res.text();
    expect(body).toContain("accountLabel,deliverySecret,deliveryNote,expiresAt");
    expect(body).toContain("user001");
  });

  it("accepts card import for legacy unicode product ids generated from Chinese titles", async () => {
    const productId = "useai兑换码-用户福利";
    const res = await createApp().request("/api/admin/cards/import", {
      method: "POST",
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      body: JSON.stringify({
        productId,
        batchName: "7.17日",
        cards: [{ accountLabel: "yh001", deliverySecret: "15782c8a9f704fdea733038c599cb20d" }],
      }),
    }, { ADMIN_TOKEN: "token" });

    expect(res.status).toBe(201);
    expect(importCards).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ productId }));
  });

  it("rejects product ids with URL separators using an actionable message", async () => {
    const res = await createApp().request("/api/admin/cards/import", {
      method: "POST",
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      body: JSON.stringify({
        productId: "useai/兑换码",
        batchName: "7.17日",
        cards: [{ accountLabel: "yh001", deliverySecret: "15782c8a9f704fdea733038c599cb20d" }],
      }),
    }, { ADMIN_TOKEN: "token" });

    expect(res.status).toBe(400);
    expect(importCards).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      error: "请求参数无效",
      details: {
        fieldErrors: {
          productId: [expect.stringContaining("商品 ID 必须是 2-80 位")],
        },
      },
    });
  });
});

describe("adminRoute logs endpoint", () => {
  it("passes operation filters to merged log service", async () => {
    getMergedLogs.mockResolvedValue({
      total: 1,
      snapshotAt: "2026-01-01T00:00:00.000Z",
      nextCursor: "next-page",
      hasMore: true,
      logs: [
        {
          type: "admin",
          action: "update_product",
          targetType: "product",
          targetId: "prod_1",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
    });

    const res = await createApp().request(
      "/api/admin/logs?limit=30&action=update_product&targetType=product&targetId=prod_1&cursor=current-page",
      {
        headers: { Authorization: "Bearer token" },
      },
      { ADMIN_TOKEN: "token" },
    );

    expect(res.status).toBe(200);
    expect(getMergedLogs).toHaveBeenCalledWith({}, 30, {
      action: "update_product",
      targetType: "product",
      targetId: "prod_1",
      snapshotAt: undefined,
      cursor: "current-page",
    });
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      total: 1,
      logs: [{ action: "update_product", targetType: "product", targetId: "prod_1" }],
      nextCursor: "next-page",
      hasMore: true,
    });
  });

  it("clamps invalid pagination to safe values", async () => {
    const res = await createApp().request("/api/admin/logs?page=-3&limit=-9", {
      headers: { Authorization: "Bearer token" },
    }, { ADMIN_TOKEN: "token" });

    expect(res.status).toBe(200);
    expect(getMergedLogs).toHaveBeenCalledWith({}, 1, {
      action: undefined,
      targetType: undefined,
      targetId: undefined,
      snapshotAt: undefined,
      cursor: undefined,
    });
  });

  it("maps invalid cursors to a 400 response", async () => {
    const error = new Error("日志分页游标无效或与当前筛选条件不匹配");
    error.name = "InvalidLogCursorError";
    getMergedLogs.mockRejectedValueOnce(error);

    const res = await createApp().request("/api/admin/logs?cursor=invalid", {
      headers: { Authorization: "Bearer token" },
    }, { ADMIN_TOKEN: "token" });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      error: "日志分页游标无效或与当前筛选条件不匹配",
    });
  });

  it("rejects legacy offset pages instead of silently returning page one", async () => {
    const callsBefore = getMergedLogs.mock.calls.length;
    const res = await createApp().request("/api/admin/logs?page=2", {
      headers: { Authorization: "Bearer token" },
    }, { ADMIN_TOKEN: "token" });

    expect(res.status).toBe(400);
    expect(getMergedLogs.mock.calls).toHaveLength(callsBefore);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("nextCursor"),
    });
  });

  it("rejects oversized filters before they can produce an unusable cursor", async () => {
    const callsBefore = getMergedLogs.mock.calls.length;
    const res = await createApp().request(`/api/admin/logs?action=${"x".repeat(101)}`, {
      headers: { Authorization: "Bearer token" },
    }, { ADMIN_TOKEN: "token" });

    expect(res.status).toBe(400);
    expect(getMergedLogs.mock.calls).toHaveLength(callsBefore);
  });
});

describe("adminRoute test email endpoint", () => {
  it("rejects test email when Resend config is unavailable", async () => {
    mockMergeRuntimeConfig.mockReturnValueOnce({ resendApiKey: "", emailFrom: "" });
    const res = await createApp().request("/api/admin/test-email", {
      method: "POST",
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      body: JSON.stringify({ to: "ops@example.com" }),
    }, { ADMIN_TOKEN: "token" });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("RESEND_API_KEY 未配置"),
    });
  });

  it("rejects invalid recipient before calling Resend", async () => {
    mockMergeRuntimeConfig.mockReturnValueOnce({
      resendApiKey: "re_test_key",
      emailFrom: "shop <noreply@example.com>",
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await createApp().request("/api/admin/test-email", {
      method: "POST",
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      body: JSON.stringify({ to: "not-an-email" }),
    }, { ADMIN_TOKEN: "token" });

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("请提供有效的邮箱地址"),
    });
  });

  it("sends a provider request for test email and returns the Resend id", async () => {
    mockMergeRuntimeConfig.mockReturnValueOnce({
      resendApiKey: "re_test_key",
      emailFrom: "shop <noreply@example.com>",
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "email_resend_1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await createApp().request("/api/admin/test-email", {
      method: "POST",
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      body: JSON.stringify({ to: "ops@example.com" }),
    }, { ADMIN_TOKEN: "token" });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith("https://api.resend.com/emails", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        Authorization: "Bearer re_test_key",
        "Content-Type": "application/json",
      }),
    }));
    const payload = JSON.parse(String(fetchMock.mock.calls[0][1]?.body || "{}"));
    expect(payload).toMatchObject({
      from: "shop <noreply@example.com>",
      to: "ops@example.com",
      subject: "📧 eshop 邮件服务测试",
    });
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      resendId: "email_resend_1",
    });
  });

  it("returns provider errors from test email without hiding the configuration problem", async () => {
    mockMergeRuntimeConfig.mockReturnValueOnce({
      resendApiKey: "re_bad_key",
      emailFrom: "bad@example.com",
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: "domain is not verified" }), { status: 403 }),
    ));

    const res = await createApp().request("/api/admin/test-email", {
      method: "POST",
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      body: JSON.stringify({ to: "ops@example.com" }),
    }, { ADMIN_TOKEN: "token" });

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("domain is not verified"),
    });
  });
});

describe("adminRoute email logs endpoint", () => {
  it("passes and returns the email log cursor contract", async () => {
    getEmailLogList.mockResolvedValueOnce({
      total: 2,
      results: [{ id: "email-2" }],
      snapshotAt: "2026-01-01T00:00:00.000Z",
      nextCursor: "email-next",
      hasMore: true,
    });

    const res = await createApp().request("/api/admin/email-logs?status=sent&search=buyer&limit=10&cursor=email-current", {
      headers: { Authorization: "Bearer token" },
    }, { ADMIN_TOKEN: "token" });

    expect(res.status).toBe(200);
    expect(getEmailLogList).toHaveBeenCalledWith({}, {
      status: "sent",
      search: "buyer",
      limit: 10,
      snapshotAt: undefined,
      cursor: "email-current",
    });
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      results: [{ id: "email-2" }],
      nextCursor: "email-next",
      hasMore: true,
    });
  });

  it("rejects legacy email log offset pages", async () => {
    const callsBefore = getEmailLogList.mock.calls.length;
    const res = await createApp().request("/api/admin/email-logs?page=2", {
      headers: { Authorization: "Bearer token" },
    }, { ADMIN_TOKEN: "token" });

    expect(res.status).toBe(400);
    expect(getEmailLogList.mock.calls).toHaveLength(callsBefore);
  });

  it("deletes selected email logs through the batch endpoint", async () => {
    batchDeleteEmailLogs.mockResolvedValueOnce({ deleted: 2 });

    const res = await createApp().request("/api/admin/email-logs/batch-delete", {
      method: "POST",
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ["email-1", "email-2"] }),
    }, { ADMIN_TOKEN: "token" });

    expect(res.status).toBe(200);
    expect(batchDeleteEmailLogs).toHaveBeenCalledWith({}, ["email-1", "email-2"]);
    await expect(res.json()).resolves.toMatchObject({ ok: true, deleted: 2 });
  });
});

describe("adminRoute cards endpoint", () => {
  it("passes buyer filters from web card queries", async () => {
    getCardList.mockResolvedValue({ total: 0, results: [] });

    const res = await createApp().request(
      "/api/admin/cards?productId=prod-1&batchId=batch-1&status=issued&buyerEmail=buyer%40example.com&buyerContact=wx-001&genericOnly=true&page=3&limit=50",
      {
        headers: { Authorization: "Bearer token" },
      },
      { ADMIN_TOKEN: "token" },
    );

    expect(res.status).toBe(200);
    expect(getCardList).toHaveBeenCalledWith({}, {
      productId: "prod-1",
      batchId: "batch-1",
      status: "issued",
      buyerEmail: "buyer@example.com",
      buyerContact: "wx-001",
      genericOnly: true,
      page: 3,
      limit: 50,
    });
  });

  it("deletes selected available or disabled cards through the batch endpoint", async () => {
    batchDeleteCards.mockResolvedValueOnce({ deleted: 2, blocked: 0, force: false, unlinkRefs: false });

    const res = await createApp().request("/api/admin/cards/batch-delete", {
      method: "POST",
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ["card-1", "card-2"] }),
    }, { ADMIN_TOKEN: "token" });

    expect(res.status).toBe(200);
    expect(batchDeleteCards).toHaveBeenCalledWith({}, ["card-1", "card-2"], {
      force: false,
      unlinkRefs: false,
    });
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      deleted: 2,
      blocked: 0,
      force: false,
      unlinkRefs: false,
    });
  });

  it("forwards force and unlinkRefs when deleting cards", async () => {
    batchDeleteCards.mockResolvedValueOnce({ deleted: 1, blocked: 0, force: true, unlinkRefs: true });

    const res = await createApp().request("/api/admin/cards/batch-delete", {
      method: "POST",
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ["issued-card"], force: true, unlinkRefs: true }),
    }, { ADMIN_TOKEN: "token" });

    expect(res.status).toBe(200);
    expect(batchDeleteCards).toHaveBeenCalledWith({}, ["issued-card"], {
      force: true,
      unlinkRefs: true,
    });
  });

  it("rejects batch card deletion when protected cards are selected", async () => {
    batchDeleteCards.mockResolvedValueOnce({ deleted: 0, blocked: 1, force: false, unlinkRefs: false });

    const res = await createApp().request("/api/admin/cards/batch-delete", {
      method: "POST",
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ["issued-card"] }),
    }, { ADMIN_TOKEN: "token" });

    expect(res.status).toBe(409);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("不可删除");
    expect(body.error).toContain("全部删除");
    expect(body.error).toContain("解绑订单引用");
  });
});

describe("adminRoute log batch delete endpoint", () => {
  it("deletes selected merged logs with explicit type and id", async () => {
    batchDeleteMergedLogs.mockResolvedValueOnce({ deleted: 2, request: 1, admin: 1 });

    const res = await createApp().request("/api/admin/logs/batch-delete", {
      method: "POST",
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      body: JSON.stringify({
        logs: [
          { type: "request", id: "req-1" },
          { type: "admin", id: "audit-1" },
        ],
      }),
    }, { ADMIN_TOKEN: "token" });

    expect(res.status).toBe(200);
    expect(batchDeleteMergedLogs).toHaveBeenCalledWith({}, [
      { type: "request", id: "req-1" },
      { type: "admin", id: "audit-1" },
    ]);
    await expect(res.json()).resolves.toMatchObject({ ok: true, deleted: 2, request: 1, admin: 1 });
  });

  it("clears all merged logs only with the explicit confirmation phrase", async () => {
    clearAllMergedLogs.mockResolvedValueOnce({
      deleted: 5,
      request: 3,
      admin: 2,
      retainedAuditId: "audit-clear",
    });

    const rejected = await createApp().request("/api/admin/logs/clear", {
      method: "POST",
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation: "wrong" }),
    }, { ADMIN_TOKEN: "token" });
    expect(rejected.status).toBe(400);
    expect(clearAllMergedLogs).not.toHaveBeenCalled();

    const accepted = await createApp().request("/api/admin/logs/clear", {
      method: "POST",
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation: "CLEAR_ALL_LOGS" }),
    }, { ADMIN_TOKEN: "token" });

    expect(accepted.status).toBe(200);
    expect(clearAllMergedLogs).toHaveBeenCalledWith({}, "ip-hash");
    await expect(accepted.json()).resolves.toMatchObject({
      ok: true,
      deleted: 5,
      retainedAuditId: "audit-clear",
    });
  });
});

describe("adminRoute low-stock notification", () => {
  it("returns count zero when no low-stock products need notification", async () => {
    getLowStockProducts.mockResolvedValueOnce([]);

    const res = await createApp().request("/api/admin/low-stock-products/notify", {
      method: "POST",
      headers: { Authorization: "Bearer token" },
    }, { ADMIN_TOKEN: "token" });

    expect(res.status).toBe(200);
    expect(sendLowStockWarningEmailWithDedup).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      sent: false,
      count: 0,
    });
  });

  it("sends low-stock warnings through the 24h dedup service", async () => {
    getLowStockProducts.mockResolvedValueOnce([
      { id: "prod-low", title: "低库存", category: "默认", stock: 1 },
    ]);
    mockReadRuntimeConfig.mockResolvedValueOnce({ resendApiKey: "db-key", emailFrom: "ops@example.com" });
    mockMergeRuntimeConfig.mockReturnValueOnce({ resendApiKey: "db-key", emailFrom: "ops@example.com" });
    sendLowStockWarningEmailWithDedup.mockResolvedValueOnce({
      ok: true,
      message: "sent",
      sent: true,
      count: 1,
    });

    const res = await createApp().request("/api/admin/low-stock-products/notify?threshold=3", {
      method: "POST",
      headers: { Authorization: "Bearer token" },
    }, { ADMIN_TOKEN: "token" });

    expect(res.status).toBe(200);
    expect(sendLowStockWarningEmailWithDedup).toHaveBeenCalledWith(
      {},
      { resendApiKey: "db-key", emailFrom: "ops@example.com" },
      [{ id: "prod-low", title: "低库存", category: "默认", stock: 1 }],
      3,
      "ip-hash",
    );
    await expect(res.json()).resolves.toMatchObject({ ok: true, sent: true, count: 1 });
  });
});

describe("adminRoute order query endpoints", () => {
  it("deletes selected terminal orders through the batch endpoint", async () => {
    batchDeleteOrders.mockResolvedValueOnce({ deleted: 2, blocked: 0, force: false, unlinkRefs: false });

    const res = await createApp().request("/api/admin/orders/batch-delete", {
      method: "POST",
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ["order-1", "order-2"] }),
    }, { ADMIN_TOKEN: "token" });

    expect(res.status).toBe(200);
    expect(batchDeleteOrders).toHaveBeenCalledWith({}, ["order-1", "order-2"], {
      force: false,
      unlinkRefs: false,
    });
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      deleted: 2,
      blocked: 0,
      force: false,
      unlinkRefs: false,
    });
  });

  it("forwards force and unlinkRefs when deleting orders", async () => {
    batchDeleteOrders.mockResolvedValueOnce({ deleted: 1, blocked: 0, force: true, unlinkRefs: true });

    const res = await createApp().request("/api/admin/orders/batch-delete", {
      method: "POST",
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ["issued-order"], force: true, unlinkRefs: true }),
    }, { ADMIN_TOKEN: "token" });

    expect(res.status).toBe(200);
    expect(batchDeleteOrders).toHaveBeenCalledWith({}, ["issued-order"], {
      force: true,
      unlinkRefs: true,
    });
  });

  it("rejects batch deletion when protected orders are selected", async () => {
    batchDeleteOrders.mockResolvedValueOnce({ deleted: 0, blocked: 1, force: false, unlinkRefs: false });

    const res = await createApp().request("/api/admin/orders/batch-delete", {
      method: "POST",
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ["issued-order"] }),
    }, { ADMIN_TOKEN: "token" });

    expect(res.status).toBe(409);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("不可删除");
    expect(body.error).toContain("全部删除");
    expect(body.error).toContain("解绑卡密引用");
  });

  it("only hints missing switches when force is already true", async () => {
    batchDeleteOrders.mockResolvedValueOnce({ deleted: 0, blocked: 2, force: true, unlinkRefs: false });

    const res = await createApp().request("/api/admin/orders/batch-delete", {
      method: "POST",
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ["a", "b"], force: true }),
    }, { ADMIN_TOKEN: "token" });

    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("解绑卡密引用");
    expect(body.error).not.toContain("全部删除");
  });

  it("passes comma-separated statuses as a status list", async () => {
    getOrderList.mockResolvedValue({ total: 0, orders: [] });

    const res = await createApp().request("/api/admin/orders?status=failed,canceled,expired&page=4&limit=20", {
      headers: { Authorization: "Bearer token" },
    }, { ADMIN_TOKEN: "token" });

    expect(res.status).toBe(200);
    expect(getOrderList).toHaveBeenCalledWith({}, {
      status: ["failed", "canceled", "expired"],
      productId: "",
      q: "",
      buyerContact: "",
      paymentMethod: "",
      orderSource: "",
      storefrontId: "",
      page: 4,
      limit: 20,
    });
  });

  it("passes order export filters consistently", async () => {
    exportOrders.mockResolvedValue({ rows: [], nextCursor: "", hasMore: false });

    const res = await createApp().request(
      "/api/admin/orders/export?format=csv&status=failed,canceled&productId=prod-1&q=buyer&paymentMethod=offline&limit=1000",
      {
        headers: { Authorization: "Bearer token" },
      },
      { ADMIN_TOKEN: "token" },
    );

    expect(res.status).toBe(200);
    expect(exportOrders).toHaveBeenCalledWith({}, {
      status: ["failed", "canceled"],
      productId: "prod-1",
      q: "buyer",
      paymentMethod: "offline",
      orderSource: "",
      storefrontId: "",
      cursor: "",
      limit: 1000,
    });
  });

  it("passes finance export status lists consistently", async () => {
    exportFinance.mockResolvedValue({
      orders: [],
      balanceTransactions: [],
      summary: {
        totalIncomeCents: 0,
        totalCardIssuedCents: 0,
        totalBalanceSpentCents: 0,
        totalRefundCents: 0,
      },
      nextCursor: "",
      hasMore: false,
    });

    const res = await createApp().request(
      "/api/admin/finance/export?format=json&status=failed,canceled&productId=prod-1&q=buyer&paymentMethod=offline&limit=1000",
      {
        headers: { Authorization: "Bearer token" },
      },
      { ADMIN_TOKEN: "token" },
    );

    expect(res.status).toBe(200);
    expect(exportFinance).toHaveBeenCalledWith({}, {
      status: ["failed", "canceled"],
      productId: "prod-1",
      q: "buyer",
      paymentMethod: "offline",
      orderSource: "",
      storefrontId: "",
      cursor: "",
      limit: 1000,
    });
  });
});

describe("adminRoute products endpoint", () => {
  it("passes low-stock filter from dashboard shortcuts", async () => {
    getAdminProducts.mockResolvedValue({ total: 0, products: [] });

    const res = await createApp().request("/api/admin/products?active=true&stock=low&page=1&limit=20", {
      headers: { Authorization: "Bearer token" },
    }, { ADMIN_TOKEN: "token" });

    expect(res.status).toBe(200);
    expect(getAdminProducts).toHaveBeenCalledWith({}, {
      q: "",
      active: "true",
      category: "",
      stock: "low",
      storefrontId: "",
      page: 1,
      limit: 20,
    });
  });

  it("returns configured product categories", async () => {
    getAdminProductCategories.mockResolvedValue([{ id: "cat-1", name: "类别1", sortOrder: 100, active: true, productCount: 2 }]);

    const res = await createApp().request("/api/admin/product-categories", {
      headers: { Authorization: "Bearer token" },
    }, { ADMIN_TOKEN: "token" });
    const body = await res.json() as { categories: Array<{ name: string }> };

    expect(res.status).toBe(200);
    expect(body.categories[0].name).toBe("类别1");
  });

  it("creates product categories for product assignment", async () => {
    createProductCategory.mockResolvedValue("cat-1");

    const res = await createApp().request("/api/admin/product-categories", {
      method: "POST",
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "类别1" }),
    }, { ADMIN_TOKEN: "token" });
    const body = await res.json() as { id: string };

    expect(res.status).toBe(201);
    expect(body.id).toBe("cat-1");
    expect(createProductCategory).toHaveBeenCalledWith(expect.anything(), { name: "类别1", sortOrder: 100, active: true });
  });

  it("creates products without requiring operators to provide an id", async () => {
    createProduct.mockResolvedValue("generated-product-id");

    const res = await createApp().request("/api/admin/products", {
      method: "POST",
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      body: JSON.stringify({ title: "新商品", priceCents: 1000 }),
    }, { ADMIN_TOKEN: "token" });
    const body = await res.json() as { productId: string };

    expect(res.status).toBe(201);
    expect(body.productId).toBe("generated-product-id");
    expect(checkProductExists).not.toHaveBeenCalled();
    expect(createProduct).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ title: "新商品" }));
  });

  it("accepts compare-at originalPriceCents when strictly above selling price", async () => {
    createProduct.mockResolvedValue("promo-product");

    const res = await createApp().request("/api/admin/products", {
      method: "POST",
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      // 现价 2 元、对比价 5 元：仅营销展示，不参与计费
      body: JSON.stringify({ title: "促销商品", priceCents: 200, originalPriceCents: 500 }),
    }, { ADMIN_TOKEN: "token" });

    expect(res.status).toBe(201);
    expect(createProduct).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      priceCents: 200,
      originalPriceCents: 500,
    }));
  });

  it("rejects create when originalPriceCents is not higher than priceCents", async () => {
    const res = await createApp().request("/api/admin/products", {
      method: "POST",
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      body: JSON.stringify({ title: "脏对比价", priceCents: 500, originalPriceCents: 500 }),
    }, { ADMIN_TOKEN: "token" });

    expect(res.status).toBe(400);
    expect(createProduct).not.toHaveBeenCalled();
  });

  it("normalizes zero originalPriceCents to null on create", async () => {
    createProduct.mockResolvedValue("no-promo-product");

    const res = await createApp().request("/api/admin/products", {
      method: "POST",
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      body: JSON.stringify({ title: "无促销", priceCents: 200, originalPriceCents: 0 }),
    }, { ADMIN_TOKEN: "token" });

    expect(res.status).toBe(201);
    expect(createProduct).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      priceCents: 200,
      originalPriceCents: null,
    }));
  });

  it("rejects patch when next price would exceed stored compare-at price", async () => {
    getProductCommerceState.mockResolvedValue({
      currency: "CNY",
      active: true,
      priceCents: 200,
      originalPriceCents: 500,
    });

    const res = await createApp().request("/api/admin/products/promo-1", {
      method: "PATCH",
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      body: JSON.stringify({ priceCents: 600 }),
    }, { ADMIN_TOKEN: "token" });
    const body = await res.json() as { details?: { code?: string }; error?: string };

    expect(res.status).toBe(400);
    expect(body.details?.code).toBe("PRODUCT_ORIGINAL_PRICE_INVALID");
    expect(updateProduct).not.toHaveBeenCalled();
  });

  it("allows clearing compare-at price via null on patch", async () => {
    getProductCommerceState.mockResolvedValue({
      currency: "CNY",
      active: true,
      priceCents: 200,
      originalPriceCents: 500,
    });
    updateProduct.mockResolvedValue(undefined);

    const res = await createApp().request("/api/admin/products/promo-1", {
      method: "PATCH",
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      body: JSON.stringify({ originalPriceCents: null }),
    }, { ADMIN_TOKEN: "token" });

    expect(res.status).toBe(200);
    expect(updateProduct).toHaveBeenCalledWith(expect.anything(), "promo-1", expect.objectContaining({
      originalPriceCents: null,
    }));
  });

  it("accepts HTTPS and same-origin relative product cover URLs", async () => {
    createProduct.mockResolvedValue("covered-product");

    const httpsRes = await createApp().request("/api/admin/products", {
      method: "POST",
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      body: JSON.stringify({ title: "外链封面", priceCents: 1000, coverUrl: "https://cdn.example.com/product.webp" }),
    }, { ADMIN_TOKEN: "token" });
    const relativeRes = await createApp().request("/api/admin/products", {
      method: "POST",
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      body: JSON.stringify({ title: "站内封面", priceCents: 1000, coverUrl: "/api/media/products/cover.webp" }),
    }, { ADMIN_TOKEN: "token" });

    expect(httpsRes.status).toBe(201);
    expect(relativeRes.status).toBe(201);
    expect(createProduct).toHaveBeenNthCalledWith(1, expect.anything(), expect.objectContaining({
      coverUrl: "https://cdn.example.com/product.webp",
    }));
    expect(createProduct).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({
      coverUrl: "/api/media/products/cover.webp",
    }));
  });

  it("rejects unsafe product cover URL protocols", async () => {
    const res = await createApp().request("/api/admin/products", {
      method: "POST",
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      body: JSON.stringify({ title: "不安全封面", priceCents: 1000, coverUrl: "data:image/svg+xml;base64,PHN2Zz4=" }),
    }, { ADMIN_TOKEN: "token" });

    expect(res.status).toBe(400);
    expect(createProduct).not.toHaveBeenCalled();
  });

  it("normalizes supported product currency codes", async () => {
    createProduct.mockResolvedValue("draft-usd");

    const res = await createApp().request("/api/admin/products", {
      method: "POST",
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      body: JSON.stringify({ title: "USD 草稿", priceCents: 1000, currency: " usd ", active: false }),
    }, { ADMIN_TOKEN: "token" });

    expect(res.status).toBe(201);
    expect(createProduct).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ currency: "USD", active: false }));
  });

  it("rejects active non-CNY products until a matching payment provider exists", async () => {
    const res = await createApp().request("/api/admin/products", {
      method: "POST",
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      body: JSON.stringify({ title: "USD 商品", priceCents: 1000, currency: "USD", active: true }),
    }, { ADMIN_TOKEN: "token" });
    const body = await res.json() as { details?: { code?: string } };

    expect(res.status).toBe(400);
    expect(body.details?.code).toBe("PRODUCT_CURRENCY_NOT_SELLABLE");
    expect(createProduct).not.toHaveBeenCalled();
  });

  it("rejects currencies outside the supported metadata set", async () => {
    const res = await createApp().request("/api/admin/products", {
      method: "POST",
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      body: JSON.stringify({ title: "GBP 商品", priceCents: 1000, currency: "GBP", active: false }),
    }, { ADMIN_TOKEN: "token" });

    expect(res.status).toBe(400);
    expect(createProduct).not.toHaveBeenCalled();
  });

  it("does not re-enable an existing non-CNY draft through an active-only patch", async () => {
    getProductCommerceState.mockResolvedValue({
      currency: "USD",
      active: false,
      priceCents: 1000,
      originalPriceCents: null,
    });

    const res = await createApp().request("/api/admin/products/usd-draft", {
      method: "PATCH",
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      body: JSON.stringify({ active: true }),
    }, { ADMIN_TOKEN: "token" });
    const body = await res.json() as { details?: { code?: string } };

    expect(res.status).toBe(400);
    expect(body.details?.code).toBe("PRODUCT_CURRENCY_NOT_SELLABLE");
  });

  it("normalizes empty and zero purchase limits to unlimited", async () => {
    createProduct.mockResolvedValue("unlimited-product");

    const emptyRes = await createApp().request("/api/admin/products", {
      method: "POST",
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      body: JSON.stringify({ title: "不限购空值", priceCents: 1000, purchaseLimit: "", purchaseLimitDisplay: true }),
    }, { ADMIN_TOKEN: "token" });
    const zeroRes = await createApp().request("/api/admin/products", {
      method: "POST",
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      body: JSON.stringify({ title: "不限购 0", priceCents: 1000, purchaseLimit: 0, purchaseLimitDisplay: true }),
    }, { ADMIN_TOKEN: "token" });

    expect(emptyRes.status).toBe(201);
    expect(zeroRes.status).toBe(201);
    expect(createProduct).toHaveBeenNthCalledWith(1, expect.anything(), expect.objectContaining({
      purchaseLimit: null,
      purchaseLimitDisplay: true,
    }));
    expect(createProduct).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({
      purchaseLimit: null,
      purchaseLimitDisplay: true,
    }));
  });

  it("duplicates an existing product through a database insert path", async () => {
    duplicateProduct.mockResolvedValue("product-copy");

    const res = await createApp().request("/api/admin/products/source-product/duplicate", {
      method: "POST",
      headers: { Authorization: "Bearer token" },
    }, { ADMIN_TOKEN: "token" });
    const body = await res.json() as { productId: string };

    expect(res.status).toBe(201);
    expect(body.productId).toBe("product-copy");
    expect(duplicateProduct).toHaveBeenCalledWith(expect.anything(), "source-product");
    expect(writeAdminAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "duplicate_product",
      targetType: "product",
      targetId: "product-copy",
      metadata: { sourceProductId: "source-product" },
    }));
  });

  it("creates coupons without requiring operators to provide a code", async () => {
    upsertCoupon.mockResolvedValue("auto-coupon-1");

    const res = await createApp().request("/api/admin/coupons", {
      method: "POST",
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      body: JSON.stringify({ productId: "prod-1", discountType: "fixed", discountValue: 100, maxUses: 1, active: true }),
    }, { ADMIN_TOKEN: "token" });
    const body = await res.json() as { code: string };

    expect(res.status).toBe(201);
    expect(body.code).toBe("auto-coupon-1");
    expect(upsertCoupon).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ code: "" }));
  });
});

describe("adminRoute order payment operations", () => {
  it("rejects manual mark-paid for online pending orders", async () => {
    getOrderDetail.mockResolvedValueOnce({ id: "order-online", status: "pending", paymentMethod: "online" });

    const res = await createApp().request("/api/admin/orders/order-online/mark-paid", {
      method: "POST",
      headers: { Authorization: "Bearer token" },
    }, { ADMIN_TOKEN: "token" });
    const body = await res.json() as { ok: boolean; error: string };

    expect(res.status).toBe(409);
    expect(body.error).toBe("仅线下待收款订单允许人工确认收款");
    expect(markPaidAndIssue).not.toHaveBeenCalled();
  });

  it("allows manual mark-paid for offline pending orders", async () => {
    getOrderDetail.mockResolvedValueOnce({ id: "order-offline", status: "pending", paymentMethod: "offline" });
    vi.mocked(markPaidAndIssue).mockResolvedValueOnce({ ok: true, card: { id: "card-1" } as never, cards: [{ id: "card-1" }] as never });

    const res = await createApp().request("/api/admin/orders/order-offline/mark-paid", {
      method: "POST",
      headers: { Authorization: "Bearer token" },
    }, { ADMIN_TOKEN: "token" });

    expect(res.status).toBe(200);
    expect(markPaidAndIssue).toHaveBeenCalledWith(
      expect.anything(),
      "order-offline",
      expect.anything(),
      expect.objectContaining({ waitUntil: expect.any(Function) }),
    );
  });

  it("rejects fulfillment retry unless the order is paid", async () => {
    getOrderDetail.mockResolvedValueOnce({ id: "order-pending", status: "pending", paymentMethod: "online" });

    const res = await createApp().request("/api/admin/orders/order-pending/retry-fulfillment", {
      method: "POST",
      headers: { Authorization: "Bearer token" },
    }, { ADMIN_TOKEN: "token" });
    const body = await res.json() as { error: string };

    expect(res.status).toBe(409);
    expect(body.error).toBe("仅已支付但未完成交付的订单允许重试履约");
    expect(markPaidAndIssue).not.toHaveBeenCalled();
  });

  it("retries fulfillment for a paid order", async () => {
    getOrderDetail.mockResolvedValueOnce({ id: "order-paid", status: "paid", paymentMethod: "online" });
    vi.mocked(markPaidAndIssue).mockResolvedValueOnce({ ok: true, card: { id: "card-1" } as never, cards: [{ id: "card-1" }] as never });

    const res = await createApp().request("/api/admin/orders/order-paid/retry-fulfillment", {
      method: "POST",
      headers: { Authorization: "Bearer token" },
    }, { ADMIN_TOKEN: "token" });
    const body = await res.json() as { message: string };

    expect(res.status).toBe(200);
    expect(body.message).toBe("订单履约已重试并完成");
    expect(markPaidAndIssue).toHaveBeenCalledWith(
      expect.anything(),
      "order-paid",
      expect.anything(),
      expect.objectContaining({ waitUntil: expect.any(Function) }),
    );
  });

  it("rejects an empty fulfillment progress update before reading the order", async () => {
    const res = await createApp().request("/api/admin/orders/order-paid/fulfillment-progress", {
      method: "POST",
      headers: { Authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ stage: "supplier_processing", supplierOrderRef: "", note: "" }),
    }, { ADMIN_TOKEN: "token" });

    expect(res.status).toBe(400);
    expect(getOrderDetail).not.toHaveBeenCalled();
    expect(recordPaidOrderFulfillmentProgress).not.toHaveBeenCalled();
  });

  it("rejects fulfillment progress updates for orders that are not awaiting delivery", async () => {
    recordPaidOrderFulfillmentProgress.mockResolvedValueOnce("status_conflict");

    const res = await createApp().request("/api/admin/orders/order-pending/fulfillment-progress", {
      method: "POST",
      headers: { Authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ stage: "manual_review", note: "等待买家确认账号" }),
    }, { ADMIN_TOKEN: "token" });

    expect(res.status).toBe(409);
    expect(writeAdminAudit).not.toHaveBeenCalled();
  });

  it("records fulfillment progress and the corresponding admin audit for a paid order", async () => {
    const res = await createApp().request("/api/admin/orders/order-paid/fulfillment-progress", {
      method: "POST",
      headers: { Authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({
        stage: "supplier_processing",
        supplierOrderRef: "SUP-20260721-1",
        note: "已提交充值",
      }),
    }, { ADMIN_TOKEN: "token" });
    const body = await res.json() as { message: string };

    expect(res.status).toBe(200);
    expect(body.message).toBe("履约进度已记录");
    expect(recordPaidOrderFulfillmentProgress).toHaveBeenCalledWith(
      expect.anything(),
      "order-paid",
      "供应商处理中：供应商订单号：SUP-20260721-1；备注：已提交充值",
      { stage: "supplier_processing", supplierOrderRef: "SUP-20260721-1" },
    );
    expect(writeAdminAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "update_fulfillment_progress",
      targetType: "order",
      targetId: "order-paid",
      metadata: { stage: "supplier_processing", supplierOrderRef: "SUP-20260721-1" },
    }));
  });

  it("does not report success when the fulfillment event cannot be persisted", async () => {
    recordPaidOrderFulfillmentProgress.mockRejectedValueOnce(new Error("database unavailable"));

    const res = await createApp().request("/api/admin/orders/order-paid/fulfillment-progress", {
      method: "POST",
      headers: { Authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ stage: "failed_pending_retry", note: "上游返回失败" }),
    }, { ADMIN_TOKEN: "token" });
    const body = await res.json() as { error: string };

    expect(res.status).toBe(503);
    expect(body.error).toBe("履约进度保存失败，请重试");
    expect(writeAdminAudit).not.toHaveBeenCalled();
  });

  it("returns released card count when canceling pending order", async () => {
    cancelOrder.mockResolvedValueOnce({ id: "order-pending", releasedCardId: null, releasedCards: 2 });

    const res = await createApp().request("/api/admin/orders/order-pending/cancel", {
      method: "POST",
      headers: { Authorization: "Bearer token" },
    }, { ADMIN_TOKEN: "token" });
    const body = await res.json() as { releasedCardId: string | null; releasedCards: number };

    expect(res.status).toBe(200);
    expect(body.releasedCardId).toBeNull();
    expect(body.releasedCards).toBe(2);
    expect(cancelOrder).toHaveBeenCalledWith(expect.anything(), "order-pending");
  });
});
