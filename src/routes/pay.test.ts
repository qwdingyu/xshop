import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { DbType } from "../db/client";
import type { AppEnv, FulfillmentMode } from "../bindings";
import { cards, idempotencyKeys, orderItems, orders } from "../db/schema";
import { enforceRateLimit } from "../lib/rate-limit";

const STRONG_IDEMPOTENCY_KEY = "k".repeat(32);

// ---------------------------------------------------------------------------
// Mock fulfillment-service（createOfflineOrder 依赖的锁库存函数）
// ---------------------------------------------------------------------------

const fulfillmentServiceMocks = {
  lockFulfillmentInventoryItems: vi.fn(),
};
const issueServiceMocks = {
  releaseLockedCardByOrder: vi.fn(),
};
const voucherServiceMocks = {
  getUserBalance: vi.fn(),
  deductBalance: vi.fn(),
  refundBalance: vi.fn(),
};
const orderServiceMocks = {
  markPaidAndIssue: vi.fn(),
  checkAndExpireOrder: vi.fn(),
  checkOrderRateLimit: vi.fn(),
  checkBalanceOrderRateLimit: vi.fn(),
  checkProductPurchaseLimitForQuantity: vi.fn(),
  deliveryVisibilityPayload: vi.fn((input: { deliveryVisibility?: string | null; buyerEmail?: string | null; status?: string | null }) => {
    if (input.deliveryVisibility !== "email_only") return { deliveryVisibility: "web_and_email" };
    if (input.status !== "issued") return { deliveryVisibility: "email_only" };
    return {
      deliveryVisibility: "email_only",
      deliveryMessage: `卡密已生成并将发送到 ${input.buyerEmail || "下单邮箱"}，邮件可能延迟；如未收到，请检查垃圾邮件或联系售后。`,
    };
  }),
};
const auditServiceMocks = {
  writeOrderEvent: vi.fn(),
};
const paymentProviderMocks = {
  verifyCallback: vi.fn(),
  queryStatus: vi.fn(),
  createPayment: vi.fn(),
  selectOnline: vi.fn((): unknown => null),
  getProvider: vi.fn((name: string) => ({
    name,
    defaultPayType: "alipay",
    enabledPayTypes: ["alipay"],
    createPayment: (...args: unknown[]) => paymentProviderMocks.createPayment(...args),
    verifyCallback: (...args: unknown[]) => paymentProviderMocks.verifyCallback(...args),
    queryStatus: (...args: unknown[]) => paymentProviderMocks.queryStatus(...args),
  })),
};
const systemConfigMocks = {
  getOrderExpireMinutes: vi.fn(),
  readSystemConfigMap: vi.fn(),
};
const couponServiceMocks = {
  quoteCoupon: vi.fn(),
  consumeCoupon: vi.fn(),
  releaseCouponReservation: vi.fn(),
  restoreCouponReservation: vi.fn(),
};
const emailServiceMocks = {
  sendEmail: vi.fn(),
};
const emailAccessMocks = {
  verifyEmailAccessCode: vi.fn(),
};
const defaultStorefront = {
  id: "sf_default",
  slug: "shop",
  name: "Shop",
  logoUrl: "",
  supportEmail: "",
  isDefault: true,
  homePath: "/shop",
};
const storefrontServiceMocks = {
  resolvePublicStorefront: vi.fn().mockResolvedValue(defaultStorefront),
  getActiveStorefrontById: vi.fn().mockResolvedValue(defaultStorefront),
  validateStorefrontProductMapping: vi.fn().mockResolvedValue(defaultStorefront),
};

vi.mock("../services/fulfillment-service", () => ({
  lockFulfillmentInventoryItems: (...args: unknown[]) => fulfillmentServiceMocks.lockFulfillmentInventoryItems(...args),
}));

vi.mock("../services/issue-service", () => ({
  releaseLockedCardByOrder: (...args: unknown[]) => issueServiceMocks.releaseLockedCardByOrder(...args),
}));

vi.mock("../services/voucher-service", () => ({
  getUserBalance: (...args: unknown[]) => voucherServiceMocks.getUserBalance(...args),
  deductBalance: (...args: unknown[]) => voucherServiceMocks.deductBalance(...args),
  refundBalance: (...args: unknown[]) => voucherServiceMocks.refundBalance(...args),
}));

vi.mock("../services/order-service", () => ({
  checkAndExpireOrder: (...args: unknown[]) => orderServiceMocks.checkAndExpireOrder(...args),
  checkOrderRateLimit: (...args: unknown[]) => orderServiceMocks.checkOrderRateLimit(...args),
  checkBalanceOrderRateLimit: (...args: unknown[]) => orderServiceMocks.checkBalanceOrderRateLimit(...args),
  checkProductPurchaseLimitForQuantity: (...args: unknown[]) => orderServiceMocks.checkProductPurchaseLimitForQuantity(...args),
  deliveryVisibilityPayload: (input: { deliveryVisibility?: string | null; buyerEmail?: string | null; status?: string | null }) => orderServiceMocks.deliveryVisibilityPayload(input),
  redactItemDeliveries: (items: Array<Record<string, unknown>>) => items.map(({ deliveryJson: _deliveryJson, ...item }) => item),
  markPaidAndIssue: (...args: unknown[]) => orderServiceMocks.markPaidAndIssue(...args),
}));

vi.mock("../services/payments", () => ({
  createDbProviderRegistry: vi.fn().mockResolvedValue({
    selectOnline: () => paymentProviderMocks.selectOnline(),
    get: (name: string) => paymentProviderMocks.getProvider(name),
  }),
  createDbProviderRegistryForCallback: vi.fn().mockResolvedValue({
    selectOnline: () => null,
    get: (name: string) => paymentProviderMocks.getProvider(name),
  }),
  selectOnlineProviderForCurrency: () => paymentProviderMocks.selectOnline(),
  isValidProviderName: (name: string) => name === "easypay",
  normalizeEasyPayPayType: (value: unknown) => {
    const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
    return normalized === "wxpay" || normalized === "qqpay" ? normalized : "alipay";
  },
  normalizeEasyPayEnabledPayTypes: (value: unknown, fallback: unknown = "alipay") => {
    const fallbackValue = typeof fallback === "string" ? fallback.trim().toLowerCase() : "alipay";
    const fallbackPayType = fallbackValue === "wxpay" || fallbackValue === "qqpay" ? fallbackValue : "alipay";
    const rawValues = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
    const enabled: string[] = [];
    for (const raw of rawValues) {
      if (typeof raw !== "string") continue;
      const normalized = raw.trim().toLowerCase();
      if (!["alipay", "wxpay", "qqpay"].includes(normalized)) continue;
      if (!enabled.includes(normalized)) enabled.push(normalized);
    }
    return enabled.length > 0 ? enabled : [fallbackPayType];
  },
  easyPayPayTypeLabel: (value: unknown) => {
    const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (normalized === "wxpay") return "微信支付";
    if (normalized === "qqpay") return "QQ 支付";
    return "支付宝";
  },
  EasyPayProviderError: class EasyPayProviderError extends Error {
    constructor(
      public kind: "deterministic" | "ambiguous",
      message: string,
    ) {
      super(message);
      this.name = "EasyPayProviderError";
    }
  },
  isAmbiguousEasyPayProviderError: (error: unknown) =>
    error instanceof Error && (error as { kind?: string }).kind === "ambiguous",
}));

vi.mock("../lib/rate-limit", () => ({
  enforceRateLimit: vi.fn().mockResolvedValue({ ok: true, ipHash: "ip-hash" }),
  writeRequestLog: vi.fn(),
}));

vi.mock("../lib/runtime-config", () => ({
  readRuntimeConfig: vi.fn().mockResolvedValue({
    resendApiKey: "",
    emailFrom: "",
    turnstileEnabled: false,
    turnstileSecretKey: "",
    allowTurnstileBypassForSmoke: false,
  }),
  mergeRuntimeConfig: vi.fn((dbConfig: Record<string, unknown>, env: Record<string, unknown> = {}) => ({
    ...dbConfig,
    resendApiKey: dbConfig.resendApiKey || env.RESEND_API_KEY || "",
    emailFrom: dbConfig.emailFrom || env.EMAIL_FROM || "",
    allowTurnstileBypassForSmoke:
      dbConfig.allowTurnstileBypassForSmoke || env.ALLOW_TURNSTILE_BYPASS_FOR_SMOKE === "true",
  })),
}));

vi.mock("../services/email-service", () => ({
  sendEmail: (...args: unknown[]) => emailServiceMocks.sendEmail(...args),
}));

vi.mock("../lib/email-access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/email-access")>();
  return {
    ...actual,
    verifyEmailAccessCode: (...args: unknown[]) => emailAccessMocks.verifyEmailAccessCode(...args),
  };
});

vi.mock("../lib/system-config-registry", () => ({
  getOrderExpireMinutes: (...args: unknown[]) => systemConfigMocks.getOrderExpireMinutes(...args),
  isBalancePaymentEnabled: (...args: unknown[]) => systemConfigMocks.readSystemConfigMap(...args).then((config: Record<string, string>) => config.balance_payment_enabled === "true"),
  readSystemConfigMap: (...args: unknown[]) => systemConfigMocks.readSystemConfigMap(...args),
}));

// Mock audit-service
vi.mock("../services/audit-service", () => ({
  writeOrderEvent: (...args: unknown[]) => auditServiceMocks.writeOrderEvent(...args),
}));

vi.mock("../services/coupon-service", () => ({
  quoteCoupon: (...args: unknown[]) => couponServiceMocks.quoteCoupon(...args),
  consumeCoupon: (...args: unknown[]) => couponServiceMocks.consumeCoupon(...args),
  releaseCouponReservation: (...args: unknown[]) => couponServiceMocks.releaseCouponReservation(...args),
  restoreCouponReservation: (...args: unknown[]) => couponServiceMocks.restoreCouponReservation(...args),
}));

vi.mock("../services/storefront-service", () => ({
  resolvePublicStorefront: (...args: unknown[]) => storefrontServiceMocks.resolvePublicStorefront(...args),
  getActiveStorefrontById: (...args: unknown[]) => storefrontServiceMocks.getActiveStorefrontById(...args),
  validateStorefrontProductMapping: (...args: unknown[]) => storefrontServiceMocks.validateStorefrontProductMapping(...args),
}));

// Mock token module
vi.mock("../lib/token", () => ({
  createOrderToken: () => "mock-order-token",
  hashOrderToken: () => Promise.resolve("mock-token-hash"),
  createOrderNo: () => "ORD-MOCK-001",
}));

import {
  createPayOrderNo,
  createOfflineNoteCode,
  createOrderRecord,
  createOfflineOrder,
  handleInternalSettlement,
  payRoute,
  VALID_ISSUE_MODES,
} from "./pay";

function createSelectChain(results: unknown[]) {
  const chain: any = {};
  for (const method of ["where", "innerJoin", "leftJoin", "orderBy", "limit", "offset", "groupBy", "having"]) {
    chain[method] = () => chain;
  }
  chain.then = (resolve: (value: unknown[]) => void, reject?: (reason: unknown) => void) =>
    Promise.resolve(results).then(resolve, reject);
  return chain;
}

// ---------------------------------------------------------------------------
// 工具函数：createPayOrderNo / createOfflineNoteCode / VALID_ISSUE_MODES
// ---------------------------------------------------------------------------

describe("createPayOrderNo", () => {
  it("以 P 前缀开头", () => {
    const no = createPayOrderNo();
    expect(no.startsWith("P")).toBe(true);
  });

  it("长度至少 10（P + 时间戳 + 随机后缀）", () => {
    const no = createPayOrderNo();
    expect(no.length).toBeGreaterThanOrEqual(10);
  });

  it("每次调用生成不同的订单号", () => {
    const nos = new Set(Array.from({ length: 20 }, () => createPayOrderNo()));
    expect(nos.size).toBeGreaterThanOrEqual(19);
  });

  it("只包含大写字母和数字", () => {
    for (let i = 0; i < 10; i++) {
      const no = createPayOrderNo();
      expect(no).toMatch(/^[A-Z0-9]+$/);
    }
  });
});

describe("createOfflineNoteCode", () => {
  it("返回 6 位纯数字字符串", () => {
    const code = createOfflineNoteCode();
    expect(code).toMatch(/^\d{6}$/);
  });

  it("范围在 100000~999999 之间", () => {
    for (let i = 0; i < 50; i++) {
      const code = createOfflineNoteCode();
      const num = Number(code);
      expect(num).toBeGreaterThanOrEqual(100000);
      expect(num).toBeLessThanOrEqual(999999);
    }
  });

  it("多次调用产生不同的备注码（高概率）", () => {
    const codes = new Set(Array.from({ length: 20 }, () => createOfflineNoteCode()));
    expect(codes.size).toBeGreaterThanOrEqual(18);
  });
});

describe("VALID_ISSUE_MODES", () => {
  it("包含 direct 和 manual", () => {
    expect(VALID_ISSUE_MODES).toContain("direct");
    expect(VALID_ISSUE_MODES).toContain("manual");
  });

  it("只有两个枚举值", () => {
    expect(VALID_ISSUE_MODES).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// createOrderRecord — 向 orders 表插入一条记录
// ---------------------------------------------------------------------------

describe("createOrderRecord", () => {
  let insertedData: Record<string, unknown> | null;
  let insertedItem: Record<string, unknown> | null;

  function createMockDb() {
    insertedData = null;
    insertedItem = null;
    return {
      insert: (_table?: unknown) => ({
        values: (data: Record<string, unknown>) => {
          if (!insertedData) insertedData = data;
          else insertedItem = data;
          return { onConflictDoNothing: () => Promise.resolve([]) };
        },
      }),
    } as unknown as DbType;
  }

  it("插入的数据包含所有必要字段", async () => {
    const db = createMockDb();
    await createOrderRecord(
      db, "order-1", "PTEST001", "prod-1", "测试商品", "card",
      "备注码001", "buyer@test.com", 1, 1200, 1000, 200,
      "CNY", "online", "direct", "camp1", "ref1",
      "coupon1", "iphash", "ua", "tokhash",
      new Date(Date.now() + 1800000).toISOString(),
    );
    expect(insertedData).not.toBeNull();
    expect(insertedData!.id).toBe("order-1");
    expect(insertedData!.orderNo).toBe("PTEST001");
    expect(insertedData!.productId).toBe("prod-1");
    expect(insertedData!.buyerEmail).toBe("buyer@test.com");
    expect(insertedData!.amountCents).toBe(1000);
    expect(insertedData!.discountCents).toBe(200);
    expect(insertedData!.currency).toBe("CNY");
    expect(insertedData!.status).toBe("pending");
    expect(insertedData!.paymentMethod).toBe("online");
    expect(insertedData!.issueMode).toBe("direct");
    expect(insertedData!.fulfillmentMode).toBe("card");
    expect(insertedData!.campaignCode).toBe("camp1");
    expect(insertedData!.referralCode).toBe("ref1");
    expect(insertedData!.couponCode).toBe("coupon1");
    expect(insertedItem).toMatchObject({
      orderId: "order-1",
      productId: "prod-1",
      productTitle: "测试商品",
      quantity: 1,
      unitPriceCents: 1200,
      amountCents: 1000,
    });
  });

  it("stores the product delivery visibility as an order snapshot", async () => {
    const db = createMockDb();
    await createOrderRecord(
      db, "order-email-only", "PEMAIL001", "prod-1", "测试商品", "card",
      "备注码", "buyer@test.com", 1, 1200, 1200, 0,
      "CNY", "online", "direct", "", "", "", "", "ua", "tokhash",
      new Date(Date.now() + 1800000).toISOString(), "balance", "", "email_only",
    );

    expect(insertedData!.deliveryVisibility).toBe("email_only");
  });

  it("stores the fulfillment input snapshot independently from buyer contact", async () => {
    const db = createMockDb();
    const fulfillmentInputJson = JSON.stringify({ type: "uid", label: "用户 ID", value: "user_123" });
    await createOrderRecord(
      db, "order-input", "PINPUT001", "prod-1", "测试商品", "virtual",
      "pay:INPUT001", "buyer@test.com", 1, 1200, 1200, 0,
      "CNY", "online", "manual", "", "", "", "", "ua", "tokhash",
      new Date(Date.now() + 1800000).toISOString(), "easypay", "", "web_and_email", undefined,
      fulfillmentInputJson,
    );

    expect(insertedData!.buyerContact).toBe("pay:INPUT001");
    expect(insertedData!.fulfillmentInputJson).toBe(fulfillmentInputJson);
  });

  it("空字符串的 campaignCode/referralCode/ipHash 存为空字符串", async () => {
    const db = createMockDb();
    await createOrderRecord(
      db, "order-2", "PTEST002", "prod-1", "测试商品", "card",
      "备注码002", "b@t.com", 1, 500, 500, 0,
      "CNY", "offline", "manual", undefined, undefined, "",
      undefined, "ua", "tokhash",
      new Date(Date.now() + 1800000).toISOString(),
    );
    expect(insertedData!.campaignCode).toBe("");
    expect(insertedData!.referralCode).toBe("");
    expect(insertedData!.ipHash).toBe("");
  });

  it("payableCents 正确映射到 amountCents", async () => {
    const db = createMockDb();
    await createOrderRecord(
      db, "order-3", "PTEST003", "prod-1", "测试商品", "card",
      "code3", "b@t.com", 1, 1000, 800, 200,
      "CNY", "offline", "manual", "", "", "",
      "", "ua", "tokhash",
      new Date(Date.now() + 1800000).toISOString(),
    );
    expect(insertedData!.amountCents).toBe(800);
    expect(insertedData!.discountCents).toBe(200);
  });

  it("paymentMethod 支持 online 和 offline", async () => {
    // online
    const db1 = createMockDb();
    await createOrderRecord(
      db1, "o1", "P1", "p1", "测试商品", "card", "c1", "b@t.com", 1, 1000, 1000, 0,
      "CNY", "online", "direct", "", "", "", "", "ua", "th",
      new Date(Date.now() + 1800000).toISOString(),
    );
    expect(insertedData!.paymentMethod).toBe("online");

    // offline
    const db2 = createMockDb();
    await createOrderRecord(
      db2, "o2", "P2", "p1", "测试商品", "card", "c2", "b@t.com", 1, 1000, 1000, 0,
      "CNY", "offline", "manual", "", "", "", "", "ua", "th",
      new Date(Date.now() + 1800000).toISOString(),
    );
    expect(insertedData!.paymentMethod).toBe("offline");
  });
});

// ---------------------------------------------------------------------------
// createOfflineOrder — 线下支付订单创建（含卡密锁定/释放/回滚）
// ---------------------------------------------------------------------------

describe("createOfflineOrder", () => {
  let insertedData: Record<string, unknown> | null;

  function createMockDb() {
    insertedData = null;
    let insertCount = 0;
    return {
      insert: (_table?: unknown) => ({
        values: (data: Record<string, unknown>) => {
          insertCount++;
          if (insertCount === 1) insertedData = data;
          return { onConflictDoNothing: () => Promise.resolve([]) };
        },
      }),
      update: (_table?: unknown) => ({
        set: (_data?: unknown) => ({
          where: () => Promise.resolve({ rowsAffected: 1 }),
        }),
      }),
      select: (_cols?: unknown) => ({
        from: (_table?: unknown) => createSelectChain([]),
      }),
      run: () => Promise.resolve({ rows: [] }),
    } as unknown as DbType;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    storefrontServiceMocks.resolvePublicStorefront.mockResolvedValue(defaultStorefront);
    storefrontServiceMocks.getActiveStorefrontById.mockResolvedValue(defaultStorefront);
    storefrontServiceMocks.validateStorefrontProductMapping.mockResolvedValue(defaultStorefront);
    insertedData = null;
    systemConfigMocks.getOrderExpireMinutes.mockResolvedValue(30);
    couponServiceMocks.consumeCoupon.mockResolvedValue({ success: true, changes: 1 });
  });

  it("库存不足时抛出异常", async () => {
    fulfillmentServiceMocks.lockFulfillmentInventoryItems.mockResolvedValueOnce(null);
    const db = createMockDb();
    const product = { id: "prod-1", currency: "CNY", title: "Test Product", priceCents: 1000, fulfillmentMode: "card" as FulfillmentMode };
    await expect(
      createOfflineOrder(db, product, "b@t.com", 1, 1000, 0, "manual", undefined, undefined, "", undefined, "ua")
    ).rejects.toThrow("当前商品库存不足");
  });

  it("锁卡成功后插入订单记录", async () => {
    fulfillmentServiceMocks.lockFulfillmentInventoryItems.mockResolvedValueOnce({ inventoryIds: ["card-1"] });
    issueServiceMocks.releaseLockedCardByOrder.mockResolvedValueOnce(undefined);
    const db = createMockDb();
    const product = { id: "prod-1", currency: "CNY", title: "Test Product", priceCents: 1000, fulfillmentMode: "card" as FulfillmentMode };
    const result = await createOfflineOrder(
      db, product, "b@t.com", 1, 1000, 200, "manual", "camp1", "ref1", "SAVE10", "iphash", "ua"
    );
    expect(result.orderId).toBeTruthy();
    expect(result.orderNo).toBeTruthy();
    expect(result.orderToken).toBe("mock-order-token");
    expect(result.offlineNoteCode).toMatch(/^\d{6}$/);
    expect(insertedData).not.toBeNull();
    expect(insertedData!.amountCents).toBe(1000);
    expect(insertedData!.discountCents).toBe(200);
    expect(insertedData!.paymentMethod).toBe("offline");
    expect(insertedData!.couponCode).toBe("SAVE10");
    expect(couponServiceMocks.consumeCoupon).toHaveBeenCalledWith(expect.anything(), "SAVE10");
  });

  it("does not lock stock when coupon reservation fails", async () => {
    couponServiceMocks.consumeCoupon.mockResolvedValueOnce({ success: false, changes: 0 });
    const db = createMockDb();
    const product = { id: "prod-1", currency: "CNY", title: "Test Product", priceCents: 1000, fulfillmentMode: "card" as FulfillmentMode };

    await expect(
      createOfflineOrder(db, product, "b@t.com", 1, 1000, 200, "manual", "camp1", "ref1", "SAVE10", "iphash", "ua")
    ).rejects.toThrow("优惠码已被他人使用或已失效，请重试");
    expect(fulfillmentServiceMocks.lockFulfillmentInventoryItems).not.toHaveBeenCalled();
  });

  it("订单插入失败时释放已锁定的卡密", async () => {
    fulfillmentServiceMocks.lockFulfillmentInventoryItems.mockResolvedValueOnce({ inventoryIds: ["card-1"] });
    issueServiceMocks.releaseLockedCardByOrder.mockResolvedValueOnce(undefined);
    // 让 insert 失败
    const db = {
      insert: () => ({ values: () => { throw new Error("DB error"); } }),
      update: () => ({ set: () => ({ where: () => Promise.resolve({ rowsAffected: 1 }) }) }),
      select: () => ({ from: () => createSelectChain([]) }),
      run: () => Promise.resolve({ rows: [] }),
    } as unknown as DbType;
    const product = { id: "prod-1", currency: "CNY", title: "Test Product", priceCents: 1000, fulfillmentMode: "card" as FulfillmentMode };
    await expect(
      createOfflineOrder(db, product, "b@t.com", 1, 1000, 0, "manual", undefined, undefined, "", undefined, "ua")
    ).rejects.toThrow("订单创建失败，请稍后重试");
    expect(issueServiceMocks.releaseLockedCardByOrder).not.toHaveBeenCalled();
  });

  it("锁卡参数传递正确（orderId, productId, expiresAt）", async () => {
    fulfillmentServiceMocks.lockFulfillmentInventoryItems.mockResolvedValueOnce({ inventoryIds: ["card-1"] });
    issueServiceMocks.releaseLockedCardByOrder.mockResolvedValueOnce(undefined);
    const db = createMockDb();
    const product = { id: "prod-1", currency: "CNY", title: "Test Product", priceCents: 1000, fulfillmentMode: "card" as FulfillmentMode };
    await createOfflineOrder(db, product, "b@t.com", 1, 500, 0, "direct", "", "", "", "", "ua");
    expect(fulfillmentServiceMocks.lockFulfillmentInventoryItems).toHaveBeenCalledTimes(1);
    const lockCall = fulfillmentServiceMocks.lockFulfillmentInventoryItems.mock.calls[0];
    // lockFulfillmentInventory(db, orderId, productId, expiresAt)
    expect(lockCall[2]).toBe("prod-1"); // productId
    expect(lockCall[3]).toBeTruthy();   // expiresAt
    expect(lockCall[4]).toBe(1);        // quantity
  });
});

// ---------------------------------------------------------------------------
// handleInternalSettlement — 余额支付补偿闭环
// ---------------------------------------------------------------------------

describe("handleInternalSettlement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createBalanceMockDb(paymentProvider = "balance") {
    const updates: Array<Record<string, unknown>> = [];
    const scopedUpdates: Array<{ data: Record<string, unknown>; scope: "db" | "tx" }> = [];
    const orderRows: Array<Record<string, unknown>> = [{
      id: "order-balance",
      status: "pending",
      paymentProvider,
      buyerEmail: "buyer@example.com",
      fulfillmentMode: "card",
    }];
    const createWriteScope = (scope: "db" | "tx") => ({
      update: () => ({
        set: (data: Record<string, unknown>) => {
          updates.push(data);
          scopedUpdates.push({ data, scope });
          return { where: () => {
            const currentStatus = String(orderRows[0]?.status || "");
            const nextStatus = typeof data.status === "string" ? data.status : "";
            const rowsAffected = nextStatus === "paid" && currentStatus !== "pending"
              ? 0
              : nextStatus === "failed" && !["pending", "paid"].includes(currentStatus)
                ? 0
                : 1;
            if (rowsAffected > 0 && nextStatus) Object.assign(orderRows[0], data);
            return Promise.resolve({ rowsAffected });
          } };
        },
      }),
      insert: () => ({ values: () => Promise.resolve({ rowsAffected: 1 }) }),
      select: () => ({ from: () => createSelectChain(orderRows) }),
      run: () => Promise.resolve({ rows: [] }),
    });
    const tx = createWriteScope("tx");
    const db = {
      ...createWriteScope("db"),
      transaction: vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) => callback(tx)),
      __orderRows: orderRows,
      __updates: updates,
      __scopedUpdates: scopedUpdates,
      __tx: tx,
    } as unknown as DbType & {
      __orderRows: Array<Record<string, unknown>>;
      __updates: Array<Record<string, unknown>>;
      __scopedUpdates: Array<{ data: Record<string, unknown>; scope: "db" | "tx" }>;
      __tx: DbType;
    };
    return db;
  }

  it("rejects an internal settlement order without an explicit provider snapshot", async () => {
    const db = createBalanceMockDb("");

    const result = await handleInternalSettlement(
      db,
      "order-without-provider",
      "buyer@example.com",
      0,
      { id: "prod-1", title: "免费资料", fulfillmentMode: "card" as FulfillmentMode },
    );

    expect(result).toMatchObject({ ok: false, status: 400, message: "非站内即时结算订单" });
    expect(voucherServiceMocks.getUserBalance).not.toHaveBeenCalled();
    expect(orderServiceMocks.markPaidAndIssue).not.toHaveBeenCalled();
  });

  it("refunds balance, releases stock, and marks order failed when issuing fails", async () => {
    voucherServiceMocks.getUserBalance.mockResolvedValueOnce({
      email: "buyer@example.com",
      balanceCents: 2000,
      totalDepositedCents: 2000,
      totalSpentCents: 0,
    });
    voucherServiceMocks.deductBalance.mockResolvedValueOnce(true);
    voucherServiceMocks.refundBalance.mockResolvedValueOnce(undefined);
    orderServiceMocks.markPaidAndIssue.mockResolvedValueOnce({ ok: false, status: 409, message: "当前商品库存不足" });
    issueServiceMocks.releaseLockedCardByOrder.mockResolvedValueOnce(1);
    const db = createBalanceMockDb();

    const result = await handleInternalSettlement(
      db,
      "order-balance-fail",
      "buyer@example.com",
      1200,
      { id: "prod-1", title: "资料包", fulfillmentMode: "card" as FulfillmentMode },
      undefined,
    );

    expect(result.ok).toBe(false);
    expect(voucherServiceMocks.refundBalance).toHaveBeenCalledWith(
      db.__tx,
      "buyer@example.com",
      1200,
      expect.objectContaining({ referenceId: "order-balance-fail" }),
    );
    expect(issueServiceMocks.releaseLockedCardByOrder).toHaveBeenCalledWith(db.__tx, "order-balance-fail");
    expect(db.__updates).toContainEqual({ status: "failed" });
  });

  it("commits the balance deduction and pending-to-paid claim in the same transaction", async () => {
    voucherServiceMocks.getUserBalance.mockResolvedValueOnce({
      email: "buyer@example.com",
      balanceCents: 2000,
      totalDepositedCents: 2000,
      totalSpentCents: 0,
    });
    voucherServiceMocks.deductBalance.mockResolvedValueOnce(true);
    orderServiceMocks.markPaidAndIssue.mockResolvedValueOnce({ ok: true, card: { id: "card-1" } });
    const db = createBalanceMockDb();

    const result = await handleInternalSettlement(
      db,
      "order-balance-atomic",
      "buyer@example.com",
      1200,
      { id: "prod-1", title: "资料包", fulfillmentMode: "card" as FulfillmentMode },
      undefined,
    );

    expect(result.ok).toBe(true);
    expect(voucherServiceMocks.deductBalance).toHaveBeenCalledWith(
      db.__tx,
      "buyer@example.com",
      1200,
      expect.objectContaining({ referenceId: "order-balance-atomic" }),
    );
    expect(db.__scopedUpdates).toContainEqual({
      data: expect.objectContaining({ status: "paid" }),
      scope: "tx",
    });
  });

  it("does not refund or release inventory when concurrent fulfillment already issued the order", async () => {
    voucherServiceMocks.getUserBalance.mockResolvedValueOnce({
      email: "buyer@example.com",
      balanceCents: 2000,
      totalDepositedCents: 2000,
      totalSpentCents: 0,
    });
    voucherServiceMocks.deductBalance.mockResolvedValueOnce(true);
    const db = createBalanceMockDb();
    orderServiceMocks.markPaidAndIssue.mockImplementationOnce(async () => {
      db.__orderRows[0].status = "issued";
      return { ok: false, status: 409, message: "当前订单状态不可发卡" };
    });

    const result = await handleInternalSettlement(
      db,
      "order-balance-concurrent-issued",
      "buyer@example.com",
      1200,
      { id: "prod-1", title: "资料包", fulfillmentMode: "card" as FulfillmentMode },
      undefined,
    );

    expect(result).toEqual({ ok: true, status: 200, message: "余额支付成功" });
    expect(voucherServiceMocks.refundBalance).not.toHaveBeenCalled();
    expect(issueServiceMocks.releaseLockedCardByOrder).not.toHaveBeenCalled();
    expect(db.__orderRows[0].status).toBe("issued");
  });

  it("compensates a previously charged paid order exactly once when retry fulfillment fails", async () => {
    const db = createBalanceMockDb();
    db.__orderRows[0].status = "paid";
    orderServiceMocks.markPaidAndIssue.mockResolvedValueOnce({ ok: false, status: 409, message: "当前商品库存不足" });
    voucherServiceMocks.refundBalance.mockResolvedValueOnce(undefined);
    issueServiceMocks.releaseLockedCardByOrder.mockResolvedValueOnce(1);

    const result = await handleInternalSettlement(
      db,
      "order-balance-paid-retry-fail",
      "buyer@example.com",
      1200,
      { id: "prod-1", title: "资料包", fulfillmentMode: "card" as FulfillmentMode },
      undefined,
    );

    expect(result.ok).toBe(false);
    const retry = await handleInternalSettlement(
      db,
      "order-balance-paid-retry-fail",
      "buyer@example.com",
      1200,
      { id: "prod-1", title: "资料包", fulfillmentMode: "card" as FulfillmentMode },
      undefined,
    );

    expect(retry.ok).toBe(false);
    expect(voucherServiceMocks.getUserBalance).not.toHaveBeenCalled();
    expect(voucherServiceMocks.deductBalance).not.toHaveBeenCalled();
    expect(voucherServiceMocks.refundBalance).toHaveBeenCalledTimes(1);
    expect(issueServiceMocks.releaseLockedCardByOrder).toHaveBeenCalledTimes(1);
    expect(orderServiceMocks.markPaidAndIssue).toHaveBeenCalledTimes(1);
    expect(db.__orderRows[0].status).toBe("failed");
  });

  it("releases stock and closes order when balance is insufficient", async () => {
    voucherServiceMocks.getUserBalance.mockResolvedValueOnce({
      email: "buyer@example.com",
      balanceCents: 500,
      totalDepositedCents: 500,
      totalSpentCents: 0,
    });
    issueServiceMocks.releaseLockedCardByOrder.mockResolvedValueOnce(1);
    const db = createBalanceMockDb();

    const result = await handleInternalSettlement(
      db,
      "order-balance-low",
      "buyer@example.com",
      1200,
      { id: "prod-1", title: "资料包", fulfillmentMode: "card" as FulfillmentMode },
      undefined,
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe(402);
    expect(voucherServiceMocks.deductBalance).not.toHaveBeenCalled();
    expect(voucherServiceMocks.refundBalance).not.toHaveBeenCalled();
    expect(orderServiceMocks.markPaidAndIssue).not.toHaveBeenCalled();
    expect(issueServiceMocks.releaseLockedCardByOrder).toHaveBeenCalledWith(db.__tx, "order-balance-low");
    expect(db.__updates).toContainEqual({ status: "failed" });
  });

  it("releases stock and closes order when balance deduction loses the race", async () => {
    voucherServiceMocks.getUserBalance.mockResolvedValueOnce({
      email: "buyer@example.com",
      balanceCents: 2000,
      totalDepositedCents: 2000,
      totalSpentCents: 0,
    });
    voucherServiceMocks.deductBalance.mockResolvedValueOnce(false);
    issueServiceMocks.releaseLockedCardByOrder.mockResolvedValueOnce(1);
    const db = createBalanceMockDb();

    const result = await handleInternalSettlement(
      db,
      "order-balance-race",
      "buyer@example.com",
      1200,
      { id: "prod-1", title: "资料包", fulfillmentMode: "card" as FulfillmentMode },
      undefined,
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe(409);
    expect(voucherServiceMocks.deductBalance).toHaveBeenCalledWith(
      db.__tx,
      "buyer@example.com",
      1200,
      expect.objectContaining({ referenceId: "order-balance-race" }),
    );
    expect(voucherServiceMocks.refundBalance).not.toHaveBeenCalled();
    expect(orderServiceMocks.markPaidAndIssue).not.toHaveBeenCalled();
    expect(issueServiceMocks.releaseLockedCardByOrder).toHaveBeenCalledWith(db.__tx, "order-balance-race");
    expect(db.__updates).toContainEqual({ status: "failed" });
  });

  it("uses the order fulfillment snapshot when the product setting has changed", async () => {
    const db = createBalanceMockDb();
    db.__orderRows[0].id = "order-balance-virtual";
    db.__orderRows[0].fulfillmentMode = "virtual";
    voucherServiceMocks.getUserBalance.mockResolvedValueOnce({
      email: "buyer@example.com",
      balanceCents: 500,
      totalDepositedCents: 500,
      totalSpentCents: 0,
    });

    const result = await handleInternalSettlement(
      db,
      "order-balance-virtual",
      "buyer@example.com",
      1200,
      { id: "prod-1", title: "资料包", fulfillmentMode: "card" as FulfillmentMode },
      undefined,
    );

    expect(result.ok).toBe(false);
    expect(issueServiceMocks.releaseLockedCardByOrder).not.toHaveBeenCalled();
    expect(db.__updates).toContainEqual({ status: "failed" });
  });

  it("does not refund or release stock after balance payment issues successfully", async () => {
    voucherServiceMocks.getUserBalance.mockResolvedValueOnce({
      email: "buyer@example.com",
      balanceCents: 2000,
      totalDepositedCents: 2000,
      totalSpentCents: 0,
    });
    voucherServiceMocks.deductBalance.mockResolvedValueOnce(true);
    orderServiceMocks.markPaidAndIssue.mockResolvedValueOnce({
      ok: true,
      card: {
        id: "card-1",
        accountLabel: "ACC-1",
        deliverySecret: "SECRET-1",
        deliveryNote: "NOTE-1",
      },
    });
    const db = createBalanceMockDb();

    const result = await handleInternalSettlement(
      db,
      "order-balance-ok",
      "buyer@example.com",
      1200,
      { id: "prod-1", title: "资料包", fulfillmentMode: "card" as FulfillmentMode },
      undefined,
    );

    expect(result).toEqual({ ok: true, status: 200, message: "余额支付成功" });
    expect(voucherServiceMocks.refundBalance).not.toHaveBeenCalled();
    expect(issueServiceMocks.releaseLockedCardByOrder).not.toHaveBeenCalled();
    expect(db.__updates).not.toContainEqual({ status: "failed" });
  });

  it("treats already issued balance orders as idempotent without another deduction", async () => {
    const db = createBalanceMockDb();
    db.__orderRows[0].id = "order-balance-issued";
    db.__orderRows[0].status = "issued";

    const result = await handleInternalSettlement(
      db,
      "order-balance-issued",
      "buyer@example.com",
      1200,
      { id: "prod-1", title: "资料包", fulfillmentMode: "card" as FulfillmentMode },
      undefined,
    );

    expect(result).toEqual({ ok: true, status: 200, message: "余额支付成功" });
    expect(voucherServiceMocks.getUserBalance).not.toHaveBeenCalled();
    expect(voucherServiceMocks.deductBalance).not.toHaveBeenCalled();
    expect(voucherServiceMocks.refundBalance).not.toHaveBeenCalled();
    expect(issueServiceMocks.releaseLockedCardByOrder).not.toHaveBeenCalled();
    expect(orderServiceMocks.markPaidAndIssue).not.toHaveBeenCalled();
  });

  it("retries fulfillment for paid balance orders without charging again", async () => {
    const db = createBalanceMockDb();
    db.__orderRows[0].id = "order-balance-paid";
    db.__orderRows[0].status = "paid";
    orderServiceMocks.markPaidAndIssue.mockResolvedValueOnce({ ok: true, card: { id: "card-1" }, cards: [{ id: "card-1" }] });

    const result = await handleInternalSettlement(
      db,
      "order-balance-paid",
      "buyer@example.com",
      1200,
      { id: "prod-1", title: "资料包", fulfillmentMode: "card" as FulfillmentMode },
      undefined,
    );

    expect(result).toEqual({ ok: true, status: 200, message: "余额支付成功" });
    expect(voucherServiceMocks.getUserBalance).not.toHaveBeenCalled();
    expect(voucherServiceMocks.deductBalance).not.toHaveBeenCalled();
    expect(issueServiceMocks.releaseLockedCardByOrder).not.toHaveBeenCalled();
    expect(orderServiceMocks.markPaidAndIssue).toHaveBeenCalledWith(db, "order-balance-paid", undefined, undefined);
  });
});

describe("POST /pay/unified", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storefrontServiceMocks.resolvePublicStorefront.mockResolvedValue(defaultStorefront);
    storefrontServiceMocks.getActiveStorefrontById.mockResolvedValue(defaultStorefront);
    storefrontServiceMocks.validateStorefrontProductMapping.mockResolvedValue(defaultStorefront);
    paymentProviderMocks.selectOnline.mockReturnValue(null);
    orderServiceMocks.checkOrderRateLimit.mockResolvedValue({ ok: true });
    orderServiceMocks.checkBalanceOrderRateLimit.mockResolvedValue({ ok: true });
    orderServiceMocks.checkProductPurchaseLimitForQuantity.mockReset().mockResolvedValue({ ok: true });
    systemConfigMocks.getOrderExpireMinutes.mockResolvedValue(30);
    systemConfigMocks.readSystemConfigMap.mockResolvedValue({
      balance_payment_enabled: "true",
      offline_pay_qr_wechat: "https://example.test/wechat.png",
      offline_pay_qr_alipay: "",
      offline_pay_hint: "请扫码付款",
    });
    couponServiceMocks.quoteCoupon.mockResolvedValue({
      couponCode: "",
      valid: true,
      discountCents: 0,
      payableCents: 1200,
      message: "无折扣码，按原价购买",
    });
    emailAccessMocks.verifyEmailAccessCode.mockResolvedValue(true);
  });

  function createUnifiedPayApp(options: { idempotencyResponseJson?: string; idempotencyRequestHash?: string; insertedIdempotency?: boolean; product?: Record<string, unknown>; orderDeliveryVisibility?: string; orderFulfillmentMode?: string; orderDeliveryJson?: string; orderStatus?: string; failedTransitionRowsAffected?: number } = {}) {
    const app = new Hono<AppEnv>();
    const executionCtx = { waitUntil: vi.fn() } as unknown as ExecutionContext<unknown>;
    let selectCount = 0;
    const idempotencyState = {
      responseJson: options.idempotencyResponseJson ?? "__pending__",
      requestHash: options.idempotencyRequestHash ?? "",
      resourceId: options.idempotencyResponseJson && options.idempotencyResponseJson !== "__pending__" ? "cached-order" : "",
      inserted: options.insertedIdempotency ?? true,
      clearedPending: false,
      reservationAttempts: 0,
    };
    const product = {
      id: "prod-1",
      title: "Test Product",
      priceCents: 1200,
      currency: "CNY",
      issueMode: "manual",
      fulfillmentMode: "card",
      salesCopy: "",
      stock: 10,
      purchaseLimit: 3,
      deliveryVisibility: "web_and_email",
      ...(options.product || {}),
    };
    const orderState = { status: options.orderStatus ?? "pending", paymentProvider: "balance" };
    const db = {
      select: () => ({
        from: (_table?: unknown) => {
          selectCount++;
          if (_table === cards) {
            if (selectCount > 3) {
              return createSelectChain([
                { id: "card-1", accountLabel: "ACC-1", deliverySecret: "SECRET-1", deliveryNote: "NOTE-1" },
                { id: "card-2", accountLabel: "ACC-2", deliverySecret: "SECRET-2", deliveryNote: "NOTE-2" },
              ]);
            }
            return createSelectChain([{ productId: "prod-1", stock: 10 }]);
          }
          if (_table === idempotencyKeys) {
            return createSelectChain([{
              requestHash: idempotencyState.requestHash,
              resourceId: idempotencyState.resourceId,
              responseJson: idempotencyState.responseJson,
            }]);
          }
          if (_table === orders) {
            return createSelectChain([{
              id: "order-1",
              status: orderState.status,
              paymentProvider: orderState.paymentProvider,
              buyerEmail: "buyer@example.com",
              deliveryVisibility: options.orderDeliveryVisibility ?? product.deliveryVisibility,
              fulfillmentMode: options.orderFulfillmentMode ?? product.fulfillmentMode,
              deliveryJson: options.orderDeliveryJson ?? "",
            }]);
          }
          return createSelectChain([product]);
        },
      }),
      insert: (_table?: unknown) => ({
        values: (data: Record<string, unknown>) => {
          if (_table === idempotencyKeys) idempotencyState.reservationAttempts++;
          if (_table === orders && typeof data.paymentProvider === "string") {
            orderState.paymentProvider = data.paymentProvider;
          }
          if (
            _table === idempotencyKeys &&
            !options.idempotencyRequestHash &&
            typeof data.requestHash === "string"
          ) {
            idempotencyState.requestHash = data.requestHash;
          }
          const promise = Promise.resolve({ rowsAffected: 1 });
          const result: any = {
            onConflictDoNothing: () => ({
              returning: () => Promise.resolve(
                _table === idempotencyKeys && idempotencyState.inserted
                  ? [{ responseJson: "__pending__" }]
                  : []
              ),
            }),
            onConflictDoUpdate: (config?: { set?: { responseJson?: string } }) => {
              if (_table === idempotencyKeys && typeof config?.set?.responseJson === "string") {
                idempotencyState.responseJson = config.set.responseJson;
              }
              return promise;
            },
          };
          result.then = promise.then.bind(promise);
          result.catch = promise.catch.bind(promise);
          result.finally = promise.finally.bind(promise);
          return result;
        },
      }),
      update: () => ({ set: (data: Record<string, unknown>) => ({
        where: () => {
          const rowsAffected = "createdAt" in data
            ? 0
            : data.status === "failed"
            ? options.failedTransitionRowsAffected ?? 1
            : 1;
          if (rowsAffected > 0 && typeof data.status === "string") orderState.status = data.status;
          if (rowsAffected > 0 && typeof data.responseJson === "string") {
            idempotencyState.responseJson = data.responseJson;
            if (typeof data.resourceId === "string") idempotencyState.resourceId = data.resourceId;
          }
          return Promise.resolve({ rowsAffected });
        },
      }) }),
      delete: () => ({ where: () => {
        idempotencyState.clearedPending = true;
        return Promise.resolve({ rowsAffected: 1 });
      } }),
    } as unknown as DbType;

    app.use("*", async (c, next) => {
      c.set("db", db as never);
      c.set("executionCtx", executionCtx);
      await next();
    });
    app.route("/api", payRoute);
    return { app, idempotencyState, executionCtx };
  }

  function unifiedPayPayload(extra?: Record<string, unknown>) {
    return {
      storefrontId: "sf_default",
      productId: "prod-1",
      buyerEmail: "buyer@example.com",
      ...extra,
    };
  }

  it("returns public EasyPay methods ordered with the default channel first", async () => {
    paymentProviderMocks.getProvider.mockReturnValueOnce({
      name: "easypay",
      defaultPayType: "wxpay",
      enabledPayTypes: ["alipay", "wxpay"],
      createPayment: (...args: unknown[]) => paymentProviderMocks.createPayment(...args),
      verifyCallback: (...args: unknown[]) => paymentProviderMocks.verifyCallback(...args),
      queryStatus: (...args: unknown[]) => paymentProviderMocks.queryStatus(...args),
    });
    const { app } = createUnifiedPayApp();

    const res = await app.request("/api/pay/methods", {}, {});
    const body = await res.json() as {
      ok: boolean;
      methods: Array<{ provider: string; channel: string; label: string }>;
    };

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store, no-cache, must-revalidate");
    expect(body.ok).toBe(true);
    expect(body.methods).toEqual([
      { provider: "easypay", channel: "wxpay", label: "微信支付" },
      { provider: "easypay", channel: "alipay", label: "支付宝" },
    ]);
  });

  it("uses configured order rate limit before locking inventory", async () => {
    orderServiceMocks.checkOrderRateLimit.mockResolvedValueOnce({
      ok: false,
      status: 429,
      message: "该邮箱购买过于频繁，请 5 分钟后再试",
    });
    const { app } = createUnifiedPayApp();

    const res = await app.request("/api/pay/unified", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": STRONG_IDEMPOTENCY_KEY },
      body: JSON.stringify(unifiedPayPayload()),
    }, {});
    const body = await res.json() as { ok: boolean; error: string };

    expect(res.status).toBe(429);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("购买过于频繁");
    expect(orderServiceMocks.checkOrderRateLimit).toHaveBeenCalledWith(expect.anything(), "buyer@example.com", "prod-1");
    expect(fulfillmentServiceMocks.lockFulfillmentInventoryItems).not.toHaveBeenCalled();
  });

  it("enforces product purchase limit before unified payment locks inventory", async () => {
    orderServiceMocks.checkProductPurchaseLimitForQuantity.mockResolvedValueOnce({
      ok: false,
      status: 429,
      message: "该商品每人限购 3 件，您已达到上限",
    });
    const { app } = createUnifiedPayApp();

    const res = await app.request("/api/pay/unified", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": STRONG_IDEMPOTENCY_KEY },
      body: JSON.stringify(unifiedPayPayload({ quantity: 2 })),
    }, {});
    const body = await res.json() as { ok: boolean; error: string };

    expect(res.status).toBe(429);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("限购 3 件");
    expect(orderServiceMocks.checkProductPurchaseLimitForQuantity).toHaveBeenCalledWith(expect.anything(), "buyer@example.com", "prod-1", 3, 2);
    expect(fulfillmentServiceMocks.lockFulfillmentInventoryItems).not.toHaveBeenCalled();
  });

  it("rechecks the product purchase limit inside the order transaction", async () => {
    orderServiceMocks.checkProductPurchaseLimitForQuantity
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        message: "该商品每人限购 3 件，您已达到上限",
      });
    fulfillmentServiceMocks.lockFulfillmentInventoryItems.mockResolvedValueOnce({
      mode: "card",
      inventoryIds: ["card-1"],
    });
    const { app } = createUnifiedPayApp();

    const res = await app.request("/api/pay/unified", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": STRONG_IDEMPOTENCY_KEY },
      body: JSON.stringify(unifiedPayPayload()),
    }, {});
    const body = await res.json() as { error: string };

    expect(res.status).toBe(429);
    expect(body.error).toContain("限购 3 件");
    expect(orderServiceMocks.checkProductPurchaseLimitForQuantity).toHaveBeenCalledTimes(2);
    expect(fulfillmentServiceMocks.lockFulfillmentInventoryItems).not.toHaveBeenCalled();
  });

  it("rejects an invalid fulfillment mode instead of treating it as virtual delivery", async () => {
    const { app } = createUnifiedPayApp({ product: { fulfillmentMode: "broken-mode" } });

    const res = await app.request("/api/pay/unified", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": STRONG_IDEMPOTENCY_KEY },
      body: JSON.stringify(unifiedPayPayload()),
    }, {});
    const body = await res.json() as { error: string };

    expect(res.status).toBe(400);
    expect(body.error).toContain("履约模式配置异常");
    expect(fulfillmentServiceMocks.lockFulfillmentInventoryItems).not.toHaveBeenCalled();
  });

  it("rejects a missing required fulfillment input before reserving inventory", async () => {
    const { app, idempotencyState } = createUnifiedPayApp({
      product: {
        fulfillmentInputType: "account",
        fulfillmentInputLabel: "充值账号",
        fulfillmentInputRequired: true,
      },
    });

    const res = await app.request("/api/pay/unified", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": STRONG_IDEMPOTENCY_KEY },
      body: JSON.stringify(unifiedPayPayload()),
    }, {});
    const body = await res.json() as { error: string; code?: string };

    expect(res.status).toBe(400);
    expect(body.error).toBe("请填写充值账号");
    expect(idempotencyState.clearedPending).toBe(true);
    expect(fulfillmentServiceMocks.lockFulfillmentInventoryItems).not.toHaveBeenCalled();
  });

  it("rejects an invalid issue mode instead of silently treating it as manual", async () => {
    const { app } = createUnifiedPayApp({ product: { issueMode: "webhook" } });

    const res = await app.request("/api/pay/unified", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": STRONG_IDEMPOTENCY_KEY },
      body: JSON.stringify(unifiedPayPayload()),
    }, {});
    const body = await res.json() as { error: string };

    expect(res.status).toBe(400);
    expect(body.error).toContain("发卡模式配置异常");
    expect(fulfillmentServiceMocks.lockFulfillmentInventoryItems).not.toHaveBeenCalled();
  });

  it("rejects balance payment for non-CNY products", async () => {
    const { app } = createUnifiedPayApp({ product: { currency: "USD" } });

    const res = await app.request("/api/pay/unified", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": STRONG_IDEMPOTENCY_KEY },
      body: JSON.stringify(unifiedPayPayload({ balancePayment: true, emailAccessCode: "123456" })),
    }, { ADMIN_TOKEN: "admin-secret" });
    const body = await res.json() as { error: string; details?: { code?: string } };

    expect(res.status).toBe(400);
    expect(body.error).toContain("余额仅支持 CNY");
    expect(body.details?.code).toBe("BALANCE_CURRENCY_UNSUPPORTED");
    expect(voucherServiceMocks.deductBalance).not.toHaveBeenCalled();
    expect(fulfillmentServiceMocks.lockFulfillmentInventoryItems).not.toHaveBeenCalled();
  });

  it("rejects balance payment when the admin switch is disabled", async () => {
    systemConfigMocks.readSystemConfigMap.mockResolvedValueOnce({
      balance_payment_enabled: "false",
      offline_pay_qr_wechat: "https://example.test/wechat.png",
      offline_pay_qr_alipay: "",
      offline_pay_hint: "请扫码付款",
    });
    const { app } = createUnifiedPayApp();

    const res = await app.request("/api/pay/unified", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": STRONG_IDEMPOTENCY_KEY },
      body: JSON.stringify(unifiedPayPayload({ balancePayment: true, emailAccessCode: "123456" })),
    }, { ADMIN_TOKEN: "admin-secret" });
    const body = await res.json() as { error: string; details?: { code?: string } };

    expect(res.status).toBe(403);
    expect(body.error).toContain("余额支付未启用");
    expect(body.details?.code).toBe("BALANCE_PAYMENT_DISABLED");
    expect(emailAccessMocks.verifyEmailAccessCode).not.toHaveBeenCalled();
    expect(fulfillmentServiceMocks.lockFulfillmentInventoryItems).not.toHaveBeenCalled();
    expect(voucherServiceMocks.deductBalance).not.toHaveBeenCalled();
  });

  it("does not degrade a non-CNY order to CNY offline payment", async () => {
    const { app } = createUnifiedPayApp({ product: { currency: "USD" } });

    const res = await app.request("/api/pay/unified", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": STRONG_IDEMPOTENCY_KEY },
      body: JSON.stringify(unifiedPayPayload()),
    }, {});
    const body = await res.json() as { error: string; details?: { code?: string } };

    expect(res.status).toBe(503);
    expect(body.error).toContain("暂无可用支付渠道");
    expect(body.details?.code).toBe("PAYMENT_CURRENCY_UNAVAILABLE");
    expect(fulfillmentServiceMocks.lockFulfillmentInventoryItems).not.toHaveBeenCalled();
  });

  it("uses configured balance rate limit before locking inventory", async () => {
    orderServiceMocks.checkBalanceOrderRateLimit.mockResolvedValueOnce({
      ok: false,
      status: 429,
      message: "该邮箱余额支付过于频繁，请 5 分钟后再试",
    });
    const { app } = createUnifiedPayApp();

    const res = await app.request("/api/pay/unified", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": STRONG_IDEMPOTENCY_KEY },
      body: JSON.stringify(unifiedPayPayload({ balancePayment: true, emailAccessCode: "123456" })),
    }, { ADMIN_TOKEN: "admin-secret" });
    const body = await res.json() as { ok: boolean; error: string };

    expect(res.status).toBe(429);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("余额支付过于频繁");
    expect(orderServiceMocks.checkOrderRateLimit).toHaveBeenCalledWith(expect.anything(), "buyer@example.com", "prod-1");
    expect(orderServiceMocks.checkBalanceOrderRateLimit).toHaveBeenCalledWith(expect.anything(), "buyer@example.com");
    expect(orderServiceMocks.checkProductPurchaseLimitForQuantity).toHaveBeenCalledWith(expect.anything(), "buyer@example.com", "prod-1", 3, 1);
    expect(fulfillmentServiceMocks.lockFulfillmentInventoryItems).not.toHaveBeenCalled();
  });

  it("locks the requested quantity for unified manual card orders", async () => {
    couponServiceMocks.quoteCoupon.mockResolvedValueOnce({
      couponCode: "",
      valid: true,
      discountCents: 0,
      payableCents: 2400,
      message: "无折扣码，按原价购买",
    });
    fulfillmentServiceMocks.lockFulfillmentInventoryItems.mockResolvedValueOnce({
      mode: "card",
      inventoryIds: ["card-1", "card-2"],
    });
    const { app } = createUnifiedPayApp();

    const res = await app.request("/api/pay/unified", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": STRONG_IDEMPOTENCY_KEY },
      body: JSON.stringify(unifiedPayPayload({ quantity: 2 })),
    }, {});
    const body = await res.json() as { ok: boolean; quantity: number };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.quantity).toBe(2);
    expect(fulfillmentServiceMocks.lockFulfillmentInventoryItems).toHaveBeenCalledTimes(1);
    expect(fulfillmentServiceMocks.lockFulfillmentInventoryItems.mock.calls[0][2]).toBe("prod-1");
    expect(fulfillmentServiceMocks.lockFulfillmentInventoryItems.mock.calls[0][4]).toBe(2);
  });

  it("registers offline order email delivery with waitUntil", async () => {
    fulfillmentServiceMocks.lockFulfillmentInventoryItems.mockResolvedValueOnce({
      mode: "card",
      inventoryIds: ["card-1"],
    });
    const emailPromise = Promise.resolve({ ok: true, message: "sent" });
    emailServiceMocks.sendEmail.mockReturnValueOnce(emailPromise);
    const { app, executionCtx } = createUnifiedPayApp();

    const res = await app.request("/api/pay/unified", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": STRONG_IDEMPOTENCY_KEY },
      body: JSON.stringify(unifiedPayPayload()),
    }, { RESEND_API_KEY: "resend-key" });

    expect(res.status).toBe(200);
    expect(emailServiceMocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(executionCtx.waitUntil).toHaveBeenCalledWith(emailPromise);
  });

  it("auto-generates provider notify and return URLs from the current request origin", async () => {
    fulfillmentServiceMocks.lockFulfillmentInventoryItems.mockResolvedValueOnce({
      mode: "card",
      inventoryIds: ["card-1"],
    });
    paymentProviderMocks.createPayment.mockResolvedValueOnce({
      qrCode: "https://pay.example.test/qr.png",
      redirectUrl: "https://pay.example.test/pay",
      raw: {
        payType: "alipay",
      },
    });
    paymentProviderMocks.selectOnline.mockReturnValueOnce({
      name: "easypay",
      createPayment: (...args: unknown[]) => paymentProviderMocks.createPayment(...args),
    });
    const { app } = createUnifiedPayApp();

    const res = await app.request("https://shop.example.com/api/pay/unified", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": STRONG_IDEMPOTENCY_KEY },
      body: JSON.stringify(unifiedPayPayload()),
    }, {});
    const body = await res.json() as {
      ok: boolean;
      mode: string;
      provider: string;
      paymentChannel?: string;
      paymentChannelLabel?: string;
      qrcode: string;
      qrImageUrl?: string;
      qrContent?: string;
      redirectUrl: string;
    };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.mode).toBe("online");
    expect(body.provider).toBe("easypay");
    expect(body.paymentChannel).toBe("alipay");
    expect(body.paymentChannelLabel).toBe("支付宝");
    expect(body.qrcode).toBe("https://pay.example.test/qr.png");
    expect(body.qrImageUrl).toBe("https://pay.example.test/qr.png");
    const createPaymentInput = paymentProviderMocks.createPayment.mock.calls[0][0] as {
      orderNo: string;
      notifyUrl: string;
      returnUrl: string;
      metadata: { clientIp?: string };
    };
    expect(createPaymentInput.notifyUrl).toBe("https://shop.example.com/api/pay/callback/easypay");
    expect(createPaymentInput.returnUrl).toBe("https://shop.example.com/lookup");
    expect(createPaymentInput.metadata.clientIp).toBe("unknown");
  });

  it("passes the selected EasyPay channel into provider metadata", async () => {
    fulfillmentServiceMocks.lockFulfillmentInventoryItems.mockResolvedValueOnce({
      mode: "card",
      inventoryIds: ["card-1"],
    });
    paymentProviderMocks.createPayment.mockResolvedValueOnce({
      qrCode: "https://pay.example.test/qr.png",
      redirectUrl: "https://pay.example.test/pay",
      raw: {
        payType: "wxpay",
      },
    });
    paymentProviderMocks.selectOnline.mockReturnValueOnce({
      name: "easypay",
      createPayment: (...args: unknown[]) => paymentProviderMocks.createPayment(...args),
    });
    const { app } = createUnifiedPayApp();

    const res = await app.request("https://shop.example.com/api/pay/unified", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": STRONG_IDEMPOTENCY_KEY },
      body: JSON.stringify(unifiedPayPayload({ paymentChannel: "wxpay" })),
    }, {});
    const body = await res.json() as { ok: boolean; paymentChannel?: string; paymentChannelLabel?: string };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.paymentChannel).toBe("wxpay");
    expect(body.paymentChannelLabel).toBe("微信支付");
    const createPaymentInput = paymentProviderMocks.createPayment.mock.calls[0][0] as {
      metadata: { payType?: string };
    };
    expect(createPaymentInput.metadata.payType).toBe("wxpay");
  });

  it("keeps EasyPay qrcode content separate from the image field", async () => {
    fulfillmentServiceMocks.lockFulfillmentInventoryItems.mockResolvedValueOnce({
      mode: "card",
      inventoryIds: ["card-1"],
    });
    paymentProviderMocks.createPayment.mockResolvedValueOnce({
      qrCode: "https://pay.example.test/qr-content",
      raw: {
        qrcode: "https://pay.example.test/qr-content",
        qrContent: "https://pay.example.test/qr-content",
        img: "https://pay.example.test/qr-image.png",
        qrImageUrl: "https://pay.example.test/qr-image.png",
      },
    });
    paymentProviderMocks.selectOnline.mockReturnValueOnce({
      name: "easypay",
      createPayment: (...args: unknown[]) => paymentProviderMocks.createPayment(...args),
    });
    const { app } = createUnifiedPayApp();

    const res = await app.request("https://shop.example.com/api/pay/unified", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": STRONG_IDEMPOTENCY_KEY },
      body: JSON.stringify(unifiedPayPayload()),
    }, {});
    const body = await res.json() as {
      ok: boolean;
      qrcode: string;
      qrImageUrl?: string;
      qrContent?: string;
      redirectUrl?: string;
    };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.qrcode).toBe("https://pay.example.test/qr-image.png");
    expect(body.qrImageUrl).toBe("https://pay.example.test/qr-image.png");
    expect(body.qrContent).toBe("https://pay.example.test/qr-content");
    expect(body.redirectUrl).toBe("https://pay.example.test/qr-content");
  });

  it("settles zero-amount orders without creating an external payment", async () => {
    couponServiceMocks.quoteCoupon.mockResolvedValueOnce({
      couponCode: "FREE100",
      valid: true,
      discountCents: 1200,
      payableCents: 0,
      message: "折扣后无需支付",
    });
    paymentProviderMocks.selectOnline.mockReturnValueOnce({
      name: "easypay",
      createPayment: (...args: unknown[]) => paymentProviderMocks.createPayment(...args),
    });
    fulfillmentServiceMocks.lockFulfillmentInventoryItems.mockResolvedValueOnce({
      mode: "card",
      inventoryIds: ["card-1"],
    });
    orderServiceMocks.markPaidAndIssue.mockResolvedValueOnce({
      ok: true,
      card: { id: "card-1", accountLabel: "ACC-1", deliverySecret: "SECRET-1", deliveryNote: "" },
      cards: [{ id: "card-1", accountLabel: "ACC-1", deliverySecret: "SECRET-1", deliveryNote: "" }],
    });
    const { app } = createUnifiedPayApp();

    try {
      const res = await app.request("https://shop.example.com/api/pay/unified", {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": STRONG_IDEMPOTENCY_KEY },
        body: JSON.stringify(unifiedPayPayload({ couponCode: "FREE100" })),
      }, {});
      const body = await res.json() as {
        ok: boolean;
        mode: string;
        status?: string;
        amountCents: number;
        delivery?: { deliverySecret?: string };
      };

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.mode).toBe("free");
      expect(body.status).toBe("issued");
      expect(body.amountCents).toBe(0);
      expect(body.delivery).toMatchObject({ deliverySecret: "SECRET-1" });
      expect(paymentProviderMocks.selectOnline).not.toHaveBeenCalled();
      expect(paymentProviderMocks.createPayment).not.toHaveBeenCalled();
      expect(voucherServiceMocks.getUserBalance).not.toHaveBeenCalled();
      expect(voucherServiceMocks.deductBalance).not.toHaveBeenCalled();
    } finally {
      paymentProviderMocks.selectOnline.mockReset().mockReturnValue(null);
    }
  });

  it.each([
    {
      name: "一次领取多件",
      payload: { quantity: 2 },
      code: "FREE_PRODUCT_QUANTITY_INVALID",
    },
    {
      name: "携带优惠码",
      payload: { couponCode: "FREE100" },
      code: "FREE_PRODUCT_COUPON_UNSUPPORTED",
    },
    {
      name: "指定在线支付方式",
      payload: { paymentChannel: "alipay" },
      code: "FREE_PRODUCT_PAYMENT_METHOD_UNSUPPORTED",
    },
    {
      name: "指定余额支付",
      payload: { balancePayment: true, emailAccessCode: "123456" },
      code: "FREE_PRODUCT_PAYMENT_METHOD_UNSUPPORTED",
    },
  ])("rejects base-free product requests that bypass the simplified checkout: $name", async ({ payload, code }) => {
    const { app, idempotencyState } = createUnifiedPayApp({ product: { priceCents: 0 } });

    const res = await app.request("https://shop.example.com/api/pay/unified", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": STRONG_IDEMPOTENCY_KEY },
      body: JSON.stringify(unifiedPayPayload(payload)),
    }, { ADMIN_TOKEN: "admin-secret" });
    const body = await res.json() as { ok: boolean; details?: { code?: string } };

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.details?.code).toBe(code);
    expect(idempotencyState.clearedPending).toBe(true);
    expect(couponServiceMocks.quoteCoupon).not.toHaveBeenCalled();
    expect(couponServiceMocks.consumeCoupon).not.toHaveBeenCalled();
    expect(paymentProviderMocks.selectOnline).not.toHaveBeenCalled();
    expect(paymentProviderMocks.createPayment).not.toHaveBeenCalled();
    expect(fulfillmentServiceMocks.lockFulfillmentInventoryItems).not.toHaveBeenCalled();
  });

  it("issues a base-free product once without quoting coupons or invoking a payment provider", async () => {
    fulfillmentServiceMocks.lockFulfillmentInventoryItems.mockResolvedValueOnce({
      mode: "card",
      inventoryIds: ["card-1"],
    });
    orderServiceMocks.markPaidAndIssue.mockResolvedValueOnce({
      ok: true,
      card: { id: "card-1", accountLabel: "FREE-ACC", deliverySecret: "FREE-SECRET", deliveryNote: "" },
      cards: [{ id: "card-1", accountLabel: "FREE-ACC", deliverySecret: "FREE-SECRET", deliveryNote: "" }],
    });
    const { app } = createUnifiedPayApp({ product: { priceCents: 0, purchaseLimit: 1 } });

    const res = await app.request("https://shop.example.com/api/pay/unified", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": STRONG_IDEMPOTENCY_KEY },
      body: JSON.stringify(unifiedPayPayload()),
    }, {});
    const body = await res.json() as {
      ok: boolean;
      mode: string;
      status?: string;
      amountCents: number;
      quantity: number;
      delivery?: { deliverySecret?: string };
    };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.mode).toBe("free");
    expect(body.status).toBe("issued");
    expect(body.amountCents).toBe(0);
    expect(body.quantity).toBe(1);
    expect(body.delivery).toMatchObject({ deliverySecret: "SECRET-1" });
    expect(orderServiceMocks.checkOrderRateLimit).toHaveBeenCalledWith(expect.anything(), "buyer@example.com", "prod-1");
    expect(orderServiceMocks.checkProductPurchaseLimitForQuantity).toHaveBeenCalledWith(
      expect.anything(),
      "buyer@example.com",
      "prod-1",
      1,
      1,
    );
    expect(fulfillmentServiceMocks.lockFulfillmentInventoryItems).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "prod-1",
      expect.any(String),
      1,
    );
    expect(couponServiceMocks.quoteCoupon).not.toHaveBeenCalled();
    expect(couponServiceMocks.consumeCoupon).not.toHaveBeenCalled();
    expect(paymentProviderMocks.selectOnline).not.toHaveBeenCalled();
    expect(paymentProviderMocks.createPayment).not.toHaveBeenCalled();
    expect(voucherServiceMocks.getUserBalance).not.toHaveBeenCalled();
    expect(voucherServiceMocks.deductBalance).not.toHaveBeenCalled();
  });

  it("forces authorized admin smoke orders through the deterministic offline branch", async () => {
    fulfillmentServiceMocks.lockFulfillmentInventoryItems.mockResolvedValueOnce({
      mode: "card",
      inventoryIds: ["card-1"],
    });
    paymentProviderMocks.selectOnline.mockReturnValue({
      name: "easypay",
      createPayment: (...args: unknown[]) => paymentProviderMocks.createPayment(...args),
    });
    const { app } = createUnifiedPayApp();

    const res = await app.request("https://shop.example.com/api/pay/unified", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": STRONG_IDEMPOTENCY_KEY,
        "x-smoke-admin-token": "admin-secret",
        "x-smoke-payment-mode": "offline",
      },
      body: JSON.stringify(unifiedPayPayload()),
    }, {
      ADMIN_TOKEN: "admin-secret",
      ALLOW_TURNSTILE_BYPASS_FOR_SMOKE: "true",
    });
    const body = await res.json() as { ok: boolean; mode: string };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.mode).toBe("offline");
    expect(paymentProviderMocks.selectOnline).not.toHaveBeenCalled();
    expect(paymentProviderMocks.createPayment).not.toHaveBeenCalled();
  });

  it("does not honor the smoke payment mode when the admin token is wrong", async () => {
    fulfillmentServiceMocks.lockFulfillmentInventoryItems.mockResolvedValueOnce({
      mode: "card",
      inventoryIds: ["card-1"],
    });
    paymentProviderMocks.createPayment.mockResolvedValueOnce({
      redirectUrl: "https://pay.example.test/pay",
    });
    paymentProviderMocks.selectOnline.mockReturnValueOnce({
      name: "easypay",
      createPayment: (...args: unknown[]) => paymentProviderMocks.createPayment(...args),
    });
    const { app } = createUnifiedPayApp();

    const res = await app.request("https://shop.example.com/api/pay/unified", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": STRONG_IDEMPOTENCY_KEY,
        "x-smoke-admin-token": "wrong-secret",
        "x-smoke-payment-mode": "offline",
      },
      body: JSON.stringify(unifiedPayPayload()),
    }, {
      ADMIN_TOKEN: "admin-secret",
      ALLOW_TURNSTILE_BYPASS_FOR_SMOKE: "true",
    });
    const body = await res.json() as { ok: boolean; mode: string };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.mode).toBe("online");
    expect(paymentProviderMocks.createPayment).toHaveBeenCalledTimes(1);
  });

  it("fails and closes the local order when EasyPay returns no safe payment entry", async () => {
    fulfillmentServiceMocks.lockFulfillmentInventoryItems.mockResolvedValueOnce({
      mode: "card",
      inventoryIds: ["card-1"],
    });
    paymentProviderMocks.createPayment.mockResolvedValueOnce({
      redirectUrl: "javascript:alert(document.domain)",
      raw: {
        address: "TReceiverAddress",
        amount: "12.000000",
        memo: "00123456",
        network: "TRC20",
      },
    });
    paymentProviderMocks.selectOnline.mockReturnValueOnce({
      name: "easypay",
      createPayment: (...args: unknown[]) => paymentProviderMocks.createPayment(...args),
    });
    const { app } = createUnifiedPayApp();

    const res = await app.request("https://shop.example.com/api/pay/unified", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": STRONG_IDEMPOTENCY_KEY },
      body: JSON.stringify(unifiedPayPayload()),
    }, {});
    const body = await res.json() as { ok: boolean; error: string; details?: { code?: string; status?: string; releasedCards?: number } };

    expect(res.status).toBe(502);
    expect(body.ok).toBe(false);
    expect(body.details?.code).toBe("PAYMENT_CREATION_FAILED");
    expect(body.details?.status).toBe("failed");
    expect(body.details?.releasedCards).toBe(1);
    expect(issueServiceMocks.releaseLockedCardByOrder).toHaveBeenCalledTimes(1);
    expect(couponServiceMocks.releaseCouponReservation).not.toHaveBeenCalled();
  });

  it("keeps the online order pending when provider creation times out ambiguously", async () => {
    fulfillmentServiceMocks.lockFulfillmentInventoryItems.mockResolvedValueOnce({
      mode: "card",
      inventoryIds: ["card-1"],
    });
    paymentProviderMocks.createPayment.mockRejectedValueOnce(Object.assign(new Error("provider timeout"), { kind: "ambiguous" }));
    paymentProviderMocks.selectOnline.mockReturnValueOnce({
      name: "easypay",
      createPayment: (...args: unknown[]) => paymentProviderMocks.createPayment(...args),
    });
    const { app } = createUnifiedPayApp({ orderStatus: "pending" });

    const res = await app.request("https://shop.example.com/api/pay/unified", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": STRONG_IDEMPOTENCY_KEY },
      body: JSON.stringify(unifiedPayPayload()),
    }, {});
    const body = await res.json() as { ok: boolean; details?: { code?: string } };

    expect(res.status).toBe(503);
    expect(body.details?.code).toBe("PAYMENT_CREATION_UNCERTAIN");
    expect(issueServiceMocks.releaseLockedCardByOrder).not.toHaveBeenCalled();
    expect(couponServiceMocks.releaseCouponReservation).not.toHaveBeenCalled();
    expect(fulfillmentServiceMocks.lockFulfillmentInventoryItems).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite or release an online order when callback wins the provider creation failure race", async () => {
    fulfillmentServiceMocks.lockFulfillmentInventoryItems.mockResolvedValueOnce({
      mode: "card",
      inventoryIds: ["card-1"],
    });
    paymentProviderMocks.createPayment.mockRejectedValueOnce(Object.assign(new Error("provider timeout"), { kind: "ambiguous" }));
    paymentProviderMocks.selectOnline.mockReturnValueOnce({
      name: "easypay",
      createPayment: (...args: unknown[]) => paymentProviderMocks.createPayment(...args),
    });
    const { app } = createUnifiedPayApp({
      orderStatus: "paid",
      failedTransitionRowsAffected: 0,
    });

    const res = await app.request("https://shop.example.com/api/pay/unified", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": STRONG_IDEMPOTENCY_KEY },
      body: JSON.stringify(unifiedPayPayload()),
    }, {});
    const body = await res.json() as { ok: boolean; error: string };

    expect(res.status).toBe(409);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("支付状态已变更");
    expect(issueServiceMocks.releaseLockedCardByOrder).not.toHaveBeenCalled();
    expect(couponServiceMocks.releaseCouponReservation).not.toHaveBeenCalled();
    expect(fulfillmentServiceMocks.lockFulfillmentInventoryItems).toHaveBeenCalledTimes(1);
  });

  it("returns every issued card for multi-quantity balance payments", async () => {
    couponServiceMocks.quoteCoupon.mockResolvedValueOnce({
      couponCode: "",
      valid: true,
      discountCents: 0,
      payableCents: 2400,
      message: "无折扣码，按原价购买",
    });
    fulfillmentServiceMocks.lockFulfillmentInventoryItems.mockResolvedValueOnce({
      mode: "card",
      inventoryIds: ["card-1", "card-2"],
    });
    voucherServiceMocks.getUserBalance.mockResolvedValueOnce({
      email: "buyer@example.com",
      balanceCents: 5000,
      totalDepositedCents: 5000,
      totalSpentCents: 0,
    });
    voucherServiceMocks.deductBalance.mockResolvedValueOnce(true);
    orderServiceMocks.markPaidAndIssue.mockResolvedValueOnce({
      ok: true,
      card: { id: "card-1", accountLabel: "ACC-1", deliverySecret: "SECRET-1", deliveryNote: "NOTE-1" },
      cards: [
        { id: "card-1", accountLabel: "ACC-1", deliverySecret: "SECRET-1", deliveryNote: "NOTE-1" },
        { id: "card-2", accountLabel: "ACC-2", deliverySecret: "SECRET-2", deliveryNote: "NOTE-2" },
      ],
    });
    const { app } = createUnifiedPayApp();

    const res = await app.request("/api/pay/unified", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": STRONG_IDEMPOTENCY_KEY },
      body: JSON.stringify(unifiedPayPayload({ quantity: 2, balancePayment: true, emailAccessCode: "123456" })),
    }, { ADMIN_TOKEN: "admin-secret" });
    const body = await res.json() as {
      ok: boolean;
      mode: string;
      quantity: number;
      delivery?: { accountLabel?: string; deliverySecret?: string };
      cards?: Array<{ id?: string; cardData?: string }>;
    };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.mode).toBe("balance");
    expect(body.quantity).toBe(2);
    expect(body.delivery).toMatchObject({ accountLabel: "ACC-1", deliverySecret: "SECRET-1" });
    expect(body.cards).toEqual([
      { id: "card-1", accountLabel: "ACC-1", deliverySecret: "SECRET-1", deliveryNote: "NOTE-1", cardData: "ACC-1 / SECRET-1" },
      { id: "card-2", accountLabel: "ACC-2", deliverySecret: "SECRET-2", deliveryNote: "NOTE-2", cardData: "ACC-2 / SECRET-2" },
    ]);
  });

  it("caches the completed balance response for idempotent replay", async () => {
    fulfillmentServiceMocks.lockFulfillmentInventoryItems.mockResolvedValueOnce({
      mode: "card",
      inventoryIds: ["card-1"],
    });
    voucherServiceMocks.getUserBalance.mockResolvedValueOnce({
      email: "buyer@example.com",
      balanceCents: 5000,
      totalDepositedCents: 5000,
      totalSpentCents: 0,
    });
    voucherServiceMocks.deductBalance.mockResolvedValueOnce(true);
    orderServiceMocks.markPaidAndIssue.mockResolvedValueOnce({
      ok: true,
      card: { id: "card-1", accountLabel: "ACC-1", deliverySecret: "SECRET-1", deliveryNote: "NOTE-1" },
      cards: [{ id: "card-1", accountLabel: "ACC-1", deliverySecret: "SECRET-1", deliveryNote: "NOTE-1" }],
    });
    const { app, idempotencyState } = createUnifiedPayApp();

    const res = await app.request("/api/pay/unified", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": STRONG_IDEMPOTENCY_KEY },
      body: JSON.stringify(unifiedPayPayload({ balancePayment: true, emailAccessCode: "123456" })),
    }, { ADMIN_TOKEN: "admin-secret" });

    expect(res.status).toBe(200);
    expect(JSON.parse(idempotencyState.responseJson)).toMatchObject({
      mode: "balance",
      status: "issued",
    });
  });

  it("stores a recoverable balance response before fulfillment starts", async () => {
    fulfillmentServiceMocks.lockFulfillmentInventoryItems.mockResolvedValueOnce({
      mode: "card",
      inventoryIds: ["card-1"],
    });
    voucherServiceMocks.getUserBalance.mockResolvedValueOnce({
      email: "buyer@example.com",
      balanceCents: 5000,
      totalDepositedCents: 5000,
      totalSpentCents: 0,
    });
    voucherServiceMocks.deductBalance.mockResolvedValueOnce(true);
    const { app, idempotencyState } = createUnifiedPayApp();
    orderServiceMocks.markPaidAndIssue.mockImplementationOnce(async () => {
      expect(JSON.parse(idempotencyState.responseJson)).toMatchObject({
        mode: "balance",
        status: "pending",
        orderId: expect.any(String),
        orderToken: expect.any(String),
      });
      return { ok: true, card: { id: "card-1" }, cards: [{ id: "card-1" }] };
    });

    const res = await app.request("/api/pay/unified", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": STRONG_IDEMPOTENCY_KEY },
      body: JSON.stringify(unifiedPayPayload({ balancePayment: true, emailAccessCode: "123456" })),
    }, { ADMIN_TOKEN: "admin-secret" });

    expect(res.status).toBe(200);
  });

  it("rejects email-only products before locking inventory when email is not configured", async () => {
    const { app } = createUnifiedPayApp({ product: { deliveryVisibility: "email_only" } });

    const res = await app.request("/api/pay/unified", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": STRONG_IDEMPOTENCY_KEY },
      body: JSON.stringify(unifiedPayPayload({ balancePayment: true, emailAccessCode: "123456" })),
    }, { ADMIN_TOKEN: "admin-secret" });
    const body = await res.json() as { ok: boolean; error: string; details?: { code?: string } };

    expect(res.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("邮件服务未配置");
    expect(body.details?.code).toBe("EMAIL_REQUIRED_FOR_EMAIL_ONLY_DELIVERY");
    expect(fulfillmentServiceMocks.lockFulfillmentInventoryItems).not.toHaveBeenCalled();
    expect(voucherServiceMocks.deductBalance).not.toHaveBeenCalled();
    expect(orderServiceMocks.markPaidAndIssue).not.toHaveBeenCalled();
  });

  it("redacts issued cards from balance payment response for email-only delivery products", async () => {
    fulfillmentServiceMocks.lockFulfillmentInventoryItems.mockResolvedValueOnce({
      mode: "card",
      inventoryIds: ["card-1"],
    });
    voucherServiceMocks.getUserBalance.mockResolvedValueOnce({
      email: "buyer@example.com",
      balanceCents: 5000,
      totalDepositedCents: 5000,
      totalSpentCents: 0,
    });
    voucherServiceMocks.deductBalance.mockResolvedValueOnce(true);
    orderServiceMocks.markPaidAndIssue.mockResolvedValueOnce({
      ok: true,
      card: { id: "card-1", accountLabel: "ACC-1", deliverySecret: "SECRET-1", deliveryNote: "NOTE-1" },
      cards: [{ id: "card-1", accountLabel: "ACC-1", deliverySecret: "SECRET-1", deliveryNote: "NOTE-1" }],
    });
    const { app, executionCtx } = createUnifiedPayApp({ product: { deliveryVisibility: "email_only" } });

    const res = await app.request("/api/pay/unified", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": STRONG_IDEMPOTENCY_KEY },
      body: JSON.stringify(unifiedPayPayload({ balancePayment: true, emailAccessCode: "123456" })),
    }, { ADMIN_TOKEN: "admin-secret", RESEND_API_KEY: "resend-key" });
    const body = await res.json() as {
      ok: boolean;
      mode: string;
      deliveryVisibility?: string;
      deliveryMessage?: string;
      delivery?: Record<string, string>;
      cards?: Array<Record<string, string>>;
    };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.mode).toBe("balance");
    expect(body.deliveryVisibility).toBe("email_only");
    expect(body.deliveryMessage).toContain("buyer@example.com");
    expect(body.delivery).toBeUndefined();
    expect(body.cards).toBeUndefined();
    expect(orderServiceMocks.markPaidAndIssue).toHaveBeenCalledWith(expect.anything(), expect.any(String), expect.anything(), executionCtx);
  });

  it("uses the order delivery snapshot when the product setting has changed", async () => {
    fulfillmentServiceMocks.lockFulfillmentInventoryItems.mockResolvedValueOnce({
      mode: "card",
      inventoryIds: ["card-1"],
    });
    voucherServiceMocks.getUserBalance.mockResolvedValueOnce({
      email: "buyer@example.com",
      balanceCents: 5000,
      totalDepositedCents: 5000,
      totalSpentCents: 0,
    });
    voucherServiceMocks.deductBalance.mockResolvedValueOnce(true);
    orderServiceMocks.markPaidAndIssue.mockResolvedValueOnce({
      ok: true,
      cards: [{ id: "card-1", accountLabel: "ACC-1", deliverySecret: "SECRET-1", deliveryNote: "NOTE-1" }],
    });
    const { app } = createUnifiedPayApp({
      product: { deliveryVisibility: "web_and_email" },
      orderDeliveryVisibility: "email_only",
    });

    const res = await app.request("/api/pay/unified", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": STRONG_IDEMPOTENCY_KEY },
      body: JSON.stringify(unifiedPayPayload({ balancePayment: true, emailAccessCode: "123456" })),
    }, { ADMIN_TOKEN: "admin-secret", RESEND_API_KEY: "resend-key" });
    const body = await res.json() as {
      ok: boolean;
      deliveryVisibility?: string;
      deliveryMessage?: string;
      delivery?: Record<string, string>;
      cards?: Array<Record<string, string>>;
    };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.deliveryVisibility).toBe("email_only");
    expect(body.deliveryMessage).toContain("buyer@example.com");
    expect(body.delivery).toBeUndefined();
    expect(body.cards).toBeUndefined();
  });

  it("uses the order fulfillment snapshot for balance cleanup and delivery", async () => {
    fulfillmentServiceMocks.lockFulfillmentInventoryItems.mockResolvedValueOnce({
      mode: "card",
      inventoryIds: ["card-1"],
    });
    voucherServiceMocks.getUserBalance.mockResolvedValueOnce({
      email: "buyer@example.com",
      balanceCents: 5000,
      totalDepositedCents: 5000,
      totalSpentCents: 0,
    });
    voucherServiceMocks.deductBalance.mockResolvedValueOnce(true);
    orderServiceMocks.markPaidAndIssue.mockResolvedValueOnce({ ok: true });
    const { app } = createUnifiedPayApp({
      product: { fulfillmentMode: "card", deliveryVisibility: "web_and_email" },
      orderFulfillmentMode: "virtual",
      orderDeliveryJson: JSON.stringify({ accountLabel: "资料包", deliverySecret: "SNAPSHOT", deliveryNote: "订单快照" }),
    });

    const res = await app.request("/api/pay/unified", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": STRONG_IDEMPOTENCY_KEY },
      body: JSON.stringify(unifiedPayPayload({ balancePayment: true, emailAccessCode: "123456" })),
    }, { ADMIN_TOKEN: "admin-secret" });
    const body = await res.json() as {
      ok: boolean;
      fulfillmentMode?: string;
      delivery?: Record<string, string>;
      cards?: Array<Record<string, string>>;
    };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.fulfillmentMode).toBe("virtual");
    expect(body.delivery).toEqual({ accountLabel: "资料包", deliverySecret: "SNAPSHOT", deliveryNote: "订单快照" });
    expect(body.cards).toBeUndefined();
    expect(issueServiceMocks.releaseLockedCardByOrder).not.toHaveBeenCalled();
  });

  it("rejects balance payment before idempotency replay or inventory locking when mailbox ownership is not verified", async () => {
    emailAccessMocks.verifyEmailAccessCode.mockResolvedValueOnce(false);
    const { app } = createUnifiedPayApp({
      idempotencyResponseJson: JSON.stringify({ ok: true, mode: "balance", cards: [{ deliverySecret: "stolen" }] }),
      insertedIdempotency: false,
    });

    const res = await app.request("/api/pay/unified", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": STRONG_IDEMPOTENCY_KEY },
      body: JSON.stringify(unifiedPayPayload({ balancePayment: true, emailAccessCode: "000000" })),
    }, { ADMIN_TOKEN: "admin-secret" });

    expect(res.status).toBe(403);
    expect(fulfillmentServiceMocks.lockFulfillmentInventoryItems).not.toHaveBeenCalled();
    expect(voucherServiceMocks.deductBalance).not.toHaveBeenCalled();
  });

  it("rejects invalid coupon before unified payment locks inventory", async () => {
    couponServiceMocks.quoteCoupon.mockResolvedValueOnce({
      couponCode: "BAD10",
      valid: false,
      discountCents: 0,
      payableCents: 1200,
      message: "折扣码不存在或已停用",
    });
    const { app } = createUnifiedPayApp();

    const res = await app.request("/api/pay/unified", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": STRONG_IDEMPOTENCY_KEY },
      body: JSON.stringify(unifiedPayPayload({ couponCode: "BAD10" })),
    }, {});
    const body = await res.json() as { ok: boolean; error: string };

    expect(res.status).toBe(403);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("折扣码不存在或已停用");
    expect(fulfillmentServiceMocks.lockFulfillmentInventoryItems).not.toHaveBeenCalled();
  });

  it("replaces boolean-like polluted offline hint with a safe payment instruction", async () => {
    systemConfigMocks.readSystemConfigMap.mockResolvedValueOnce({
      offline_pay_qr_wechat: "https://example.test/wechat.png",
      offline_pay_qr_alipay: "",
      offline_pay_hint: "true smoke-1783268325360",
    });
    fulfillmentServiceMocks.lockFulfillmentInventoryItems.mockResolvedValueOnce({
      mode: "card",
      inventoryIds: ["card-1"],
    });
    const { app } = createUnifiedPayApp();

    const res = await app.request("/api/pay/unified", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": STRONG_IDEMPOTENCY_KEY },
      body: JSON.stringify(unifiedPayPayload()),
    }, {});
    const body = await res.json() as { ok: boolean; offlineHint: string };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.offlineHint).not.toContain("true smoke");
    expect(body.offlineHint).toContain("付款备注码");
  });

  it("does not create or lock an offline order when no collection QR is configured", async () => {
    systemConfigMocks.readSystemConfigMap.mockResolvedValueOnce({
      offline_pay_qr_wechat: "",
      offline_pay_qr_alipay: "",
      offline_pay_hint: "请扫码付款",
    });
    const { app } = createUnifiedPayApp();

    const res = await app.request("/api/pay/unified", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": STRONG_IDEMPOTENCY_KEY },
      body: JSON.stringify(unifiedPayPayload()),
    }, {});
    const body = await res.json() as { ok: boolean; error: string; detail?: { code?: string } };

    expect(res.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("线下收款码未配置");
    expect(fulfillmentServiceMocks.lockFulfillmentInventoryItems).not.toHaveBeenCalled();
  });

  it("returns pending instead of reprocessing when the same Idempotency-Key is already in flight", async () => {
    const { app } = createUnifiedPayApp({ insertedIdempotency: false, idempotencyResponseJson: "__pending__" });

    const res = await app.request("/api/pay/unified", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": STRONG_IDEMPOTENCY_KEY },
      body: JSON.stringify(unifiedPayPayload()),
    }, {});
    const body = await res.json() as { ok: boolean; error?: string };

    expect(res.status).toBe(409);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("正在处理中");
    expect(orderServiceMocks.checkOrderRateLimit).not.toHaveBeenCalled();
    expect(fulfillmentServiceMocks.lockFulfillmentInventoryItems).not.toHaveBeenCalled();
  });

  it("returns a matching cached idempotency response after applying pay_unified rate limit", async () => {
    const cachedResponse = { ok: true, orderId: "cached-order", mode: "offline" };
    const { app } = createUnifiedPayApp({ insertedIdempotency: false, idempotencyResponseJson: JSON.stringify(cachedResponse) });

    const res = await app.request("/api/pay/unified", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": STRONG_IDEMPOTENCY_KEY },
      body: JSON.stringify(unifiedPayPayload()),
    }, {});
    const body = await res.json() as typeof cachedResponse;

    expect(res.status).toBe(200);
    expect(body).toEqual(cachedResponse);
    expect(enforceRateLimit).toHaveBeenCalledWith(expect.anything(), "pay_unified", 8);
    expect(orderServiceMocks.checkOrderRateLimit).not.toHaveBeenCalled();
    expect(fulfillmentServiceMocks.lockFulfillmentInventoryItems).not.toHaveBeenCalled();
  });

  it("replays an existing order even after its storefront has been disabled", async () => {
    const cachedResponse = { ok: true, orderId: "cached-order", mode: "offline" };
    storefrontServiceMocks.getActiveStorefrontById.mockResolvedValueOnce(null);
    const { app } = createUnifiedPayApp({
      insertedIdempotency: false,
      idempotencyResponseJson: JSON.stringify(cachedResponse),
    });

    const res = await app.request("/api/pay/unified", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": STRONG_IDEMPOTENCY_KEY },
      body: JSON.stringify(unifiedPayPayload()),
    }, {});

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(cachedResponse);
    expect(storefrontServiceMocks.getActiveStorefrontById).not.toHaveBeenCalled();
    expect(fulfillmentServiceMocks.lockFulfillmentInventoryItems).not.toHaveBeenCalled();
  });

  it("rejects reuse of an Idempotency-Key for different payment parameters", async () => {
    const cachedResponse = { orderId: "cached-order", mode: "offline" };
    const { app } = createUnifiedPayApp({
      insertedIdempotency: false,
      idempotencyResponseJson: JSON.stringify(cachedResponse),
      idempotencyRequestHash: "b".repeat(64),
    });

    const res = await app.request("/api/pay/unified", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": STRONG_IDEMPOTENCY_KEY },
      body: JSON.stringify(unifiedPayPayload()),
    }, {});

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      details: { code: "IDEMPOTENCY_REQUEST_MISMATCH" },
    });
    expect(orderServiceMocks.checkOrderRateLimit).not.toHaveBeenCalled();
  });

  it("binds the idempotency request hash to the storefront", async () => {
    storefrontServiceMocks.getActiveStorefrontById.mockImplementation(async (_db: unknown, id: string) => ({
      ...defaultStorefront,
      id,
      slug: id === "sf_accounts" ? "accounts" : "software",
      isDefault: false,
      homePath: id === "sf_accounts" ? "/s/accounts" : "/s/software",
    }));
    const first = createUnifiedPayApp();
    const second = createUnifiedPayApp();

    await first.app.request("/api/pay/unified", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": STRONG_IDEMPOTENCY_KEY },
      body: JSON.stringify(unifiedPayPayload({ storefrontId: "sf_accounts" })),
    }, {});
    await second.app.request("/api/pay/unified", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": STRONG_IDEMPOTENCY_KEY },
      body: JSON.stringify(unifiedPayPayload({ storefrontId: "sf_software" })),
    }, {});

    expect(first.idempotencyState.requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(second.idempotencyState.requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.idempotencyState.requestHash).not.toBe(second.idempotencyState.requestHash);
  });

  it("revalidates the storefront mapping inside the order transaction", async () => {
    storefrontServiceMocks.validateStorefrontProductMapping.mockResolvedValueOnce(null);
    fulfillmentServiceMocks.lockFulfillmentInventoryItems.mockResolvedValueOnce({ inventoryIds: ["card-1"] });
    const { app, idempotencyState } = createUnifiedPayApp();

    const res = await app.request("/api/pay/unified", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": STRONG_IDEMPOTENCY_KEY },
      body: JSON.stringify(unifiedPayPayload()),
    }, {});

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      details: { code: "PRODUCT_NOT_IN_STOREFRONT" },
    });
    expect(storefrontServiceMocks.validateStorefrontProductMapping).toHaveBeenCalledWith(
      expect.anything(),
      defaultStorefront.id,
      "prod-1",
    );
    expect(fulfillmentServiceMocks.lockFulfillmentInventoryItems).not.toHaveBeenCalled();
    expect(idempotencyState.clearedPending).toBe(true);
  });

  it("rejects an oversized Idempotency-Key header before reserving it", async () => {
    const { app, idempotencyState } = createUnifiedPayApp();

    const res = await app.request("/api/pay/unified", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": "k".repeat(121),
      },
      body: JSON.stringify(unifiedPayPayload()),
    }, {});

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("120"),
    });
    expect(idempotencyState.reservationAttempts).toBe(0);
  });

  it("rejects a low-entropy Idempotency-Key before reserving it", async () => {
    const { app, idempotencyState } = createUnifiedPayApp();

    const res = await app.request("/api/pay/unified", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": "guessable-key",
      },
      body: JSON.stringify(unifiedPayPayload()),
    }, {});

    expect(res.status).toBe(400);
    expect(idempotencyState.reservationAttempts).toBe(0);
  });

  it("keeps an online recovery snapshot pending until the provider lease window closes", async () => {
    const cachedResponse = {
      mode: "online",
      orderId: "cached-order",
      orderToken: "cached-token",
      qrcode: "",
      redirectUrl: "",
      _idempotencyReplayAfter: "2999-01-01T00:00:00.000Z",
    };
    const { app } = createUnifiedPayApp({
      insertedIdempotency: false,
      idempotencyResponseJson: JSON.stringify(cachedResponse),
    });

    const res = await app.request("/api/pay/unified", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": STRONG_IDEMPOTENCY_KEY },
      body: JSON.stringify(unifiedPayPayload()),
    }, {});
    const body = await res.json() as { details?: { code?: string }; orderToken?: string };

    expect(res.status).toBe(409);
    expect(body.details?.code).toBe("IDEMPOTENCY_PENDING");
    expect(body.orderToken).toBeUndefined();
  });

  it("returns an interrupted online recovery snapshot after its lease window closes", async () => {
    const cachedResponse = {
      mode: "online",
      orderId: "cached-order",
      orderToken: "cached-token",
      qrcode: "",
      redirectUrl: "",
      _idempotencyReplayAfter: "2020-01-01T00:00:00.000Z",
    };
    const { app } = createUnifiedPayApp({
      insertedIdempotency: false,
      idempotencyResponseJson: JSON.stringify(cachedResponse),
    });

    const res = await app.request("/api/pay/unified", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": STRONG_IDEMPOTENCY_KEY },
      body: JSON.stringify(unifiedPayPayload()),
    }, {});
    const body = await res.json() as { ok?: boolean; orderToken?: string; _idempotencyReplayAfter?: string };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.orderToken).toBe("cached-token");
    expect(body._idempotencyReplayAfter).toBeUndefined();
  });

  it("requires Idempotency-Key in the header and ignores a body compatibility field", async () => {
    systemConfigMocks.readSystemConfigMap.mockResolvedValueOnce({
      offline_pay_qr_wechat: "",
      offline_pay_qr_alipay: "",
      offline_pay_hint: "请扫码付款",
    });
    const { app, idempotencyState } = createUnifiedPayApp({ insertedIdempotency: true });

    const res = await app.request("/api/pay/unified", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(unifiedPayPayload({ idempotencyKey: STRONG_IDEMPOTENCY_KEY })),
    }, {});

    expect(res.status).toBe(400);
    expect(idempotencyState.reservationAttempts).toBe(0);
    expect(idempotencyState.clearedPending).toBe(false);
    expect(fulfillmentServiceMocks.lockFulfillmentInventoryItems).not.toHaveBeenCalled();
  });

  it("clears pending idempotency reservation when unified payment rejects invalid coupon", async () => {
    couponServiceMocks.quoteCoupon.mockResolvedValueOnce({
      couponCode: "BAD10",
      valid: false,
      discountCents: 0,
      payableCents: 1200,
      message: "折扣码不存在或已停用",
    });
    const { app, idempotencyState } = createUnifiedPayApp({ insertedIdempotency: true });

    const res = await app.request("/api/pay/unified", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": STRONG_IDEMPOTENCY_KEY },
      body: JSON.stringify(unifiedPayPayload({ couponCode: "BAD10" })),
    }, {});

    expect(res.status).toBe(403);
    expect(idempotencyState.clearedPending).toBe(true);
    expect(fulfillmentServiceMocks.lockFulfillmentInventoryItems).not.toHaveBeenCalled();
  });

});

describe("POST /pay/offline/cancel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    issueServiceMocks.releaseLockedCardByOrder.mockResolvedValue(1);
    auditServiceMocks.writeOrderEvent.mockResolvedValue(undefined);
  });

  function createOfflineCancelApp(orderRow: Record<string, unknown>, rowsAffected = 1) {
    const app = new Hono<AppEnv>();
    const tx = {
      select: () => ({ from: () => createSelectChain([orderRow]) }),
      update: () => ({ set: () => ({ where: () => Promise.resolve({ rowsAffected }) }) }),
    } as unknown as DbType;
    const transaction = vi.fn(async (callback: (transaction: DbType) => Promise<unknown>) => callback(tx));
    const db = {
      select: tx.select,
      update: tx.update,
      transaction,
    } as unknown as DbType;

    app.use("*", async (c, next) => {
      c.set("db", db as never);
      await next();
    });
    app.route("/api", payRoute);
    return { app, transaction, tx };
  }

  it("cancels a pending offline order and releases locked stock by order token", async () => {
    const { app, transaction, tx } = createOfflineCancelApp({
      id: "11111111-1111-4111-8111-111111111111",
      status: "pending",
      paymentMethod: "offline",
      paymentRef: "",
    });

    const res = await app.request("/api/pay/offline/cancel", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": STRONG_IDEMPOTENCY_KEY },
      body: JSON.stringify({
        orderId: "11111111-1111-4111-8111-111111111111",
        orderToken: "mock-order-token",
      }),
    }, {});
    const body = await res.json() as { ok: boolean; canceled: boolean; releasedCards: number };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.canceled).toBe(true);
    expect(body.releasedCards).toBe(1);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(issueServiceMocks.releaseLockedCardByOrder).toHaveBeenCalledWith(tx, "11111111-1111-4111-8111-111111111111");
    expect(auditServiceMocks.writeOrderEvent).toHaveBeenCalledWith(
      expect.anything(),
      "11111111-1111-4111-8111-111111111111",
      "canceled",
      expect.stringContaining("用户关闭线下支付"),
      { releasedCards: 1 },
    );
  });

  it("refuses user cancellation after payment reference is submitted", async () => {
    const { app } = createOfflineCancelApp({
      id: "22222222-2222-4222-8222-222222222222",
      status: "pending",
      paymentMethod: "offline",
      paymentRef: "last4:1234",
    });

    const res = await app.request("/api/pay/offline/cancel", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": STRONG_IDEMPOTENCY_KEY },
      body: JSON.stringify({
        orderId: "22222222-2222-4222-8222-222222222222",
        orderToken: "mock-order-token",
      }),
    }, {});

    expect(res.status).toBe(409);
    expect(issueServiceMocks.releaseLockedCardByOrder).not.toHaveBeenCalled();
  });

  it("does not cancel when payment confirmation wins the concurrent update", async () => {
    const { app } = createOfflineCancelApp({
      id: "55555555-5555-4555-8555-555555555555",
      status: "pending",
      paymentMethod: "offline",
      paymentRef: "",
    }, 0);

    const res = await app.request("/api/pay/offline/cancel", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": STRONG_IDEMPOTENCY_KEY },
      body: JSON.stringify({
        orderId: "55555555-5555-4555-8555-555555555555",
        orderToken: "mock-order-token",
      }),
    }, {});

    expect(res.status).toBe(409);
    expect(issueServiceMocks.releaseLockedCardByOrder).not.toHaveBeenCalled();
    expect(auditServiceMocks.writeOrderEvent).not.toHaveBeenCalled();
  });
});

describe("POST /pay/offline/confirm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orderServiceMocks.checkAndExpireOrder.mockResolvedValue({ expired: false, releasedCards: 0 });
  });

  function createOfflineConfirmApp(orderRow: Record<string, unknown>, rowsAffected = 1) {
    const updateSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ rowsAffected }) });
    const app = new Hono<AppEnv>();
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([orderRow]),
          }),
        }),
      }),
      update: vi.fn(() => ({ set: updateSet })),
    } as unknown as DbType;

    app.use("*", async (c, next) => {
      c.set("db", db as never);
      await next();
    });
    app.route("/api", payRoute);
    return { app, updateSet };
  }

  it("saves payment reference for a valid pending offline order", async () => {
    const { app, updateSet } = createOfflineConfirmApp({
      id: "33333333-3333-4333-8333-333333333333",
      orderNo: "POFFLINE001",
      productId: "prod-1",
      buyerEmail: "buyer@example.com",
      status: "pending",
      paymentMethod: "offline",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const res = await app.request("/api/pay/offline/confirm", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": STRONG_IDEMPOTENCY_KEY },
      body: JSON.stringify({
        orderId: "33333333-3333-4333-8333-333333333333",
        orderToken: "mock-order-token",
        payRefLast4: "1234",
      }),
    }, {});

    expect(res.status).toBe(200);
    expect(updateSet).toHaveBeenCalledWith({ paymentRef: "last4:1234" });
    expect(auditServiceMocks.writeOrderEvent).toHaveBeenCalledWith(
      expect.anything(),
      "33333333-3333-4333-8333-333333333333",
      "offline_confirm",
      expect.stringContaining("1234"),
    );
  });

  it("rejects expired offline payment confirmation before saving payment reference", async () => {
    orderServiceMocks.checkAndExpireOrder.mockResolvedValueOnce({ expired: true, releasedCards: 1 });
    const { app, updateSet } = createOfflineConfirmApp({
      id: "44444444-4444-4444-8444-444444444444",
      orderNo: "POFFLINE002",
      productId: "prod-1",
      buyerEmail: "buyer@example.com",
      status: "pending",
      paymentMethod: "offline",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const res = await app.request("/api/pay/offline/confirm", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": STRONG_IDEMPOTENCY_KEY },
      body: JSON.stringify({
        orderId: "44444444-4444-4444-8444-444444444444",
        orderToken: "mock-order-token",
        payRefLast4: "5678",
      }),
    }, {});
    const body = await res.json() as { ok: boolean; error: string };

    expect(res.status).toBe(410);
    expect(body.error).toBe("订单已过期，请重新下单");
    expect(updateSet).not.toHaveBeenCalled();
    expect(auditServiceMocks.writeOrderEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      "44444444-4444-4444-8444-444444444444",
      "offline_confirm",
      expect.any(String),
    );
  });

  it("does not confirm when cancellation wins the concurrent update", async () => {
    const { app } = createOfflineConfirmApp({
      id: "66666666-6666-4666-8666-666666666666",
      orderNo: "POFFLINE-RACE",
      productId: "prod-1",
      buyerEmail: "buyer@example.com",
      status: "pending",
      paymentMethod: "offline",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }, 0);

    const res = await app.request("/api/pay/offline/confirm", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": STRONG_IDEMPOTENCY_KEY },
      body: JSON.stringify({
        orderId: "66666666-6666-4666-8666-666666666666",
        orderToken: "mock-order-token",
        payRefLast4: "9876",
      }),
    }, {});

    expect(res.status).toBe(409);
    expect(auditServiceMocks.writeOrderEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      "66666666-6666-4666-8666-666666666666",
      "offline_confirm",
      expect.any(String),
    );
  });
});

describe("GET /pay/status/:orderId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orderServiceMocks.checkAndExpireOrder.mockResolvedValue({ expired: false, releasedCards: 0 });
  });

  function createStatusApp(
    orderRow: Record<string, unknown>,
    options: {
      itemRows?: Array<Record<string, unknown>>;
      cardRows?: Array<Record<string, unknown>>;
      refreshedOrderRow?: Record<string, unknown>;
      refreshedAfterOrderSelect?: number;
      updateRows?: Array<Record<string, unknown>>;
    } = {},
  ) {
    const app = new Hono<AppEnv>();
    let orderSelectCount = 0;
    const updateSets: unknown[] = [];
    const db = {
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: () => ({
            returning: () => Promise.resolve([{ count: 1 }]),
          }),
        }),
      }),
      select: () => ({
        from: (table?: unknown) => {
          if (table === orders) {
            orderSelectCount++;
            const source = options.refreshedOrderRow && orderSelectCount >= (options.refreshedAfterOrderSelect ?? 3)
              ? options.refreshedOrderRow
              : orderRow;
            return createSelectChain([{ deliveryVisibility: "web_and_email", ...source }]);
          }
          if (table === orderItems) return createSelectChain(options.itemRows || []);
          if (table === cards) {
            return createSelectChain(options.cardRows || [{ id: "card-secret-only", accountLabel: "", deliverySecret: "ONLY-SECRET", deliveryNote: "" }]);
          }
          return createSelectChain([]);
        },
      }),
      update: () => ({
        set: (data: unknown) => {
          updateSets.push(data);
          return {
            where: () => ({
              returning: () => Promise.resolve(options.updateRows || [{ id: "order-updated" }]),
            }),
          };
        },
      }),
      __updateSets: updateSets,
    } as unknown as DbType;

    app.use("*", async (c, next) => {
      c.set("db", db as never);
      await next();
    });
    app.route("/api", payRoute);
    return app;
  }

  it("returns delivery for issued card orders when accountLabel is empty but secret exists", async () => {
    const itemDeliveryJson = JSON.stringify({ deliverySecret: "VISIBLE-VIRTUAL-SECRET" });
    const app = createStatusApp({
      id: "order-secret-only",
      orderNo: "PSECRET001",
      status: "issued",
      issuedCardId: "card-secret-only",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      buyerEmail: "buyer@example.com",
      buyerContact: "",
      productTitle: "Secret Only",
      amountCents: 500,
      currency: "CNY",
      paymentProvider: "",
      paymentRef: "",
      paidAt: new Date().toISOString(),
      issuedAt: new Date().toISOString(),
      ipHash: "ip-hash",
      userAgent: "test-agent",
      accountLabel: "",
      deliverySecret: "ONLY-SECRET",
      deliveryNote: "",
      deliveryJson: "",
    }, {
      itemRows: [{
        id: "item-visible",
        productId: "product-visible",
        productTitle: "Visible Virtual Product",
        fulfillmentMode: "virtual",
        quantity: 1,
        unitPriceCents: 500,
        discountCents: 0,
        amountCents: 500,
        deliveryJson: itemDeliveryJson,
      }],
    });

    const res = await app.request("/api/pay/status/order-secret-only?token=mock-order-token");
    const body = await res.json() as { ok: boolean; delivery?: Record<string, string> };

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store, no-cache, must-revalidate");
    expect(body.ok).toBe(true);
    expect(body.delivery).toMatchObject({
      accountLabel: "",
      deliverySecret: "ONLY-SECRET",
      deliveryNote: "",
    });
    expect((body as { items?: Array<{ deliveryJson?: string }> }).items?.[0]?.deliveryJson).toBe(itemDeliveryJson);
  });

  it("redacts issued cards from pay status for email-only delivery products", async () => {
    const app = createStatusApp({
      id: "order-email-only",
      orderNo: "PEMAILONLY001",
      status: "issued",
      issuedCardId: "card-secret-only",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      buyerEmail: "buyer@example.com",
      buyerContact: "",
      productTitle: "Email Only",
      amountCents: 500,
      currency: "CNY",
      paymentProvider: "",
      paymentRef: "",
      paidAt: new Date().toISOString(),
      issuedAt: new Date().toISOString(),
      accountLabel: "",
      deliverySecret: "ONLY-SECRET",
      deliveryNote: "",
      deliveryJson: "",
      deliveryVisibility: "email_only",
    }, {
      itemRows: [{
        id: "item-email-only",
        productId: "product-email-only",
        productTitle: "Email Only Virtual Product",
        fulfillmentMode: "virtual",
        quantity: 1,
        unitPriceCents: 500,
        discountCents: 0,
        amountCents: 500,
        deliveryJson: JSON.stringify({ deliverySecret: "HIDDEN-VIRTUAL-SECRET" }),
      }],
    });

    const res = await app.request("/api/pay/status/order-email-only?token=mock-order-token");
    const body = await res.json() as {
      ok: boolean;
      deliveryVisibility?: string;
      deliveryMessage?: string;
      delivery?: Record<string, string>;
      cards?: Array<Record<string, string>>;
      items?: Array<Record<string, unknown>>;
    };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.deliveryVisibility).toBe("email_only");
    expect(body.deliveryMessage).toContain("buyer@example.com");
    expect(body.delivery).toBeUndefined();
    expect(body.cards).toBeUndefined();
    expect(body.items?.[0]).not.toHaveProperty("deliveryJson");
    expect(JSON.stringify(body)).not.toContain("HIDDEN-VIRTUAL-SECRET");
  });

  it("does not claim email delivery while an email-only order is still pending", async () => {
    const app = createStatusApp({
      id: "order-email-only-pending",
      orderNo: "PEMAILPENDING001",
      status: "pending",
      fulfillmentMode: "card",
      issuedCardId: "",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      buyerEmail: "buyer@example.com",
      buyerContact: "",
      productTitle: "Email Only Pending",
      amountCents: 500,
      currency: "CNY",
      paymentProvider: "",
      paymentRef: "",
      paidAt: "",
      issuedAt: "",
      deliveryJson: "",
      deliveryVisibility: "email_only",
    });

    const res = await app.request("/api/pay/status/order-email-only-pending?token=mock-order-token");
    const body = await res.json() as {
      ok: boolean;
      status: string;
      fulfillmentMode?: string;
      deliveryVisibility?: string;
      deliveryMessage?: string;
    };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.status).toBe("pending");
    expect(body.fulfillmentMode).toBe("card");
    expect(body.deliveryVisibility).toBe("email_only");
    expect(body.deliveryMessage).toBeUndefined();
  });

  it("retries fulfillment for a paid balance order and returns the refreshed issued state", async () => {
    orderServiceMocks.markPaidAndIssue.mockResolvedValueOnce({
      ok: true,
      card: { id: "card-balance-recovered", accountLabel: "ACC-R", deliverySecret: "SECRET-R", deliveryNote: "recovered" },
      cards: [{ id: "card-balance-recovered", accountLabel: "ACC-R", deliverySecret: "SECRET-R", deliveryNote: "recovered" }],
    });
    const baseOrder = {
      id: "order-balance-recovery",
      orderNo: "PBALANCERECOVERY001",
      productId: "product-balance-recovery",
      status: "paid",
      fulfillmentMode: "card",
      issuedCardId: "",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      buyerEmail: "buyer@example.com",
      buyerContact: "",
      productTitle: "Balance Recovery Product",
      amountCents: 1200,
      currency: "CNY",
      paymentProvider: "balance",
      paymentRef: "",
      paidAt: new Date().toISOString(),
      issuedAt: "",
      deliveryJson: "",
    };
    const app = createStatusApp(baseOrder, {
      refreshedOrderRow: {
        ...baseOrder,
        status: "issued",
        issuedCardId: "card-balance-recovered",
        issuedAt: new Date().toISOString(),
      },
      cardRows: [{ id: "card-balance-recovered", accountLabel: "ACC-R", deliverySecret: "SECRET-R", deliveryNote: "recovered" }],
    });

    const res = await app.request("/api/pay/status/order-balance-recovery?token=mock-order-token");
    const body = await res.json() as { ok: boolean; status: string; delivery?: Record<string, string> };

    expect(res.status).toBe(200);
    expect(body.status).toBe("issued");
    expect(body.delivery).toMatchObject({ accountLabel: "ACC-R", deliverySecret: "SECRET-R" });
    expect(orderServiceMocks.markPaidAndIssue).toHaveBeenCalledWith(
      expect.anything(),
      "order-balance-recovery",
      expect.anything(),
      undefined,
    );
  });

  it("retries fulfillment for a paid zero-amount order without invoking an external provider", async () => {
    orderServiceMocks.markPaidAndIssue.mockResolvedValueOnce({
      ok: true,
      card: { id: "card-free-recovered", accountLabel: "FREE-ACC", deliverySecret: "FREE-SECRET", deliveryNote: "" },
      cards: [{ id: "card-free-recovered", accountLabel: "FREE-ACC", deliverySecret: "FREE-SECRET", deliveryNote: "" }],
    });
    const baseOrder = {
      id: "order-free-recovery",
      orderNo: "PFREERECOVERY001",
      productId: "product-free-recovery",
      status: "paid",
      fulfillmentMode: "card",
      issuedCardId: "",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      buyerEmail: "buyer@example.com",
      buyerContact: "",
      productTitle: "Free Recovery Product",
      amountCents: 0,
      currency: "CNY",
      paymentProvider: "free",
      paymentRef: "",
      paidAt: new Date().toISOString(),
      issuedAt: "",
      deliveryJson: "",
    };
    const app = createStatusApp(baseOrder, {
      refreshedOrderRow: {
        ...baseOrder,
        status: "issued",
        issuedCardId: "card-free-recovered",
        issuedAt: new Date().toISOString(),
      },
      cardRows: [{ id: "card-free-recovered", accountLabel: "FREE-ACC", deliverySecret: "FREE-SECRET", deliveryNote: "" }],
    });

    const res = await app.request("/api/pay/status/order-free-recovery?token=mock-order-token");
    const body = await res.json() as { ok: boolean; status: string; delivery?: Record<string, string> };

    expect(res.status).toBe(200);
    expect(body.status).toBe("issued");
    expect(body.delivery).toMatchObject({ accountLabel: "FREE-ACC", deliverySecret: "FREE-SECRET" });
    expect(orderServiceMocks.markPaidAndIssue).toHaveBeenCalledWith(
      expect.anything(),
      "order-free-recovery",
      expect.anything(),
      undefined,
    );
    expect(paymentProviderMocks.createPayment).not.toHaveBeenCalled();
  });

  it("actively reconciles a pending online order from provider status before expiring it", async () => {
    const orderCreatedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const providerPaidAt = new Date(Date.now() - 2 * 60_000).toISOString();
    paymentProviderMocks.queryStatus.mockResolvedValueOnce({
      paid: true,
      providerTradeNo: "EP-STATUS-001",
      paidAt: providerPaidAt,
      amountCents: 1200,
      currency: "CNY",
    });
    orderServiceMocks.markPaidAndIssue.mockResolvedValueOnce({
      ok: true,
      card: { id: "card-online-recovered", accountLabel: "ONLINE-ACC", deliverySecret: "ONLINE-SECRET", deliveryNote: "" },
      cards: [{ id: "card-online-recovered", accountLabel: "ONLINE-ACC", deliverySecret: "ONLINE-SECRET", deliveryNote: "" }],
    });

    const baseOrder = {
      id: "order-online-reconcile",
      orderNo: "PONLINESTATUS001",
      productId: "product-online-reconcile",
      status: "pending",
      fulfillmentMode: "card",
      issuedCardId: "",
      expiresAt: new Date(Date.now() + 25 * 60_000).toISOString(),
      buyerEmail: "buyer@example.com",
      buyerContact: "",
      productTitle: "Online Reconcile Product",
      amountCents: 1200,
      currency: "CNY",
      paymentProvider: "easypay",
      paymentRef: "",
      createdAt: orderCreatedAt,
      paidAt: "",
      issuedAt: "",
      deliveryJson: "",
    };
    const app = createStatusApp(baseOrder, {
      refreshedAfterOrderSelect: 2,
      refreshedOrderRow: {
        ...baseOrder,
        status: "issued",
        issuedCardId: "card-online-recovered",
        paymentRef: "EP-STATUS-001",
        paidAt: providerPaidAt,
        issuedAt: new Date().toISOString(),
      },
      cardRows: [{ id: "card-online-recovered", accountLabel: "ONLINE-ACC", deliverySecret: "ONLINE-SECRET", deliveryNote: "" }],
    });

    const res = await app.request(
      "/api/pay/status/order-online-reconcile?token=mock-order-token",
      {},
      { CREDENTIALS_ENCRYPTION_KEY: "a".repeat(64) },
    );
    const body = await res.json() as { ok: boolean; status: string; delivery?: Record<string, string> };

    expect(res.status).toBe(200);
    expect(body.status).toBe("issued");
    expect(body.delivery).toMatchObject({ accountLabel: "ONLINE-ACC", deliverySecret: "ONLINE-SECRET" });
    expect(paymentProviderMocks.queryStatus).toHaveBeenCalledWith("PONLINESTATUS001");
    expect(orderServiceMocks.markPaidAndIssue).toHaveBeenCalledWith(
      expect.anything(),
      "order-online-reconcile",
      expect.anything(),
      undefined,
    );
    expect(orderServiceMocks.checkAndExpireOrder).toHaveBeenCalledWith(
      expect.anything(),
      "order-online-reconcile",
      expect.any(String),
      "issued",
      expect.anything(),
      expect.anything(),
      undefined,
    );
  });

});

describe("ALL /pay/callback/:provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    paymentProviderMocks.verifyCallback.mockReset();
    paymentProviderMocks.queryStatus.mockReset();
    orderServiceMocks.markPaidAndIssue.mockReset();
    orderServiceMocks.checkAndExpireOrder.mockReset();
    auditServiceMocks.writeOrderEvent.mockResolvedValue(undefined);
    orderServiceMocks.checkAndExpireOrder.mockResolvedValue({ expired: false, releasedCards: 0 });
  });

  function createCallbackApp(
    orderRow: Record<string, unknown>,
    updateRows: Array<Record<string, unknown>> = [{ id: "order-updated" }],
    concurrentOrderRow?: Record<string, unknown>,
    subsequentUpdateRows?: Array<Record<string, unknown>>,
  ) {
    const app = new Hono<AppEnv>();
    const executionCtx = { waitUntil: vi.fn() } as unknown as ExecutionContext<unknown>;
    const updateSets: unknown[] = [];
    let updateCall = 0;
    const updateMock = vi.fn(() => ({
      set: (data: unknown) => {
        updateSets.push(data);
        return {
        where: () => ({
          returning: () => {
            const rows = updateCall++ === 0 || !subsequentUpdateRows
              ? updateRows
              : subsequentUpdateRows;
            return Promise.resolve(rows);
          },
        }),
      };
      },
    }));
    const effectiveOrderRow = {
      paymentProvider: "easypay",
      currency: "CNY",
      createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      ...orderRow,
    };
    let selectCall = 0;
    const db = {
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: () => ({
            returning: () => Promise.resolve([{ count: 1 }]),
          }),
        }),
      }),
      select: () => {
        selectCall += 1;
        const selectedOrder = selectCall === 1 || !concurrentOrderRow
          ? effectiveOrderRow
          : { ...effectiveOrderRow, ...concurrentOrderRow };
        return {
          from: () => ({
            where: () => ({
              limit: () => Promise.resolve([selectedOrder]),
            }),
          }),
        };
      },
      update: updateMock,
      __updateMock: updateMock,
      __updateSets: updateSets,
    } as unknown as DbType & { __updateMock: ReturnType<typeof vi.fn>; __updateSets: unknown[] };

    app.use("*", async (c, next) => {
      c.set("db", db as never);
      c.set("executionCtx", executionCtx);
      await next();
    });
    app.route("/api", payRoute);
    return { app, db, executionCtx };
  }

  function mockVerifiedCallback(result: Record<string, unknown>) {
    paymentProviderMocks.verifyCallback.mockResolvedValueOnce({ currency: "CNY", ...result });
  }

  it("rejects callbacks for canceled orders and does not try fulfillment", async () => {
    mockVerifiedCallback({
      orderNo: "PCANCELED001",
      amountCents: 1200,
      providerTradeNo: "trade-canceled-1",
      paidAt: new Date().toISOString(),
    });
    const { app } = createCallbackApp({
      id: "order-canceled",
      status: "canceled",
      productId: "prod-1",
      buyerEmail: "buyer@example.com",
      amountCents: 1200,
    });

    const res = await app.request(
      "/api/pay/callback/easypay?out_trade_no=PCANCELED001&trade_status=TRADE_SUCCESS",
      {},
      { CREDENTIALS_ENCRYPTION_KEY: "test-key" },
    );
    const text = await res.text();

    expect(res.status).toBe(400);
    expect(text).toBe("fail");
    expect(orderServiceMocks.markPaidAndIssue).not.toHaveBeenCalled();
    expect(auditServiceMocks.writeOrderEvent).toHaveBeenCalledWith(
      expect.anything(),
      "order-canceled",
      "callback_rejected",
      "订单已取消，拒绝回调",
      { status: "canceled" },
    );
  });

  it("rejects callbacks for expired orders and does not try fulfillment", async () => {
    const expiresAt = new Date(Date.now() - 60_000).toISOString();
    const paidAt = new Date().toISOString();
    mockVerifiedCallback({
      orderNo: "PEXPIRED001",
      amountCents: 1200,
      providerTradeNo: "trade-expired-1",
      paidAt,
    });
    paymentProviderMocks.queryStatus.mockResolvedValueOnce({
      paid: true,
      providerTradeNo: "trade-expired-1",
      providerCreatedAt: "2026-07-15 10:00:00",
      paidAt: "2026-07-15 10:05:00",
    });
    const { app } = createCallbackApp({
      id: "order-expired",
      status: "expired",
      productId: "prod-1",
      buyerEmail: "buyer@example.com",
      amountCents: 1200,
      expiresAt,
    });

    const res = await app.request(
      "/api/pay/callback/easypay?out_trade_no=PEXPIRED001&trade_status=TRADE_SUCCESS",
      {},
      { CREDENTIALS_ENCRYPTION_KEY: "test-key" },
    );

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("fail");
    expect(orderServiceMocks.markPaidAndIssue).not.toHaveBeenCalled();
    expect(auditServiceMocks.writeOrderEvent).toHaveBeenCalledWith(
      expect.anything(),
      "order-expired",
      "callback_rejected",
      "订单已过期且付款时间不在有效期内",
      {
        status: "expired",
        provider: "easypay",
        trade_no: "trade-expired-1",
      },
    );
  });

  it("rejects callback amount mismatch before updating payment state", async () => {
    mockVerifiedCallback({
      orderNo: "PMISMATCH001",
      amountCents: 1,
      providerTradeNo: "trade-mismatch-1",
      paidAt: new Date().toISOString(),
    });
    const { app, db } = createCallbackApp({
      id: "order-mismatch",
      status: "pending",
      productId: "prod-1",
      buyerEmail: "buyer@example.com",
      amountCents: 1200,
    });

    const res = await app.request(
      "/api/pay/callback/easypay?out_trade_no=PMISMATCH001&trade_status=TRADE_SUCCESS",
      {},
      { CREDENTIALS_ENCRYPTION_KEY: "test-key" },
    );

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("fail");
    expect(db.__updateMock).not.toHaveBeenCalled();
    expect(orderServiceMocks.markPaidAndIssue).not.toHaveBeenCalled();
    expect(auditServiceMocks.writeOrderEvent).toHaveBeenCalledWith(
      expect.anything(),
      "order-mismatch",
      "callback_amount_mismatch",
      "回调金额与订单金额不一致",
      { expected: 1200, received: 1 },
    );
  });

  it("rejects callback currency mismatch before updating payment state", async () => {
    mockVerifiedCallback({
      orderNo: "PCURRENCYMISMATCH001",
      amountCents: 1200,
      currency: "USD",
      providerTradeNo: "trade-currency-mismatch-1",
      paidAt: new Date().toISOString(),
    });
    const { app, db } = createCallbackApp({
      id: "order-currency-mismatch",
      status: "pending",
      productId: "prod-1",
      buyerEmail: "buyer@example.com",
      amountCents: 1200,
      currency: "CNY",
    });

    const res = await app.request(
      "/api/pay/callback/easypay?out_trade_no=PCURRENCYMISMATCH001&trade_status=TRADE_SUCCESS",
      {},
      { CREDENTIALS_ENCRYPTION_KEY: "test-key" },
    );

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("fail");
    expect(db.__updateMock).not.toHaveBeenCalled();
    expect(orderServiceMocks.markPaidAndIssue).not.toHaveBeenCalled();
    expect(auditServiceMocks.writeOrderEvent).toHaveBeenCalledWith(
      expect.anything(),
      "order-currency-mismatch",
      "callback_currency_mismatch",
      "回调币种与订单币种不一致",
      { expected: "CNY", received: "USD" },
    );
  });

  it("rejects callback missing currency before updating payment state", async () => {
    mockVerifiedCallback({
      orderNo: "PCURRENCYMISSING001",
      amountCents: 1200,
      currency: undefined,
      providerTradeNo: "trade-currency-missing-1",
      paidAt: new Date().toISOString(),
    });
    const { app, db } = createCallbackApp({
      id: "order-currency-missing",
      status: "pending",
      productId: "prod-1",
      buyerEmail: "buyer@example.com",
      amountCents: 1200,
      currency: "CNY",
    });

    const res = await app.request(
      "/api/pay/callback/easypay?out_trade_no=PCURRENCYMISSING001&trade_status=TRADE_SUCCESS",
      {},
      { CREDENTIALS_ENCRYPTION_KEY: "test-key" },
    );

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("fail");
    expect(db.__updateMock).not.toHaveBeenCalled();
    expect(orderServiceMocks.markPaidAndIssue).not.toHaveBeenCalled();
    expect(auditServiceMocks.writeOrderEvent).toHaveBeenCalledWith(
      expect.anything(),
      "order-currency-missing",
      "callback_currency_mismatch",
      "回调币种与订单币种不一致",
      { expected: "CNY", received: "" },
    );
  });

  it("rejects a callback when the provider does not match the order", async () => {
    mockVerifiedCallback({
      orderNo: "PPROVIDER001",
      amountCents: 1200,
      providerTradeNo: "trade-provider-1",
      paidAt: new Date().toISOString(),
    });
    const { app, db } = createCallbackApp({
      id: "order-provider-mismatch",
      status: "pending",
      productId: "prod-1",
      buyerEmail: "buyer@example.com",
      amountCents: 1200,
      paymentProvider: "stripe",
    });

    const res = await app.request(
      "/api/pay/callback/easypay?out_trade_no=PPROVIDER001&trade_status=TRADE_SUCCESS",
      {},
      { CREDENTIALS_ENCRYPTION_KEY: "test-key" },
    );

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("fail");
    expect(db.__updateMock).not.toHaveBeenCalled();
    expect(auditServiceMocks.writeOrderEvent).toHaveBeenCalledWith(
      expect.anything(),
      "order-provider-mismatch",
      "callback_rejected",
      "回调渠道与订单支付渠道不一致",
      { expected: "stripe", received: "easypay" },
    );
  });

  it("backfills an issued order payment reference before acknowledging the callback", async () => {
    mockVerifiedCallback({
      orderNo: "PISSUEDLEGACY001",
      amountCents: 1200,
      providerTradeNo: "trade-issued-legacy-1",
      paidAt: new Date().toISOString(),
    });
    const { app, db } = createCallbackApp({
      id: "order-issued-legacy",
      status: "issued",
      productId: "prod-1",
      buyerEmail: "buyer@example.com",
      amountCents: 1200,
      paymentRef: "",
    });

    const res = await app.request(
      "/api/pay/callback/easypay?out_trade_no=PISSUEDLEGACY001&trade_status=TRADE_SUCCESS",
      {},
      { CREDENTIALS_ENCRYPTION_KEY: "test-key" },
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("success");
    expect(db.__updateSets).toContainEqual(expect.objectContaining({
      paymentProvider: "easypay",
      paymentRef: "trade-issued-legacy-1",
    }));
    expect(orderServiceMocks.markPaidAndIssue).not.toHaveBeenCalled();
  });

  it("expires a stale pending order before accepting a callback", async () => {
    mockVerifiedCallback({
      orderNo: "PSTALE001",
      amountCents: 1200,
      providerTradeNo: "trade-stale-1",
      paidAt: new Date().toISOString(),
    });
    paymentProviderMocks.queryStatus.mockResolvedValueOnce({
      paid: true,
      providerTradeNo: "trade-stale-1",
      providerCreatedAt: "2026-07-15 10:00:00",
      paidAt: "2026-07-15 10:05:00",
    });
    orderServiceMocks.checkAndExpireOrder.mockResolvedValueOnce({ expired: true, releasedCards: 1 });
    const { app, db } = createCallbackApp({
      id: "order-stale",
      status: "pending",
      productId: "prod-1",
      buyerEmail: "buyer@example.com",
      amountCents: 1200,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const res = await app.request(
      "/api/pay/callback/easypay?out_trade_no=PSTALE001&trade_status=TRADE_SUCCESS",
      {},
      { CREDENTIALS_ENCRYPTION_KEY: "test-key" },
    );

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("fail");
    expect(db.__updateMock).not.toHaveBeenCalled();
    expect(orderServiceMocks.checkAndExpireOrder).toHaveBeenCalledWith(
      expect.anything(),
      "order-stale",
      expect.any(String),
      "pending",
    );
  });

  it("records an EasyPay callback when the gateway omits authoritative payment time", async () => {
    mockVerifiedCallback({
      orderNo: "PUNKNOWNPAIDAT001",
      amountCents: 1200,
      providerTradeNo: "trade-unknown-paid-at-1",
      paidAt: new Date().toISOString(),
      raw: { trade_status: "TRADE_SUCCESS" },
    });
    paymentProviderMocks.queryStatus.mockResolvedValueOnce({
      paid: true,
      providerTradeNo: "trade-unknown-paid-at-1",
      providerCreatedAt: "2026-07-15 10:00:00",
      paidAt: "2026-07-15 10:03:00",
    });
    orderServiceMocks.markPaidAndIssue.mockResolvedValueOnce({
      ok: true,
      card: { id: "card-1" },
      cards: [{ id: "card-1" }],
    });
    const { app, db } = createCallbackApp({
      id: "order-unknown-paid-at",
      status: "pending",
      productId: "prod-1",
      buyerEmail: "buyer@example.com",
      amountCents: 1200,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const res = await app.request(
      "/api/pay/callback/easypay?out_trade_no=PUNKNOWNPAIDAT001&trade_status=TRADE_SUCCESS",
      {},
      { CREDENTIALS_ENCRYPTION_KEY: "test-key" },
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("success");
    expect(orderServiceMocks.checkAndExpireOrder).not.toHaveBeenCalled();
    expect(db.__updateSets).toContainEqual(expect.objectContaining({
      status: "paid",
      paymentRef: "trade-unknown-paid-at-1",
    }));
  });

  it("accepts a delayed callback when provider paidAt proves payment happened before expiry", async () => {
    const paidAt = new Date(Date.now() - 120_000).toISOString();
    const expiresAt = new Date(Date.now() - 60_000).toISOString();
    mockVerifiedCallback({
      orderNo: "PPAIDBEFOREEXPIRY001",
      amountCents: 1200,
      providerTradeNo: "trade-before-expiry-1",
      paidAt,
    });
    orderServiceMocks.markPaidAndIssue.mockResolvedValueOnce({ ok: true, card: { id: "card-1" }, cards: [{ id: "card-1" }] });
    const { app, db } = createCallbackApp({
      id: "order-paid-before-expiry",
      status: "pending",
      productId: "prod-1",
      buyerEmail: "buyer@example.com",
      amountCents: 1200,
      expiresAt,
    });

    const res = await app.request(
      "/api/pay/callback/easypay?out_trade_no=PPAIDBEFOREEXPIRY001&trade_status=TRADE_SUCCESS",
      {},
      { CREDENTIALS_ENCRYPTION_KEY: "test-key" },
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("success");
    expect(orderServiceMocks.checkAndExpireOrder).not.toHaveBeenCalled();
    expect(db.__updateSets).toContainEqual(expect.objectContaining({
      status: "paid",
      paymentProvider: "easypay",
      paymentRef: "trade-before-expiry-1",
      paidAt,
    }));
  });

  it("recovers a verified pre-expiry payment when expiration wins the first update race", async () => {
    const paidAt = new Date(Date.now() - 120_000).toISOString();
    mockVerifiedCallback({
      orderNo: "PEXPIRERACE001",
      amountCents: 1200,
      currency: "CNY",
      providerTradeNo: "trade-expire-race-1",
      paidAt,
    });
    couponServiceMocks.restoreCouponReservation.mockResolvedValueOnce({ success: true, changes: 1 });
    orderServiceMocks.markPaidAndIssue.mockResolvedValueOnce({ ok: true, card: { id: "card-1" } });
    const { app, db } = createCallbackApp({
      id: "order-expire-race",
      status: "pending",
      productId: "prod-1",
      buyerEmail: "buyer@example.com",
      amountCents: 1200,
    }, [], {
      status: "expired",
      paymentRef: "",
    }, [{ id: "order-expire-race", couponCode: "SAVE10" }]);

    const res = await app.request(
      "/api/pay/callback/easypay?out_trade_no=PEXPIRERACE001&trade_status=TRADE_SUCCESS",
      {},
      { CREDENTIALS_ENCRYPTION_KEY: "test-key" },
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("success");
    expect(couponServiceMocks.restoreCouponReservation).toHaveBeenCalledWith(db, "SAVE10");
    expect(orderServiceMocks.markPaidAndIssue).toHaveBeenCalledWith(
      db,
      "order-expire-race",
      expect.anything(),
      expect.anything(),
    );
    expect(db.__updateSets).toContainEqual(expect.objectContaining({
      status: "paid",
      paymentProvider: "easypay",
      paymentRef: "trade-expire-race-1",
      paidAt,
    }));
  });

  it("continues fulfillment when another callback already recorded the same payment", async () => {
    const paidAt = new Date().toISOString();
    mockVerifiedCallback({
      orderNo: "PPAIDRACE001",
      amountCents: 1200,
      currency: "CNY",
      providerTradeNo: "trade-paid-race-1",
      paidAt,
    });
    orderServiceMocks.markPaidAndIssue.mockResolvedValueOnce({ ok: true, card: { id: "card-1" } });
    const { app, executionCtx } = createCallbackApp({
      id: "order-paid-race",
      status: "pending",
      productId: "prod-1",
      buyerEmail: "buyer@example.com",
      amountCents: 1200,
    }, [], {
      status: "paid",
      paymentProvider: "easypay",
      paymentRef: "trade-paid-race-1",
    });

    const res = await app.request(
      "/api/pay/callback/easypay?out_trade_no=PPAIDRACE001&trade_status=TRADE_SUCCESS",
      {},
      { CREDENTIALS_ENCRYPTION_KEY: "test-key" },
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("success");
    expect(orderServiceMocks.markPaidAndIssue).toHaveBeenCalledWith(
      expect.anything(),
      "order-paid-race",
      expect.anything(),
      executionCtx,
    );
  });

  it("queries EasyPay order timing before expiring a delayed successful callback", async () => {
    const orderCreatedAt = new Date(Date.now() - 31 * 60_000).toISOString();
    const expiresAt = new Date(Date.parse(orderCreatedAt) + 30 * 60_000).toISOString();
    const inferredPaidAt = new Date(Date.parse(orderCreatedAt) + 29 * 60_000).toISOString();
    mockVerifiedCallback({
      orderNo: "PEPAYDELAYED001",
      amountCents: 1200,
      currency: "CNY",
      providerTradeNo: "trade-epay-delayed-1",
      paidAt: new Date().toISOString(),
    });
    paymentProviderMocks.queryStatus.mockResolvedValueOnce({
      paid: true,
      providerTradeNo: "trade-epay-delayed-1",
      providerCreatedAt: "2026-07-15 10:00:00",
      paidAt: "2026-07-15 10:29:00",
    });
    orderServiceMocks.markPaidAndIssue.mockResolvedValueOnce({ ok: true, card: { id: "card-1" }, cards: [{ id: "card-1" }] });
    const { app, db } = createCallbackApp({
      id: "order-epay-delayed",
      status: "pending",
      productId: "prod-1",
      buyerEmail: "buyer@example.com",
      amountCents: 1200,
      paymentProvider: "easypay",
      createdAt: orderCreatedAt,
      expiresAt,
    });

    const res = await app.request(
      "/api/pay/callback/easypay?out_trade_no=PEPAYDELAYED001&trade_status=TRADE_SUCCESS",
      {},
      { CREDENTIALS_ENCRYPTION_KEY: "test-key" },
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("success");
    expect(paymentProviderMocks.queryStatus).toHaveBeenCalledWith("PEPAYDELAYED001");
    expect(orderServiceMocks.checkAndExpireOrder).not.toHaveBeenCalled();
    expect(db.__updateSets).toContainEqual(expect.objectContaining({
      status: "paid",
      paymentProvider: "easypay",
      paymentRef: "trade-epay-delayed-1",
      paidAt: inferredPaidAt,
    }));
  });

  it("expires a delayed EasyPay order when the query proves payment happened after expiry", async () => {
    const orderCreatedAt = new Date(Date.now() - 31 * 60_000).toISOString();
    const expiresAt = new Date(Date.parse(orderCreatedAt) + 30 * 60_000).toISOString();
    mockVerifiedCallback({
      orderNo: "PEPAYAFTEREXPIRY001",
      amountCents: 1200,
      currency: "CNY",
      providerTradeNo: "trade-epay-after-expiry-1",
      paidAt: new Date().toISOString(),
    });
    paymentProviderMocks.queryStatus.mockResolvedValueOnce({
      paid: true,
      providerTradeNo: "trade-epay-after-expiry-1",
      providerCreatedAt: "2026-07-15 10:00:00",
      paidAt: "2026-07-15 10:31:00",
    });
    orderServiceMocks.checkAndExpireOrder.mockResolvedValueOnce({ expired: true, releasedCards: 1 });
    const { app, db } = createCallbackApp({
      id: "order-epay-after-expiry",
      status: "pending",
      productId: "prod-1",
      buyerEmail: "buyer@example.com",
      amountCents: 1200,
      paymentProvider: "easypay",
      createdAt: orderCreatedAt,
      expiresAt,
    });

    const res = await app.request(
      "/api/pay/callback/easypay?out_trade_no=PEPAYAFTEREXPIRY001&trade_status=TRADE_SUCCESS",
      {},
      { CREDENTIALS_ENCRYPTION_KEY: "test-key" },
    );

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("fail");
    expect(orderServiceMocks.checkAndExpireOrder).toHaveBeenCalledWith(
      expect.anything(),
      "order-epay-after-expiry",
      expiresAt,
      "pending",
    );
    expect(db.__updateMock).not.toHaveBeenCalled();
  });

  it("keeps a delayed EasyPay order pending when payment timing cannot be verified", async () => {
    mockVerifiedCallback({
      orderNo: "PEPAYTIMINGUNKNOWN001",
      amountCents: 1200,
      currency: "CNY",
      providerTradeNo: "trade-epay-timing-unknown-1",
      paidAt: new Date().toISOString(),
    });
    paymentProviderMocks.queryStatus.mockResolvedValueOnce({
      paid: true,
      providerTradeNo: "trade-epay-timing-unknown-1",
    });
    const { app, db } = createCallbackApp({
      id: "order-epay-timing-unknown",
      status: "pending",
      productId: "prod-1",
      buyerEmail: "buyer@example.com",
      amountCents: 1200,
      paymentProvider: "easypay",
      createdAt: new Date(Date.now() - 31 * 60_000).toISOString(),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const res = await app.request(
      "/api/pay/callback/easypay?out_trade_no=PEPAYTIMINGUNKNOWN001&trade_status=TRADE_SUCCESS",
      {},
      { CREDENTIALS_ENCRYPTION_KEY: "test-key" },
    );

    expect(res.status).toBe(503);
    expect(await res.text()).toBe("fail");
    expect(orderServiceMocks.checkAndExpireOrder).not.toHaveBeenCalled();
    expect(db.__updateMock).not.toHaveBeenCalled();
  });

  it("rejects orders whose payment provider snapshot is empty", async () => {
    mockVerifiedCallback({
      orderNo: "PLEGACYPROVIDER001",
      amountCents: 1200,
      providerTradeNo: "trade-legacy-provider-1",
      paidAt: new Date().toISOString(),
    });
    orderServiceMocks.markPaidAndIssue.mockResolvedValueOnce({ ok: true, card: { id: "card-1" }, cards: [{ id: "card-1" }] });
    const { app, db } = createCallbackApp({
      id: "order-legacy-provider",
      status: "pending",
      productId: "prod-1",
      buyerEmail: "buyer@example.com",
      amountCents: 1200,
      paymentProvider: "",
    });

    const res = await app.request(
      "/api/pay/callback/easypay?out_trade_no=PLEGACYPROVIDER001&trade_status=TRADE_SUCCESS",
      {},
      { CREDENTIALS_ENCRYPTION_KEY: "test-key" },
    );

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("fail");
    expect(db.__updateMock).not.toHaveBeenCalled();
    expect(auditServiceMocks.writeOrderEvent).toHaveBeenCalledWith(
      expect.anything(),
      "order-legacy-provider",
      "callback_rejected",
      "回调渠道与订单支付渠道不一致",
      { expected: "", received: "easypay" },
    );
  });

  it("continues fulfillment retry for paid callback when payment state update succeeds", async () => {
    mockVerifiedCallback({
      orderNo: "PPAID001",
      amountCents: 1200,
      providerTradeNo: "trade-paid-1",
      paidAt: new Date().toISOString(),
    });
    orderServiceMocks.markPaidAndIssue.mockResolvedValueOnce({ ok: true, card: { id: "card-1" }, cards: [{ id: "card-1" }] });
    const { app, executionCtx } = createCallbackApp({
      id: "order-paid",
      status: "paid",
      productId: "prod-1",
      buyerEmail: "buyer@example.com",
      amountCents: 1200,
    });

    const res = await app.request(
      "/api/pay/callback/easypay?out_trade_no=PPAID001&trade_status=TRADE_SUCCESS",
      {},
      { CREDENTIALS_ENCRYPTION_KEY: "test-key" },
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("success");
    expect(orderServiceMocks.markPaidAndIssue).toHaveBeenCalledWith(expect.anything(), "order-paid", expect.anything(), executionCtx);
  });

  it("persists paid status before fulfillment and returns retryable failure when issuing fails", async () => {
    mockVerifiedCallback({
      orderNo: "PISSUEFAIL001",
      amountCents: 1200,
      providerTradeNo: "trade-issue-fail-1",
      paidAt: new Date().toISOString(),
    });
    orderServiceMocks.markPaidAndIssue.mockResolvedValueOnce({ ok: false, status: 409, message: "当前商品库存不足" });
    const { app, db } = createCallbackApp({
      id: "order-issue-fail",
      status: "pending",
      productId: "prod-1",
      buyerEmail: "buyer@example.com",
      amountCents: 1200,
    });

    const res = await app.request(
      "/api/pay/callback/easypay?out_trade_no=PISSUEFAIL001&trade_status=TRADE_SUCCESS",
      {},
      { CREDENTIALS_ENCRYPTION_KEY: "test-key" },
    );

    expect(res.status).toBe(409);
    expect(await res.text()).toBe("fail");
    expect(db.__updateSets).toContainEqual(expect.objectContaining({ status: "paid", paymentRef: "trade-issue-fail-1" }));
    expect(auditServiceMocks.writeOrderEvent).toHaveBeenCalledWith(
      expect.anything(),
      "order-issue-fail",
      "callback_issue_failed",
      "当前商品库存不足",
      { provider: "easypay", trade_no: "trade-issue-fail-1" },
    );
  });
});
