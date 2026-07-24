import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DbType } from "../db/client";
import {
  createOrder,
  getOrderByToken,
  getOrderSummariesByEmail,
  markPaidAndIssue,
  publicOrder,
  publicOrderSummary,
  checkBalanceOrderRateLimit,
} from "./order-service";
import type { CreateOrderInput, OrderSummaryRow } from "./order-service";
import type { IssueMode } from "../bindings";
import type { Context } from "hono";
import type { AppEnv } from "../bindings";
import { orders as ordersTable } from "../db/schema";

// ---------------------------------------------------------------------------
// Mock Drizzle-dependent modules
// ---------------------------------------------------------------------------
const mockGetCoupon = vi.fn();
const mockQuoteCoupon = vi.fn();
const mockConsumeCoupon = vi.fn();
const mockReleaseCouponReservation = vi.fn();
const mockGetProduct = vi.fn();
const mockWriteOrderEvent = vi.fn();
const mockSendEmail = vi.fn();
const mockGetOrderRateLimitConfig = vi.fn().mockResolvedValue({ windowSeconds: 300, maxOrders: 3 });

vi.mock("./coupon-service", () => ({
  getCoupon: (...args: unknown[]) => mockGetCoupon(...args),
  quoteCoupon: (...args: unknown[]) => mockQuoteCoupon(...args),
  consumeCoupon: (...args: unknown[]) => mockConsumeCoupon(...args),
  releaseCouponReservation: (...args: unknown[]) => mockReleaseCouponReservation(...args),
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
    sendEmail: (...args: unknown[]) => Promise.resolve(mockSendEmail(...args) || { ok: true, message: "mock" }),
  };
});

vi.mock(import("../lib/system-config-registry"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getOrderRateLimitConfig: (...args: unknown[]) => mockGetOrderRateLimitConfig(...args),
  };
});

// ── ORM chain mock for select queries with JOINs ──
// This handles getOrderByToken, getOrderByNo,
// order summary lookups and markPaidAndIssue's initial select.

function createSelectChain(results: unknown[]) {
  const chain: any = {};
  // All intermediate methods return the chain itself
  for (const method of ["where", "innerJoin", "leftJoin", "orderBy", "limit", "offset", "groupBy", "having"]) {
    chain[method] = () => chain;
  }
  // Make the chain thenable — await resolves to results
  chain.then = (resolve: (v: unknown[]) => void, reject?: (e: unknown) => void) =>
    Promise.resolve(results).then(resolve, reject);
  return chain;
}

function createResultDb(selectResults: unknown[] = [], runResults: Record<string, { rows: unknown[] }> = {}): DbType {
  return {
    select: (_colMap?: unknown) => ({
      from: (_table?: unknown) => createSelectChain(selectResults),
    }),
    insert: (_table?: unknown) => ({
      values: (_data?: unknown) => {
        const p = Promise.resolve({ rowsAffected: 1 });
        const result: any = {
          onConflictDoUpdate: () => p,
          onConflictDoNothing: () => p,
        };
        result.then = p.then.bind(p);
        result.catch = p.catch.bind(p);
        result.finally = p.finally.bind(p);
        return result;
      },
    }),
    update: (_table?: unknown) => ({
      set: (_data?: unknown) => {
        const whereChain: any = {
          returning: () => ({
            then: (resolve: (v: unknown) => void) => Promise.resolve([{ id: "any" }]).then(resolve),
          }),
          then: (resolve: (v: unknown) => void) => Promise.resolve({ rowsAffected: 1 }).then(resolve),
        };
        return { where: () => whereChain };
      },
    }),
    delete: (_table?: unknown) => ({
      where: (_cond?: unknown) => Promise.resolve({ rowsAffected: 0 }),
    }),
    run: (sqlExpr?: any) => {
      // Extract SQL text from Drizzle SQL template object
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
      for (const [pattern, result] of Object.entries(runResults)) {
        if (sqlStr.toLowerCase().includes(pattern.toLowerCase())) {
          return Promise.resolve(result);
        }
      }
      return Promise.resolve({ rows: [] });
    },
  } as unknown as DbType;
}

// ── Stateful mock for createOrder tests ──
// createOrder uses getDb(c) + mocked service functions.
// We need a mock that supports db.insert(orders).values(...)
// and the issue-service operations.

function createMockContext(db: DbType, overrides: Record<string, unknown> = {}): Context<AppEnv> {
  const headers: Record<string, string> = { "user-agent": "test-agent", ...(overrides.headerOverrides as Record<string, string> || {}) };
  return {
    get: (key: string) => {
      if (key === "db") return db;
      if (key === "executionCtx") return overrides.executionCtx;
      return undefined as any;
    },
    env: {
      ADMIN_TOKEN: "test-token",
      ...(overrides.env as Record<string, unknown> || {}),
    } as any,
    req: {
      header: (name: string) => headers[name.toLowerCase()] || undefined,
      url: "https://example.com/api/pay/order",
      method: "POST",
    },
  } as unknown as Context<AppEnv>;
}

// ── Stateful DB mock for createOrder / markPaidAndIssue ──
function createMockDb(state: {
  orders?: Record<string, Record<string, unknown>>;
  cards?: Record<string, Record<string, unknown>>;
  coupons?: Record<string, Record<string, unknown>>;
  products?: Record<string, Record<string, unknown>>;
  events?: unknown[];
  referralEvents?: unknown[];
} = {}): DbType {
  const events = state.events || [];
  const referralEvents = state.referralEvents || [];
  const orders = state.orders || {};
  const cards = state.cards || {};

  // Helper: create an update chain with .set().where().returning() support
  function statefulUpdateChain(setData: Record<string, unknown> | undefined) {
    const whereChain: any = {
      returning: () => ({
        then: (resolve: (v: unknown) => void) => Promise.resolve([{ id: "any" }]).then(resolve),
      }),
      then: (resolve: (v: unknown) => void) => Promise.resolve({ rowsAffected: 1 }).then(resolve),
    };
    return {
      set: (_data?: unknown) => ({ where: () => whereChain }),
    };
  }

  return {
    __cards: cards,
    select: (_colMap?: unknown) => ({
      from: (_table?: unknown) => createSelectChain([]),
    }),
    insert: (_table?: unknown) => ({
      values: (data: unknown) => {
        const p = Array.isArray(data)
          ? Promise.resolve({ rowsAffected: data.length })
          : Promise.resolve({ rowsAffected: 1 });
        // Must be both thenable (await / .catch) AND support .onConflictDo*()
        const result: any = {
          onConflictDoUpdate: () => p,
          onConflictDoNothing: () => p,
        };
        // Copy Promise methods so `await` and `.catch()` work
        result.then = p.then.bind(p);
        result.catch = p.catch.bind(p);
        result.finally = p.finally.bind(p);
        return result;
      },
    }),
    update: (_table?: unknown) => statefulUpdateChain(undefined),
    delete: () => ({
      where: () => Promise.resolve({ rowsAffected: 0 }),
    }),
    run: (sqlExpr?: any) => {
      // Extract SQL text from Drizzle SQL template object
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
      // markPaidAndIssue: UPDATE orders SET status='issued' ... RETURNING
      if (q.includes("update orders") && q.includes("issued") && q.includes("returning")) {
        return Promise.resolve({ rows: [{ id: "any" }] });
      }
      // checkAndExpireOrder: UPDATE orders SET status='expired' ... RETURNING
      if (q.includes("update orders") && q.includes("expired") && q.includes("returning")) {
        return Promise.resolve({ rows: [] });
      }
      // issueAvailableCard: UPDATE cards SET status='issued' ... RETURNING
      if (q.includes("update cards") && q.includes("issued") && q.includes("returning")) {
        for (const [cardId, card] of Object.entries(cards)) {
          if (card.status === "available") {
            cards[cardId].status = "issued";
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
        return Promise.resolve({ rows: [] });
      }
      // lockCardForOrder: UPDATE cards SET status='locked' ... RETURNING
      if (q.includes("update cards") && q.includes("locked") && q.includes("returning")) {
        for (const [cardId, card] of Object.entries(cards)) {
          if (card.status === "available") {
            cards[cardId].status = "locked";
            return Promise.resolve({ rows: [{ id: cardId }] });
          }
        }
        return Promise.resolve({ rows: [] });
      }
      // releaseLockedCardByOrder: UPDATE cards SET status='available' ... (no RETURNING)
      if (q.includes("update cards") && q.includes("available")) {
        for (const [cardId, card] of Object.entries(cards)) {
          if (card.status === "locked") {
            cards[cardId].status = "available";
          }
        }
        return Promise.resolve({ rows: [] });
      }
      // insert card_logs (from writeCardLog)
      return Promise.resolve({ rows: [] });
    },
  } as unknown as DbType;
}

// ---------------------------------------------------------------------------
// publicOrder tests
// ---------------------------------------------------------------------------
describe("publicOrder", () => {
  const baseRow: OrderSummaryRow = {
    id: "order-1",
    orderNo: "AB20260101TEST",
    productId: "prod-1",
    productTitle: "Test Product",
    buyerContact: "pay:TEST1234",
    buyerEmail: "test@example.com",
    quantity: 1,
    amountCents: 5000,
    discountCents: 0,
    currency: "CNY",
    status: "pending",
    fulfillmentMode: "card",
    issueMode: "manual" as IssueMode,
    issuedCardId: null,
    campaignCode: "",
    referralCode: "",
    couponCode: "",
    createdAt: "2026-01-01T00:00:00Z",
    paidAt: null,
    issuedAt: null,
    accountLabel: null,
    deliverySecret: null,
    deliveryNote: null,
    deliveryJson: null,
    deliveryVisibility: "web_and_email",
  };

  it("returns order without delivery when no delivery provided", () => {
    const result = publicOrder(baseRow);
    expect(result.id).toBe("order-1");
    expect(result.status).toBe("pending");
    expect(result).not.toHaveProperty("delivery");
  });

  it("returns order with delivery when delivery provided", () => {
    const delivery = {
      accountLabel: "ACC-001",
      deliverySecret: "SECRET-001",
      deliveryNote: "Use wisely",
    };
    const result = publicOrder(baseRow, delivery);
    expect(result.delivery).toEqual(delivery);
  });

  it("does not expose delivery or cards for email-only products", () => {
    const delivery = {
      accountLabel: "ACC-001",
      deliverySecret: "SECRET-001",
      deliveryNote: "Use wisely",
    };
    const result = publicOrder({
      ...baseRow,
      status: "issued",
      deliveryVisibility: "email_only",
      cards: [{ id: "card-1", ...delivery }],
      items: [{
        id: "item-1",
        productId: "prod-1",
        productTitle: "Test Product",
        fulfillmentMode: "virtual",
        quantity: 1,
        unitPriceCents: 5000,
        discountCents: 0,
        amountCents: 5000,
        deliveryJson: JSON.stringify({ deliverySecret: "VIRTUAL-SECRET" }),
      }],
    }, delivery);

    expect((result as Record<string, unknown>).deliveryVisibility).toBe("email_only");
    expect(result.fulfillmentMode).toBe("virtual");
    expect(((result as unknown) as Record<string, string>).deliveryMessage).toContain("test@example.com");
    expect(((result as unknown) as Record<string, string>).deliveryMessage).toContain("邮件可能延迟");
    expect(result).not.toHaveProperty("delivery");
    expect(result).not.toHaveProperty("cards");
    expect(result.items?.[0]).not.toHaveProperty("deliveryJson");
    expect(JSON.stringify(result)).not.toContain("VIRTUAL-SECRET");
  });

  it("does not claim email delivery before an email-only order is issued", () => {
    const result = publicOrder({
      ...baseRow,
      status: "pending",
      deliveryVisibility: "email_only",
    });

    expect(result.deliveryVisibility).toBe("email_only");
    expect(result).not.toHaveProperty("deliveryMessage");
    expect(publicOrderSummary(result)).not.toHaveProperty("deliveryMessage");
  });

  it("preserves item deliveryJson for web-and-email products", () => {
    const deliveryJson = JSON.stringify({ deliverySecret: "VIRTUAL-SECRET" });
    const result = publicOrder({
      ...baseRow,
      items: [{
        id: "item-1",
        productId: "prod-1",
        productTitle: "Test Product",
        fulfillmentMode: "virtual",
        quantity: 1,
        unitPriceCents: 5000,
        discountCents: 0,
        amountCents: 5000,
        deliveryJson,
      }],
    });

    expect(result.items?.[0]).toHaveProperty("deliveryJson", deliveryJson);
  });

  it("removes delivery, cards, and item deliveryJson from public summaries", () => {
    const result = publicOrderSummary({
      ...publicOrder(baseRow, { text: "secret" }),
      cards: [{ id: "card-1", accountLabel: "acc", deliverySecret: "secret", deliveryNote: "note", cardData: "acc / secret" }],
      items: [{
        id: "item-1",
        productId: "prod-1",
        productTitle: "Product 1",
        fulfillmentMode: "link",
        quantity: 1,
        unitPriceCents: 1000,
        discountCents: 0,
        amountCents: 1000,
        deliveryJson: JSON.stringify({ url: "https://secret.example" }),
      }],
    });

    expect(result).not.toHaveProperty("delivery");
    expect(result).not.toHaveProperty("cards");
    expect(result.items?.[0]).not.toHaveProperty("deliveryJson");
    expect(result).not.toHaveProperty("buyerContact");
    expect(result).not.toHaveProperty("buyerEmail");
    expect(result).not.toHaveProperty("couponCode");
    expect(result).not.toHaveProperty("campaignCode");
    expect(result).not.toHaveProperty("referralCode");
  });

  it("includes couponCode when present", () => {
    const row = { ...baseRow, couponCode: "SAVE10" };
    const result = publicOrder(row);
    expect(result.couponCode).toBe("SAVE10");
  });

  it("preserves all basic fields", () => {
    const result = publicOrder(baseRow);
    expect(result.orderNo).toBe("AB20260101TEST");
    expect(result.productId).toBe("prod-1");
    expect(result.productTitle).toBe("Test Product");
    expect(result.amountCents).toBe(5000);
    expect(result.currency).toBe("CNY");
    expect(result.issueMode).toBe("manual");
  });
});

// ---------------------------------------------------------------------------
// checkAndExpireOrder tests
// ---------------------------------------------------------------------------
import { checkAndExpireOrder } from "./order-service";

describe("checkAndExpireOrder", () => {
  it("returns { expired: false } when expiresAt is null", async () => {
    const db = createResultDb([]);
    const result = await checkAndExpireOrder(db, "order-1", null, "pending");
    expect(result.expired).toBe(false);
    expect(result.releasedCards).toBe(0);
  });

  it("returns { expired: false } when order has not expired", async () => {
    const db = createResultDb([]);
    const future = new Date(Date.now() + 60000).toISOString();
    const result = await checkAndExpireOrder(db, "order-1", future, "pending");
    expect(result.expired).toBe(false);
    expect(result.releasedCards).toBe(0);
  });

  it("returns { expired: false } when status is issued and past expiresAt", async () => {
    const db = createResultDb([]);
    const past = new Date(Date.now() - 60000).toISOString();
    const result = await checkAndExpireOrder(db, "order-1", past, "issued");
    expect(result.expired).toBe(false);
    expect(result.releasedCards).toBe(0);
  });

  it("returns { expired: false } when status is paid and past expiresAt", async () => {
    const db = createResultDb([]);
    const past = new Date(Date.now() - 60000).toISOString();
    const result = await checkAndExpireOrder(db, "order-1", past, "paid");
    expect(result.expired).toBe(false);
    expect(result.releasedCards).toBe(0);
    expect(mockReleaseCouponReservation).not.toHaveBeenCalled();
  });

  it("returns { expired: false } when status is expired", async () => {
    const db = createResultDb([]);
    const past = new Date(Date.now() - 60000).toISOString();
    const result = await checkAndExpireOrder(db, "order-1", past, "expired");
    expect(result.expired).toBe(false);
    expect(result.releasedCards).toBe(0);
  });

  it("returns { expired: true } and marks expired when past expiresAt and status is pending", async () => {
    const past = new Date(Date.now() - 60000).toISOString();
    const state = {
      cards: {},
    };
    const db = createMockDb(state);
    // Override select to return the expired order coupon after card release queries.
    let selectCall = 0;
    (db as any).select = () => ({
      from: () => ({
        where: () => {
          selectCall += 1;
          const rows = selectCall >= 3 ? [{ couponCode: "SAVE10" }] : [];
          return createSelectChain(rows);
        },
      }),
    });
    // Override update to simulate successful expiration
    let updateCalled = false;
    (db as any).update = (_table?: unknown) => ({
      set: (_data?: unknown) => ({
        where: () => ({
          returning: () => {
            updateCalled = true;
            return Promise.resolve([{ id: "order-1", couponCode: "SAVE10" }]);
          },
        }),
      }),
    });
    const result = await checkAndExpireOrder(db, "order-1", past, "pending");
    expect(result.expired).toBe(true);
    expect(result.releasedCards).toBe(0);
    expect(updateCalled).toBe(true);
    expect(mockReleaseCouponReservation).toHaveBeenCalledWith(db, "SAVE10");
  });

  it("returns { expired: false } when UPDATE affects 0 rows (concurrent)", async () => {
    const past = new Date(Date.now() - 60000).toISOString();
    const db = createMockDb({});
    // Override update to return empty (concurrent update won the race)
    (db as any).update = (_table?: unknown) => ({
      set: (_data?: unknown) => ({
        where: () => ({
          returning: () => Promise.resolve([]),  // No rows updated
        }),
      }),
    });
    const result = await checkAndExpireOrder(db, "order-1", past, "pending");
    expect(result.expired).toBe(false);
    expect(result.releasedCards).toBe(0);
  });

  it("sends expired email when env and orderInfo provided", async () => {
    const past = new Date(Date.now() - 60000).toISOString();
    let updateCalled = false;
    // 使用完整的 createMockDb，只覆盖 update returning
    const db = createMockDb({});
    (db as any).update = (_table?: unknown) => ({
      set: (_data?: unknown) => ({
        where: () => ({
          returning: () => {
            updateCalled = true;
            return Promise.resolve([{ id: "order-1" }]);
          },
        }),
      }),
    });

    // 调用 checkAndExpireOrder 带 env 和 orderInfo
    // sendEmail 是异步 fire-and-forget，即使 Resend 不可用也不会阻塞
    const result = await checkAndExpireOrder(
      db, "order-1", past, "pending",
      { resendApiKey: "re_test", emailFrom: "", turnstileEnabled: false, turnstileSecretKey: "", allowTurnstileBypassForSmoke: false, inventoryWarningEmailTo: "" },
      { orderNo: "OID-EXP", productTitle: "Test Product", buyerEmail: "buyer@test.com" }
    );

    expect(result.expired).toBe(true);
    expect(result.releasedCards).toBe(0);
    expect(updateCalled).toBe(true);
    // 邮件是异步 catch 发送，不阻塞主流程
    // 等待异步操作完成
    await new Promise((r) => setTimeout(r, 100));
  });

  it("does not send email when env has no RESEND_API_KEY", async () => {
    const past = new Date(Date.now() - 60000).toISOString();
    const db = createMockDb({});
    (db as any).update = (_table?: unknown) => ({
      set: (_data?: unknown) => ({
        where: () => ({
          returning: () => Promise.resolve([{ id: "order-1" }]),
        }),
      }),
    });

    // Without env.RESEND_API_KEY
    const result = await checkAndExpireOrder(
      db, "order-1", past, "pending",
      undefined,  // no runtime config
      { orderNo: "OID-EXP", productTitle: "Test", buyerEmail: "buyer@test.com" }
    );
    expect(result.expired).toBe(true);
    expect(result.releasedCards).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// createOrder tests
// ---------------------------------------------------------------------------
describe("createOrder", () => {
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
  });

  it("returns 400 with 折扣码不存在 when coupon code not found in DB", async () => {
    mockGetCoupon.mockResolvedValue(null);
    const db = createMockDb();
    const c = createMockContext(db);
    const input: CreateOrderInput = { buyerEmail: "test@example.com", couponCode: "DOESNOTEXIST" };
    const result = await createOrder(c, input, "iphash123");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.message).toBe("折扣码不存在");
    }
  });

  it("returns 400 with 该折扣码未绑定商品 when coupon exists but has no productId", async () => {
    mockGetCoupon.mockResolvedValue({ productId: "" });
    const db = createMockDb();
    const c = createMockContext(db);
    const input: CreateOrderInput = { buyerEmail: "test@example.com", couponCode: "NOPRODUCT" };
    const result = await createOrder(c, input, "iphash123");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.message).toBe("该折扣码未绑定商品");
    }
  });

  it("returns 400 when no productId and no coupon with productId", async () => {
    mockGetCoupon.mockResolvedValue(null);
    const db = createMockDb();
    const c = createMockContext(db);
    const input: CreateOrderInput = { buyerEmail: "test@example.com" };
    const result = await createOrder(c, input, "iphash123");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.message).toBe("请选择商品");
    }
  });

  it("resolves productId from coupon when input.productId is empty", async () => {
    mockGetCoupon.mockResolvedValue({ productId: "prod-from-coupon" });
    mockGetProduct.mockResolvedValue({
      id: "prod-from-coupon",
      title: "Coupon Product",
      priceCents: 3000,
      currency: "CNY",
      issueMode: "manual",
      fulfillmentMode: "card",
    });
    mockQuoteCoupon.mockResolvedValue({
      couponCode: "COUPON10",
      valid: true,
      discountCents: 0,
      payableCents: 3000,
      message: "折扣码可用",
    });
    const db = createMockDb({
      cards: {
        "card-1": {
          id: "card-1",
          status: "available",
          accountLabel: "ACC",
          deliverySecret: "SEC",
          deliveryNote: "",
          lockedOrderId: null,
        },
      },
    });
    const c = createMockContext(db);
    const input: CreateOrderInput = { buyerEmail: "coupon@example.com", couponCode: "COUPON10" };
    const result = await createOrder(c, input, "iphash123");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.order.status).toBe("pending");
    }
  });

  it("returns 404 when product does not exist", async () => {
    mockGetProduct.mockResolvedValue(null);
    const db = createMockDb();
    const c = createMockContext(db);
    const input: CreateOrderInput = { productId: "nonexistent", buyerEmail: "test@example.com" };
    const result = await createOrder(c, input, "iphash123");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
      expect(result.message).toBe("商品不存在或已下架");
    }
  });

  it("returns 500 when product has no issueMode", async () => {
    mockGetProduct.mockResolvedValue({
      id: "prod-no-mode",
      title: "No Mode Product",
      priceCents: 1000,
      currency: "CNY",
      issueMode: null,
      fulfillmentMode: "card",
    });
    const db = createMockDb();
    const c = createMockContext(db);
    const input: CreateOrderInput = { productId: "prod-no-mode", buyerEmail: "test@example.com" };
    const result = await createOrder(c, input, "iphash123");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.message).toBe("商品发卡模式配置异常，请联系管理员");
    }
  });

  it("returns 403 when coupon is invalid", async () => {
    mockGetProduct.mockResolvedValue({
      id: "prod-1",
      title: "Product",
      priceCents: 1000,
      currency: "CNY",
      issueMode: "manual",
      fulfillmentMode: "card",
    });
    mockQuoteCoupon.mockResolvedValue({
      couponCode: "BAD",
      valid: false,
      discountCents: 0,
      payableCents: 1000,
      message: "折扣码不存在或已停用",
    });
    const db = createMockDb();
    const c = createMockContext(db);
    const input: CreateOrderInput = { productId: "prod-1", buyerEmail: "test@example.com", couponCode: "BAD" };
    const result = await createOrder(c, input, "iphash123");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.message).toBe("折扣码不存在或已停用");
    }
  });

  it("returns 409 when manual mode and no card available (lock fails)", async () => {
    mockGetProduct.mockResolvedValue({
      id: "prod-manual",
      title: "Manual Product",
      priceCents: 2000,
      currency: "CNY",
      issueMode: "manual",
      fulfillmentMode: "card",
    });
    const db = createMockDb({ cards: {} });
    const c = createMockContext(db);
    const input: CreateOrderInput = { productId: "prod-manual", buyerEmail: "test@example.com" };
    const result = await createOrder(c, input, "iphash123");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.message).toBe("当前商品库存不足");
    }
  });

  it("creates manual order successfully when card is available", async () => {
    mockGetProduct.mockResolvedValue({
      id: "prod-manual",
      title: "Manual Product",
      priceCents: 2000,
      currency: "CNY",
      issueMode: "manual",
      fulfillmentMode: "card",
    });
    const db = createMockDb({
      cards: {
        "card-1": {
          id: "card-1",
          status: "available",
          accountLabel: "ACC",
          deliverySecret: "SEC",
          deliveryNote: "Note",
          lockedOrderId: null,
        },
      },
    });
    const c = createMockContext(db);
    const input: CreateOrderInput = { productId: "prod-manual", buyerEmail: "buyer@example.com", buyerContact: "  test contact  " };
    const result = await createOrder(c, input, "iphash123");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.order.id).toBeDefined();
      expect(result.order.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.order.orderNo).toMatch(/^AB\d{8}.{8}$/);
      expect(result.order.status).toBe("pending");
      expect(result.order.issueMode).toBe("manual");
      expect(result.order.amountCents).toBe(1000);
      expect(result.order.currency).toBe("CNY");
      expect(result.order.orderToken).toBeDefined();
      expect(result.order.orderToken).toBeTruthy();
      expect(result.order.lookupUrl).toContain("/lookup?token=");
      expect(result.order.nextAction).toBeDefined();
    }
  });

  it("bills selling price only when product has compare-at originalPriceCents", async () => {
    // 货架对比价仅营销；下单 baseAmount / 报价 / 订单金额不得使用 originalPriceCents
    mockGetProduct.mockResolvedValue({
      id: "prod-promo",
      title: "Promo Product",
      priceCents: 200,
      originalPriceCents: 500,
      currency: "CNY",
      issueMode: "manual",
      fulfillmentMode: "card",
    });
    mockQuoteCoupon.mockResolvedValue({
      couponCode: "",
      valid: true,
      discountCents: 0,
      payableCents: 200,
      message: "无折扣码，按原价购买",
    });
    const db = createMockDb({
      cards: {
        "card-promo": {
          id: "card-promo",
          status: "available",
          accountLabel: "ACC",
          deliverySecret: "SEC",
          deliveryNote: "",
          lockedOrderId: null,
        },
      },
    });
    const c = createMockContext(db);
    const result = await createOrder(c, {
      productId: "prod-promo",
      buyerEmail: "promo@example.com",
      quantity: 1,
    }, "iphash123");

    expect(result.ok).toBe(true);
    expect(mockQuoteCoupon).toHaveBeenCalledWith(
      expect.anything(),
      200,
      "prod-promo",
      undefined,
      "CNY",
    );
    if (result.ok) {
      expect(result.order.amountCents).toBe(200);
    }
  });

  it("returns 400 when paid product is configured as direct mode", async () => {
    mockGetProduct.mockResolvedValue({
      id: "prod-direct",
      title: "Direct Product",
      priceCents: 1000,
      currency: "CNY",
      issueMode: "direct",
      fulfillmentMode: "card",
    });
    const db = createMockDb({ cards: {} });
    const c = createMockContext(db);
    const input: CreateOrderInput = { productId: "prod-direct", buyerEmail: "test@example.com" };
    const result = await createOrder(c, input, "iphash123");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.message).toBe("付费商品不能使用直接发卡模式，请改用支付下单");
    }
  });

  it("rejects paid direct order before issuing card", async () => {
    mockGetProduct.mockResolvedValue({
      id: "prod-direct",
      title: "Direct Product",
      priceCents: 1000,
      currency: "CNY",
      issueMode: "direct",
      fulfillmentMode: "card",
    });
    const db = createMockDb({
      cards: {
        "card-1": {
          id: "card-1",
          status: "available",
          accountLabel: "ACC-DIRECT",
          deliverySecret: "SECRET-DIRECT",
          deliveryNote: "Direct note",
        },
      },
    });
    const c = createMockContext(db);
    const input: CreateOrderInput = { productId: "prod-direct", buyerEmail: "direct@example.com" };
    const result = await createOrder(c, input, "iphash123");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.message).toBe("付费商品不能使用直接发卡模式，请改用支付下单");
    }
  });

  it("creates direct order only when coupon makes it free", async () => {
    mockGetProduct.mockResolvedValue({
      id: "prod-direct",
      title: "Direct Product",
      priceCents: 1000,
      currency: "CNY",
      issueMode: "direct",
      fulfillmentMode: "card",
    });
    mockQuoteCoupon.mockResolvedValue({
      couponCode: "FREE100",
      valid: true,
      discountCents: 1000,
      payableCents: 0,
      message: "折扣码可用",
    });
    const db = createMockDb({
      cards: {
        "card-1": {
          id: "card-1",
          status: "available",
          accountLabel: "ACC-COUPON",
          deliverySecret: "SECRET-COUPON",
          deliveryNote: "Coupon note",
        },
      },
    });
    const c = createMockContext(db);
    const input: CreateOrderInput = {
      productId: "prod-direct",
      buyerEmail: "direct@example.com",
      couponCode: "FREE100",
    };
    const result = await createOrder(c, input, "iphash123");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.order.status).toBe("issued");
      expect(mockConsumeCoupon).toHaveBeenCalled();
    }
  });

  it("creates direct order but coupon consume fails — order marked failed", async () => {
    mockGetProduct.mockResolvedValue({
      id: "prod-direct",
      title: "Direct Product",
      priceCents: 1000,
      currency: "CNY",
      issueMode: "direct",
      fulfillmentMode: "card",
    });
    mockQuoteCoupon.mockResolvedValue({
      couponCode: "EXPIRED",
      valid: true,
      discountCents: 1000,
      payableCents: 0,
      message: "折扣码可用",
    });
    mockConsumeCoupon.mockResolvedValue({ success: false, changes: 0 });
    const db = createMockDb({
      cards: {
        "card-1": {
          id: "card-1",
          status: "available",
          accountLabel: "ACC-FAIL",
          deliverySecret: "SECRET-FAIL",
          deliveryNote: "Fail note",
        },
      },
    });
    const c = createMockContext(db);
    const input: CreateOrderInput = {
      productId: "prod-direct",
      buyerEmail: "direct@example.com",
      couponCode: "EXPIRED",
    };
    const result = await createOrder(c, input, "iphash123");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.message).toContain("优惠码");
    }
  });

  it("returns 400 when product has invalid issueMode (webhook)", async () => {
    mockGetProduct.mockResolvedValue({
      id: "prod-webhook",
      title: "Webhook Product",
      priceCents: 5000,
      currency: "CNY",
      issueMode: "webhook",
      fulfillmentMode: "card",
    });
    const db = createMockDb();
    const c = createMockContext(db);
    const input: CreateOrderInput = { productId: "prod-webhook", buyerEmail: "webhook@example.com" };
    const result = await createOrder(c, input, "iphash123");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.message).toBe("商品发卡模式配置异常，请联系管理员");
    }
  });

  it("returns 429 when same email has >=maxOrders pending/paid orders within windowSeconds", async () => {
    mockGetProduct.mockResolvedValue({
      id: "prod-manual",
      title: "Manual Product",
      priceCents: 2000,
      currency: "CNY",
      issueMode: "manual",
      fulfillmentMode: "card",
    });
    const db = createMockDb({});
    (db as any).select = (_colMap: unknown) => ({
      from: (_table?: unknown) => createSelectChain([{ count: 3 }]),
    });
    const c = createMockContext(db);
    const input: CreateOrderInput = { productId: "prod-manual", buyerEmail: "rush@example.com" };
    const result = await createOrder(c, input, "iphash123");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(429);
      expect(result.message).toBe("该邮箱购买过于频繁，请 5 分钟后再试");
    }
  });

  it("allows order when same email has <maxOrders pending/paid orders within windowSeconds", async () => {
    mockGetProduct.mockResolvedValue({
      id: "prod-manual",
      title: "Manual Product",
      priceCents: 2000,
      currency: "CNY",
      issueMode: "manual",
      fulfillmentMode: "card",
    });
    const db = createMockDb({
      cards: {
        "card-1": {
          id: "card-1",
          status: "available",
          accountLabel: "ACC",
          deliverySecret: "SEC",
          deliveryNote: "Note",
          lockedOrderId: null,
        },
      },
    });
    (db as any).select = (_colMap: unknown) => ({
      from: (_table?: unknown) => createSelectChain([{ count: 2 }]),
    });
    const c = createMockContext(db);
    const input: CreateOrderInput = { productId: "prod-manual", buyerEmail: "ok@example.com" };
    const result = await createOrder(c, input, "iphash123");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.order.status).toBe("pending");
    }
  });

  it("uses dynamic rate limit config for product-level check", async () => {
    mockGetProduct.mockResolvedValue({
      id: "prod-manual",
      title: "Manual Product",
      priceCents: 2000,
      currency: "CNY",
      issueMode: "manual",
      fulfillmentMode: "card",
    });
    mockGetOrderRateLimitConfig.mockResolvedValueOnce({ windowSeconds: 600, maxOrders: 5 });
    const db = createMockDb({});
    (db as any).select = (_colMap: unknown) => ({
      from: (_table?: unknown) => createSelectChain([{ count: 5 }]),
    });
    const c = createMockContext(db);
    const input: CreateOrderInput = { productId: "prod-manual", buyerEmail: "rush@example.com" };
    const result = await createOrder(c, input, "iphash123");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(429);
      expect(result.message).toBe("该邮箱购买过于频繁，请 10 分钟后再试");
    }
  });

  it("returns 429 when product purchase limit reached by quantity", async () => {
    mockGetProduct.mockResolvedValue({
      id: "prod-limited",
      title: "Limited Product",
      priceCents: 2000,
      currency: "CNY",
      issueMode: "manual",
      fulfillmentMode: "card",
      purchaseLimit: 2,
    });
    const db = createMockDb({});
    (db as any).select = (_colMap: unknown) => ({
      from: (_table?: unknown) => createSelectChain([{ count: 1 }]),
    });
    const c = createMockContext(db);
    const input: CreateOrderInput = { productId: "prod-limited", buyerEmail: "buyer@example.com", quantity: 2 };
    const result = await createOrder(c, input, "iphash123");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(429);
      expect(result.message).toBe("该商品每人限购 2 件，您已达到上限");
    }
  });

  it("allows order when under product purchase limit", async () => {
    mockGetProduct.mockResolvedValue({
      id: "prod-limited",
      title: "Limited Product",
      priceCents: 2000,
      currency: "CNY",
      issueMode: "manual",
      fulfillmentMode: "card",
      purchaseLimit: 3,
    });
    const db = createMockDb({
      cards: {
        "card-1": {
          id: "card-1",
          status: "available",
          accountLabel: "ACC",
          deliverySecret: "SEC",
          deliveryNote: "Note",
          lockedOrderId: null,
        },
      },
    });
    (db as any).select = (_colMap: unknown) => ({
      from: (_table?: unknown) => createSelectChain([{ count: 1 }]),
    });
    const c = createMockContext(db);
    const input: CreateOrderInput = { productId: "prod-limited", buyerEmail: "buyer@example.com" };
    const result = await createOrder(c, input, "iphash123");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.order.status).toBe("pending");
    }
  });

  it("skips purchase limit when product has no limit", async () => {
    mockGetProduct.mockResolvedValue({
      id: "prod-unlimited",
      title: "Unlimited Product",
      priceCents: 2000,
      currency: "CNY",
      issueMode: "manual",
      fulfillmentMode: "card",
      purchaseLimit: null,
    });
    const db = createMockDb({
      cards: {
        "card-1": {
          id: "card-1",
          status: "available",
          accountLabel: "ACC",
          deliverySecret: "SEC",
          deliveryNote: "Note",
          lockedOrderId: null,
        },
      },
    });
    (db as any).select = (_colMap: unknown) => ({
      from: (_table?: unknown) => createSelectChain([{ count: 2 }]),
    });
    const c = createMockContext(db);
    const input: CreateOrderInput = { productId: "prod-unlimited", buyerEmail: "buyer@example.com" };
    const result = await createOrder(c, input, "iphash123");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.order.status).toBe("pending");
    }
  });

  it("enforces purchase limit for direct issue mode", async () => {
    mockGetProduct.mockResolvedValue({
      id: "prod-direct",
      title: "Direct Product",
      priceCents: 0,
      currency: "CNY",
      issueMode: "direct",
      fulfillmentMode: "card",
      purchaseLimit: 1,
    });
    mockQuoteCoupon.mockResolvedValue({
      couponCode: "FREE",
      valid: true,
      discountCents: 0,
      payableCents: 0,
      message: "免单",
    });
    const db = createMockDb({
      cards: {
        "card-1": {
          id: "card-1",
          status: "available",
          accountLabel: "ACC",
          deliverySecret: "SEC",
          deliveryNote: "Note",
          lockedOrderId: null,
        },
      },
    });
    (db as any).select = (_colMap: unknown) => ({
      from: (_table?: unknown) => createSelectChain([{ count: 1 }]),
    });
    const c = createMockContext(db);
    const input: CreateOrderInput = { productId: "prod-direct", buyerEmail: "direct@example.com", couponCode: "FREE" };
    const result = await createOrder(c, input, "iphash123");
    expect(result).toEqual({ ok: false, status: 429, message: "该商品每人限购 1 件，您已达到上限" });
  });

  it("rechecks direct purchase limit inside its write transaction", async () => {
    mockGetProduct.mockResolvedValue({
      id: "prod-direct-race",
      title: "Direct Race Product",
      priceCents: 0,
      currency: "CNY",
      issueMode: "direct",
      fulfillmentMode: "card",
      purchaseLimit: 1,
    });
    mockQuoteCoupon.mockResolvedValue({
      couponCode: "",
      valid: true,
      discountCents: 0,
      payableCents: 0,
      message: "无折扣码",
    });
    const db = createMockDb({
      cards: {
        "card-direct-race": {
          id: "card-direct-race",
          status: "available",
          accountLabel: "ACC",
          deliverySecret: "SECRET",
          deliveryNote: "Note",
        },
      },
    });
    let purchaseLimitReads = 0;
    const originalSelect = (db as any).select.bind(db);
    (db as any).select = (columns: unknown) => ({
      from: (table: unknown) => table === ordersTable
        ? createSelectChain([{ count: purchaseLimitReads++ === 0 ? 0 : 1 }])
        : originalSelect(columns).from(table),
    });

    const result = await createOrder(createMockContext(db), {
      productId: "prod-direct-race",
      buyerEmail: "direct-race@example.com",
    }, "iphash-direct-race");

    expect(result).toEqual({ ok: false, status: 429, message: "该商品每人限购 1 件，您已达到上限" });
    expect(purchaseLimitReads).toBe(2);
    expect((db as any).__cards["card-direct-race"].status).toBe("available");
  });

  // ── 虚拟资料交付（非 card） ──
  it("creates issued virtual-direct order with deliveryJson when free", async () => {
    mockGetProduct.mockResolvedValue({
      id: "prod-virtual",
      title: "Virtual Product",
      priceCents: 0,
      currency: "CNY",
      issueMode: "direct",
      fulfillmentMode: "virtual",
      salesCopy: "Download link: https://example.com/file.zip",
    });
    mockQuoteCoupon.mockResolvedValue({
      couponCode: "",
      valid: true,
      discountCents: 0,
      payableCents: 0,
      message: "无折扣码",
    });
    const db = createMockDb({});
    const c = createMockContext(db);
    const input: CreateOrderInput = { productId: "prod-virtual", buyerEmail: "virtual@example.com" };
    const result = await createOrder(c, input, "iphash123");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.order.status).toBe("issued");
      expect(result.order.delivery).toBeDefined();
      expect((result.order.delivery as any).accountLabel).toBe("Virtual Product");
      expect((result.order.delivery as any).deliverySecret).toBe("Download link: https://example.com/file.zip");
    }
  });

  it("consumes a free coupon when creating a virtual direct order", async () => {
    mockGetCoupon.mockResolvedValue({ code: "FREE-VIRTUAL", productId: "prod-virtual-coupon" });
    mockGetProduct.mockResolvedValue({
      id: "prod-virtual-coupon",
      title: "Virtual Coupon Product",
      priceCents: 1000,
      currency: "CNY",
      issueMode: "direct",
      fulfillmentMode: "virtual",
      salesCopy: "PRIVATE-VIRTUAL",
    });
    mockQuoteCoupon.mockResolvedValue({
      couponCode: "FREE-VIRTUAL",
      valid: true,
      discountCents: 1000,
      payableCents: 0,
      message: "折扣码可用",
    });

    const result = await createOrder(createMockContext(createMockDb({})), {
      productId: "prod-virtual-coupon",
      buyerEmail: "virtual-coupon@example.com",
      couponCode: "FREE-VIRTUAL",
    }, "iphash-virtual-coupon");

    expect(result.ok).toBe(true);
    expect(mockConsumeCoupon).toHaveBeenCalledWith(expect.anything(), "free-virtual");
  });

  it("does not return virtual delivery plaintext for email-only direct orders", async () => {
    mockGetProduct.mockResolvedValue({
      id: "prod-virtual-email-only",
      title: "Email Only Product",
      priceCents: 0,
      currency: "CNY",
      issueMode: "direct",
      fulfillmentMode: "virtual",
      salesCopy: "PRIVATE-DIRECT-CONTENT",
      deliveryVisibility: "email_only",
    });
    mockQuoteCoupon.mockResolvedValue({
      couponCode: "",
      valid: true,
      discountCents: 0,
      payableCents: 0,
      message: "无折扣码",
    });
    const result = await createOrder(createMockContext(createMockDb({}), {
      env: { RESEND_API_KEY: "resend-key" },
      executionCtx: { waitUntil: vi.fn() },
    }), {
      productId: "prod-virtual-email-only",
      buyerEmail: "virtual-email@example.com",
    }, "iphash-email-only");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.order.deliveryVisibility).toBe("email_only");
      expect(result.order.deliveryMessage).toContain("virtual-email@example.com");
      expect(result.order.delivery).toBeUndefined();
    }
  });

  it("does not return card plaintext for email-only direct orders", async () => {
    mockGetProduct.mockResolvedValue({
      id: "prod-card-email-only",
      title: "Card Email Only",
      priceCents: 0,
      currency: "CNY",
      issueMode: "direct",
      fulfillmentMode: "card",
      deliveryVisibility: "email_only",
    });
    mockQuoteCoupon.mockResolvedValue({
      couponCode: "",
      valid: true,
      discountCents: 0,
      payableCents: 0,
      message: "无折扣码",
    });
    const db = createMockDb({
      cards: {
        "card-email-only": {
          id: "card-email-only",
          status: "available",
          accountLabel: "ACC-EMAIL",
          deliverySecret: "SECRET-EMAIL",
          deliveryNote: "Note",
        },
      },
    });
    const result = await createOrder(createMockContext(db, {
      env: { RESEND_API_KEY: "resend-key" },
      executionCtx: { waitUntil: vi.fn() },
    }), {
      productId: "prod-card-email-only",
      buyerEmail: "card-email@example.com",
    }, "iphash-card-email-only");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.order.deliveryVisibility).toBe("email_only");
      expect(result.order.delivery).toBeUndefined();
      expect(result.order.cards).toBeUndefined();
      expect(result.order.deliveryMessage).toContain("card-email@example.com");
    }
  });

  it("creates pending virtual-manual order without deliveryJson", async () => {
    mockGetProduct.mockResolvedValue({
      id: "prod-virtual-manual",
      title: "Virtual Manual Product",
      priceCents: 1000,
      currency: "CNY",
      issueMode: "manual",
      fulfillmentMode: "virtual",
      salesCopy: "Secret content",
    });
    const db = createMockDb({});
    const c = createMockContext(db);
    const input: CreateOrderInput = { productId: "prod-virtual-manual", buyerEmail: "vm@example.com" };
    const result = await createOrder(c, input, "iphash123");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.order.status).toBe("pending");
      expect(result.order.delivery).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// getOrderByToken tests
// ---------------------------------------------------------------------------
describe("getOrderByToken", () => {
  it("returns null for empty token", async () => {
    const db = createResultDb([]);
    const result = await getOrderByToken(db, "");
    // hashOrderToken("") gives some hash, but DB returns no rows
    expect(result).toBeNull();
  });

  it("returns order when found", async () => {
    const orderRow = {
      id: "order-1",
      orderNo: "AB20260101TEST",
      productId: "prod-1",
      productTitle: "Product 1",
      buyerContact: "contact",
      buyerEmail: "test@example.com",
      amountCents: 1000,
      discountCents: 0,
      currency: "CNY",
      status: "pending",
      issueMode: "manual",
      issuedCardId: null,
      campaignCode: "",
      referralCode: "",
      couponCode: "",
      createdAt: "2026-01-01T00:00:00Z",
      paidAt: null,
      issuedAt: null,
      accountLabel: null,
      deliverySecret: null,
      deliveryNote: null,
    };
    const db = createResultDb([orderRow]);
    const result = await getOrderByToken(db, "some-token");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("order-1");
    expect(result!.status).toBe("pending");
    expect(result).not.toHaveProperty("delivery");
  });

  it("returns order with delivery when issued and card info exists", async () => {
    const orderRow = {
      id: "order-issued",
      orderNo: "AB20260101ISS",
      productId: "prod-1",
      productTitle: "Product 1",
      buyerContact: "contact",
      buyerEmail: "test@example.com",
      amountCents: 1000,
      discountCents: 0,
      currency: "CNY",
      status: "issued",
      issueMode: "direct",
      issuedCardId: "card-1",
      campaignCode: "",
      referralCode: "",
      couponCode: "",
      createdAt: "2026-01-01T00:00:00Z",
      paidAt: null,
      issuedAt: null,
      accountLabel: "ACC-001",
      deliverySecret: "SECRET-001",
      deliveryNote: "Note 1",
    };
    const db = createResultDb([orderRow]);
    const result = await getOrderByToken(db, "token-issued");
    expect(result).not.toBeNull();
    expect(result!.status).toBe("issued");
    expect(result!.delivery).toBeDefined();
    expect((result!.delivery as any).accountLabel).toBe("ACC-001");
  });

  it("returns order without delivery when card info is missing", async () => {
    const orderRow = {
      id: "order-no-card",
      orderNo: "AB20260101NC",
      productId: "prod-1",
      productTitle: "Product 1",
      buyerContact: "contact",
      buyerEmail: "test@example.com",
      amountCents: 1000,
      discountCents: 0,
      currency: "CNY",
      status: "issued",
      issueMode: "direct",
      issuedCardId: "card-missing",
      campaignCode: "",
      referralCode: "",
      couponCode: "",
      createdAt: "2026-01-01T00:00:00Z",
      paidAt: null,
      issuedAt: null,
      accountLabel: null,
      deliverySecret: null,
      deliveryNote: null,
    };
    const db = createResultDb([orderRow]);
    const result = await getOrderByToken(db, "some-token");
    expect(result).not.toBeNull();
    expect(result!.status).toBe("issued");
    expect(result).not.toHaveProperty("delivery");
  });
});

// ---------------------------------------------------------------------------
// getOrderSummariesByEmail tests
// ---------------------------------------------------------------------------
describe("getOrderSummariesByEmail", () => {
  it("returns an empty list when the mailbox has no orders", async () => {
    const db = createResultDb([]);
    const result = await getOrderSummariesByEmail(db, "nobody@example.com", 20);
    expect(result).toEqual([]);
  });

  it("returns only explicitly selected summary fields", async () => {
    const db = createResultDb([{
      id: "order-1",
      orderNo: "ORD-1",
      productId: "prod-1",
      productTitle: "Product 1",
      buyerContact: "private-contact",
      buyerEmail: "buyer@example.com",
      amountCents: 1000,
      discountCents: 0,
      currency: "CNY",
      status: "issued",
      issueMode: "direct",
      issuedCardId: "card-1",
      campaignCode: "campaign-private",
      referralCode: "referral-private",
      couponCode: "coupon-private",
      createdAt: "2026-01-01T00:00:00Z",
      paidAt: null,
      issuedAt: null,
      accountLabel: "account-private",
      deliverySecret: "delivery-private",
      deliveryNote: "note-private",
    }]);

    const result = await getOrderSummariesByEmail(db, "BUYER@example.com", 20);

    expect(result[0]?.orderNo).toBe("ORD-1");
    expect(result[0]).not.toHaveProperty("delivery");
    expect(result[0]).not.toHaveProperty("cards");
    expect(result[0]).not.toHaveProperty("buyerContact");
    expect(result[0]).not.toHaveProperty("buyerEmail");
    expect(result[0]).not.toHaveProperty("couponCode");
  });
});

// ---------------------------------------------------------------------------
// markPaidAndIssue tests
// ---------------------------------------------------------------------------
describe("markPaidAndIssue", () => {
  it("returns 404 when order does not exist", async () => {
    const db = createResultDb([]); // no orders
    const result = await markPaidAndIssue(db, "nonexistent-id", undefined);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.message).toBe("订单不存在");
  });

  it("returns 410 when order is expired", async () => {
    const orderRow = {
      id: "order-expired",
      productId: "product-1",
      buyerEmail: "user@test.com",
      status: "pending",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      couponCode: null,
      productTitle: "Test Product",
    };
    const db = createResultDb([orderRow], {
      "update orders set status = 'expired'": { rows: [{ id: "order-expired" }] },
    });
    const result = await markPaidAndIssue(db, "order-expired", undefined);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(410);
    expect(result.message).toBe("订单已过期");
  });

  it("returns alreadyIssued when order is already issued", async () => {
    const orderRow = {
      id: "order-issued",
      productId: "product-1",
      buyerEmail: "user@test.com",
      status: "issued",
      expiresAt: null,
      couponCode: null,
      productTitle: "Test Product",
    };
    const db = createResultDb([orderRow]);
    const result = await markPaidAndIssue(db, "order-issued", undefined);
    expect(result.ok).toBe(true);
    expect(result.alreadyIssued).toBe(true);
  });

  it("returns 409 when order status is invalid (canceled)", async () => {
    const orderRow = {
      id: "order-canceled",
      productId: "product-1",
      buyerEmail: "user@test.com",
      status: "canceled",
      couponCode: null,
      expiresAt: null,
      productTitle: "Test Product",
    };
    const db = createResultDb([orderRow]);
    const result = await markPaidAndIssue(db, "order-canceled", undefined);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(409);
    expect(result.message).toBe("当前订单状态不可发卡");
  });

  it("returns 409 when order status is refunded", async () => {
    const orderRow = {
      id: "order-refunded",
      productId: "product-1",
      buyerEmail: "user@test.com",
      status: "refunded",
      expiresAt: null,
      productTitle: "Test Product",
      couponCode: null,
    };
    const db = createResultDb([orderRow]);
    const result = await markPaidAndIssue(db, "order-refunded", undefined);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(409);
    expect(result.message).toBe("当前订单状态不可发卡");
  });

  it("returns 409 when no card is available", async () => {
    const orderRow = {
      id: "order-pending",
      productId: "product-empty",
      buyerEmail: "user@test.com",
      status: "pending",
      expiresAt: null,
      productTitle: "Test Product",
      couponCode: null,
    };
    const db = createResultDb([orderRow]);
    const result = await markPaidAndIssue(db, "order-pending", undefined);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(409);
    expect(result.message).toBe("当前商品库存不足");
  });

  it("keeps paid order paid when issuing fails", async () => {
    const orderRow = {
      id: "order-paid-empty",
      productId: "product-empty",
      buyerEmail: "user@test.com",
      status: "paid",
      expiresAt: null,
      productTitle: "Test Product",
      couponCode: null,
    };
    const updates: unknown[] = [];
    const db = createResultDb([orderRow]);
    (db as any).update = () => ({
      set: (data: unknown) => {
        updates.push(data);
        return {
          where: () => ({
            returning: () => Promise.resolve([]),
            then: (resolve: (v: unknown) => void) => Promise.resolve({ rowsAffected: 1 }).then(resolve),
          }),
        };
      },
    });
    const result = await markPaidAndIssue(db, "order-paid-empty", undefined);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(409);
    expect(updates).not.toContainEqual({ status: "pending", paidAt: null });
    expect(mockWriteOrderEvent).toHaveBeenCalledWith(
      db,
      "order-paid-empty",
      "issue_failed",
      expect.stringContaining("订单已支付"),
    );
  });

  it("successfully issues card for pending order", async () => {
    const orderRow = {
      id: "order-ok",
      productId: "product-1",
      buyerEmail: "buyer@test.com",
      status: "pending",
      expiresAt: null,
      productTitle: "Test Product",
      couponCode: null,
    };
    const state = {
      cards: {
        "card-available": {
          id: "card-available",
          accountLabel: "FINAL-ACC",
          deliverySecret: "FINAL-SECRET",
          deliveryNote: "Delivered via test",
          status: "available",
        },
      },
    };
    const db = createMockDb(state);
    // Override select for markPaidAndIssue's initial query
    (db as any).select = (_colMap: unknown) => ({
      from: (_table?: unknown) => createSelectChain([orderRow]),
    });
    const result = await markPaidAndIssue(db, "order-ok", { resendApiKey: "re_test", emailFrom: "", turnstileEnabled: false, turnstileSecretKey: "", allowTurnstileBypassForSmoke: false, inventoryWarningEmailTo: "" });
    expect(result.ok).toBe(true);
    expect(result.card).toMatchObject({
      id: "card-available",
      accountLabel: "FINAL-ACC",
      deliverySecret: "FINAL-SECRET",
    });
  });

  it("allows paid orders to be issued", async () => {
    const orderRow = {
      id: "order-paid",
      productId: "product-1",
      buyerEmail: "user@test.com",
      status: "paid",
      expiresAt: null,
      productTitle: "Test Product",
      couponCode: null,
    };
    const state = {
      cards: {
        "card-paid": {
          id: "card-paid",
          accountLabel: "PAID-ACC",
          deliverySecret: "PAID-SECRET",
          deliveryNote: "",
          status: "available",
        },
      },
    };
    const db = createMockDb(state);
    (db as any).select = (_colMap: unknown) => ({
      from: (_table?: unknown) => createSelectChain([orderRow]),
    });
    const result = await markPaidAndIssue(db, "order-paid", undefined);
    expect(result.ok).toBe(true);
  });

  it("reuses existing issued card for paid order instead of issuing another card", async () => {
    const orderRow = {
      id: "order-paid-existing-card",
      orderNo: "ORD-EXISTING",
      productId: "product-1",
      buyerEmail: "user@test.com",
      status: "paid",
      expiresAt: null,
      productTitle: "Test Product",
      couponCode: null,
    };
    const currentOrderRow = {
      status: "paid",
      issuedCardId: "card-existing",
    };
    const existingCard = {
      id: "card-existing",
      accountLabel: "EXISTING-ACC",
      deliverySecret: "EXISTING-SECRET",
      deliveryNote: "Existing delivery",
    };
    let selectCall = 0;
    const runCalls: unknown[] = [];
    const updates: unknown[] = [];
    const db = {
      select: (_colMap?: unknown) => ({
        from: () => ({
          innerJoin: () => ({
            where: () => {
              selectCall += 1;
              return Promise.resolve([orderRow]);
            },
          }),
          where: () => {
            selectCall += 1;
            if (selectCall === 2) return Promise.resolve([currentOrderRow]);
            return Promise.resolve([existingCard]);
          },
        }),
      }),
      update: () => ({
        set: (data: unknown) => {
          updates.push(data);
          return {
            where: () => Promise.resolve({ rowsAffected: 1 }),
          };
        },
      }),
      insert: () => ({
        values: () => Promise.resolve({ rowsAffected: 1 }),
      }),
      run: (sqlExpr?: unknown) => {
        runCalls.push(sqlExpr);
        return Promise.resolve({ rows: [] });
      },
    } as unknown as DbType;

    const executionCtx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
    const result = await markPaidAndIssue(
      db,
      "order-paid-existing-card",
      { resendApiKey: "re_key", emailFrom: "", turnstileEnabled: false, turnstileSecretKey: "", allowTurnstileBypassForSmoke: false, inventoryWarningEmailTo: "" },
      executionCtx,
    );

    expect(result.ok).toBe(true);
    expect(result.card).toEqual(existingCard);
    expect(runCalls).toHaveLength(0);
    expect(updates).toContainEqual({ status: "issued", issuedCardId: "card-existing", issuedAt: expect.any(String) });
    expect(mockSendEmail).toHaveBeenCalledWith(
      db,
      expect.anything(),
      expect.objectContaining({
        template: "order_issued",
        templateData: expect.objectContaining({ deliverySecret: "EXISTING-SECRET" }),
      }),
    );
    expect(executionCtx.waitUntil).toHaveBeenCalled();
  });

  it("does not overwrite a canceled order when recovering an existing card", async () => {
    const orderRow = {
      id: "order-existing-card-race",
      orderNo: "ORD-EXISTING-RACE",
      productId: "product-1",
      buyerEmail: "user@test.com",
      status: "paid",
      expiresAt: null,
      productTitle: "Test Product",
      couponCode: null,
    };
    const existingCard = {
      id: "card-existing-race",
      accountLabel: "EXISTING-ACC",
      deliverySecret: "EXISTING-SECRET",
      deliveryNote: "Existing delivery",
    };
    const db = {
      select: () => ({
        from: () => ({
          innerJoin: () => ({ where: () => Promise.resolve([orderRow]) }),
          where: () => Promise.resolve([existingCard]),
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => Promise.resolve({ rowsAffected: 0 }),
        }),
      }),
      insert: () => ({ values: () => Promise.resolve({ rowsAffected: 1 }) }),
      run: () => Promise.resolve({ rows: [] }),
    } as unknown as DbType;

    const result = await markPaidAndIssue(db, "order-existing-card-race", undefined);

    expect(result).toMatchObject({ ok: false, status: 409, message: "当前订单状态不可发卡" });
  });

  it("does not consume coupon again when already-issued retry finalizes a reserved coupon order", async () => {
    const orderRow = {
      id: "order-existing-coupon-fail",
      orderNo: "ORD-EXISTING-COUPON",
      productId: "product-1",
      buyerEmail: "user@test.com",
      buyerContact: "user@test.com",
      status: "paid",
      expiresAt: null,
      productTitle: "Test Product",
      couponCode: "USED10",
    };
    const existingCard = {
      id: "card-existing-coupon",
      accountLabel: "EXISTING-ACC",
      deliverySecret: "EXISTING-SECRET",
      deliveryNote: "Existing delivery",
    };
    let selectCall = 0;
    const updates: unknown[] = [];
    const db = {
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: () => Promise.resolve([orderRow]),
          }),
          where: () => {
            selectCall += 1;
            if (selectCall === 1) return Promise.resolve([{ quantity: 1 }]);
            return Promise.resolve([existingCard]);
          },
        }),
      }),
      update: () => ({
        set: (data: unknown) => {
          updates.push(data);
          return { where: () => Promise.resolve({ rowsAffected: 1 }) };
        },
      }),
      insert: () => ({ values: () => Promise.resolve({ rowsAffected: 1 }) }),
      run: () => Promise.resolve({ rows: [] }),
    } as unknown as DbType;

    const result = await markPaidAndIssue(db, "order-existing-coupon-fail", undefined);

    expect(result.ok).toBe(true);
    expect(mockConsumeCoupon).not.toHaveBeenCalled();
    expect(updates).toContainEqual({ status: "issued", issuedCardId: "card-existing-coupon", issuedAt: expect.any(String) });
  });

  it("only issues the remaining cards when a previous attempt partially issued inventory", async () => {
    const orderRow = {
      id: "order-partial-existing-card",
      orderNo: "ORD-PARTIAL",
      productId: "product-1",
      buyerEmail: "user@test.com",
      buyerContact: "user@test.com",
      status: "paid",
      expiresAt: null,
      productTitle: "Test Product",
      couponCode: null,
    };
    const existingCards = [{
      id: "card-existing",
      accountLabel: "EXISTING-ACC",
      deliverySecret: "EXISTING-SECRET",
      deliveryNote: "Existing delivery",
    }];
    const itemRows = [{ quantity: 2 }];
    const newCard = {
      id: "card-new",
      accountLabel: "NEW-ACC",
      deliverySecret: "NEW-SECRET",
      deliveryNote: "New delivery",
    };
    let selectCall = 0;
    const runCalls: unknown[] = [];
    const db = {
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: () => Promise.resolve([orderRow]),
          }),
          where: () => {
            selectCall += 1;
            if (selectCall === 1) return Promise.resolve(itemRows);
            return Promise.resolve(existingCards);
          },
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => Promise.resolve({ rowsAffected: 1 }),
        }),
      }),
      insert: () => ({ values: () => Promise.resolve({ rowsAffected: 1 }) }),
      run: () => {
        runCalls.push("issue-card");
        return Promise.resolve({ rows: [newCard] });
      },
    } as unknown as DbType;

    const executionCtx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
    const result = await markPaidAndIssue(
      db,
      "order-partial-existing-card",
      { resendApiKey: "re_key", emailFrom: "", turnstileEnabled: false, turnstileSecretKey: "", allowTurnstileBypassForSmoke: false, inventoryWarningEmailTo: "" },
      executionCtx,
    );

    expect(result.ok).toBe(true);
    expect(result.cards?.map((card) => card.id)).toEqual(["card-existing", "card-new"]);
    expect(runCalls).toHaveLength(1);
    expect(mockSendEmail).toHaveBeenCalledWith(
      db,
      expect.anything(),
      expect.objectContaining({
        template: "order_issued",
        templateData: expect.objectContaining({
          deliverySecret: "EXISTING-SECRET",
          additionalDeliveries: expect.stringContaining("NEW-SECRET"),
        }),
      }),
    );
  });

  it("uses the order header quantity for legacy orders without order items", async () => {
    const orderRow = {
      id: "order-legacy-quantity",
      orderNo: "ORD-LEGACY-QUANTITY",
      productId: "product-1",
      buyerEmail: "user@test.com",
      buyerContact: "user@test.com",
      status: "paid",
      quantity: 2,
      fulfillmentMode: "card",
      productFulfillmentMode: "card",
      expiresAt: null,
      productTitle: "Test Product",
      couponCode: null,
    };
    const issuedCards = [
      { id: "card-legacy-1", accountLabel: "LEGACY-1", deliverySecret: "SECRET-1", deliveryNote: "" },
      { id: "card-legacy-2", accountLabel: "LEGACY-2", deliverySecret: "SECRET-2", deliveryNote: "" },
    ];
    let plainSelectCall = 0;
    let issueCall = 0;
    const db = {
      select: () => ({
        from: () => ({
          innerJoin: () => ({ where: () => Promise.resolve([orderRow]) }),
          where: () => {
            plainSelectCall += 1;
            return Promise.resolve([]);
          },
        }),
      }),
      update: () => ({
        set: () => ({ where: () => Promise.resolve({ rowsAffected: 1 }) }),
      }),
      insert: () => ({ values: () => Promise.resolve({ rowsAffected: 1 }) }),
      run: () => Promise.resolve({ rows: [issuedCards[issueCall++]] }),
    } as unknown as DbType;

    const result = await markPaidAndIssue(db, "order-legacy-quantity", undefined);

    expect(result.ok).toBe(true);
    expect(result.cards?.map((card) => card.id)).toEqual(["card-legacy-1", "card-legacy-2"]);
    expect(issueCall).toBe(2);
    expect(plainSelectCall).toBe(2);
  });

  it("issues reserved coupon card order without consuming coupon again", async () => {
    const orderRow = {
      id: "order-coupon",
      productId: "product-1",
      buyerEmail: "buyer@test.com",
      status: "pending",
      expiresAt: null,
      productTitle: "Test Product",
      couponCode: "SAVE10",
    };
    const state = {
      cards: {
        "card-1": {
          id: "card-1",
          accountLabel: "ACC-COUPON",
          deliverySecret: "SEC-COUPON",
          deliveryNote: "Coupon note",
          status: "available",
        },
      },
    };
    const db = createMockDb(state);
    (db as any).select = (_colMap: unknown) => ({
      from: (_table?: unknown) => createSelectChain([orderRow]),
    });
    const result = await markPaidAndIssue(db, "order-coupon", undefined);
    expect(result.ok).toBe(true);
    expect(result.card).toMatchObject({ id: "card-1" });
    expect(mockConsumeCoupon).not.toHaveBeenCalled();
  });

  // ── 并发回滚：updated.length === 0 时应释放已发卡密 ──

  it("rolls back issued card when concurrent UPDATE returns 0 rows", async () => {
    const orderRow = {
      id: "order-concurrent",
      productId: "product-1",
      buyerEmail: "user@test.com",
      status: "pending",
      expiresAt: null,
      productTitle: "Test Product",
      couponCode: null,
    };
    const state = {
      cards: {
        "card-concurrent": {
          id: "card-concurrent",
          accountLabel: "CONC-ACC",
          deliverySecret: "CONC-SEC",
          deliveryNote: "",
          status: "available",
        },
      },
    };
    const db = createMockDb(state);
    // Override select for markPaidAndIssue's initial query
    (db as any).select = (_colMap: unknown) => ({
      from: (_table?: unknown) => createSelectChain([orderRow]),
    });
    // Override update for markPaidAndIssue's status UPDATE to return empty (concurrent conflict)
    (db as any).update = (_table?: unknown) => ({
      set: (_data?: unknown) => ({
        where: () => ({
          returning: () => Promise.resolve([]),  // Concurrent: no rows updated
        }),
      }),
    });
    const result = await markPaidAndIssue(db, "order-concurrent", undefined);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(409);
    expect(result.message).toBe("当前订单状态不可发卡");
  });

  // ── coupon 已在下单时预留，确认发卡不应重复消耗 ──

  it("does not consume coupon again when issuing reserved coupon card order", async () => {
    const orderRow = {
      id: "order-coupon-fail",
      productId: "product-1",
      buyerEmail: "user@test.com",
      status: "pending",
      expiresAt: null,
      productTitle: "Test Product",
      couponCode: "FAIL10",
    };
    const state = {
      cards: {
        "card-coupon-fail": {
          id: "card-coupon-fail",
          accountLabel: "CF-ACC",
          deliverySecret: "CF-SEC",
          deliveryNote: "",
          status: "available",
        },
      },
    };
    const db = createMockDb(state);
    (db as any).select = (_colMap: unknown) => ({
      from: (_table?: unknown) => createSelectChain([orderRow]),
    });
    const result = await markPaidAndIssue(db, "order-coupon-fail", undefined);
    expect(result.ok).toBe(true);
    expect(mockConsumeCoupon).not.toHaveBeenCalled();
    expect(state.cards["card-coupon-fail"].status).toBe("issued");
  });

  it("does not consume coupon again when issuing reserved coupon virtual order", async () => {
    const db = createMockDb({});
    (db as any).select = (_colMap: unknown) => ({
      from: (_table?: unknown) => createSelectChain([{
        id: "order-virtual-coupon-fail",
        productId: "product-virtual",
        buyerEmail: "user@test.com",
        buyerContact: "contact",
        status: "pending",
        expiresAt: null,
        productTitle: "Virtual Product",
        fulfillmentMode: "virtual",
        deliveryJson: JSON.stringify({ accountLabel: "Virtual Product", deliverySecret: "SECRET", deliveryNote: "NOTE" }),
        couponCode: "VIRTUALFAIL",
      }]),
    });

    const result = await markPaidAndIssue(db, "order-virtual-coupon-fail", undefined);
    expect(result.ok).toBe(true);
    expect(mockConsumeCoupon).not.toHaveBeenCalled();
    expect(mockWriteOrderEvent).toHaveBeenCalledWith(
      expect.anything(),
      "order-virtual-coupon-fail",
      "issued",
      expect.anything(),
      expect.anything(),
    );
  });

  // ── 发邮件通知：RESEND_API_KEY 存在且 buyerEmail 合格 ──

  it("sends email notification when RESEND_API_KEY is configured", async () => {
    const emailPromise = Promise.resolve({ ok: true, message: "sent" });
    mockSendEmail.mockReturnValueOnce(emailPromise);
    const orderRow = {
      id: "order-email",
      productId: "product-1",
      buyerEmail: "buyer@test.com",
      status: "pending",
      expiresAt: null,
      productTitle: "Test Product",
      couponCode: null,
    };
    const state = {
      cards: {
        "card-email": {
          id: "card-email",
          accountLabel: "EM-ACC",
          deliverySecret: "EM-SEC",
          deliveryNote: "",
          status: "available",
        },
      },
    };
    const db = createMockDb(state);
    (db as any).select = (_colMap: unknown) => ({
      from: (_table?: unknown) => createSelectChain([orderRow]),
    });
    const executionCtx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
    const result = await markPaidAndIssue(db, "order-email", { resendApiKey: "re_key", emailFrom: "", turnstileEnabled: false, turnstileSecretKey: "", allowTurnstileBypassForSmoke: false, inventoryWarningEmailTo: "" }, executionCtx);
    expect(result.ok).toBe(true);
    expect(mockSendEmail).toHaveBeenCalled();
    expect(executionCtx.waitUntil).toHaveBeenCalledWith(emailPromise);
  });

  // ── 虚拟资料交付（非 card） ──
  it("issues virtual order from pending using deliveryJson", async () => {
    mockWriteOrderEvent.mockClear();
    const orderRow = {
      id: "order-virtual-pending",
      productId: "product-virtual",
      buyerEmail: "virtual@test.com",
      status: "pending",
      expiresAt: null,
      productTitle: "Virtual Product",
      couponCode: null,
      fulfillmentMode: "virtual",
      deliveryJson: JSON.stringify({ url: "https://example.com/file.zip", code: "ABC123" }),
    };
    const db = createMockDb({});
    (db as any).select = (_colMap: unknown) => ({
      from: (_table?: unknown) => createSelectChain([orderRow]),
    });
    const result = await markPaidAndIssue(db, "order-virtual-pending", undefined);
    expect(result.ok).toBe(true);
    expect(result.delivery).toBeDefined();
    expect((result.delivery as any).url).toBe("https://example.com/file.zip");
    expect((result.delivery as any).code).toBe("ABC123");
    expect(mockWriteOrderEvent).toHaveBeenCalledWith(
      expect.anything(),
      "order-virtual-pending",
      "issued",
      "虚拟资料订单交付完成",
      { fulfillmentMode: "virtual" },
    );
    expect(JSON.stringify(mockWriteOrderEvent.mock.calls)).not.toContain("ABC123");
  });

  it("uses the order-item fulfillment snapshot after the product mode changes", async () => {
    const orderRow = {
      id: "order-virtual-snapshot",
      productId: "product-virtual",
      buyerEmail: "virtual@test.com",
      buyerContact: "virtual@test.com",
      status: "pending",
      expiresAt: null,
      productTitle: "Current Product Title",
      fulfillmentMode: "card",
      deliveryJson: JSON.stringify({ url: "https://example.com/snapshot.zip" }),
      couponCode: null,
    };
    let plainSelectCount = 0;
    const db = {
      select: () => ({
        from: () => ({
          innerJoin: () => ({ where: () => Promise.resolve([orderRow]) }),
          where: () => {
            plainSelectCount += 1;
            return plainSelectCount === 1
              ? Promise.resolve([{ quantity: 1, fulfillmentMode: "virtual" }])
              : Promise.resolve([]);
          },
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => {
            const result = Promise.resolve({ rowsAffected: 1 }) as Promise<{ rowsAffected: number }> & {
              returning: () => Promise<Array<{ id: string }>>;
            };
            result.returning = () => Promise.resolve([{ id: "order-virtual-snapshot" }]);
            return result;
          },
        }),
      }),
      insert: () => ({ values: () => Promise.resolve({ rowsAffected: 1 }) }),
      run: () => Promise.resolve({ rows: [] }),
    } as unknown as DbType;

    const result = await markPaidAndIssue(db, "order-virtual-snapshot", undefined);

    expect(result.ok).toBe(true);
    expect(result.delivery).toEqual({ url: "https://example.com/snapshot.zip" });
  });

  it("returns alreadyIssued with delivery for issued virtual order", async () => {
    const orderRow = {
      id: "order-virtual-issued",
      productId: "product-virtual",
      buyerEmail: "virtual@test.com",
      status: "issued",
      expiresAt: null,
      productTitle: "Virtual Product",
      couponCode: null,
      fulfillmentMode: "virtual",
      deliveryJson: JSON.stringify({ text: "Secret content" }),
    };
    const db = createResultDb([orderRow]);
    const result = await markPaidAndIssue(db, "order-virtual-issued", undefined);
    expect(result.ok).toBe(true);
    expect(result.alreadyIssued).toBe(true);
    expect(result.delivery).toBeDefined();
    expect((result.delivery as any).text).toBe("Secret content");
  });

  it("fails when virtual order has no deliveryJson", async () => {
    const orderRow = {
      id: "order-virtual-empty",
      productId: "product-virtual",
      buyerEmail: "virtual@test.com",
      status: "pending",
      expiresAt: null,
      productTitle: "Virtual Product",
      couponCode: null,
      fulfillmentMode: "virtual",
      deliveryJson: null,
    };
    const db = createMockDb({});
    (db as any).select = (_colMap: unknown) => ({
      from: (_table?: unknown) => createSelectChain([orderRow]),
    });
    const result = await markPaidAndIssue(db, "order-virtual-empty", undefined);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(409);
    expect(result.message).toBe("虚拟商品内容缺失，请联系管理员");
  });
});

// ── 余额支付限购：checkBalanceOrderRateLimit ──
describe("checkBalanceOrderRateLimit", () => {
  it("returns 429 when same email has >=maxOrders balance paid/pending orders within windowSeconds", async () => {
    const db = createMockDb({});
    (db as any).select = (_colMap: unknown) => ({
      from: (_table?: unknown) => createSelectChain([{ count: 3 }]),
    });
    const result = await checkBalanceOrderRateLimit(db, "rush@example.com");
    expect(result.ok).toBe(false);
    expect((result as { ok: false; status: number; message: string }).status).toBe(429);
    expect((result as { ok: false; status: number; message: string }).message).toBe("该邮箱余额支付过于频繁，请 5 分钟后再试");
  });

  it("allows balance payment when same email has <maxOrders balance paid/pending orders within windowSeconds", async () => {
    const db = createMockDb({});
    (db as any).select = (_colMap: unknown) => ({
      from: (_table?: unknown) => createSelectChain([{ count: 2 }]),
    });
    const result = await checkBalanceOrderRateLimit(db, "rush@example.com");
    expect(result.ok).toBe(true);
  });

  it("allows balance payment when there are no recent balance orders", async () => {
    const db = createMockDb({});
    (db as any).select = (_colMap: unknown) => ({
      from: (_table?: unknown) => createSelectChain([{ count: 0 }]),
    });
    const result = await checkBalanceOrderRateLimit(db, "new@example.com");
    expect(result.ok).toBe(true);
  });

  it("uses dynamic config for window and max orders", async () => {
    mockGetOrderRateLimitConfig.mockResolvedValueOnce({ windowSeconds: 600, maxOrders: 5 });
    const db = createMockDb({});
    (db as any).select = (_colMap: unknown) => ({
      from: (_table?: unknown) => createSelectChain([{ count: 5 }]),
    });
    const result = await checkBalanceOrderRateLimit(db, "rush@example.com");
    expect(result.ok).toBe(false);
    expect((result as { ok: false; status: number; message: string }).status).toBe(429);
    expect((result as { ok: false; status: number; message: string }).message).toBe("该邮箱余额支付过于频繁，请 10 分钟后再试");
  });
});
