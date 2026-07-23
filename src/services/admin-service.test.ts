import { describe, it, expect, vi } from "vitest";
import type { DbType } from "../db/client";
import { orders, orderItems, orderEvents, products, cards, coupons, cardBatches, campaigns, referralCodes, emailLogs, adminAuditLogs, systemConfig, requestLogs } from "../db/schema";
import { eq, and, or, like, desc, count, inArray, sql } from "drizzle-orm";

// 在导入 admin-service 前 mock releaseLockedCardByOrder
const mockReleaseLockedCardByOrder = vi.fn();
vi.mock("./issue-service", () => ({
  releaseLockedCardByOrder: (...args: unknown[]) => mockReleaseLockedCardByOrder(...args),
}));

const mockReleaseCouponReservation = vi.fn();
vi.mock("./coupon-service", () => ({
  releaseCouponReservation: (...args: unknown[]) => mockReleaseCouponReservation(...args),
}));

// 在导入 admin-service 前 mock readSystemConfigMap
const mockReadSystemConfigMap = vi.fn().mockResolvedValue({});
vi.mock("../lib/system-config-registry", () => ({
  readSystemConfigMap: (...args: unknown[]) => mockReadSystemConfigMap(...args),
  isSensitiveSystemConfigKey: (key: string) => ["resend_api_key", "turnstile_secret_key"].includes(key),
  SYSTEM_CONFIG_KEYS: ["site_name", "contact_email", "alipay_app_id", "wechat_app_id"],
  buildSystemConfigMap: (rows: { key: string; value: string }[]) => {
    const map: Record<string, string> = {};
    for (const row of rows) {
      map[row.key] = row.value;
    }
    return map;
  },
}));

// ── ORM 模拟（只模拟测试需要的查询链） ──────────────────────────────

function createSelectChain<T>(results: T[]) {
  const chain: any = {};
  const methods = ["where", "innerJoin", "leftJoin", "orderBy", "limit", "offset", "groupBy", "having"];
  for (const method of methods) {
    chain[method] = () => chain;
  }
  const promise = Promise.resolve(results);
  chain.then = (onFulfilled: (v: T[]) => void, onRejected?: (e: unknown) => void) => promise.then(onFulfilled, onRejected);
  return chain;
}

function createMockDb(selectResults: Record<string, unknown[]> = {}): DbType {
  return {
    select: (_colMap?: unknown) => ({
      from: (_table?: unknown) => {
        const table = _table;
        let key = "default";
        if (table === orders) key = "orders";
        else if (table === orderItems) key = "orderItems";
        else if (table === products) key = "products";
        else if (table === cards) key = "cards";
        return createSelectChain(selectResults[key] || []);
      },
    }),
    insert: () => ({
      values: () => {
        const p = Promise.resolve({ rowsAffected: 1 });
        const result: any = { onConflictDoUpdate: () => p, onConflictDoNothing: () => p };
        result.then = p.then.bind(p);
        result.catch = p.catch.bind(p);
        result.finally = p.finally.bind(p);
        return result;
      },
    }),
    update: () => ({
      set: () => {
        const whereChain: any = {
          returning: () => ({ then: (resolve: (v: unknown) => void) => Promise.resolve([{ id: "any" }]).then(resolve) }),
          then: (resolve: (v: unknown) => void) => Promise.resolve({ rowsAffected: 1 }).then(resolve),
        };
        return { where: () => whereChain };
      },
    }),
    delete: () => ({
      where: () => Promise.resolve({ rowsAffected: 0 }),
    }),
    run: () => Promise.resolve({ rows: [] }),
  } as unknown as DbType;
}

// ── 订单列表核心筛选 ──────────────────────────────────

describe("admin-service - 订单列表核心筛选", () => {
  it("status 为数组时，应生成 IN 条件（异常订单多状态筛选）", async () => {
    const capturedWheres: unknown[] = [];
    const db = {
      select: () => ({
        from: () => ({
          leftJoin: () => ({
            leftJoin: () => ({
              where: (cond: unknown) => {
                capturedWheres.push(cond);
                return createSelectChain([{ count: 3 }]);
              },
              orderBy: () => createSelectChain([{ count: 3 }]),
              limit: () => createSelectChain([{ count: 3 }]),
              offset: () => createSelectChain([{ count: 3 }]),
            }),
            where: (cond: unknown) => {
              capturedWheres.push(cond);
              return createSelectChain([{ count: 3 }]);
            },
            orderBy: () => createSelectChain([{ count: 3 }]),
            limit: () => createSelectChain([{ count: 3 }]),
            offset: () => createSelectChain([{ count: 3 }]),
          }),
        }),
      }),
      run: () => Promise.resolve({ rows: [] }),
    } as unknown as DbType;

    const { getOrderList } = await import("./admin-service");
    const filter = {
      status: ["failed", "cancelled", "expired"] as string | string[],
      productId: "",
      q: "",
      buyerContact: "",
      paymentMethod: "",
      page: 1,
      limit: 20,
    };

    const result = await getOrderList(db, filter);
    expect(result.total).toBe(3);
    // 应捕获到 where 条件中包含多状态 IN
    expect(capturedWheres.length).toBeGreaterThanOrEqual(1);
  });

  it("status 为单字符串时，应生成 IN 条件（单值数组）", async () => {
    const db = createMockDb({
      orders: [{ count: 5 }],
    });

    const { getOrderList } = await import("./admin-service");
    const filter = {
      status: "pending" as string | string[],
      productId: "",
      q: "",
      buyerContact: "",
      paymentMethod: "",
      page: 1,
      limit: 20,
    };

    const result = await getOrderList(db, filter);
    expect(result.total).toBe(5);
  });

  it("status 为空时，不应添加状态过滤条件", async () => {
    const db = createMockDb({
      orders: [{ count: 10 }],
    });

    const { getOrderList } = await import("./admin-service");
    const filter = {
      status: "",
      productId: "",
      q: "",
      buyerContact: "",
      paymentMethod: "",
      page: 1,
      limit: 20,
    };

    const result = await getOrderList(db, filter);
    expect(result.total).toBe(10);
  });

  it("组合筛选：status + productId + q + paymentMethod", async () => {
    const db = createMockDb({
      orders: [{ count: 2 }],
    });

    const { getOrderList } = await import("./admin-service");
    const filter = {
      status: "paid" as string | string[],
      productId: "prod-123",
      q: "order-abc",
      buyerContact: "",
      paymentMethod: "online",
      page: 1,
      limit: 20,
    };

    const result = await getOrderList(db, filter);
    expect(result.total).toBe(2);
  });
});

// ── 卡密列表 ──────────────────────────────────

describe("admin-service - 卡密列表", () => {
  it("getCardList 返回 total + results，且包含 batchName JOIN 字段", async () => {
    const db = createMockDb({
      cards: [
        {
          id: "card-1",
          productId: "prod-1",
          batchId: "batch-1",
          accountLabel: "acc-1",
          deliverySecret: "secret-1",
          deliveryNote: "note-1",
          status: "available",
          issuedOrderId: null,
          createdAt: "2026-01-01T00:00:00Z",
          batchName: "Batch A",
          productTitle: "Product A",
          count: 1,
        },
      ],
    });

    const { getCardList } = await import("./admin-service");
    const result = await getCardList(db, { productId: "prod-1", batchId: "", status: "", page: 1, limit: 20 });
    expect(result.total).toBe(1);
    expect(result.results[0]).toMatchObject({
      id: "card-1",
      accountLabel: "acc-1",
      batchName: "Batch A",
      productTitle: "Product A",
    });
  });
});

// ── 概览收入统计 ──────────────────────────────────

describe("admin-service - 概览收入统计", () => {
  it("getAdminSummary 应返回全部收入统计字段", async () => {
    const selectResults = [
      { count: 10 },
      { count: 20 },
      { count: 5 },
      { count: 30 },
      { count: 2 },
      { count: 8 },
      { count: 3 },
      { total: 5000 },
      { total: 1500 },
      { total: 800 },
      { total: 0 },
    ];
    let callIndex = 0;
    const db = {
      select: () => ({
        from: () => {
          const result = selectResults[callIndex] || [];
          callIndex++;
          return createSelectChain(Array.isArray(result) ? result : [result]);
        },
      }),
      run: () => Promise.resolve({ rows: [] }),
    } as unknown as DbType;

    const { getAdminSummary } = await import("./admin-service");
    const summary = await getAdminSummary(db);

    expect(summary).toMatchObject({
      products: 10,
      totalCards: 20,
      availableCards: 5,
      totalOrders: 30,
      pendingOrders: 2,
      ordersToday: 8,
      issuedToday: 3,
      totalIncomeCents: 5000,
      todayIncomeCents: 1500,
      todayAlipayCents: 800,
      todayEasyPayCents: 0,
    });
    expect(summary?.lowStockCount).toBe(0);
  });
});

// ── 取消订单边界 ──────────────────────────────────

describe("admin-service - 取消订单边界", () => {
  it("cancelOrder 对不存在订单抛错", async () => {
    const db = createMockDb({ orders: [] });
    const { cancelOrder } = await import("./admin-service");
    await expect(cancelOrder(db, "missing-id")).rejects.toThrow("订单不存在");
  });

  it("cancelOrder 对已 issued 订单拒绝取消", async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: () =>
            createSelectChain([
              { id: "order-1", status: "issued", issuedCardId: "card-1" },
            ]),
          limit: () => createSelectChain([
            { id: "order-1", status: "issued", issuedCardId: "card-1" },
          ]),
        }),
      }),
      update: () => ({
        set: () => {
          const whereChain: any = {
            then: () => Promise.resolve({ rowsAffected: 0 }),
          };
          return { where: () => whereChain };
        },
      }),
      delete: () => ({ where: () => Promise.resolve({ rowsAffected: 0 }) }),
      run: () => Promise.resolve({ rows: [] }),
      insert: () => ({
        values: () => {
          const p = Promise.resolve({ rowsAffected: 1 });
          const result: any = {};
          result.then = p.then.bind(p);
          return result;
        },
      }),
    } as unknown as DbType;

    const { cancelOrder } = await import("./admin-service");
    await expect(cancelOrder(db, "order-1")).rejects.toThrow("状态为 issued 的订单不可取消");
  });

  it("cancelOrder 对 paid 订单拒绝取消且不释放库存或优惠券", async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: () => createSelectChain([
            { id: "order-paid", status: "paid", issuedCardId: null, couponCode: "SAVE10" },
          ]),
          limit: () => createSelectChain([
            { id: "order-paid", status: "paid", issuedCardId: null, couponCode: "SAVE10" },
          ]),
        }),
      }),
      update: () => ({
        set: () => ({ where: () => Promise.resolve({ rowsAffected: 1 }) }),
      }),
      delete: () => ({ where: () => Promise.resolve({ rowsAffected: 0 }) }),
      run: () => Promise.resolve({ rows: [] }),
      insert: () => ({ values: () => Promise.resolve({ rowsAffected: 1 }) }),
    } as unknown as DbType;

    const { cancelOrder } = await import("./admin-service");
    await expect(cancelOrder(db, "order-paid")).rejects.toThrow("状态为 paid 的订单不可取消");
    expect(mockReleaseLockedCardByOrder).not.toHaveBeenCalled();
    expect(mockReleaseCouponReservation).not.toHaveBeenCalled();
  });

  it("cancelOrder 对 pending 订单成功取消并释放卡密", async () => {
    mockReleaseLockedCardByOrder.mockResolvedValueOnce(1);

    const db = {
      select: () => ({
        from: () => ({
          where: () =>
            createSelectChain([
              { id: "order-1", status: "pending", issuedCardId: null, couponCode: "SAVE10" },
            ]),
          limit: () => createSelectChain([
            { id: "order-1", status: "pending", issuedCardId: null, couponCode: "SAVE10" },
          ]),
        }),
      }),
      update: () => ({
        set: () => {
          const whereChain: any = {
            then: (resolve: (v: unknown) => void) => Promise.resolve({ rowsAffected: 1 }).then(resolve),
          };
          return { where: () => whereChain };
        },
      }),
      delete: () => ({ where: () => Promise.resolve({ rowsAffected: 0 }) }),
      run: () => Promise.resolve({ rows: [] }),
      insert: () => ({
        values: () => {
          const p = Promise.resolve({ rowsAffected: 1 });
          const result: any = {};
          result.then = p.then.bind(p);
          return result;
        },
      }),
    } as unknown as DbType;

    const { cancelOrder } = await import("./admin-service");
    const result = await cancelOrder(db, "order-1");
    expect(result.releasedCards).toBe(1);
    expect(mockReleaseLockedCardByOrder).toHaveBeenCalledWith(db, "order-1");
    expect(mockReleaseCouponReservation).toHaveBeenCalledWith(db, "SAVE10");
  });
});

// ── 库存预警 ──────────────────────────────────

describe("admin-service - 库存预警", () => {
  it("getLowStockProducts 返回低库存商品", async () => {
    mockReadSystemConfigMap.mockResolvedValue({
      inventory_warning_enabled: "true",
      inventory_warning_threshold: "3",
    });

    const db = createMockDb({
      products: [{ id: "prod-1", title: "低库存", category: "cat" }],
      cards: [{ productId: "prod-1", stock: 1 }],
    });

    const { getLowStockProducts } = await import("./admin-service");
    const result = await getLowStockProducts(db, 3);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "prod-1", title: "低库存" });
  });

  it("getLowStockProducts 显式阈值优先于系统配置", async () => {
    mockReadSystemConfigMap.mockResolvedValue({
      inventory_warning_enabled: "true",
      inventory_warning_threshold: "1",
    });

    const db = createMockDb({
      products: [{ id: "prod-1", title: "需预警", category: "cat" }],
      cards: [{ productId: "prod-1", stock: 2 }],
    });

    const { getLowStockProducts } = await import("./admin-service");
    const result = await getLowStockProducts(db, 3);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "prod-1", stock: 2 });
  });
});

// ── 商品 CRUD（含 purchaseLimit） ──────────────────────────────────

describe("admin-service - 商品 CRUD", () => {
  it("getAdminProducts 应返回 purchaseLimit 和已购数量", async () => {
    let selectCallCount = 0;
    const db = {
      select: (_colMap?: unknown) => ({
        from: (_table?: unknown) => {
          const table = _table;
          if (table === products) {
            selectCallCount += 1;
            if (selectCallCount === 1) {
              return createSelectChain([{ count: 1 }]);
            }
            return createSelectChain([{ id: "prod-1", title: "Limited Product", purchaseLimit: 5, purchaseLimitDisplay: 1, active: 1, category: "cat", stock: 10 }]);
          }
          if (table === orders) {
            return createSelectChain([{ productId: "prod-1", purchasedCount: 3 }]);
          }
          return createSelectChain([]);
        },
      }),
      insert: () => ({
        values: () => {
          const p = Promise.resolve({ rowsAffected: 1 });
          const result: any = { onConflictDoUpdate: () => p, onConflictDoNothing: () => p };
          result.then = p.then.bind(p);
          result.catch = p.catch.bind(p);
          result.finally = p.finally.bind(p);
          return result;
        },
      }),
      update: () => ({
        set: () => {
          const whereChain: any = {
            returning: () => ({ then: (resolve: (v: unknown) => void) => Promise.resolve([{ id: "any" }]).then(resolve) }),
            then: (resolve: (v: unknown) => void) => Promise.resolve({ rowsAffected: 1 }).then(resolve),
          };
          return { where: () => whereChain };
        },
      }),
      delete: () => ({
        where: () => Promise.resolve({ rowsAffected: 0 }),
      }),
      run: () => Promise.resolve({ rows: [] }),
    } as unknown as DbType;

    const { getAdminProducts } = await import("./admin-service");
    const result = await getAdminProducts(db, { q: "", active: "", category: "", page: 1, limit: 20 });
    expect(result.total).toBe(1);
    expect(result.products[0]).toMatchObject({ id: "prod-1", purchaseLimit: 5, purchaseLimitDisplay: true, purchasedCount: 3 });
  });

  it("createProduct 应保存 purchaseLimit", async () => {
    const capturedValues: Record<string, unknown> = {};
    const db = {
      select: () => ({
        from: () => createSelectChain([{ count: 0 }]),
      }),
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          capturedValues.values = values;
          const p = Promise.resolve({ rowsAffected: 1 });
          const result: any = {};
          result.then = p.then.bind(p);
          return result;
        },
      }),
      update: () => ({
        set: () => {
          const whereChain: any = {
            returning: () => ({ then: (resolve: (v: unknown) => void) => Promise.resolve([{ id: "any" }]).then(resolve) }),
            then: (resolve: (v: unknown) => void) => Promise.resolve({ rowsAffected: 1 }).then(resolve),
          };
          return { where: () => whereChain };
        },
      }),
      delete: () => ({
        where: () => Promise.resolve({ rowsAffected: 0 }),
      }),
      run: () => Promise.resolve({ rows: [] }),
    } as unknown as DbType;

    const { createProduct } = await import("./admin-service");
    await createProduct(db, {
      id: "prod-new",
      title: "New Product",
      priceCents: 1000,
      currency: "CNY",
      issueMode: "manual",
      fulfillmentMode: "card",
      active: true,
      purchaseLimit: 10,
      purchaseLimitDisplay: true,
      category: "cat",
      tagsJson: "[]",
      salesCopy: "",
      coverUrl: "",
      description: "",
      sortOrder: 0,
      storefrontIds: [],
    });

    expect(capturedValues.values).toMatchObject({
      id: "prod-new",
      purchaseLimit: 10,
      purchaseLimitDisplay: 1,
    });
  });

  it("创建和切换为无需输入时会清空整组履约配置", async () => {
    let insertedValues: Record<string, unknown> = {};
    let updatedValues: Record<string, unknown> = {};
    const db = {
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          insertedValues = values;
          return Promise.resolve({ rowsAffected: 1 });
        },
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          updatedValues = values;
          return { where: () => Promise.resolve({ rowsAffected: 1 }) };
        },
      }),
    } as unknown as DbType;
    const input = {
      id: "prod-fulfillment-none",
      title: "无需输入商品",
      description: "",
      salesCopy: "",
      coverUrl: "",
      tagsJson: "[]",
      priceCents: 100,
      currency: "CNY",
      issueMode: "manual",
      fulfillmentMode: "virtual",
      active: true,
      category: "",
      sortOrder: 0,
      storefrontIds: [] as string[],
      fulfillmentInputType: "none" as const,
      fulfillmentInputLabel: "遗留标签",
      fulfillmentInputHint: "遗留提示",
      fulfillmentInputRequired: true,
    };
    const { createProduct, updateProduct } = await import("./admin-service");

    await createProduct(db, input);
    await updateProduct(db, input.id, input);

    const expected = {
      fulfillmentInputType: "none",
      fulfillmentInputLabel: "",
      fulfillmentInputHint: "",
      fulfillmentInputRequired: 0,
    };
    expect(insertedValues).toMatchObject(expected);
    expect(updatedValues).toMatchObject(expected);
  });

  it("createProduct 从中文标题生成商品 ID 时应保持 ASCII 安全", async () => {
    const capturedValues: Record<string, unknown> = {};
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => createSelectChain([]),
          }),
        }),
      }),
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          capturedValues.values = values;
          const p = Promise.resolve({ rowsAffected: 1 });
          const result: any = {};
          result.then = p.then.bind(p);
          return result;
        },
      }),
      update: () => ({
        set: () => ({ where: () => Promise.resolve({ rowsAffected: 1 }) }),
      }),
      delete: () => ({
        where: () => Promise.resolve({ rowsAffected: 0 }),
      }),
      run: () => Promise.resolve({ rows: [] }),
    } as unknown as DbType;

    const { createProduct } = await import("./admin-service");
    const id = await createProduct(db, {
      title: "useai兑换码-用户福利",
      priceCents: 1000,
      currency: "CNY",
      issueMode: "manual",
      fulfillmentMode: "card",
      active: true,
      category: "cat",
      tagsJson: "[]",
      salesCopy: "",
      coverUrl: "",
      description: "",
      sortOrder: 0,
      storefrontIds: [],
    });

    expect(id).toBe("useai");
    expect(capturedValues.values).toMatchObject({ id: "useai", slug: "useai" });
  });

  it("createProduct 对纯中文标题回退到稳定 ASCII 前缀", async () => {
    const capturedValues: Record<string, unknown> = {};
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => createSelectChain([]),
          }),
        }),
      }),
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          capturedValues.values = values;
          const p = Promise.resolve({ rowsAffected: 1 });
          const result: any = {};
          result.then = p.then.bind(p);
          return result;
        },
      }),
      update: () => ({
        set: () => ({ where: () => Promise.resolve({ rowsAffected: 1 }) }),
      }),
      delete: () => ({
        where: () => Promise.resolve({ rowsAffected: 0 }),
      }),
      run: () => Promise.resolve({ rows: [] }),
    } as unknown as DbType;

    const { createProduct } = await import("./admin-service");
    const id = await createProduct(db, {
      title: "兑换码用户福利",
      priceCents: 1000,
      currency: "CNY",
      issueMode: "manual",
      fulfillmentMode: "card",
      active: true,
      category: "cat",
      tagsJson: "[]",
      salesCopy: "",
      coverUrl: "",
      description: "",
      sortOrder: 0,
      storefrontIds: [],
    });

    expect(id).toBe("product");
    expect(capturedValues.values).toMatchObject({ id: "product", slug: "product" });
  });

  it("updateProduct 应更新 purchaseLimit", async () => {
    const capturedSet: Record<string, unknown> = {};
    const db = {
      select: () => ({
        from: () => createSelectChain([{ count: 0 }]),
      }),
      insert: () => ({
        values: () => {
          const p = Promise.resolve({ rowsAffected: 1 });
          const result: any = {};
          result.then = p.then.bind(p);
          return result;
        },
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          capturedSet.values = values;
          return {
            where: () => Promise.resolve({ rowsAffected: 1 }),
          };
        },
      }),
      delete: () => ({
        where: () => Promise.resolve({ rowsAffected: 0 }),
      }),
      run: () => Promise.resolve({ rows: [] }),
    } as unknown as DbType;

    const { updateProduct } = await import("./admin-service");
    await updateProduct(db, "prod-1", { purchaseLimit: 20 });

    expect(capturedSet.values).toMatchObject({
      purchaseLimit: 20,
    });
  });

  it("updateProduct 应将 purchaseLimit 设为 null", async () => {
    const capturedSet: Record<string, unknown> = {};
    const db = {
      select: () => ({
        from: () => createSelectChain([{ count: 0 }]),
      }),
      insert: () => ({
        values: () => {
          const p = Promise.resolve({ rowsAffected: 1 });
          const result: any = {};
          result.then = p.then.bind(p);
          return result;
        },
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          capturedSet.values = values;
          return {
            where: () => Promise.resolve({ rowsAffected: 1 }),
          };
        },
      }),
      delete: () => ({
        where: () => Promise.resolve({ rowsAffected: 0 }),
      }),
      run: () => Promise.resolve({ rows: [] }),
    } as unknown as DbType;

    const { updateProduct } = await import("./admin-service");
    await updateProduct(db, "prod-1", { purchaseLimit: null });

    expect(capturedSet.values).toMatchObject({
      purchaseLimit: null,
    });
  });
});

// ── Phase 3: 运营效率工具 ──────────────────────────────

describe("admin-service - Phase 3 运营效率工具", () => {
  // ── 今日待处理聚合 ──

  describe("getTodayPendingTasks", () => {
    it("应返回今日待确认线下付款 + 已付未发 + 低库存", async () => {
      let callIndex = 0;
      const db = {
        select: (_colMap?: unknown) => ({
          from: (_table?: unknown) => {
            const table = _table;
            callIndex++;
            if (callIndex === 1) {
              // pendingOfflinePayments
              return createSelectChain([
                { id: "order-1", status: "pending", paymentMethod: "offline", createdAt: new Date().toISOString() }
              ]);
            } else if (callIndex === 2) {
              // paidButNotIssued
              return createSelectChain([
                { id: "order-2", status: "paid", createdAt: new Date().toISOString() }
              ]);
            }
            // lowStockProducts (getLowStockProducts)
            return createSelectChain([]);
          },
        }),
        insert: () => ({
          values: () => {
            const p = Promise.resolve({ rowsAffected: 1 });
            const result: any = {};
            result.then = p.then.bind(p);
            return result;
          },
        }),
        update: () => ({
          set: () => {
            const whereChain: any = {
              then: (resolve: (v: unknown) => void) => Promise.resolve({ rowsAffected: 1 }).then(resolve),
            };
            return { where: () => whereChain };
          },
        }),
        delete: () => ({ where: () => Promise.resolve({ rowsAffected: 0 }) }),
        run: () => Promise.resolve({ rows: [] }),
      } as unknown as DbType;

      mockReadSystemConfigMap.mockResolvedValue({
        inventory_warning_enabled: "true",
        inventory_warning_threshold: "3",
      });

      const { getTodayPendingTasks } = await import("./admin-service");
      const result = await getTodayPendingTasks(db);

      expect(result.pendingOfflinePayments).toHaveLength(1);
      expect(result.pendingOfflinePayments[0]).toMatchObject({ id: "order-1" });
      expect(result.paidButNotIssued).toHaveLength(1);
      expect(result.paidButNotIssued[0]).toMatchObject({ id: "order-2" });
      expect(result.lowStockProducts).toHaveLength(0);
    });
  });

  // ── 更新卡密批次 ──

  describe("updateCardBatch", () => {
    it("批次存在时更新字段", async () => {
      const db = {
        select: () => ({
          from: () => ({
            where: () => createSelectChain([{ id: "batch-1" }]),
          }),
        }),
        update: () => ({
          set: (values: Record<string, unknown>) => {
            const captured = values;
            return {
              where: () => Promise.resolve({ rowsAffected: 1 }),
            };
          },
        }),
        insert: () => ({
          values: () => {
            const p = Promise.resolve({ rowsAffected: 1 });
            const result: any = {};
            result.then = p.then.bind(p);
            return result;
          },
        }),
        delete: () => ({ where: () => Promise.resolve({ rowsAffected: 0 }) }),
        run: () => Promise.resolve({ rows: [] }),
      } as unknown as DbType;

      const { updateCardBatch } = await import("./admin-service");
      const result = await updateCardBatch(db, "batch-1", {
        name: "新批次",
        costPriceCents: 1000,
        note: "备注",
      });

      expect(result).toMatchObject({ id: "batch-1" });
    });

    it("批次不存在时返回 null", async () => {
      const db = {
        select: () => ({
          from: () => ({
            where: () => createSelectChain([]),
          }),
        }),
        update: () => ({
          set: () => ({ where: () => Promise.resolve({ rowsAffected: 1 }) }),
        }),
        insert: () => ({
          values: () => {
            const p = Promise.resolve({ rowsAffected: 1 });
            const result: any = {};
            result.then = p.then.bind(p);
            return result;
          },
        }),
        delete: () => ({ where: () => Promise.resolve({ rowsAffected: 0 }) }),
        run: () => Promise.resolve({ rows: [] }),
      } as unknown as DbType;

      const { updateCardBatch } = await import("./admin-service");
      const result = await updateCardBatch(db, "missing", { name: "x" });
      expect(result).toBeNull();
    });
  });

  // ── 重发订单邮件 ──

  describe("resendOrderEmail", () => {
    it("卡密订单应成功重发邮件", async () => {
      const emailMod = await import("./email-service");
      const mockSendEmail = vi.fn().mockResolvedValue({ ok: true, message: "sent" });
      vi.spyOn(emailMod, "sendEmail").mockImplementation(mockSendEmail);

      const db = createMockDb({
        orders: [{
          id: "order-1",
          buyerEmail: "test@example.com",
          status: "issued",
          orderNo: "ORD-1",
          productTitle: "测试商品",
          fulfillmentMode: "card",
          deliveryJson: "",
        }],
        cards: [{ accountLabel: "acc-1", deliverySecret: "secret-1", deliveryNote: "note-1" }],
      });

      const { resendOrderEmail } = await import("./admin-service");
      const result = await resendOrderEmail(db, { resendApiKey: "test", emailFrom: "test@example.com" }, "order-1");

      expect(result.ok).toBe(true);
      expect(mockSendEmail).toHaveBeenCalledWith(
        db,
        { resendApiKey: "test", emailFrom: "test@example.com" },
        expect.objectContaining({
          to: "test@example.com",
          template: "order_issued",
          templateData: expect.objectContaining({
            productName: "测试商品",
            accountLabel: "acc-1",
            deliverySecret: "secret-1",
            deliveryNote: "note-1",
          }),
        }),
      );
    });

    it("多卡订单重发邮件应包含全部卡密", async () => {
      const emailMod = await import("./email-service");
      const mockSendEmail = vi.fn().mockResolvedValue({ ok: true, message: "sent" });
      vi.spyOn(emailMod, "sendEmail").mockImplementation(mockSendEmail);
      const db = createMockDb({
        orders: [{
          id: "order-multi",
          buyerEmail: "test@example.com",
          status: "issued",
          orderNo: "ORD-MULTI",
          productTitle: "多卡商品",
          fulfillmentMode: "card",
          deliveryJson: "",
        }],
        cards: [
          { accountLabel: "acc-1", deliverySecret: "secret-1", deliveryNote: "note-1" },
          { accountLabel: "acc-2", deliverySecret: "secret-2", deliveryNote: "note-2" },
        ],
      });

      const { resendOrderEmail } = await import("./admin-service");
      const result = await resendOrderEmail(db, { resendApiKey: "test", emailFrom: "test@example.com" }, "order-multi");

      expect(result.ok).toBe(true);
      expect(mockSendEmail).toHaveBeenCalledWith(
        db,
        expect.anything(),
        expect.objectContaining({
          templateData: expect.objectContaining({
            deliverySecret: "secret-1",
            additionalDeliveries: expect.stringContaining("secret-2"),
          }),
        }),
      );
    });

    it("邮件供应商失败时重发接口应返回失败", async () => {
      const emailMod = await import("./email-service");
      const mockSendEmail = vi.fn().mockResolvedValue({ ok: false, message: "provider rejected" });
      vi.spyOn(emailMod, "sendEmail").mockImplementation(mockSendEmail);
      const db = createMockDb({
        orders: [{
          id: "order-failed-email",
          buyerEmail: "test@example.com",
          status: "issued",
          orderNo: "ORD-FAILED-EMAIL",
          productTitle: "测试商品",
          fulfillmentMode: "card",
          deliveryJson: "",
        }],
        cards: [{ accountLabel: "acc-1", deliverySecret: "secret-1", deliveryNote: "" }],
      });

      const { resendOrderEmail } = await import("./admin-service");
      const result = await resendOrderEmail(db, { resendApiKey: "test", emailFrom: "test@example.com" }, "order-failed-email");

      expect(result.ok).toBe(false);
      expect(result.message).toContain("provider rejected");
    });

    it("非卡密订单且无 deliveryJson 时应拒绝", async () => {
      const db = createMockDb({
        orders: [{
          id: "order-1",
          buyerEmail: "test@example.com",
          status: "issued",
          orderNo: "ORD-1",
          productTitle: "测试商品",
          fulfillmentMode: "link",
          deliveryJson: "",
        }],
      });

      const { resendOrderEmail } = await import("./admin-service");
      const result = await resendOrderEmail(db, { resendApiKey: "test", emailFrom: "test@example.com" }, "order-1");

      expect(result.ok).toBe(false);
      expect(result.message).toContain("没有可交付内容");
    });

    it("未完成交付的虚拟订单即使已有 deliveryJson 也不得重发", async () => {
      const emailMod = await import("./email-service");
      const mockSendEmail = vi.fn().mockResolvedValue({ ok: true, message: "sent" });
      vi.spyOn(emailMod, "sendEmail").mockImplementation(mockSendEmail);
      const db = createMockDb({
        orders: [{
          id: "order-pending-virtual",
          buyerEmail: "test@example.com",
          status: "pending",
          orderNo: "ORD-PENDING-VIRTUAL",
          productTitle: "待支付虚拟商品",
          fulfillmentMode: "virtual",
          deliveryJson: JSON.stringify({ deliverySecret: "SHOULD-NOT-SEND" }),
        }],
      });

      const { resendOrderEmail } = await import("./admin-service");
      const result = await resendOrderEmail(db, { resendApiKey: "test", emailFrom: "test@example.com" }, "order-pending-virtual");

      expect(result.ok).toBe(false);
      expect(result.message).toContain("尚未完成交付");
      expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it("deliveryJson 格式异常时应拒绝", async () => {
      const db = createMockDb({
        orders: [{
          id: "order-1",
          buyerEmail: "test@example.com",
          status: "issued",
          orderNo: "ORD-1",
          productTitle: "测试商品",
          fulfillmentMode: "link",
          deliveryJson: "not-valid-json",
        }],
      });

      const { resendOrderEmail } = await import("./admin-service");
      const result = await resendOrderEmail(db, { resendApiKey: "test", emailFrom: "test@example.com" }, "order-1");

      expect(result.ok).toBe(false);
      expect(result.message).toContain("格式异常");
    });

    it("商品模式变更后应按订单明细快照重发虚拟交付邮件", async () => {
      const emailMod = await import("./email-service");
      const mockSendEmail = vi.fn().mockResolvedValue({ ok: true, message: "sent" });
      vi.spyOn(emailMod, "sendEmail").mockImplementation(mockSendEmail);
      const db = createMockDb({
        orders: [{
          id: "order-virtual-snapshot",
          buyerEmail: "test@example.com",
          status: "issued",
          orderNo: "ORD-VIRTUAL",
          productTitle: "已改成卡密的商品",
          fulfillmentMode: "card",
          deliveryJson: JSON.stringify({
            accountLabel: "资料包",
            deliverySecret: "https://example.com/archive.zip",
            deliveryNote: "历史虚拟交付",
          }),
        }],
        orderItems: [{ fulfillmentMode: "virtual" }],
        cards: [],
      });

      const { resendOrderEmail } = await import("./admin-service");
      const result = await resendOrderEmail(db, { resendApiKey: "test", emailFrom: "test@example.com" }, "order-virtual-snapshot");

      expect(result.ok).toBe(true);
      expect(mockSendEmail).toHaveBeenCalledWith(
        db,
        expect.anything(),
        expect.objectContaining({
          templateData: expect.objectContaining({
            deliverySecret: "https://example.com/archive.zip",
          }),
        }),
      );
    });
  });

  // ── 订单补偿备注 ──

  describe("addOrderCompensationNote", () => {
    it("应成功写入补偿备注", async () => {
      const capturedValues: Record<string, unknown> = {};
      const db = {
        select: () => ({
          from: () => ({
            where: () => createSelectChain([{ id: "order-1" }]),
          }),
        }),
        insert: () => ({
          values: (values: Record<string, unknown>) => {
            capturedValues.values = values;
            const p = Promise.resolve({ rowsAffected: 1 });
            const result: any = {};
            result.then = p.then.bind(p);
            return result;
          },
        }),
        update: () => ({
          set: () => ({ where: () => Promise.resolve({ rowsAffected: 1 }) }),
        }),
        delete: () => ({ where: () => Promise.resolve({ rowsAffected: 0 }) }),
        run: () => Promise.resolve({ rows: [] }),
      } as unknown as DbType;

      const { addOrderCompensationNote } = await import("./admin-service");
      const result = await addOrderCompensationNote(db, "order-1", "补偿 10 元");

      expect(result.ok).toBe(true);
      expect(capturedValues.values).toMatchObject({
        orderId: "order-1",
        type: "compensation_note",
        message: "补偿 10 元",
      });
    });

    it("备注为空时应拒绝", async () => {
      const db = createMockDb({ orders: [] });
      const { addOrderCompensationNote } = await import("./admin-service");
      const result = await addOrderCompensationNote(db, "order-1", "   ");
      expect(result.ok).toBe(false);
      expect(result.message).toContain("不能为空");
    });

    it("订单不存在时应返回错误", async () => {
      const db = createMockDb({ orders: [] });
      const { addOrderCompensationNote } = await import("./admin-service");
      const result = await addOrderCompensationNote(db, "order-none", "补偿 10 元");
      expect(result.ok).toBe(false);
      expect(result.message).toContain("订单不存在");
    });
  });

  // ── 低库存预警邮件去重 ──

  describe("sendLowStockWarningEmailWithDedup", () => {
    it("24h 内已通知的商品应跳过", async () => {
      const adminMod = await import("./admin-service");
      const mockSendLowStockWarningEmail = vi.fn().mockResolvedValue({ ok: true, message: "sent" });
      vi.spyOn(adminMod, "sendLowStockWarningEmail").mockImplementation(mockSendLowStockWarningEmail);

      const oneDayAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
      const db = {
        select: () => ({
          from: () => ({
            where: () => createSelectChain([
              { targetId: JSON.stringify({ productIds: ["prod-1"] }), createdAt: oneDayAgo }
            ]),
          }),
        }),
        insert: () => ({
          values: () => {
            const p = Promise.resolve({ rowsAffected: 1 });
            const result: any = {};
            result.then = p.then.bind(p);
            return result;
          },
        }),
        update: () => ({
          set: () => ({ where: () => Promise.resolve({ rowsAffected: 1 }) }),
        }),
        delete: () => ({ where: () => Promise.resolve({ rowsAffected: 0 }) }),
        run: () => Promise.resolve({ rows: [] }),
      } as unknown as DbType;

      mockReadSystemConfigMap.mockResolvedValue({
        inventory_warning_email_to: "admin@example.com",
      });

      const { sendLowStockWarningEmailWithDedup } = adminMod;
      const result = await sendLowStockWarningEmailWithDedup(db, { resendApiKey: "test", emailFrom: "test@example.com" }, [
        { id: "prod-1", title: "低库存", category: "default", stock: 1 }
      ], 3);

      expect(result.sent).toBe(false);
      expect(result.message).toContain("24h 内已通知过");
      expect(mockSendLowStockWarningEmail).not.toHaveBeenCalled();
    });

    it("未配置通知邮箱时应提前返回", async () => {
      mockReadSystemConfigMap.mockResolvedValue({});

      const db = {
        select: () => ({ from: () => ({ where: () => createSelectChain([]), limit: () => createSelectChain([]) }) }),
        insert: () => ({ values: () => { const p = Promise.resolve({ rowsAffected: 1 }); const result: any = {}; result.then = p.then.bind(p); return result; } }),
        update: () => ({ set: () => ({ where: () => Promise.resolve({ rowsAffected: 1 }) }) }),
        delete: () => ({ where: () => Promise.resolve({ rowsAffected: 0 }) }),
        run: () => Promise.resolve({ rows: [] }),
      } as unknown as DbType;

      const { sendLowStockWarningEmailWithDedup } = await import("./admin-service");
      const result = await sendLowStockWarningEmailWithDedup(db, { resendApiKey: "test", emailFrom: "test@example.com" }, [
        { id: "prod-1", title: "低库存", category: "default", stock: 1 }
      ], 3);

      expect(result.ok).toBe(false);
      expect(result.message).toContain("未配置库存预警通知邮箱");
      expect(result.sent).toBe(false);
    });

    it("所有商品 24h 内已通知时应跳过发送", async () => {
      mockReadSystemConfigMap.mockResolvedValue({ inventory_warning_email_to: "admin@example.com" });
      const adminMod = await import("./admin-service");
      const mockSendLowStockWarningEmail = vi.fn().mockResolvedValue({ ok: true, message: "sent" });
      vi.spyOn(adminMod, "sendLowStockWarningEmail").mockImplementation(mockSendLowStockWarningEmail);

      const oneDayAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
      const db = {
        select: () => ({
          from: () => ({
            where: () => createSelectChain([
              { targetId: JSON.stringify({ productIds: ["prod-1", "prod-2"] }), createdAt: oneDayAgo }
            ]),
          }),
        }),
        insert: () => ({
          values: () => {
            const p = Promise.resolve({ rowsAffected: 1 });
            const result: any = {};
            result.then = p.then.bind(p);
            return result;
          },
        }),
        update: () => ({
          set: () => ({ where: () => Promise.resolve({ rowsAffected: 1 }) }),
        }),
        delete: () => ({ where: () => Promise.resolve({ rowsAffected: 0 }) }),
        run: () => Promise.resolve({ rows: [] }),
      } as unknown as DbType;

      const { sendLowStockWarningEmailWithDedup } = adminMod;
      const result = await sendLowStockWarningEmailWithDedup(db, { resendApiKey: "test", emailFrom: "test@example.com" }, [
        { id: "prod-1", title: "低库存1", category: "default", stock: 1 },
        { id: "prod-2", title: "低库存2", category: "default", stock: 1 }
      ], 3);

      expect(result.ok).toBe(true);
      expect(result.message).toContain("24h 内已通知过");
      expect(result.sent).toBe(false);
      expect(mockSendLowStockWarningEmail).not.toHaveBeenCalled();
    });

    it("应发送预警邮件并记录审计日志", async () => {
      mockReadSystemConfigMap.mockResolvedValue({ inventory_warning_email_to: "admin@example.com" });

      const emailMod = await import("./email-service");
      const mockSendEmail = vi.fn().mockResolvedValue({ ok: true, message: "sent" });
      vi.spyOn(emailMod, "sendEmail").mockImplementation(mockSendEmail);

      const db = {
        select: () => ({
          from: () => ({
            where: () => createSelectChain([]),
          }),
        }),
        insert: () => ({
          values: () => {
            const p = Promise.resolve({ rowsAffected: 1 });
            const result: any = {};
            result.then = p.then.bind(p);
            return result;
          },
        }),
        update: () => ({
          set: () => ({ where: () => Promise.resolve({ rowsAffected: 1 }) }),
        }),
        delete: () => ({ where: () => Promise.resolve({ rowsAffected: 0 }) }),
        run: () => Promise.resolve({ rows: [] }),
      } as unknown as DbType;

      const { sendLowStockWarningEmailWithDedup } = await import("./admin-service");
      const result = await sendLowStockWarningEmailWithDedup(db, { resendApiKey: "test", emailFrom: "test@example.com" }, [
        { id: "prod-1", title: "低库存", category: "default", stock: 1 }
      ], 3);

      expect(result.ok).toBe(true);
      expect(result.sent).toBe(true);
      expect(mockSendEmail).toHaveBeenCalled();
    });
  });
});

// ── 卡密状态转换（防资损核心防线）─────────────────────────────────

describe("admin-service - 卡密状态转换", () => {
  describe("updateCardStatus", () => {
    it("available → locked 非法，锁定只能由订单状态机执行", async () => {
      const db = {
        select: () => ({
          from: () => ({
            where: () => createSelectChain([{ id: "card-1", status: "available" }]),
            limit: () => createSelectChain([{ id: "card-1", status: "available" }]),
          }),
        }),
        update: () => ({
          set: () => {
            const p = Promise.resolve({ rowsAffected: 1 });
            const whereChain: any = {};
            whereChain.then = p.then.bind(p);
            return { where: () => whereChain };
          },
        }),
        insert: () => ({
          values: () => {
            const p = Promise.resolve({ rowsAffected: 1 });
            const result: any = {};
            result.then = p.then.bind(p);
            return result;
          },
        }),
        delete: () => ({ where: () => Promise.resolve({ rowsAffected: 0 }) }),
        run: () => Promise.resolve({ rows: [] }),
      } as unknown as DbType;

      const { updateCardStatus } = await import("./admin-service");
      await expect(updateCardStatus(db, "card-1", "locked")).rejects.toThrow("不允许");
    });

    it("locked → available 非法，释放只能由订单取消或过期清理执行", async () => {
      const db = {
        select: () => ({
          from: () => ({
            where: () => createSelectChain([{ id: "card-1", status: "locked" }]),
            limit: () => createSelectChain([{ id: "card-1", status: "locked" }]),
          }),
        }),
        update: () => ({
          set: () => {
            const p = Promise.resolve({ rowsAffected: 1 });
            const whereChain: any = {};
            whereChain.then = p.then.bind(p);
            return { where: () => whereChain };
          },
        }),
        insert: () => ({
          values: () => {
            const p = Promise.resolve({ rowsAffected: 1 });
            const result: any = {};
            result.then = p.then.bind(p);
            return result;
          },
        }),
        delete: () => ({ where: () => Promise.resolve({ rowsAffected: 0 }) }),
        run: () => Promise.resolve({ rows: [] }),
      } as unknown as DbType;

      const { updateCardStatus } = await import("./admin-service");
      await expect(updateCardStatus(db, "card-1", "available")).rejects.toThrow("不允许");
    });

    it("issued → available 非法转换应抛错", async () => {
      const db = {
        select: () => ({
          from: () => ({
            where: () => createSelectChain([{ id: "card-1", status: "issued" }]),
            limit: () => createSelectChain([{ id: "card-1", status: "issued" }]),
          }),
        }),
        update: () => ({
          set: () => {
            const p = Promise.resolve({ rowsAffected: 1 });
            const whereChain: any = {};
            whereChain.then = p.then.bind(p);
            return { where: () => whereChain };
          },
        }),
        insert: () => ({
          values: () => {
            const p = Promise.resolve({ rowsAffected: 1 });
            const result: any = {};
            result.then = p.then.bind(p);
            return result;
          },
        }),
        delete: () => ({ where: () => Promise.resolve({ rowsAffected: 0 }) }),
        run: () => Promise.resolve({ rows: [] }),
      } as unknown as DbType;

      const { updateCardStatus } = await import("./admin-service");
      await expect(updateCardStatus(db, "card-1", "available")).rejects.toThrow("不允许");
    });

    it("并发修改导致 rowsAffected=0 应抛错", async () => {
      const db = {
        select: () => ({
          from: () => ({
            where: () => createSelectChain([{ id: "card-1", status: "available" }]),
            limit: () => createSelectChain([{ id: "card-1", status: "available" }]),
          }),
        }),
        update: () => ({
          set: () => {
            const p = Promise.resolve({ rowsAffected: 0 });
            const whereChain: any = {};
            whereChain.then = p.then.bind(p);
            return { where: () => whereChain };
          },
        }),
        insert: () => ({
          values: () => {
            const p = Promise.resolve({ rowsAffected: 1 });
            const result: any = {};
            result.then = p.then.bind(p);
            return result;
          },
        }),
        delete: () => ({ where: () => Promise.resolve({ rowsAffected: 0 }) }),
        run: () => Promise.resolve({ rows: [] }),
      } as unknown as DbType;

      const { updateCardStatus } = await import("./admin-service");
      await expect(updateCardStatus(db, "card-1", "disabled")).rejects.toThrow("请刷新重试");
    });

    it("卡密不存在应返回 null", async () => {
      const db = {
        select: () => ({
          from: () => ({
            where: () => createSelectChain([]),
            limit: () => createSelectChain([]),
          }),
        }),
        update: () => ({
          set: () => {
            const p = Promise.resolve({ rowsAffected: 1 });
            const whereChain: any = {};
            whereChain.then = p.then.bind(p);
            return { where: () => whereChain };
          },
        }),
        insert: () => ({
          values: () => {
            const p = Promise.resolve({ rowsAffected: 1 });
            const result: any = {};
            result.then = p.then.bind(p);
            return result;
          },
        }),
        delete: () => ({ where: () => Promise.resolve({ rowsAffected: 0 }) }),
        run: () => Promise.resolve({ rows: [] }),
      } as unknown as DbType;

      const { updateCardStatus } = await import("./admin-service");
      const result = await updateCardStatus(db, "missing", "disabled");
      expect(result).toBeNull();
    });
  });

  describe("batchDisableCards", () => {
    it("批量禁用 available 卡密成功", async () => {
      let capturedWhere: unknown = null;
      const db = {
        select: () => ({
          from: () => ({
            where: () => createSelectChain([{ id: "card-1" }]),
          }),
        }),
        update: () => ({
          set: () => {
            const p = Promise.resolve({ rowsAffected: 2 });
            const whereChain: any = {};
            whereChain.then = p.then.bind(p);
            return {
              where: (cond: unknown) => {
                capturedWhere = cond;
                return whereChain;
              },
            };
          },
        }),
        insert: () => ({
          values: () => {
            const p = Promise.resolve({ rowsAffected: 1 });
            const result: any = {};
            result.then = p.then.bind(p);
            return result;
          },
        }),
        delete: () => ({ where: () => Promise.resolve({ rowsAffected: 0 }) }),
        run: () => Promise.resolve({ rows: [] }),
      } as unknown as DbType;

      const { batchDisableCards } = await import("./admin-service");
      const result = await batchDisableCards(db, ["card-1", "card-2"], "disabled");
      expect(result.updated).toBe(2);
      // 应包含来源状态兜底条件，避免 locked/issued 被人工改状态
      expect(capturedWhere).toBeTruthy();
    });

    it("批量禁用 issued/locked 卡密应被来源状态条件排除", async () => {
      const db = {
        select: () => ({
          from: () => ({
            where: () => createSelectChain([{ id: "card-1" }]),
          }),
        }),
        update: () => ({
          set: () => {
            const p = Promise.resolve({ rowsAffected: 0 });
            const whereChain: any = {};
            whereChain.then = p.then.bind(p);
            return { where: () => whereChain };
          },
        }),
        insert: () => ({
          values: () => {
            const p = Promise.resolve({ rowsAffected: 1 });
            const result: any = {};
            result.then = p.then.bind(p);
            return result;
          },
        }),
        delete: () => ({ where: () => Promise.resolve({ rowsAffected: 0 }) }),
        run: () => Promise.resolve({ rows: [] }),
      } as unknown as DbType;

      const { batchDisableCards } = await import("./admin-service");
      const result = await batchDisableCards(db, ["issued-card"], "disabled");
      // issued 卡密被排除，updated 应为 0
      expect(result.updated).toBe(0);
    });

    it("非法目标状态应抛错", async () => {
      const db = {
        select: () => ({
          from: () => ({
            where: () => createSelectChain([{ id: "card-1" }]),
          }),
        }),
        update: () => ({
          set: () => {
            const p = Promise.resolve({ rowsAffected: 1 });
            const whereChain: any = {};
            whereChain.then = p.then.bind(p);
            return { where: () => whereChain };
          },
        }),
        insert: () => ({
          values: () => {
            const p = Promise.resolve({ rowsAffected: 1 });
            const result: any = {};
            result.then = p.then.bind(p);
            return result;
          },
        }),
        delete: () => ({ where: () => Promise.resolve({ rowsAffected: 0 }) }),
        run: () => Promise.resolve({ rows: [] }),
      } as unknown as DbType;

      const { batchDisableCards } = await import("./admin-service");
      await expect(batchDisableCards(db, ["card-1"], "unknown_status")).rejects.toThrow("非法目标状态");
    });
  });
});

// ── 卡密导入与通用卡密生成（库存入口安全）─────────────────────────────

describe("admin-service - 卡密导入与通用卡密生成", () => {
  describe("importCards", () => {
    it("商品不存在时抛错", async () => {
      const db = {
        select: () => ({
          from: () => ({
            where: () => createSelectChain([]),
            limit: () => createSelectChain([]),
          }),
        }),
        insert: () => ({
          values: () => {
            const p = Promise.resolve({ rowsAffected: 1 });
            const result: any = {};
            result.then = p.then.bind(p);
            return result;
          },
        }),
        update: () => ({
          set: () => {
            const p = Promise.resolve({ rowsAffected: 1 });
            const whereChain: any = {};
            whereChain.then = p.then.bind(p);
            return { where: () => whereChain };
          },
        }),
        delete: () => ({ where: () => Promise.resolve({ rowsAffected: 0 }) }),
        run: () => Promise.resolve({ rows: [] }),
      } as unknown as DbType;

      const { importCards } = await import("./admin-service");
      await expect(importCards(db, {
        productId: "missing",
        batchName: "Batch",
        cards: [{ accountLabel: "acc", deliverySecret: "secret" }],
      })).rejects.toThrow("商品不存在");
    });

    it("卡密为空且无有效数据时抛错", async () => {
      const db = {
        select: () => ({
          from: () => ({
            where: () => createSelectChain([{ id: "prod-1" }]),
            limit: () => createSelectChain([{ id: "prod-1" }]),
          }),
        }),
        insert: () => ({
          values: () => {
            const p = Promise.resolve({ rowsAffected: 1 });
            const result: any = {};
            result.then = p.then.bind(p);
            return result;
          },
        }),
        update: () => ({
          set: () => {
            const p = Promise.resolve({ rowsAffected: 1 });
            const whereChain: any = {};
            whereChain.then = p.then.bind(p);
            return { where: () => whereChain };
          },
        }),
        delete: () => ({ where: () => Promise.resolve({ rowsAffected: 0 }) }),
        run: () => Promise.resolve({ rows: [] }),
      } as unknown as DbType;

      const { importCards } = await import("./admin-service");
      await expect(importCards(db, {
        productId: "prod-1",
        batchName: "Batch",
        cards: [{ accountLabel: "   ", deliverySecret: "" }],
      })).rejects.toThrow("没有有效的卡密数据");
    });

    it("重复卡密应被拒绝", async () => {
      let selectCount = 0;
      const db = {
        select: () => {
          selectCount++;
          return {
            from: () => ({
              where: (_cond: unknown) => {
                // 第一次查询商品存在，第二次查询重复卡密返回已存在记录
                if (selectCount === 1) {
                  return createSelectChain([{ id: "prod-1" }]);
                }
                return createSelectChain([{ deliverySecret: "secret-1" }]);
              },
              limit: () => createSelectChain([{ id: "prod-1" }]),
            }),
          };
        },
        insert: () => ({
          values: () => {
            const p = Promise.resolve({ rowsAffected: 1 });
            const result: any = {};
            result.then = p.then.bind(p);
            return result;
          },
        }),
        update: () => ({
          set: () => {
            const p = Promise.resolve({ rowsAffected: 1 });
            const whereChain: any = {};
            whereChain.then = p.then.bind(p);
            return { where: () => whereChain };
          },
        }),
        delete: () => ({ where: () => Promise.resolve({ rowsAffected: 0 }) }),
        run: () => Promise.resolve({ rows: [] }),
      } as unknown as DbType;

      const { importCards } = await import("./admin-service");
      await expect(importCards(db, {
        productId: "prod-1",
        batchName: "Batch",
        cards: [
          { accountLabel: "acc-1", deliverySecret: "secret-1" },
          { accountLabel: "acc-2", deliverySecret: "secret-2" },
          { accountLabel: "acc-3", deliverySecret: "secret-3" },
        ],
      })).rejects.toThrow("已有");
    });

    it("成功导入应返回 batchId 和数量", async () => {
      const capturedValues: Record<string, unknown> = {};
      let selectCount = 0;
      const db = {
        select: () => {
          selectCount++;
          const fromChain = (_table?: unknown) => {
            // 第一次查询商品存在，第二次查询重复卡密为空
            if (selectCount === 1) {
              return createSelectChain([{ id: "prod-1" }]);
            }
            return createSelectChain([]);
          };
          const whereChain = (_cond?: unknown) => {
            if (selectCount === 1) {
              return createSelectChain([{ id: "prod-1" }]);
            }
            return createSelectChain([]);
          };
          return {
            from: fromChain,
            where: whereChain,
            limit: () => createSelectChain(selectCount === 1 ? [{ id: "prod-1" }] : []),
          };
        },
        insert: () => ({
          values: (values: Record<string, unknown>) => {
            capturedValues.values = values;
            const p = Promise.resolve({ rowsAffected: 1 });
            const result: any = { onConflictDoUpdate: () => p, onConflictDoNothing: () => p };
            result.then = p.then.bind(p);
            result.catch = p.catch.bind(p);
            result.finally = p.finally.bind(p);
            return result;
          },
        }),
        update: () => ({
          set: () => {
            const p = Promise.resolve({ rowsAffected: 1 });
            const whereChain: any = {};
            whereChain.then = p.then.bind(p);
            return { where: () => whereChain };
          },
        }),
        delete: () => ({ where: () => Promise.resolve({ rowsAffected: 0 }) }),
        run: () => Promise.resolve({ rows: [] }),
      } as unknown as DbType;

      const { importCards } = await import("./admin-service");
      const result = await importCards(db, {
        productId: "prod-1",
        batchName: "Batch A",
        cards: [
          { accountLabel: "acc-1", deliverySecret: "secret-1", deliveryNote: "note-1" },
          { accountLabel: "acc-2", deliverySecret: "secret-2", deliveryNote: "note-2" },
        ],
      });

      expect(result.imported).toBe(2);
      expect(result.batchId).toBeTruthy();
      expect(capturedValues.values).toBeTruthy();
    });
  });

  describe("generateGenericCards", () => {
    it("商品不存在时抛错", async () => {
      const db = {
        select: () => ({
          from: () => ({
            where: () => createSelectChain([]),
            limit: () => createSelectChain([]),
          }),
        }),
        insert: () => ({
          values: () => {
            const p = Promise.resolve({ rowsAffected: 1 });
            const result: any = {};
            result.then = p.then.bind(p);
            return result;
          },
        }),
        update: () => ({
          set: () => {
            const p = Promise.resolve({ rowsAffected: 1 });
            const whereChain: any = {};
            whereChain.then = p.then.bind(p);
            return { where: () => whereChain };
          },
        }),
        delete: () => ({ where: () => Promise.resolve({ rowsAffected: 0 }) }),
        run: () => Promise.resolve({ rows: [] }),
      } as unknown as DbType;

      const { generateGenericCards } = await import("./admin-service");
      await expect(generateGenericCards(db, {
        productId: "missing",
        count: 1,
        genericCode: "CODE123",
        batchName: "Batch",
      })).rejects.toThrow("商品不存在");
    });

    it("成功生成通用卡密应存入 batches + cards，deliverySecret 留空", async () => {
      const capturedBatch: Record<string, unknown> = {};
      const capturedCards: Record<string, unknown>[] = [];
      let batchInsertCalled = false;
      let cardsInsertCalled = false;

      const db = {
        select: () => ({
          from: () => ({
            where: () => createSelectChain([{ id: "prod-1" }]),
            limit: () => createSelectChain([{ id: "prod-1" }]),
          }),
        }),
        insert: () => {
          const self: any = {
            values: (values: Record<string, unknown>) => {
              if (!batchInsertCalled) {
                capturedBatch.values = values;
                batchInsertCalled = true;
              } else if (!cardsInsertCalled) {
                capturedCards.push(...(values as unknown as Record<string, unknown>[]));
                cardsInsertCalled = true;
              }
              const p = Promise.resolve({ rowsAffected: 1 });
              const result: any = {};
              result.then = p.then.bind(p);
              return result;
            },
          };
          return self;
        },
        update: () => ({
          set: () => {
            const p = Promise.resolve({ rowsAffected: 1 });
            const whereChain: any = {};
            whereChain.then = p.then.bind(p);
            return { where: () => whereChain };
          },
        }),
        delete: () => ({ where: () => Promise.resolve({ rowsAffected: 0 }) }),
        run: () => Promise.resolve({ rows: [] }),
      } as unknown as DbType;

      const { generateGenericCards } = await import("./admin-service");
      const result = await generateGenericCards(db, {
        productId: "prod-1",
        count: 3,
        genericCode: "GENERIC-CODE",
        batchName: "Generic Batch",
        expiresAt: "2026-12-31T23:59:59Z",
      });

      expect(result.generated).toBe(3);
      expect(result.batchId).toBeTruthy();
      expect(capturedBatch.values).toMatchObject({
        productId: "prod-1",
        name: "Generic Batch",
        source: "generated",
        totalCount: 3,
      });
      expect(capturedCards).toHaveLength(3);
      expect(capturedCards[0]).toMatchObject({
        accountLabel: "card-001",
        deliverySecret: "",
        deliveryNote: "GENERIC-CODE",
        status: "available",
      });
    });
  });
});

// ── 订单导出（游标分页 + hasMore）─────────────────────────────────

describe("admin-service - 订单导出", () => {
  describe("exportOrders", () => {
    it("无筛选条件应返回全部订单并正确计算 hasMore", async () => {
      const rows = Array.from({ length: 5 }, (_, i) => ({
        id: `order-${i}`,
        orderNo: `ORD-${i}`,
        createdAt: `2026-01-0${5 - i}T00:00:00Z`,
        amountCents: 1000,
      }));
      const db = {
        select: () => ({
          from: () => ({
            leftJoin: () => ({
              leftJoin: () => ({
                where: () => createSelectChain(rows),
                orderBy: () => createSelectChain(rows),
                limit: () => createSelectChain(rows),
              }),
            }),
          }),
        }),
        run: () => Promise.resolve({ rows: [] }),
      } as unknown as DbType;

      const { exportOrders } = await import("./admin-service");
      const result = await exportOrders(db, { status: "", productId: "", q: "", cursor: "", limit: 3 });

      expect(result.rows).toHaveLength(3);
      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).toBeTruthy();
    });

    it("cursor 分页应基于 createdAt + id 精确定位", async () => {
      const rows = [
        { id: "order-2", createdAt: "2026-01-03T00:00:00Z", amountCents: 1000 },
        { id: "order-1", createdAt: "2026-01-02T00:00:00Z", amountCents: 1000 },
      ];
      const db = {
        select: () => ({
          from: () => ({
            leftJoin: () => ({
              leftJoin: () => ({
                where: () => createSelectChain(rows),
                orderBy: () => createSelectChain(rows),
                limit: () => createSelectChain(rows),
              }),
            }),
          }),
        }),
        run: () => Promise.resolve({ rows: [] }),
      } as unknown as DbType;

      const { exportOrders } = await import("./admin-service");
      const result = await exportOrders(db, { status: "", productId: "", q: "", cursor: "2026-01-03T00:00:00Z::order-2", limit: 1 });

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].id).toBe("order-2");
    });
  });

  describe("exportFinance", () => {
    it("应正确汇总收入、发卡、余额消费和退款金额", async () => {
      const orderRows = [
        { id: "o1", amountCents: 2000, currency: "CNY", batchId: "b1", accountLabel: "acc", paymentMethod: "balance", status: "paid" },
        { id: "o2", amountCents: 1000, currency: "CNY", batchId: null, accountLabel: null, paymentMethod: "online", status: "refunded" },
        { id: "o3", amountCents: 500, currency: "CNY", batchId: "b2", accountLabel: "acc", paymentMethod: "online", status: "paid" },
        { id: "o4", amountCents: 900, currency: "JPY", batchId: null, accountLabel: null, paymentMethod: "online", status: "paid" },
      ];
      let selectCount = 0;
      const db = {
        select: () => {
          selectCount++;
          const fromChain = (_table?: unknown) => {
            return createSelectChain(selectCount === 1 ? orderRows : []);
          };
          return { from: fromChain };
        },
        run: () => Promise.resolve({ rows: [] }),
      } as unknown as DbType;

      const { exportFinance } = await import("./admin-service");
      const result = await exportFinance(db, { status: "", productId: "", q: "", cursor: "", limit: 10 });

      expect(result.summary.totalIncomeCents).toBe(3500);
      expect(result.summary.totalCardIssuedCents).toBe(2500); // o1 + o3
      expect(result.summary.totalBalanceSpentCents).toBe(2000); // o1
      expect(result.summary.totalRefundCents).toBe(1000); // o2
      expect(result.summary.currency).toBe("CNY");
      expect(result.summary.totalsByCurrency).toEqual({
        CNY: {
          totalIncomeCents: 3500,
          totalCardIssuedCents: 2500,
          totalBalanceSpentCents: 2000,
          totalRefundCents: 1000,
        },
        JPY: {
          totalIncomeCents: 900,
          totalCardIssuedCents: 0,
          totalBalanceSpentCents: 0,
          totalRefundCents: 0,
        },
      });
    });

    it("应返回余额变动流水", async () => {
      const txRows = [
        { id: "tx-1", amountCents: 1000, createdAt: "2026-01-01T00:00:00Z" },
      ];
      let selectCount = 0;
      const db = {
        select: () => {
          selectCount++;
          const fromChain = (_table?: unknown) => {
            if (selectCount === 1) {
              return createSelectChain([]);
            }
            return createSelectChain(txRows);
          };
          return { from: fromChain };
        },
        run: () => Promise.resolve({ rows: [] }),
      } as unknown as DbType;

      const { exportFinance } = await import("./admin-service");
      const result = await exportFinance(db, { status: "", productId: "", q: "", cursor: "", limit: 10 });

      expect(result.balanceTransactions).toHaveLength(1);
      expect(result.balanceTransactions[0].id).toBe("tx-1");
    });
  });
});

// ── 订单详情（含 orderItems + issuedCards JOIN）─────────────────────────

describe("admin-service - 订单详情", () => {
  it("订单不存在应返回 null", async () => {
    const db = {
      select: () => ({
        from: () => ({
          leftJoin: () => ({
            leftJoin: () => ({
              where: () => createSelectChain([]),
            }),
          }),
        }),
      }),
      insert: () => ({
        values: () => {
          const p = Promise.resolve({ rowsAffected: 1 });
          const result: any = {};
          result.then = p.then.bind(p);
          return result;
        },
      }),
      update: () => ({
        set: () => {
          const whereChain: any = {
            then: () => Promise.resolve({ rowsAffected: 1 }),
          };
          return { where: () => whereChain };
        },
      }),
      delete: () => ({ where: () => Promise.resolve({ rowsAffected: 0 }) }),
      run: () => Promise.resolve({ rows: [] }),
    } as unknown as DbType;

    const { getOrderDetail } = await import("./admin-service");
    const result = await getOrderDetail(db, "missing");
    expect(result).toBeNull();
  });

  it("订单存在时应包含 items、cards 和最近事件聚合字段", async () => {
    let selectCount = 0;
    const db = {
      select: () => {
        selectCount++;
        const fromChain = (_table?: unknown) => {
          if (selectCount === 1) {
            // 主订单查询
            return createSelectChain([{
              id: "order-1",
              orderNo: "ORD-1",
              productId: "prod-1",
              quantity: 2,
              amountCents: 2000,
              status: "paid",
              issuedCardId: "card-1",
              couponCode: "",
              campaignCode: "",
              referralCode: "",
              createdAt: "2026-01-01T00:00:00Z",
              paidAt: "2026-01-01T00:01:00Z",
              issuedAt: "2026-01-01T00:02:00Z",
              ipHash: "",
              userAgent: "",
              expiresAt: null,
              productTitle: "Test Product",
              fulfillmentMode: "card",
              accountLabel: "acc-1",
              deliverySecret: "secret-1",
              deliveryNote: "note-1",
              deliveryJson: "",
            }]);
          }
          if (selectCount === 2) {
            // orderItems
            return createSelectChain([
              { id: "item-1", productId: "prod-1", productTitle: "Test", fulfillmentMode: "virtual", quantity: 2, unitPriceCents: 1000, discountCents: 0, amountCents: 2000, deliveryJson: "" },
            ]);
          }
          if (selectCount === 3) {
            // issuedCards
            return createSelectChain([
              { id: "card-1", accountLabel: "acc-1", deliverySecret: "secret-1", deliveryNote: "note-1" },
            ]);
          }
          expect(_table).toBe(orderEvents);
          return createSelectChain([
            { id: "event-1", type: "notification_failed", message: "Telegram 支付成功通知发送失败", createdAt: "2026-01-01T00:03:00Z" },
          ]);
        };
        return { from: fromChain };
      },
      insert: () => ({
        values: () => {
          const p = Promise.resolve({ rowsAffected: 1 });
          const result: any = {};
          result.then = p.then.bind(p);
          return result;
        },
      }),
      update: () => ({
        set: () => {
          const whereChain: any = {
            then: () => Promise.resolve({ rowsAffected: 1 }),
          };
          return { where: () => whereChain };
        },
      }),
      delete: () => ({ where: () => Promise.resolve({ rowsAffected: 0 }) }),
      run: () => Promise.resolve({ rows: [] }),
    } as unknown as DbType;

    const { getOrderDetail } = await import("./admin-service");
    const result = await getOrderDetail(db, "order-1");

    expect(result).toBeTruthy();
    expect((result as any).id).toBe("order-1");
    expect((result as any).items).toHaveLength(1);
    expect((result as any).fulfillmentMode).toBe("virtual");
    expect((result as any).cards).toHaveLength(1);
    expect((result as any).cards[0].cardData).toBe("acc-1 / secret-1");
    expect((result as any).events).toEqual([
      expect.objectContaining({ type: "notification_failed", message: "Telegram 支付成功通知发送失败" }),
    ]);
  });
});

// ── 折扣码管理 ──────────────────────────────────────

describe("admin-service - 折扣码管理", () => {
  describe("getCouponList", () => {
    it("应返回分页折扣码列表并将 active 转为 boolean", async () => {
      let selectCount = 0;
      const db = {
        select: (cols: unknown) => ({
          from: (table: unknown) => {
            if (table === coupons) {
              selectCount += 1;
              if (selectCount === 1) {
                return createSelectChain([{ count: 2 }]);
              }
              return createSelectChain([
                { code: "c1", productId: "p1", productTitle: "P1", discountType: "fixed", discountValue: 100, maxUses: 10, usedCount: 1, active: 1, expiresAt: "2025-12-31", createdAt: "2025-01-01" },
                { code: "c2", productId: "", productTitle: null, discountType: "percent", discountValue: 10, maxUses: 5, usedCount: 0, active: 0, expiresAt: null, createdAt: "2025-01-02" },
              ]);
            }
            return createSelectChain([]);
          },
        }),
        run: () => Promise.resolve({ rows: [] }),
      } as unknown as DbType;

      const { getCouponList } = await import("./admin-service");
      const result = await getCouponList(db, { status: "", search: "", productId: "", page: 1, limit: 10 });

      expect(result.total).toBe(2);
      expect(result.results).toHaveLength(2);
      expect(result.results[0].active).toBe(true);
      expect(result.results[1].active).toBe(false);
    });
  });

  describe("upsertCoupon", () => {
    it("应插入新折扣码", async () => {
      let valuesCaptured: unknown[] = [];
      const db = {
        select: () => ({ from: () => createSelectChain([]) }),
        insert: () => ({
          values: (vals: unknown[]) => {
            valuesCaptured = vals;
            const p = Promise.resolve({ rowsAffected: 1 });
            const result: any = {};
            result.then = p.then.bind(p);
            result.catch = p.catch.bind(p);
            result.finally = p.finally.bind(p);
            result.onConflictDoUpdate = () => result;
            return result;
          },
          onConflictDoUpdate: () => Promise.resolve({ rowsAffected: 1 }),
        }),
        update: () => ({ set: () => ({ where: () => Promise.resolve({ rowsAffected: 1 }) }) }),
        delete: () => ({ where: () => Promise.resolve({ rowsAffected: 0 }) }),
        run: () => Promise.resolve({ rows: [] }),
      } as unknown as DbType;

      const { upsertCoupon } = await import("./admin-service");
      await upsertCoupon(db, { code: "TEST123", discountType: "fixed", discountValue: 500, maxUses: 10, active: true, productId: "p1" });

      expect((valuesCaptured as any).code).toBe("test123");
      expect((valuesCaptured as any).discountType).toBe("fixed");
    });
  });

  describe("generateCoupon", () => {
    it("成功时应返回生成的 codes 并插入数据库", async () => {
      let insertedValues: unknown[] = [];
      const db = {
        select: () => ({ from: () => createSelectChain([]) }),
        insert: () => ({
          values: (vals: unknown[]) => {
            insertedValues = vals;
            return Promise.resolve({ rowsAffected: 1 }) as any;
          },
        }),
        update: () => ({ set: () => ({ where: () => Promise.resolve({ rowsAffected: 1 }) }) }),
        delete: () => ({ where: () => Promise.resolve({ rowsAffected: 0 }) }),
        run: () => Promise.resolve({ rows: [] }),
      } as unknown as DbType;

      const { generateCoupon } = await import("./admin-service");
      const codes = await generateCoupon(db, { productId: "p1", discountType: "percent", discountValue: 10, maxUses: 5, active: true, count: 3 });

      expect(codes).toHaveLength(3);
      expect(insertedValues).toHaveLength(3);
    });
  });

  describe("updateCoupon", () => {
    it("应更新折扣码字段", async () => {
      let capturedSet: Record<string, unknown> = {};
      const db = {
        select: () => ({ from: () => createSelectChain([]) }),
        insert: () => ({ values: () => Promise.resolve({ rowsAffected: 1 }), onConflictDoUpdate: () => Promise.resolve({ rowsAffected: 1 }) }),
        update: () => ({
          set: (vals: Record<string, unknown>) => {
            capturedSet = vals;
            return { where: () => Promise.resolve({ rowsAffected: 1 }) };
          },
        }),
        delete: () => ({ where: () => Promise.resolve({ rowsAffected: 0 }) }),
        run: () => Promise.resolve({ rows: [] }),
      } as unknown as DbType;

      const { updateCoupon } = await import("./admin-service");
      await updateCoupon(db, "test123", { discountValue: 200, active: false });

      expect(capturedSet.discountValue).toBe(200);
      expect(capturedSet.active).toBe(0);
    });
  });
});

// ── 批次列表 ──────────────────────────────────────

describe("admin-service - 批次列表", () => {
  it("应返回批次列表并包含卡密计数子查询", async () => {
    const db = {
      select: (cols: unknown) => ({
        from: (table: unknown) => {
          if (table === cardBatches) {
            return createSelectChain([
              { id: "batch-1", productId: "p1", productTitle: "P1", name: "B1", totalCount: 10, createdAt: "2025-01-01", availableCount: 5, issuedCount: 3, disabledCount: 2 },
            ]);
          }
          return createSelectChain([]);
        },
      }),
      insert: () => ({ values: () => Promise.resolve({ rowsAffected: 1 }), onConflictDoUpdate: () => Promise.resolve({ rowsAffected: 1 }) }),
      update: () => ({ set: () => ({ where: () => Promise.resolve({ rowsAffected: 1 }) }) }),
      delete: () => ({ where: () => Promise.resolve({ rowsAffected: 0 }) }),
      run: () => Promise.resolve({ rows: [] }),
    } as unknown as DbType;

    const { getBatchList } = await import("./admin-service");
    const result = await getBatchList(db, "p1");

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("batch-1");
    expect(result[0].availableCount).toBe(5);
  });
});

// ── 合并日志 ──────────────────────────────────────

describe("admin-service - 合并日志", () => {
  it("应合并 request_logs 和 admin_audit_logs", async () => {
    let runCalls = 0;
    const db = {
      select: (cols: unknown) => ({
        from: (table: unknown) => {
          return createSelectChain([]);
        },
      }),
      insert: () => ({ values: () => Promise.resolve({ rowsAffected: 1 }), onConflictDoUpdate: () => Promise.resolve({ rowsAffected: 1 }) }),
      update: () => ({ set: () => ({ where: () => Promise.resolve({ rowsAffected: 1 }) }) }),
      delete: () => ({ where: () => Promise.resolve({ rowsAffected: 0 }) }),
      run: (...args: unknown[]) => {
        runCalls += 1;
        if (runCalls === 1) return Promise.resolve({ rows: [{ count: 5 }] }) as any;
        return Promise.resolve({ rows: [
          { type: "request", method: "GET", path: "/api", action: null, statusCode: 200, createdAt: "2025-01-01T00:00:00Z" },
          { type: "admin", method: null, path: null, action: "update_product", statusCode: null, createdAt: "2025-01-01T01:00:00Z" },
        ]}) as any;
      },
    } as unknown as DbType;

    const { getMergedLogs } = await import("./admin-service");
    const result = await getMergedLogs(db, 10);

    expect(runCalls).toBe(2);
    expect(result.total).toBe(5);
    expect(result.logs).toHaveLength(2);
    expect(result.logs[0].type).toBe("request");
    expect(result.logs[1].type).toBe("admin");
    expect(result.hasMore).toBe(false);
  });

  it("redacts historical sensitive system config values from merged logs", async () => {
    let runCalls = 0;
    const db = {
      run: () => {
        runCalls += 1;
        if (runCalls === 1) return Promise.resolve({ rows: [{ count: 1 }] }) as any;
        return Promise.resolve({ rows: [{
          type: "admin",
          action: "update_system_config",
          targetType: "system_config",
          targetId: "turnstile_secret_key",
          metadata: JSON.stringify({ key: "turnstile_secret_key", value: "historical-secret" }),
          createdAt: "2025-01-01T01:00:00Z",
        }] }) as any;
      },
    } as unknown as DbType;

    const { getMergedLogs } = await import("./admin-service");
    const result = await getMergedLogs(db, 10);

    expect(result.logs[0].metadata).toEqual({ key: "turnstile_secret_key" });
    expect(JSON.stringify(result.logs)).not.toContain("historical-secret");
  });
});

// ── 系统配置 ──────────────────────────────────────

describe("admin-service - 系统配置", () => {
  it("getSystemConfig 应读取并构建配置映射", async () => {
    const db = {
      select: (cols: unknown) => ({
        from: (table: unknown) => {
          if (table === systemConfig) {
            return createSelectChain([
              { key: "site_name", value: "My Shop" },
              { key: "contact_email", value: "admin@example.com" },
            ]);
          }
          return createSelectChain([]);
        },
      }),
      insert: () => ({ values: () => Promise.resolve({ rowsAffected: 1 }), onConflictDoUpdate: () => Promise.resolve({ rowsAffected: 1 }) }),
      update: () => ({ set: () => ({ where: () => Promise.resolve({ rowsAffected: 1 }) }) }),
      delete: () => ({ where: () => Promise.resolve({ rowsAffected: 0 }) }),
      run: () => Promise.resolve({ rows: [] }),
    } as unknown as DbType;

    const { getSystemConfig } = await import("./admin-service");
    const result = await getSystemConfig(db);

    expect(result).toEqual({ site_name: "My Shop", contact_email: "admin@example.com" });
  });

  it("upsertSystemConfig 应插入或更新配置", async () => {
    let capturedValues: Record<string, unknown> = {};
    const db = {
      select: () => ({ from: () => createSelectChain([]) }),
      insert: () => ({
        values: (vals: Record<string, unknown>) => {
          capturedValues = vals;
          const p = Promise.resolve({ rowsAffected: 1 });
          const result: any = {};
          result.then = p.then.bind(p);
          result.catch = p.catch.bind(p);
          result.finally = p.finally.bind(p);
          result.onConflictDoUpdate = () => result;
          return result;
        },
        onConflictDoUpdate: () => Promise.resolve({ rowsAffected: 1 }),
      }),
      update: () => ({ set: () => ({ where: () => Promise.resolve({ rowsAffected: 1 }) }) }),
      delete: () => ({ where: () => Promise.resolve({ rowsAffected: 0 }) }),
      run: () => Promise.resolve({ rows: [] }),
    } as unknown as DbType;

    const { upsertSystemConfig } = await import("./admin-service");
    await upsertSystemConfig(db, "site_name", "New Shop");

    expect(capturedValues.key).toBe("site_name");
    expect(capturedValues.value).toBe("New Shop");
  });

  it("upsertSystemConfig encrypts sensitive values before persistence", async () => {
    let capturedValues: Record<string, unknown> = {};
    const db = {
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          capturedValues = values;
          return {
            onConflictDoUpdate: () => Promise.resolve({ rowsAffected: 1 }),
          };
        },
      }),
    } as unknown as DbType;

    const { upsertSystemConfig } = await import("./admin-service");
    await upsertSystemConfig(db, "resend_api_key", "private-resend-key", "a".repeat(64));

    expect(capturedValues.value).toMatch(/^enc:v1:/);
    expect(String(capturedValues.value)).not.toContain("private-resend-key");
  });

  it("deleteSystemConfig 应删除配置", async () => {
    let capturedWhere: unknown;
    const db = {
      select: () => ({ from: () => createSelectChain([]) }),
      insert: () => ({ values: () => Promise.resolve({ rowsAffected: 1 }), onConflictDoUpdate: () => Promise.resolve({ rowsAffected: 1 }) }),
      update: () => ({ set: () => ({ where: () => Promise.resolve({ rowsAffected: 1 }) }) }),
      delete: () => ({
        where: (cond: unknown) => {
          capturedWhere = cond;
          return Promise.resolve({ rowsAffected: 1 });
        },
      }),
      run: () => Promise.resolve({ rows: [] }),
    } as unknown as DbType;

    const { deleteSystemConfig } = await import("./admin-service");
    await deleteSystemConfig(db, "site_name");

    expect(capturedWhere).toBeTruthy();
  });
});

// ── 营销活动管理 ──────────────────────────────────

describe("admin-service - 营销活动管理", () => {
  it("getCampaignList 应返回活动列表并将 active 转为 boolean", async () => {
    const db = {
      select: () => ({
        from: (table: unknown) => {
          if (table === campaigns) {
            return createSelectChain([
              { code: "c1", name: "Campaign 1", active: 1, startsAt: "2025-01-01", endsAt: "2025-12-31", metadataJson: "{}", createdAt: "2025-01-01" },
              { code: "c2", name: "Campaign 2", active: 0, startsAt: null, endsAt: null, metadataJson: "{}", createdAt: "2025-01-02" },
            ]);
          }
          return createSelectChain([]);
        },
      }),
      insert: () => ({ values: () => Promise.resolve({ rowsAffected: 1 }), onConflictDoUpdate: () => Promise.resolve({ rowsAffected: 1 }) }),
      update: () => ({ set: () => ({ where: () => Promise.resolve({ rowsAffected: 1 }) }) }),
      delete: () => ({ where: () => Promise.resolve({ rowsAffected: 0 }) }),
      run: () => Promise.resolve({ rows: [] }),
    } as unknown as DbType;

    const { getCampaignList } = await import("./admin-service");
    const result = await getCampaignList(db);

    expect(result).toHaveLength(2);
    expect(result[0].active).toBe(true);
    expect(result[1].active).toBe(false);
  });

  it("createCampaign 应插入活动", async () => {
    let capturedValues: Record<string, unknown> = {};
    const db = {
      select: () => ({ from: () => createSelectChain([]) }),
      insert: () => ({
        values: (vals: Record<string, unknown>) => {
          capturedValues = vals;
          return Promise.resolve({ rowsAffected: 1 }) as any;
        },
      }),
      update: () => ({ set: () => ({ where: () => Promise.resolve({ rowsAffected: 1 }) }) }),
      delete: () => ({ where: () => Promise.resolve({ rowsAffected: 0 }) }),
      run: () => Promise.resolve({ rows: [] }),
    } as unknown as DbType;

    const { createCampaign } = await import("./admin-service");
    await createCampaign(db, { code: "camp1", name: "Campaign 1", active: true });

    expect(capturedValues.code).toBe("camp1");
    expect(capturedValues.active).toBe(1);
  });

  it("updateCampaign 应更新活动字段", async () => {
    let capturedSet: Record<string, unknown> = {};
    const db = {
      select: () => ({ from: () => createSelectChain([]) }),
      insert: () => ({ values: () => Promise.resolve({ rowsAffected: 1 }), onConflictDoUpdate: () => Promise.resolve({ rowsAffected: 1 }) }),
      update: () => ({
        set: (vals: Record<string, unknown>) => {
          capturedSet = vals;
          return { where: () => Promise.resolve({ rowsAffected: 1 }) };
        },
      }),
      delete: () => ({ where: () => Promise.resolve({ rowsAffected: 0 }) }),
      run: () => Promise.resolve({ rows: [] }),
    } as unknown as DbType;

    const { updateCampaign } = await import("./admin-service");
    await updateCampaign(db, "camp1", { name: "Updated Name" });

    expect(capturedSet.name).toBe("Updated Name");
  });

  it("deleteCampaign 应删除活动", async () => {
    let capturedWhere: unknown;
    const db = {
      select: () => ({ from: () => createSelectChain([]) }),
      insert: () => ({ values: () => Promise.resolve({ rowsAffected: 1 }), onConflictDoUpdate: () => Promise.resolve({ rowsAffected: 1 }) }),
      update: () => ({ set: () => ({ where: () => Promise.resolve({ rowsAffected: 1 }) }) }),
      delete: () => ({
        where: (cond: unknown) => {
          capturedWhere = cond;
          return Promise.resolve({ rowsAffected: 1 });
        },
      }),
      run: () => Promise.resolve({ rows: [] }),
    } as unknown as DbType;

    const { deleteCampaign } = await import("./admin-service");
    await deleteCampaign(db, "camp1");

    expect(capturedWhere).toBeTruthy();
  });
});

// ── 推荐码管理 ──────────────────────────────────

describe("admin-service - 推荐码管理", () => {
  it("getReferralCodeList 应返回推荐码列表", async () => {
    const db = {
      select: () => ({
        from: (table: unknown) => {
          if (table === referralCodes) {
            return createSelectChain([
              { code: "ref1", ownerContact: "user@test.com", rewardType: "fixed", rewardValue: 100, active: 1, createdAt: "2025-01-01", useCount: 5 },
            ]);
          }
          return createSelectChain([]);
        },
      }),
      insert: () => ({ values: () => Promise.resolve({ rowsAffected: 1 }), onConflictDoUpdate: () => Promise.resolve({ rowsAffected: 1 }) }),
      update: () => ({ set: () => ({ where: () => Promise.resolve({ rowsAffected: 1 }) }) }),
      delete: () => ({ where: () => Promise.resolve({ rowsAffected: 0 }) }),
      run: () => Promise.resolve({ rows: [] }),
    } as unknown as DbType;

    const { getReferralCodeList } = await import("./admin-service");
    const result = await getReferralCodeList(db);

    expect(result).toHaveLength(1);
    expect(result[0].active).toBe(true);
    expect(result[0].useCount).toBe(5);
  });

  it("createReferralCode 应插入推荐码", async () => {
    let capturedValues: Record<string, unknown> = {};
    const db = {
      select: () => ({ from: () => createSelectChain([]) }),
      insert: () => ({
        values: (vals: Record<string, unknown>) => {
          capturedValues = vals;
          return Promise.resolve({ rowsAffected: 1 }) as any;
        },
      }),
      update: () => ({ set: () => ({ where: () => Promise.resolve({ rowsAffected: 1 }) }) }),
      delete: () => ({ where: () => Promise.resolve({ rowsAffected: 0 }) }),
      run: () => Promise.resolve({ rows: [] }),
    } as unknown as DbType;

    const { createReferralCode } = await import("./admin-service");
    await createReferralCode(db, { code: "ref1", ownerContact: "user@test.com", rewardType: "fixed", rewardValue: 100, active: true });

    expect(capturedValues.code).toBe("ref1");
    expect(capturedValues.rewardType).toBe("fixed");
  });

  it("updateReferralCode 应更新推荐码", async () => {
    let capturedSet: Record<string, unknown> = {};
    const db = {
      select: () => ({ from: () => createSelectChain([]) }),
      insert: () => ({ values: () => Promise.resolve({ rowsAffected: 1 }), onConflictDoUpdate: () => Promise.resolve({ rowsAffected: 1 }) }),
      update: () => ({
        set: (vals: Record<string, unknown>) => {
          capturedSet = vals;
          return { where: () => Promise.resolve({ rowsAffected: 1 }) };
        },
      }),
      delete: () => ({ where: () => Promise.resolve({ rowsAffected: 0 }) }),
      run: () => Promise.resolve({ rows: [] }),
    } as unknown as DbType;

    const { updateReferralCode } = await import("./admin-service");
    await updateReferralCode(db, "ref1", { rewardValue: 200 });

    expect(capturedSet.rewardValue).toBe(200);
  });

  it("deleteReferralCode 应删除推荐码", async () => {
    let capturedWhere: unknown;
    const db = {
      select: () => ({ from: () => createSelectChain([]) }),
      insert: () => ({ values: () => Promise.resolve({ rowsAffected: 1 }), onConflictDoUpdate: () => Promise.resolve({ rowsAffected: 1 }) }),
      update: () => ({ set: () => ({ where: () => Promise.resolve({ rowsAffected: 1 }) }) }),
      delete: () => ({
        where: (cond: unknown) => {
          capturedWhere = cond;
          return Promise.resolve({ rowsAffected: 1 });
        },
      }),
      run: () => Promise.resolve({ rows: [] }),
    } as unknown as DbType;

    const { deleteReferralCode } = await import("./admin-service");
    await deleteReferralCode(db, "ref1");

    expect(capturedWhere).toBeTruthy();
  });
});

// ── 卡密编辑 ──────────────────────────────────────

describe("admin-service - 卡密编辑", () => {
  it("updateCard 应更新卡密字段并返回 id", async () => {
    let capturedSet: Record<string, unknown> = {};
    const db = {
      select: () => ({
        from: () => ({
          where: () => createSelectChain([{ id: "card-1" }]),
        }),
      }),
      insert: () => ({ values: () => Promise.resolve({ rowsAffected: 1 }), onConflictDoUpdate: () => Promise.resolve({ rowsAffected: 1 }) }),
      update: () => ({
        set: (vals: Record<string, unknown>) => {
          capturedSet = vals;
          return { where: () => Promise.resolve({ rowsAffected: 1 }) };
        },
      }),
      delete: () => ({ where: () => Promise.resolve({ rowsAffected: 0 }) }),
      run: () => Promise.resolve({ rows: [] }),
    } as unknown as DbType;

    const { updateCard } = await import("./admin-service");
    const result = await updateCard(db, "card-1", { accountLabel: "new-acc", deliveryNote: "new note" });

    expect(result).toEqual({ id: "card-1" });
    expect(capturedSet.accountLabel).toBe("new-acc");
    expect(capturedSet.deliveryNote).toBe("new note");
  });

  it("updateCard 卡密不存在时应返回 null", async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: () => createSelectChain([]),
        }),
      }),
      insert: () => ({ values: () => Promise.resolve({ rowsAffected: 1 }), onConflictDoUpdate: () => Promise.resolve({ rowsAffected: 1 }) }),
      update: () => ({ set: () => ({ where: () => Promise.resolve({ rowsAffected: 1 }) }) }),
      delete: () => ({ where: () => Promise.resolve({ rowsAffected: 0 }) }),
      run: () => Promise.resolve({ rows: [] }),
    } as unknown as DbType;

    const { updateCard } = await import("./admin-service");
    const result = await updateCard(db, "card-none", { accountLabel: "x" });

    expect(result).toBeNull();
  });
});

// ── 删除商品 ──────────────────────────────────────

describe("admin-service - 删除商品", () => {
  it("有关联订单时应阻止删除", async () => {
    const db = {
      select: () => ({
        from: (table: unknown) => {
          if (table === orders) return createSelectChain([{ count: 2 }]);
          if (table === cards) return createSelectChain([{ count: 0 }]);
          return createSelectChain([]);
        },
      }),
      insert: () => ({ values: () => Promise.resolve({ rowsAffected: 1 }), onConflictDoUpdate: () => Promise.resolve({ rowsAffected: 1 }) }),
      update: () => ({ set: () => ({ where: () => Promise.resolve({ rowsAffected: 1 }) }) }),
      delete: () => ({ where: () => Promise.resolve({ rowsAffected: 0 }) }),
      run: () => Promise.resolve({ rows: [] }),
    } as unknown as DbType;

    const { deleteProduct } = await import("./admin-service");
    const result = await deleteProduct(db, "prod-1");

    expect(result.deleted).toBe(false);
    expect(result.reason).toContain("关联订单");
  });

  it("有关联卡密时应阻止删除", async () => {
    const db = {
      select: () => ({
        from: (table: unknown) => {
          if (table === orders) return createSelectChain([{ count: 0 }]);
          if (table === cards) return createSelectChain([{ count: 3 }]);
          return createSelectChain([]);
        },
      }),
      insert: () => ({ values: () => Promise.resolve({ rowsAffected: 1 }), onConflictDoUpdate: () => Promise.resolve({ rowsAffected: 1 }) }),
      update: () => ({ set: () => ({ where: () => Promise.resolve({ rowsAffected: 1 }) }) }),
      delete: () => ({ where: () => Promise.resolve({ rowsAffected: 0 }) }),
      run: () => Promise.resolve({ rows: [] }),
    } as unknown as DbType;

    const { deleteProduct } = await import("./admin-service");
    const result = await deleteProduct(db, "prod-1");

    expect(result.deleted).toBe(false);
    expect(result.reason).toContain("关联卡密");
  });

  it("无关联数据时应成功删除", async () => {
    const db = {
      select: () => ({
        from: (table: unknown) => {
          if (table === orders) return createSelectChain([{ count: 0 }]);
          if (table === cards) return createSelectChain([{ count: 0 }]);
          return createSelectChain([]);
        },
      }),
      insert: () => ({ values: () => Promise.resolve({ rowsAffected: 1 }), onConflictDoUpdate: () => Promise.resolve({ rowsAffected: 1 }) }),
      update: () => ({ set: () => ({ where: () => Promise.resolve({ rowsAffected: 1 }) }) }),
      delete: () => ({
        where: () => Promise.resolve({ rowsAffected: 1 }),
      }),
      run: () => Promise.resolve({ rows: [] }),
    } as unknown as DbType;

    const { deleteProduct } = await import("./admin-service");
    const result = await deleteProduct(db, "prod-1");

    expect(result.deleted).toBe(true);
  });
});

// ── 删除折扣码 ──────────────────────────────────────

describe("admin-service - 删除折扣码", () => {
  it("deleteCoupon 应删除折扣码", async () => {
    let capturedWhere: unknown;
    const db = {
      select: () => ({ from: () => createSelectChain([]) }),
      insert: () => ({ values: () => Promise.resolve({ rowsAffected: 1 }), onConflictDoUpdate: () => Promise.resolve({ rowsAffected: 1 }) }),
      update: () => ({ set: () => ({ where: () => Promise.resolve({ rowsAffected: 1 }) }) }),
      delete: () => ({
        where: (cond: unknown) => {
          capturedWhere = cond;
          return Promise.resolve({ rowsAffected: 1 });
        },
      }),
      run: () => Promise.resolve({ rows: [] }),
    } as unknown as DbType;

    const { deleteCoupon } = await import("./admin-service");
    await deleteCoupon(db, "test123");

    expect(capturedWhere).toBeTruthy();
  });
});
