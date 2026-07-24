import { describe, expect, it, vi, beforeEach } from "vitest";
import type { DbType } from "../db/client";
import type { Context } from "hono";
import type { AppEnv } from "../bindings";

import { createOrder, getOrderByToken, markPaidAndIssue, publicOrder, checkOrderRateLimit, checkProductPurchaseLimit, checkAndExpireOrder } from "./order-service";
import { getProduct } from "./product-service";
import { quoteCoupon, consumeCoupon } from "./coupon-service";
import { redeemVoucher, deductBalance, refundBalance, getUserBalance } from "./voucher-service";
import { importCards, getOrderDetail, cancelOrder } from "./admin-service";
import { releaseIssuedCard } from "./issue-service";
import { writeOrderEvent } from "./audit-service";
import { createEmailAccessCode } from "../lib/email-access";

// ── Mock external services ──
const mockGetCoupon = vi.fn();
const mockQuoteCoupon = vi.fn();
const mockConsumeCoupon = vi.fn();
const mockGetProduct = vi.fn();
const mockWriteOrderEvent = vi.fn();
const mockSendEmail = vi.fn();
const mockGetOrderRateLimitConfig = vi.fn().mockResolvedValue({ windowSeconds: 300, maxOrders: 3 });
const mockGetOrderExpireMinutes = vi.fn().mockResolvedValue(30);
const mockGetOrderExpiresAt = vi.fn().mockResolvedValue(new Date(Date.now() + 30 * 60 * 1000).toISOString());

vi.mock("./coupon-service", () => ({
  getCoupon: (...args: unknown[]) => mockGetCoupon(...args),
  quoteCoupon: (...args: unknown[]) => mockQuoteCoupon(...args),
  consumeCoupon: (...args: unknown[]) => mockConsumeCoupon(...args),
}));

vi.mock("./voucher-service", () => ({
  redeemVoucher: (...args: unknown[]) => Promise.resolve({ success: true, amountCents: 5000, message: "充值成功" }),
  deductBalance: (...args: unknown[]) => Promise.resolve(true),
  refundBalance: (...args: unknown[]) => Promise.resolve(),
  getUserBalance: (...args: unknown[]) => ({ email: "buyer-balance@example.com", balanceCents: 5000, totalDepositedCents: 5000, totalSpentCents: 0 }),
}));

vi.mock("./product-service", () => ({
  getProduct: (...args: unknown[]) => mockGetProduct(...args),
  toPublicProduct: (row: unknown) => row,
  listProducts: vi.fn(),
}));

vi.mock("./audit-service", () => ({
  writeOrderEvent: (...args: unknown[]) => mockWriteOrderEvent(...args),
}));

vi.mock("./email-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./email-service")>();
  return {
    ...actual,
    sendEmail: (...args: unknown[]) => Promise.resolve(mockSendEmail(...args) || { ok: true }),
  };
});

vi.mock("../lib/system-config-registry", async (importOriginal) => {
  const actual = await importOriginal();
  const actualObj = actual as Record<string, unknown>;
  return {
    ...actualObj,
    getOrderRateLimitConfig: (...args: unknown[]) => mockGetOrderRateLimitConfig(...args),
    getOrderExpireMinutes: (...args: unknown[]) => mockGetOrderExpireMinutes(...args),
    getOrderExpiresAt: (...args: unknown[]) => mockGetOrderExpiresAt(...args),
  };
});

// ── Reuse existing test helpers ──
function createSelectChain(results: unknown[]) {
  const chain: any = {};
  for (const method of ["where", "innerJoin", "leftJoin", "orderBy", "limit", "offset", "groupBy", "having"]) {
    chain[method] = () => chain;
  }
  chain.then = (resolve: (v: unknown[]) => void, reject?: (e: unknown) => void) =>
    Promise.resolve(results).then(resolve, reject);
  return chain;
}

interface MockDbState {
  cards?: Record<string, { status: string; productId?: string; lockedOrderId?: string | null; issuedOrderId?: string | null; accountLabel?: string; deliverySecret?: string; deliveryNote?: string; issuedAt?: string | null; buyerEmail?: string; buyerContact?: string; lockExpiresAt?: string | null }>;
  orders?: Record<string, { id: string; status: string; productId?: string; buyerEmail?: string }>;
}

function createMockDb(state: MockDbState = {}): DbType {
  const cards = state.cards || {};
  const orders = state.orders || {};

  return {
    __cards: cards,
    __orders: orders,
    select: (_colMap?: unknown) => ({
      from: (_table?: unknown) => createSelectChain([]),
    }),
    insert: (_table?: unknown) => ({
      values: (data: unknown) => {
        const p = Array.isArray(data)
          ? Promise.resolve({ rowsAffected: data.length })
          : Promise.resolve({ rowsAffected: 1 });
        const result: any = {
          onConflictDoUpdate: () => p,
          onConflictDoNothing: () => p,
        };
        result.then = p.then.bind(p);
        result.catch = p.catch.bind(p);
        result.finally = p.finally.bind(p);
        // 兼容 redeemVoucher 的 insert(...).onConflictDoUpdate(...).returning(...)
        result.returning = () => Promise.resolve([{ balanceCents: 5000 }]);
        return result;
      },
    }),
    update: (_table?: unknown) => ({
      set: (_data?: unknown) => ({
        where: () => ({
          returning: () => ({
            then: (resolve: (v: unknown) => void) => Promise.resolve([{ id: "any" }]).then(resolve),
          }),
          then: (resolve: (v: unknown) => void) => Promise.resolve({ rowsAffected: 1 }).then(resolve),
        }),
      }),
    }),
    delete: () => ({
      where: () => Promise.resolve({ rowsAffected: 0 }),
    }),
    run: (sqlExpr?: any) => {
      let sqlStr: string;
      try {
        const raw = sqlExpr?.getSQL?.() ?? sqlExpr;
        if (typeof raw === "string") {
          sqlStr = raw;
        } else if (raw?.queryChunks && Array.isArray(raw.queryChunks)) {
          sqlStr = "";
          for (const chunk of raw.queryChunks) {
            if (typeof chunk === "string") sqlStr += chunk;
            else if (chunk?.value && Array.isArray(chunk.value)) sqlStr += chunk.value.join("");
            else if (typeof chunk?.value === "string") sqlStr += chunk.value;
            else sqlStr += "?";
          }
        } else {
          sqlStr = String(raw || "");
        }
      } catch {
        sqlStr = String(sqlExpr || "");
      }
      const q = sqlStr.toLowerCase();
      // checkAndExpireOrder: UPDATE orders SET status='expired' ... RETURNING
      if (q.includes("update orders") && q.includes("expired") && q.includes("returning")) {
        return Promise.resolve({ rows: [] });
      }

      // markPaidAndIssue: UPDATE orders SET status='issued' ... RETURNING
      if (q.includes("update orders") && q.includes("issued") && q.includes("returning")) {
        return Promise.resolve({ rows: [{ id: "any" }] });
      }

      // issueAvailableCard: UPDATE cards SET status='issued' ... RETURNING
      if (q.includes("update cards") && q.includes("issued") && q.includes("returning")) {
        // Extract orderId and productId from SQL string (skip SET clause, look for WHERE clause)
        const orderIdMatch = sqlStr.match(/locked_order_id\s*=\s*([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
        const productIdMatch = sqlStr.match(/product_id\s*=\s*([a-z0-9-]+?)(?:\s+AND|\s+OR|\s+ORDER)/i);
        const targetOrderId = orderIdMatch ? orderIdMatch[1] : null;
        const targetProductId = productIdMatch ? productIdMatch[1] : null;
        // Priority 1: find card locked by this order
        if (targetOrderId) {
          for (const [cardId, card] of Object.entries(cards)) {
            if (card.status === "locked" && card.lockedOrderId === targetOrderId) {
              cards[cardId].status = "issued";
              cards[cardId].issuedOrderId = targetOrderId;
              cards[cardId].issuedAt = new Date().toISOString();
              cards[cardId].buyerEmail = card.buyerEmail || "";
              cards[cardId].buyerContact = card.buyerContact || "";
              return Promise.resolve({
                rows: [{
                  id: cardId,
                  accountLabel: card.accountLabel,
                  deliverySecret: card.deliverySecret,
                  deliveryNote: card.deliveryNote,
                }],
              });
            }
          }
        }

        // Priority 2: find available card for this product
        if (targetProductId) {
          for (const [cardId, card] of Object.entries(cards)) {
            if (card.status === "available" && card.productId === targetProductId) {
              cards[cardId].status = "issued";
              cards[cardId].issuedOrderId = targetOrderId || "";
              cards[cardId].issuedAt = new Date().toISOString();
              return Promise.resolve({
                rows: [{
                  id: cardId,
                  accountLabel: card.accountLabel,
                  deliverySecret: card.deliverySecret,
                  deliveryNote: card.deliveryNote,
                }],
              });
            }
          }
        }

        return Promise.resolve({ rows: [] });
      }

      // lockCardForOrder: UPDATE cards SET status='locked' ... RETURNING
      if (q.includes("update cards") && q.includes("status = 'locked'") && q.includes("returning")) {
        // Extract orderId from SQL string
        const orderIdMatch = sqlStr.match(/locked_order_id\s*=\s*([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
        const lockOrderId = orderIdMatch ? orderIdMatch[1] : null;
        // Extract lockExpiresAt from SQL string
        const lockExpiresAtMatch = sqlStr.match(/lock_expires_at\s*=\s*'([^']+)'/i);
        const lockExpiresAt = lockExpiresAtMatch ? lockExpiresAtMatch[1] : null;

        for (const [cardId, card] of Object.entries(cards)) {
          if (card.status === "available") {
            cards[cardId].status = "locked";
            cards[cardId].lockedOrderId = lockOrderId;
            cards[cardId].lockExpiresAt = lockExpiresAt;
            return Promise.resolve({ rows: [{ id: cardId }] });
          }
        }
        return Promise.resolve({ rows: [] });
      }

      // releaseLockedCardByOrder / releaseIssuedCard: UPDATE cards SET status='available'
      if (q.includes("update cards") && q.includes("available")) {
        if (q.includes("locked_order_id")) {
          for (const [cardId, card] of Object.entries(cards)) {
            if (card.status === "locked") {
              cards[cardId].status = "available";
              cards[cardId].lockedOrderId = null;
              cards[cardId].lockExpiresAt = null;
            }
          }
        }
        if (q.includes("issued_order_id")) {
          for (const [cardId, card] of Object.entries(cards)) {
            if (card.status === "issued") {
              cards[cardId].status = "available";
              cards[cardId].issuedOrderId = null;
              cards[cardId].issuedAt = null;
            }
          }
        }
        return Promise.resolve({ rows: [] });
      }

      return Promise.resolve({ rows: [] });
    },
  } as unknown as DbType;
}

async function checkoutEmailInput(
  productId: string,
  buyerEmail: string,
  extra: Record<string, unknown> = {},
): Promise<{ productId: string; buyerEmail: string; emailAccessCode: string } & Record<string, unknown>> {
  return {
    productId,
    buyerEmail,
    emailAccessCode: await createEmailAccessCode(buyerEmail, "test-token"),
    ...extra,
  };
}

function createMockContext(db: DbType, overrides: Record<string, unknown> = {}): Context<AppEnv> {
  const headers: Record<string, string> = { "user-agent": "test-agent", ...(overrides.headerOverrides as Record<string, string> || {}) };
  return {
    get: (key: string) => {
      if (key === "db") return db;
      if (key === "executionCtx") return { waitUntil: (p: Promise<any>) => p.catch(() => {}) } as any;
      return undefined as any;
    },
    env: {
      ADMIN_TOKEN: "test-token",
      RESEND_API_KEY: "resend-test-key",
      ...(overrides.env as Record<string, unknown> || {}),
    } as any,
    req: {
      header: (name: string) => headers[name.toLowerCase()] || undefined,
      url: "https://example.com/api",
      method: "POST",
    },
  } as unknown as Context<AppEnv>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Business Flow Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe("核心业务流测试（跨服务端到端）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCoupon.mockResolvedValue(null);
    mockQuoteCoupon.mockResolvedValue({
      couponCode: "",
      valid: true,
      discountCents: 0,
      payableCents: 1000,
      message: "无折扣码，按原价购买",
    });
    mockConsumeCoupon.mockResolvedValue({ success: true, changes: 1 });
    mockGetProduct.mockResolvedValue({
      id: "prod-1",
      title: "Test Product",
      priceCents: 1000,
      currency: "CNY",
      issueMode: "manual",
      fulfillmentMode: "card",
      active: 1,
      purchaseLimit: null,
      salesCopy: "",
    });
    mockWriteOrderEvent.mockResolvedValue(undefined);
    mockGetOrderRateLimitConfig.mockResolvedValue({ windowSeconds: 300, maxOrders: 3 });
    mockGetOrderExpireMinutes.mockResolvedValue(30);
    mockGetOrderExpiresAt.mockResolvedValue(new Date(Date.now() + 30 * 60 * 1000).toISOString());
  });

  // ── Flow 1: 直接卡密购买（direct + card，免单） ──
  describe("Flow 1: 直接卡密购买（买家浏览 → 直接下单 → 收到卡密）", () => {
    it("完整流程：创建商品 → 导入卡密 → 用户用免单券下单 → 查询订单拿到卡密", async () => {
      const productId = "prod-direct-card";
      const cardId = "card-direct-1";
      const buyerEmail = "buyer1@example.com";

      mockGetProduct.mockResolvedValue({
        id: productId,
        title: "Direct Card Product",
        priceCents: 1000,
        currency: "CNY",
        issueMode: "direct",
        fulfillmentMode: "card",
        active: 1,
        purchaseLimit: null,
        salesCopy: "",
      });

      const db = createMockDb({
        cards: {
          [cardId]: {
            status: "available",
            productId,
            accountLabel: "ACC-001",
            deliverySecret: "SECRET-001",
            deliveryNote: "Note 1",
          },
        },
      });

      // Override select for getProduct (first call)
      let selectCount = 0;
      (db as any).select = (_colMap?: unknown) => ({
        from: (_table?: unknown) => {
          selectCount += 1;
          if (selectCount === 1) {
            return createSelectChain([{
              id: productId,
              title: "Direct Card Product",
              priceCents: 1000,
              currency: "CNY",
              issueMode: "direct",
              fulfillmentMode: "card",
              active: 1,
              purchaseLimit: null,
              salesCopy: "",
            }]);
          }
          return createSelectChain([]);
        },
      });

      mockQuoteCoupon.mockResolvedValue({
        couponCode: "FREE100",
        valid: true,
        discountCents: 1000,
        payableCents: 0,
        message: "折扣码可用",
      });

      const c = createMockContext(db);
      const orderResult = await createOrder(c, await checkoutEmailInput(productId, buyerEmail, { couponCode: "FREE100" }), "ip-hash-1");

      expect(orderResult.ok).toBe(true);
      if (!orderResult.ok) return;
      expect(orderResult.order.status).toBe("issued");
      expect(orderResult.order.delivery).toBeDefined();
      expect((orderResult.order.delivery as any).accountLabel).toBe("ACC-001");
    });
  });

  // ── Flow 2: Manual + Admin Confirm ──
  describe("Flow 2: Manual + Admin Confirm（买家下单 → 管理员确认 → 发卡）", () => {
    it("完整流程：创建 manual 商品 → 导入卡密 → 用户下单(pending) → 管理员确认(issued)", async () => {
      const productId = "prod-manual-card";
      const cardId = "card-manual-1";
      const buyerEmail = "buyer2@example.com";

      mockGetProduct.mockResolvedValue({
        id: productId,
        title: "Manual Card Product",
        priceCents: 2000,
        currency: "CNY",
        issueMode: "manual",
        fulfillmentMode: "card",
        active: 1,
        purchaseLimit: null,
        salesCopy: "",
      });

      const db = createMockDb({
        cards: {
          [cardId]: {
            status: "available",
            productId,
            accountLabel: "ACC-002",
            deliverySecret: "SECRET-002",
            deliveryNote: "Note 2",
          },
        },
      });

      // Step 1: User places manual order (should be pending)
      let selectCount = 0;
      (db as any).select = (_colMap?: unknown) => ({
        from: (_table?: unknown) => {
          selectCount += 1;
          // First call: getProduct
          if (selectCount === 1) {
            return createSelectChain([{
              id: productId,
              title: "Manual Card Product",
              priceCents: 2000,
              currency: "CNY",
              issueMode: "manual",
              fulfillmentMode: "card",
              active: 1,
              purchaseLimit: null,
              salesCopy: "",
            }]);
          }
          // Second call: checkOrderRateLimit (returns count < maxOrders)
          if (selectCount === 2) {
            return createSelectChain([{ count: 0 }]);
          }
          // Third call: checkProductPurchaseLimit (returns count < limit)
          if (selectCount === 3) {
            return createSelectChain([{ count: 0 }]);
          }
          return createSelectChain([]);
        },
      });

      const c = createMockContext(db);
      const orderResult = await createOrder(c, await checkoutEmailInput(productId, buyerEmail), "ip-hash-2");

      expect(orderResult.ok).toBe(true);
      if (!orderResult.ok) return;
      expect(orderResult.order.status).toBe("pending");
      const createdOrderId = orderResult.order.id;

      // Step 2: Admin confirms payment and issues card
      // Reset select counter for markPaidAndIssue
      selectCount = 0;
      (db as any).select = (_colMap?: unknown) => ({
        from: (_table?: unknown) => {
          selectCount += 1;
          if (selectCount === 1) {
            return createSelectChain([{
              id: createdOrderId,
              orderNo: "AB20260101TEST",
              productId,
              buyerContact: "",
              buyerEmail,
              status: "pending",
              expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
              couponCode: "",
              productTitle: "Manual Card Product",
              fulfillmentMode: "card",
              deliveryJson: "",
            }]);
          }
          return createSelectChain([]);
        },
      });

      const issueResult = await markPaidAndIssue(db, createdOrderId as string);
      expect(issueResult.ok).toBe(true);
      expect((issueResult as any).card).toBeDefined();
      expect((issueResult as any).card.accountLabel).toBe("ACC-002");
    });
  });

  // ── Flow 3: Coupon Discount ──
  describe("Flow 3: Coupon Discount（应用折扣码 → 减免金额 → 下单成功）", () => {
    it("完整流程：创建商品和折扣码 → 用户用折扣码下单 → 验证减免金额", async () => {
      const productId = "prod-coupon";
      const couponCode = "SAVE20";
      const buyerEmail = "buyer3@example.com";

      mockGetProduct.mockResolvedValue({
        id: productId,
        title: "Coupon Product",
        priceCents: 1000,
        currency: "CNY",
        issueMode: "direct",
        fulfillmentMode: "card",
        active: 1,
        purchaseLimit: null,
        salesCopy: "",
      });

      mockQuoteCoupon.mockResolvedValue({
        couponCode,
        valid: true,
        discountCents: 200,
        payableCents: 0,
        message: "折扣码可用",
      });

      const db = createMockDb({
        cards: {
          "card-coupon-1": {
            status: "available",
            productId,
            accountLabel: "ACC-003",
            deliverySecret: "SECRET-003",
            deliveryNote: "Note 3",
          },
        },
      });

      let selectCount = 0;
      (db as any).select = (_colMap?: unknown) => ({
        from: (_table?: unknown) => {
          selectCount += 1;
          if (selectCount === 1) {
            return createSelectChain([{
              id: productId,
              title: "Coupon Product",
              priceCents: 1000,
              currency: "CNY",
              issueMode: "direct",
              fulfillmentMode: "card",
              active: 1,
              purchaseLimit: null,
              salesCopy: "",
            }]);
          }
          return createSelectChain([]);
        },
      });

      const c = createMockContext(db);
      const orderResult = await createOrder(c, await checkoutEmailInput(productId, buyerEmail, { couponCode }), "ip-hash-3");

      expect(orderResult.ok).toBe(true);
      if (!orderResult.ok) return;
      expect(orderResult.order.amountCents).toBe(0);
      expect(orderResult.order.status).toBe("issued");
      expect(mockConsumeCoupon).toHaveBeenCalled();
    });
  });

  // ── Flow 4: 余额支付（充值→消费） ──
  describe("Flow 4: 余额支付（充值→消费 → 订单 → 最终发卡）", () => {
    it("完整流程：充值码兑换入账 → 余额支付下单 → 管理员确认发卡", async () => {
      const productId = "prod-balance";
      const buyerEmail = "buyer-balance@example.com";
      const voucherCode = "VCH-ABCD1234";

      mockGetProduct.mockResolvedValue({
        id: productId,
        title: "Balance Product",
        priceCents: 5000,
        currency: "CNY",
        issueMode: "manual",
        fulfillmentMode: "card",
        active: 1,
        purchaseLimit: null,
        salesCopy: "",
      });

      // 扩展 mock 以支持 voucher-service 所需的状态跟踪
      const db = createMockDb({
        cards: {
          "card-balance-1": {
            status: "available",
            productId,
            accountLabel: "ACC-BAL",
            deliverySecret: "SECRET-BAL",
            deliveryNote: "Balance note",
          },
        },
      });

      let selectCount = 0;
      let insertCount = 0;
      (db as any).select = (_colMap?: unknown) => ({
        from: (_table?: unknown) => {
          selectCount += 1;
          // createOrder -> checkOrderRateLimit
          if (selectCount === 1) {
            return createSelectChain([{ count: 0 }]);
          }
          // createOrder -> checkProductPurchaseLimit
          if (selectCount === 2) {
            return createSelectChain([{ count: 0 }]);
          }
          // markPaidAndIssue -> get order + product
          if (selectCount === 3) {
            return createSelectChain([{
              id: (db as any).__balanceOrderId,
              orderNo: "BAL20260101TEST",
              productId,
              buyerContact: "",
              buyerEmail,
              status: "pending",
              expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
              couponCode: "",
              productTitle: "Balance Product",
              fulfillmentMode: "card",
              deliveryJson: "",
            }]);
          }
          // markPaidAndIssue -> order_items quantity
          if (selectCount === 4) {
            return createSelectChain([{ quantity: 1 }]);
          }
          // markPaidAndIssue -> existing issued cards
          if (selectCount === 5) {
            return createSelectChain([]);
          }
          return createSelectChain([]);
        },
      });

      (db as any).update = (_table?: unknown) => ({
        set: (data: unknown) => {
          const status = (data as any)?.status;
          if (status === "expired") {
            return {
              where: () => ({
                returning: () => Promise.resolve([]),
              }),
            };
          }
          return {
            where: () => ({
              returning: () => Promise.resolve([{ id: "any" }]),
              then: (resolve: (v: { rowsAffected: number }) => void) => Promise.resolve({ rowsAffected: 1 }).then(resolve),
            }),
          };
        },
      });

      (db as any).insert = (_table?: unknown) => ({
        values: (data: unknown) => {
          insertCount += 1;
          if (!Array.isArray(data) && (data as { productId?: string; orderNo?: string }).productId === productId && (data as { orderNo?: string }).orderNo) {
            (db as any).__balanceOrderId = (data as { id?: string }).id || crypto.randomUUID();
          }
          // redeemVoucher -> insert/upsert user_balances (via onConflictDoUpdate)
          if (insertCount === 1) {
            const p = Promise.resolve({ rowsAffected: 1 });
            const result: any = {
              onConflictDoUpdate: () => p,
              onConflictDoNothing: () => p,
            };
            result.then = p.then.bind(p);
            result.catch = p.catch.bind(p);
            result.finally = p.finally.bind(p);
            result.returning = () => Promise.resolve([{ balanceCents: 5000 }]);
            return result;
          }
          if (insertCount === 2) {
            return Promise.resolve({ rowsAffected: 1 });
          }
          // redeemVoucher -> write balance transaction
          if (insertCount === 3) {
            return Promise.resolve({ rowsAffected: 1 });
          }
          // markPaidAndIssue -> write order event
          if (insertCount === 4) {
            return Promise.resolve({ rowsAffected: 1 });
          }
          const p = Promise.resolve({ rowsAffected: 1 });
          const result: any = { onConflictDoUpdate: () => p, onConflictDoNothing: () => p };
          result.then = p.then.bind(p);
          result.catch = p.catch.bind(p);
          result.finally = p.finally.bind(p);
          return result;
        },
      });

      // Step 1: Redeem voucher -> balance credited
      const redeemResult = await redeemVoucher(db, voucherCode, buyerEmail);
      expect(redeemResult.success).toBe(true);
      expect(redeemResult.amountCents).toBe(5000);

      // Step 2: Create order (pending)
      const c = createMockContext(db);
      const orderResult = await createOrder(c, await checkoutEmailInput(productId, buyerEmail), "ip-hash-balance");
      expect(orderResult.ok).toBe(true);
      if (!orderResult.ok) return;
      expect(orderResult.order.status).toBe("pending");
      const orderId = orderResult.order.id;

      // Step 3: Deduct balance
      const deductResult = await deductBalance(db, buyerEmail, orderResult.order.amountCents as number, {
        referenceType: "order",
        referenceId: orderId as string,
      });
      expect(deductResult).toBe(true);

      // Step 4: Admin confirms (markPaidAndIssue)
      const issueResult = await markPaidAndIssue(db, orderId as string);
      expect(issueResult.ok).toBe(true);
      if (!issueResult.ok) return;
      expect((issueResult as any).card).toBeDefined();
      expect((issueResult as any).card.accountLabel).toBe("ACC-BAL");
    });
  });

  // ── Flow 6: 虚拟资料非卡密交付（link/file 模式 → 直接拿到 delivery） ──
  describe("Flow 6: 虚拟资料非卡密交付（非 card 模式 → 直接交付内容）", () => {
    it("完整流程：创建虚拟商品 → 用户下单 → 直接拿到 delivery 内容", async () => {
      const productId = "prod-virtual";
      const buyerEmail = "buyer6@example.com";

      mockGetProduct.mockResolvedValue({
        id: productId,
        title: "Virtual Guide",
        priceCents: 0,
        currency: "CNY",
        issueMode: "direct",
        fulfillmentMode: "link",
        active: 1,
        purchaseLimit: null,
        salesCopy: "https://example.com/download/guide.pdf",
      });

      mockQuoteCoupon.mockResolvedValue({
        couponCode: "",
        valid: true,
        discountCents: 0,
        payableCents: 0,
        message: "无折扣码，按原价购买",
      });

      const db = createMockDb({});

      let selectCount = 0;
      (db as any).select = (_colMap?: unknown) => ({
        from: (_table?: unknown) => {
          selectCount += 1;
          if (selectCount === 1) {
            return createSelectChain([{
              id: productId,
              title: "Virtual Guide",
              priceCents: 0,
              currency: "CNY",
              issueMode: "direct",
              fulfillmentMode: "link",
              active: 1,
              purchaseLimit: null,
              salesCopy: "https://example.com/download/guide.pdf",
            }]);
          }
          return createSelectChain([]);
        },
      });

      const c = createMockContext(db);
      const orderResult = await createOrder(c, await checkoutEmailInput(productId, buyerEmail), "ip-hash-6");

      expect(orderResult.ok).toBe(true);
      if (!orderResult.ok) return;
      expect(orderResult.order.status).toBe("issued");
      expect(orderResult.order.delivery).toBeDefined();
      expect((orderResult.order.delivery as any).deliverySecret).toBe("https://example.com/download/guide.pdf");
      expect((orderResult.order.delivery as any).accountLabel).toBe("Virtual Guide");
    });

    it("Phase 1: manual + link 模式创建订单，管理员确认后返回 delivery 且不碰 cards 表", async () => {
      const productId = "prod-virtual-manual";
      const buyerEmail = "buyer6b@example.com";

      mockGetProduct.mockResolvedValue({
        id: productId,
        title: "Virtual Manual Product",
        priceCents: 1000,
        currency: "CNY",
        issueMode: "manual",
        fulfillmentMode: "link",
        active: 1,
        purchaseLimit: null,
        salesCopy: "https://example.com/download/manual.pdf",
      });

      mockQuoteCoupon.mockResolvedValue({
        couponCode: "",
        valid: true,
        discountCents: 0,
        payableCents: 1000,
        message: "无折扣码，按原价购买",
      });

      const db = createMockDb({});

      let selectCount = 0;
      (db as any).select = (_colMap?: unknown) => ({
        from: (_table?: unknown) => {
          selectCount += 1;
          if (selectCount === 1) {
            return createSelectChain([{ count: 0 }]);
          }
          if (selectCount === 2) {
            return createSelectChain([{ count: 0 }]);
          }
          // markPaidAndIssue -> get order + product
          if (selectCount === 3) {
            return createSelectChain([{
              id: (db as any).__adminOrderId,
              orderNo: "VIRTUAL20260101TEST",
              productId,
              buyerContact: "",
              buyerEmail,
              status: "paid",
              expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
              couponCode: "",
              productTitle: "Virtual Manual Product",
              fulfillmentMode: "link",
              deliveryJson: JSON.stringify({
                accountLabel: "Virtual Manual Product",
                deliverySecret: "https://example.com/download/manual.pdf",
                deliveryNote: "已交付"
              }),
            }]);
          }
          return createSelectChain([]);
        },
      });

      // 跟踪订单 ID，供 markPaidAndIssue 使用
      let createdOrderId = "";
      (db as any).insert = (_table?: unknown) => ({
        values: (data: unknown) => {
          const values = (data as any)?.values || data;
          createdOrderId = values.id || `order-${Date.now()}`;
          (db as any).__adminOrderId = createdOrderId;
          return Promise.resolve({ rowsAffected: 1 });
        },
        onConflictDoUpdate: () => Promise.resolve({ rowsAffected: 1 }),
        onConflictDoNothing: () => Promise.resolve({ rowsAffected: 1 }),
        returning: () => Promise.resolve([{ id: createdOrderId }]),
      });

      const c = createMockContext(db);
      const orderResult = await createOrder(c, await checkoutEmailInput(productId, buyerEmail), "ip-hash-6b");

      expect(orderResult.ok).toBe(true);
      if (!orderResult.ok) return;
      expect(orderResult.order.status).toBe("pending");
      expect(orderResult.order.fulfillmentMode).toBe("link");

      // Step 2: Admin confirms (markPaidAndIssue)
      expect(selectCount).toBe(2);
      const issueResult = await markPaidAndIssue(db, createdOrderId);
      expect(issueResult.ok).toBe(true);
      if (!issueResult.ok) return;
      expect((issueResult as any).delivery).toBeDefined();
      expect((issueResult as any).delivery.deliverySecret).toBe("https://example.com/download/manual.pdf");
      expect((issueResult as any).delivery.accountLabel).toBe("Virtual Manual Product");
    });
  });

  // ── Flow 7: 管理员完整工作流 ──
  describe("Flow 7: 管理员完整工作流（创建商品 → 导入卡密 → 下单 → 确认发卡 → 查看订单）", () => {
    it("完整流程：admin 创建商品并导入卡密 → 买家下单 → 管理员确认发卡 → 查看订单详情", async () => {
      const productId = "prod-admin-flow";
      const cardId = "card-admin-1";
      const buyerEmail = "buyer-admin@example.com";

      mockGetProduct.mockResolvedValue({
        id: productId,
        title: "Admin Flow Product",
        priceCents: 3000,
        currency: "CNY",
        issueMode: "manual",
        fulfillmentMode: "card",
        active: 1,
        purchaseLimit: null,
        salesCopy: "",
      });

      const db = createMockDb({
        cards: {
          [cardId]: {
            status: "available",
            productId,
            accountLabel: "ACC-ADMIN",
            deliverySecret: "SECRET-ADMIN",
            deliveryNote: "Admin note",
          },
        },
      });

      let selectCount = 0;
      let insertCount = 0;
      (db as any).select = (_colMap?: unknown) => ({
        from: (_table?: unknown) => {
          selectCount += 1;
          // Step 1: importCards -> check product exists
          if (selectCount === 1) {
            return createSelectChain([{ id: productId }]);
          }
          // Step 2: importCards -> check duplicate secrets (should be empty)
          if (selectCount === 2) {
            return createSelectChain([]);
          }
          // Step 3: createOrder -> getProduct
          if (selectCount === 3) {
            return createSelectChain([{
              id: productId,
              title: "Admin Flow Product",
              priceCents: 3000,
              currency: "CNY",
              issueMode: "manual",
              fulfillmentMode: "card",
              active: 1,
              purchaseLimit: null,
              salesCopy: "",
            }]);
          }
          // Step 4: createOrder -> checkOrderRateLimit
          if (selectCount === 4) {
            return createSelectChain([{ count: 0 }]);
          }
          // Step 5: createOrder -> checkProductPurchaseLimit
          if (selectCount === 5) {
            return createSelectChain([{ count: 0 }]);
          }
          // Step 6: markPaidAndIssue -> get order + product
          if (selectCount === 6) {
            return createSelectChain([{
              id: (db as any).__adminOrderId,
              orderNo: "ADMIN20260101TEST",
              productId,
              buyerContact: "",
              buyerEmail,
              status: "pending",
              expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
              couponCode: "",
              productTitle: "Admin Flow Product",
              fulfillmentMode: "card",
              deliveryJson: "",
            }]);
          }
          // Step 7: markPaidAndIssue -> checkAndExpireOrder (count query)
          if (selectCount === 7) {
            return createSelectChain([{ count: 0 }]);
          }
          // Step 8: getOrderDetail -> get order + product + card
          if (selectCount === 8) {
            return createSelectChain([{
              id: (db as any).__adminOrderId,
              orderNo: "ADMIN20260101TEST",
              productId,
              buyerContact: "",
              buyerEmail,
              amountCents: 3000,
              discountCents: 0,
              currency: "CNY",
              status: "issued",
              issueMode: "manual",
              paymentMethod: "",
              paymentRef: "",
              issuedCardId: cardId,
              couponCode: "",
              campaignCode: "",
              referralCode: "",
              createdAt: new Date().toISOString(),
              paidAt: new Date().toISOString(),
              issuedAt: new Date().toISOString(),
              ipHash: "",
              userAgent: "",
              expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
              productTitle: "Admin Flow Product",
              fulfillmentMode: "card",
              accountLabel: "ACC-ADMIN",
              deliverySecret: "SECRET-ADMIN",
              deliveryNote: "Admin note",
              deliveryJson: "",
            }]);
          }
          return createSelectChain([]);
        },
      });

      (db as any).update = (_table?: unknown) => ({
        set: (data: unknown) => {
          // 按实际写入数据判断：只有把订单标记为 expired 时才返回空（checkAndExpireOrder 场景）。
          // pending/paid/issued 的更新都返回成功，避免按调用次数分支导致 checkAndExpireOrder 提前返回时计数错位。
          const status = (data as any)?.status;
          if (status === "expired") {
            return {
              where: () => ({
                returning: () => Promise.resolve([]),
              }),
            };
          }
          return {
            where: () => ({
              returning: () => Promise.resolve([{ id: "any" }]),
              then: (resolve: (v: { rowsAffected: number }) => void) => Promise.resolve({ rowsAffected: 1 }).then(resolve),
            }),
          };
        },
      });

      (db as any).insert = (_table?: unknown) => ({
        values: (data: unknown) => {
          insertCount += 1;
          // createProduct
          if (insertCount === 1) {
            return Promise.resolve({ rowsAffected: 1 });
          }
          // importCards -> cardBatches
          if (insertCount === 2) {
            return Promise.resolve({ rowsAffected: 1 });
          }
          // importCards -> cards (batch insert)
          if (insertCount === 3) {
            return Promise.resolve({ rowsAffected: 1 });
          }
          // createOrder -> insert order (after card lock log insert)
          if (insertCount === 5) {
            (db as any).__adminOrderId = (data as any)?.id || crypto.randomUUID();
            return Promise.resolve({ rowsAffected: 1 });
          }
          const p = Promise.resolve({ rowsAffected: 1 });
          const result: any = { onConflictDoUpdate: () => p, onConflictDoNothing: () => p };
          result.then = p.then.bind(p);
          result.catch = p.catch.bind(p);
          result.finally = p.finally.bind(p);
          return result;
        },
      });

      // Step 1: Admin creates product
      const { createProduct } = await import("./admin-service");
      await createProduct(db, {
        id: productId,
        title: "Admin Flow Product",
        description: "Test",
        salesCopy: "",
        coverUrl: "",
        tagsJson: "[]",
        priceCents: 3000,
        currency: "CNY",
        issueMode: "manual",
        fulfillmentMode: "card",
        active: true,
        category: "test",
        sortOrder: 0,
        purchaseLimit: null,
        storefrontIds: [],
      });

      // Step 2: Admin imports cards
      const { importCards } = await import("./admin-service");
      const importResult = await importCards(db, {
        productId,
        batchName: "Admin Batch",
        cards: [
          { accountLabel: "ACC-ADMIN", deliverySecret: "SECRET-ADMIN", deliveryNote: "Admin note" },
        ],
      });
      expect(importResult.imported).toBe(1);

      // Step 3: User places manual order (should be pending)
      const c = createMockContext(db);
      const orderResult = await createOrder(c, await checkoutEmailInput(productId, buyerEmail), "ip-hash-admin");
      expect(orderResult.ok).toBe(true);
      if (!orderResult.ok) return;
      expect(orderResult.order.status).toBe("pending");

      // Step 4: Admin confirms payment and issues card
      selectCount = 0;
      let orderStatus = "pending";
      (db as any).select = (_colMap?: unknown) => {
        return {
          from: (_table?: unknown) => {
            selectCount += 1;
            if (selectCount === 1) {
              return createSelectChain([{
                id: (db as any).__adminOrderId,
                orderNo: "ADMIN20260101TEST",
                productId,
                buyerContact: "",
                buyerEmail,
                status: orderStatus,
                expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
                couponCode: "",
                productTitle: "Admin Flow Product",
                fulfillmentMode: "card",
                deliveryJson: "",
              }]);
            }
            if (selectCount === 2) {
              return createSelectChain([{ quantity: 1 }]);
            }
            if (selectCount === 3) {
              return createSelectChain([]);
            }
            // getOrderDetail -> return issued order with card info
            if (selectCount === 4 && orderStatus === "issued") {
              return createSelectChain([{
                id: (db as any).__adminOrderId,
                orderNo: "ADMIN20260101TEST",
                productId,
                buyerContact: "",
                buyerEmail,
                amountCents: 3000,
                discountCents: 0,
                currency: "CNY",
                status: "issued",
                issueMode: "manual",
                paymentMethod: "",
                paymentRef: "",
                issuedCardId: cardId,
                couponCode: "",
                campaignCode: "",
                referralCode: "",
                createdAt: new Date().toISOString(),
                paidAt: new Date().toISOString(),
                issuedAt: new Date().toISOString(),
                ipHash: "",
                userAgent: "",
                expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
                productTitle: "Admin Flow Product",
                fulfillmentMode: "card",
                accountLabel: "ACC-ADMIN",
                deliverySecret: "SECRET-ADMIN",
                deliveryNote: "Admin note",
                deliveryJson: "",
              }]);
            }
            if (selectCount === 5 && orderStatus === "issued") {
              return createSelectChain([{
                id: "item-admin",
                productId,
                productTitle: "Admin Flow Product",
                fulfillmentMode: "card",
                quantity: 1,
                unitPriceCents: 3000,
                discountCents: 0,
                amountCents: 3000,
                deliveryJson: "",
              }]);
            }
            if (selectCount === 6 && orderStatus === "issued") {
              return createSelectChain([{
                id: cardId,
                accountLabel: "ACC-ADMIN",
                deliverySecret: "SECRET-ADMIN",
                deliveryNote: "Admin note",
              }]);
            }
            return createSelectChain([]);
          },
        };
      };

      const issueResult = await markPaidAndIssue(db, (db as any).__adminOrderId);
      expect(issueResult.ok).toBe(true);
      if (!issueResult.ok) return;
      orderStatus = "issued";
      expect((issueResult as any).card).toBeDefined();
      expect((issueResult as any).card.accountLabel).toBe("ACC-ADMIN");

      // Step 5: Admin views order detail
      const { getOrderDetail } = await import("./admin-service");
      const detail = await getOrderDetail(db, (db as any).__adminOrderId);
      expect(detail).toBeDefined();
      expect(detail?.status).toBe("issued");
      expect(detail?.accountLabel).toBe("ACC-ADMIN");
    });
  });
});

// ── Flow 5: Overselling Prevention ──
  describe("Flow 5: 超卖防护（并发下单 → 库存耗尽 → 返回 409）", () => {
    it("只有一个卡密 → 第一个下单成功 → 第二个返回 409 库存不足", async () => {
      const productId = "prod-oversell";
      const cardId = "card-oversell-1";

      mockGetProduct.mockResolvedValue({
        id: productId,
        title: "Oversell Product",
        priceCents: 1000,
        currency: "CNY",
        issueMode: "direct",
        fulfillmentMode: "card",
        active: 1,
        purchaseLimit: null,
        salesCopy: "",
      });

      const db = createMockDb({
        cards: {
          [cardId]: {
            status: "available",
            productId,
            accountLabel: "ACC-005",
            deliverySecret: "SECRET-005",
            deliveryNote: "Note 5",
          },
        },
      });

      let selectCount = 0;
      (db as any).select = (_colMap?: unknown) => ({
        from: (_table?: unknown) => {
          selectCount += 1;
          if (selectCount === 1) {
            return createSelectChain([{
              id: productId,
              title: "Oversell Product",
              priceCents: 1000,
              currency: "CNY",
              issueMode: "direct",
              fulfillmentMode: "card",
              active: 1,
              purchaseLimit: null,
              salesCopy: "",
            }]);
          }
          return createSelectChain([]);
        },
      });

      mockQuoteCoupon.mockResolvedValue({
        couponCode: "FREE100",
        valid: true,
        discountCents: 1000,
        payableCents: 0,
        message: "折扣码可用",
      });

      // First order should succeed
      const c1 = createMockContext(db);
      const result1 = await createOrder(c1, await checkoutEmailInput(productId, "buyer5a@example.com", { couponCode: "FREE100" }), "ip-hash-5a");
      expect(result1.ok).toBe(true);
      if (!result1.ok) return;
      expect(result1.order.status).toBe("issued");

      // Verify card is now issued by checking the mock state
      const cardState = (db as any).__cards || {};
      expect(cardState[cardId]?.status).toBe("issued");

      // Second order should fail with 409
      const c2 = createMockContext(db);
      const result2 = await createOrder(c2, await checkoutEmailInput(productId, "buyer5b@example.com", { couponCode: "FREE100" }), "ip-hash-5b");
      expect(result2.ok).toBe(false);
      if (result2.ok) return;
      expect(result2.status).toBe(409);
      expect(result2.message).toBe("当前商品库存不足");
    });
  });

  // ── Flow 6: Purchase Limit Enforcement ──
  describe("Flow 6: 商品限购（同一邮箱超过限购数量 → 429）", () => {
    it("限购 2 件 → 第 3 笔下单返回 429", async () => {
      const productId = "prod-limit";
      const buyerEmail = "buyer10@example.com";

      mockGetProduct.mockResolvedValue({
        id: productId,
        title: "Limited Product",
        priceCents: 2000,
        currency: "CNY",
        issueMode: "manual",
        fulfillmentMode: "card",
        active: 1,
        purchaseLimit: 2,
        salesCopy: "",
      });

      const db = createMockDb({
        orders: {
          "order-1": { id: "order-1", productId, buyerEmail, status: "paid" },
          "order-2": { id: "order-2", productId, buyerEmail, status: "pending" },
        },
      });

      let selectCount = 0;
      (db as any).select = (_colMap?: unknown) => ({
        from: (_table?: unknown) => {
          selectCount += 1;
          if (selectCount === 1) {
            return createSelectChain([{
              id: productId,
              title: "Limited Product",
              priceCents: 2000,
              currency: "CNY",
              issueMode: "manual",
              fulfillmentMode: "card",
              active: 1,
              purchaseLimit: 2,
              salesCopy: "",
            }]);
          }
          if (selectCount === 2) {
            return createSelectChain([{ count: 0 }]);
          }
          if (selectCount === 3) {
            return createSelectChain([{ count: 2 }]);
          }
          return createSelectChain([]);
        },
      });

      mockQuoteCoupon.mockResolvedValue({
        couponCode: "",
        valid: true,
        discountCents: 0,
        payableCents: 2000,
        message: "无折扣码，按原价购买",
      });

      const c = createMockContext(db);
      const result = await createOrder(c, await checkoutEmailInput(productId, buyerEmail), "ip-hash-10");

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(429);
      expect(result.message).toBe("该商品每人限购 2 件，您已达到上限");
    });
  });

  // ── Flow 7: Email Notification Pipeline ──
  describe("Flow 7: 邮件通知管道（下单 → 发卡 → 过期通知）", () => {
    it("完整流程：用户下单 → 系统发邮件通知", async () => {
      const productId = "prod-email";
      const buyerEmail = "buyer9@example.com";
      const cardId = "card-email-1";

      mockGetProduct.mockResolvedValue({
        id: productId,
        title: "Email Product",
        priceCents: 1000,
        currency: "CNY",
        issueMode: "direct",
        fulfillmentMode: "card",
        active: 1,
        purchaseLimit: null,
        salesCopy: "",
      });

      const db = createMockDb({
        cards: {
          [cardId]: {
            status: "available",
            productId,
            accountLabel: "ACC-EMAIL",
            deliverySecret: "SECRET-EMAIL",
            deliveryNote: "Email note",
          },
        },
      });

      let selectCount = 0;
      (db as any).select = (_colMap?: unknown) => ({
        from: (_table?: unknown) => {
          selectCount += 1;
          if (selectCount === 1) {
            return createSelectChain([{
              id: productId,
              title: "Email Product",
              priceCents: 1000,
              currency: "CNY",
              issueMode: "direct",
              fulfillmentMode: "card",
              active: 1,
              purchaseLimit: null,
              salesCopy: "",
            }]);
          }
          return createSelectChain([]);
        },
      });

      mockQuoteCoupon.mockResolvedValue({
        couponCode: "FREE100",
        valid: true,
        discountCents: 1000,
        payableCents: 0,
        message: "折扣码可用",
      });

      // Step 1: Place order (should trigger order_issued email)
      const c = createMockContext(db, { env: { RESEND_API_KEY: "re_test" } });
      const orderResult = await createOrder(c, await checkoutEmailInput(productId, buyerEmail, { couponCode: "FREE100" }), "ip-hash-9");

      expect(orderResult.ok).toBe(true);
      if (!orderResult.ok) return;
      expect(orderResult.order.status).toBe("issued");

      // Verify email was sent
      expect(mockSendEmail).toHaveBeenCalled();
    });
  });

  // ── Flow 8: 订单取消 + 卡密释放 ──
  describe("Flow 8: 订单取消（pending/paid → canceled → 释放锁定卡密）", () => {
    it("管理员取消 pending manual 订单后，锁定卡密应恢复到 available", async () => {
      const productId = "prod-cancel-manual";
      const cardId = "card-cancel-manual";
      const buyerEmail = "buyer-cancel@example.com";

      mockGetProduct.mockResolvedValue({
        id: productId,
        title: "Cancel Manual Product",
        priceCents: 2000,
        currency: "CNY",
        issueMode: "manual",
        fulfillmentMode: "card",
        active: 1,
        purchaseLimit: null,
        salesCopy: "",
      });

      const db = createMockDb({
        cards: {
          [cardId]: {
            status: "available",
            productId,
            accountLabel: "ACC-CANCEL",
            deliverySecret: "SECRET-CANCEL",
            deliveryNote: "Cancel note",
          },
        },
      });

      let selectCount = 0;
      let updateCount = 0;
      (db as any).select = (_colMap?: unknown) => ({
        from: (_table?: unknown) => {
          selectCount += 1;
          if (selectCount === 1) {
            return createSelectChain([{
              id: productId,
              title: "Cancel Manual Product",
              priceCents: 2000,
              currency: "CNY",
              issueMode: "manual",
              fulfillmentMode: "card",
              active: 1,
              purchaseLimit: null,
              salesCopy: "",
            }]);
          }
          if (selectCount === 2) {
            return createSelectChain([{ count: 0 }]);
          }
          if (selectCount === 3) {
            return createSelectChain([{ count: 0 }]);
          }
          if (selectCount === 4) {
            return createSelectChain([{ id: createdOrderId, status: "pending", issuedCardId: null }]);
          }
          if (selectCount === 5) {
            return createSelectChain([{ id: cardId, status: "locked", lockedOrderId: createdOrderId }]);
          }
          return createSelectChain([]);
        },
      });
      (db as any).update = (_table?: unknown) => ({
        set: (_data?: unknown) => {
          updateCount += 1;
          return {
            where: () => {
              if (updateCount === 1) {
                return {
                  then: (resolve: (v: { rowsAffected: number }) => void) =>
                    Promise.resolve({ rowsAffected: 1 }).then(resolve),
                };
              }
              if (updateCount === 2) {
                const data = (db as any).__cards;
                if (data && data[cardId]) {
                  data[cardId].status = "available";
                  data[cardId].lockedOrderId = null;
                }
                return Promise.resolve({ rowsAffected: 1 });
              }
              return Promise.resolve({ rowsAffected: 0 });
            },
          };
        },
      });

      // Step 1: User places manual order (should be pending, card locked)
      const c = createMockContext(db);
      const orderResult = await createOrder(c, await checkoutEmailInput(productId, buyerEmail), "ip-hash-cancel");
      expect(orderResult.ok).toBe(true);
      if (!orderResult.ok) return;
      expect(orderResult.order.status).toBe("pending");
      const createdOrderId = orderResult.order.id;

      // Reset counters for cancelOrder
      selectCount = 0;
      updateCount = 0;

      // Override select for cancelOrder
      (db as any).select = (_colMap?: unknown) => ({
        from: (_table?: unknown) => {
          selectCount += 1;
          if (selectCount === 1) {
            // cancelOrder -> get order
            return createSelectChain([{ id: createdOrderId, status: "pending", issuedCardId: null }]);
          }
          if (selectCount === 2) {
            // releaseLockedCardByOrder -> get locked cards
            return createSelectChain([{ id: cardId, status: "locked", lockedOrderId: createdOrderId }]);
          }
          return createSelectChain([]);
        },
      });

      // Verify card is locked
      const cardStateAfterCreate = (db as any).__cards || {};
      expect(cardStateAfterCreate[cardId]?.status).toBe("locked");

      // Step 2: Admin cancels the order
      const cancelResult = await cancelOrder(db, createdOrderId as string);
      expect(cancelResult.releasedCards).toBe(1);

      // Verify card is released back to available
      const cardStateAfterCancel = (db as any).__cards || {};
      expect(cardStateAfterCancel[cardId]?.status).toBe("available");
      expect(cardStateAfterCancel[cardId]?.lockedOrderId).toBeNull();
    });
  });

  // ── Flow 9: 已发卡订单不应过期回滚 ──
  describe("Flow 9: 已发卡订单不应过期回滚", () => {
    it("已发卡订单过期后，订单状态应保持 issued，卡密不回滚为 available", async () => {
      const productId = "prod-expire-recover";
      const cardId = "card-expire-recover";
      const buyerEmail = "buyer-expire@example.com";

      mockGetProduct.mockResolvedValue({
        id: productId,
        title: "Expire Recover Product",
        priceCents: 1000,
        currency: "CNY",
        issueMode: "direct",
        fulfillmentMode: "card",
        active: 1,
        purchaseLimit: null,
        salesCopy: "",
      });

      const db = createMockDb({
        cards: {
          [cardId]: {
            status: "available",
            productId,
            accountLabel: "ACC-EXPIRE",
            deliverySecret: "SECRET-EXPIRE",
            deliveryNote: "Expire note",
          },
        },
      });

      let selectCount = 0;
      (db as any).select = (_colMap?: unknown) => ({
        from: (_table?: unknown) => {
          selectCount += 1;
          if (selectCount === 1) {
            return createSelectChain([{
              id: productId,
              title: "Expire Recover Product",
              priceCents: 1000,
              currency: "CNY",
              issueMode: "direct",
              fulfillmentMode: "card",
              active: 1,
              purchaseLimit: null,
              salesCopy: "",
            }]);
          }
          return createSelectChain([]);
        },
      });

      mockQuoteCoupon.mockResolvedValue({
        couponCode: "FREE100",
        valid: true,
        discountCents: 1000,
        payableCents: 0,
        message: "折扣码可用",
      });

      // Step 1: Place order and issue card
      const c = createMockContext(db);
      const orderResult = await createOrder(c, await checkoutEmailInput(productId, buyerEmail, { couponCode: "FREE100" }), "ip-hash-expire");
      expect(orderResult.ok).toBe(true);
      if (!orderResult.ok) return;
      expect(orderResult.order.status).toBe("issued");
      const createdOrderId = orderResult.order.id;

      // Verify card is issued
      let cardState = (db as any).__cards || {};
      expect(cardState[cardId]?.status).toBe("issued");

      // Step 2: Simulate order expiration by calling checkAndExpireOrder on an issued order
      const pastExpiry = new Date(Date.now() - 60_000).toISOString();
      const expireResult = await checkAndExpireOrder(
        db,
        createdOrderId as string,
        pastExpiry,
        "issued",
        { resendApiKey: "re_test", emailFrom: "", turnstileEnabled: false, turnstileSecretKey: "", allowTurnstileBypassForSmoke: false, inventoryWarningEmailTo: "" },
        { orderNo: orderResult.order.orderNo as string, productTitle: "Expire Recover Product", buyerEmail }
      );

      // 已发卡订单不应再过期回滚
      expect(expireResult.expired).toBe(false);
      expect(expireResult.releasedCards).toBe(0);

      // Verify card is still issued
      cardState = (db as any).__cards || {};
      expect(cardState[cardId]?.status).toBe("issued");
      expect(cardState[cardId]?.issuedOrderId).toBe(createdOrderId);
    });
  });

  // ── Flow 10: Referral 事件验证（下单时创建 referral_events） ──
  describe("Flow 10: Referral 事件验证（下单时记录推荐来源）", () => {
    it("使用 referralCode 下单后，应创建 referral_events 记录", async () => {
      const productId = "prod-referral";
      const buyerEmail = "buyer-referral@example.com";

      mockGetProduct.mockResolvedValue({
        id: productId,
        title: "Referral Product",
        priceCents: 1000,
        currency: "CNY",
        issueMode: "direct",
        fulfillmentMode: "card",
        active: 1,
        purchaseLimit: null,
        salesCopy: "",
      });

      const db = createMockDb({
        cards: {
          "card-referral-1": {
            status: "available",
            productId,
            accountLabel: "ACC-REF",
            deliverySecret: "SECRET-REF",
            deliveryNote: "Referral note",
          },
        },
      });

      let selectCount = 0;
      (db as any).select = (_colMap?: unknown) => ({
        from: (_table?: unknown) => {
          selectCount += 1;
          if (selectCount === 1) {
            return createSelectChain([{
              id: productId,
              title: "Referral Product",
              priceCents: 1000,
              currency: "CNY",
              issueMode: "direct",
              fulfillmentMode: "card",
              active: 1,
              purchaseLimit: null,
              salesCopy: "",
            }]);
          }
          return createSelectChain([]);
        },
      });

      let insertCount = 0;
      const insertedTables: string[] = [];
      (db as any).insert = (_table?: unknown) => ({
        values: (data: unknown) => {
          insertCount += 1;
          if (typeof data === "object" && data !== null && "referralCode" in data) {
            insertedTables.push("referralEvents");
          }
          const p = Array.isArray(data)
            ? Promise.resolve({ rowsAffected: data.length })
            : Promise.resolve({ rowsAffected: 1 });
          const result: any = {
            onConflictDoUpdate: () => p,
            onConflictDoNothing: () => p,
          };
          result.then = p.then.bind(p);
          result.catch = p.catch.bind(p);
          result.finally = p.finally.bind(p);
          return result;
        },
      });

      mockQuoteCoupon.mockResolvedValue({
        couponCode: "FREE100",
        valid: true,
        discountCents: 1000,
        payableCents: 0,
        message: "折扣码可用",
      });

      const c = createMockContext(db);
      const orderResult = await createOrder(
        c,
        await checkoutEmailInput(productId, buyerEmail, {
          referralCode: "REF-CODE-123",
          couponCode: "FREE100",
        }),
        "ip-hash-referral"
      );

      expect(orderResult.ok).toBe(true);
      if (!orderResult.ok) return;
      expect(orderResult.order.status).toBe("issued");

      // Verify referral event was created via direct db.insert into referralEvents
      expect(insertedTables).toContain("referralEvents");
      expect(insertCount).toBeGreaterThanOrEqual(1);
    });
  });
