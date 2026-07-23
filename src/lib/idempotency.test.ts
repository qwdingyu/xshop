import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkIdempotency, clearCachedIdempotentResponse, clearPendingIdempotency, hashIdempotencyRequest, saveIdempotentResponse } from "./idempotency";

const REQUEST_HASH = "a".repeat(64);
const LEASE_VERSION = "2026-07-16T00:00:00.000Z";

// ---------------------------------------------------------------------------
// 幂等键模块单元测试 — ORM 版本
// ---------------------------------------------------------------------------
// idempotency 的函数签名是 (db: DbType, key, action, ...)
// DbType 即 Drizzle ORM 实例。测试直接传入 ORM mock 对象即可。

const state: {
  rows: Array<{ responseJson: string; requestHash?: string; resourceId?: string }>;
  inserted: Array<Record<string, unknown>>;
  /** 模拟 UPSERT 冲突行为：true = 首次插入，false = 冲突（已存在） */
  isFirstInsert: boolean;
  /** 已存在的缓存响应（冲突时返回） */
  existingResponseJson: string;
  reclaimedRowsAffected: number;
  savedRowsAffected: number;
} = {
  rows: [],
  inserted: [],
  isFirstInsert: true,
  existingResponseJson: "",
  reclaimedRowsAffected: 0,
  savedRowsAffected: 1,
};

function createMockDb() {
  return {
    select: (_colMap?: unknown) => ({
      from: (_table?: unknown) => ({
        where: () => ({
          limit: () => Promise.resolve(state.rows.map((row) => ({
            requestHash: row.requestHash ?? REQUEST_HASH,
            resourceId: row.resourceId ?? "",
            ...row,
          }))),
        }),
      }),
    }),
    insert: (_table?: unknown) => ({
      values: (data: Record<string, unknown>) => {
        state.inserted.push(data);
        return {
          onConflictDoNothing: (_cfg?: unknown) => {
            const result = state.isFirstInsert ? [{ responseJson: "__pending__" }] : [];
            // 支持 .returning() 链式调用和直接 await 两种模式
            const thenable = {
              returning: () => Promise.resolve(result),
              then: (resolve: (v: unknown) => void) => Promise.resolve(result).then(resolve),
            };
            return thenable;
          },
          onConflictDoUpdate: (_cfg?: unknown) => Promise.resolve({ rowsAffected: 1 }),
        };
      },
    }),
    update: (_table?: unknown) => ({
      set: (data: Record<string, unknown>) => {
        state.inserted.push(data);
        return {
          where: () => Promise.resolve({
            rowsAffected: "responseJson" in data ? state.savedRowsAffected : state.reclaimedRowsAffected,
          }),
        };
      },
    }),
    delete: (_table?: unknown) => ({
      where: () => Promise.resolve({ rowsAffected: 0 }),
    }),
    run: () => Promise.resolve({ rows: [] }),
  };
}

function setRows(rows: Array<{ responseJson: string }>) {
  state.rows = rows;
}

function clearInserted() {
  state.inserted.length = 0;
}

function resetState() {
  state.rows = [];
  state.inserted = [];
  state.isFirstInsert = true;
  state.existingResponseJson = "";
  state.reclaimedRowsAffected = 0;
  state.savedRowsAffected = 1;
}

// ---------------------------------------------------------------------------
// checkIdempotency — 原子 UPSERT 版本
// ---------------------------------------------------------------------------

describe("checkIdempotency", () => {
  beforeEach(() => {
    resetState();
  });

  it("首次插入返回 shouldProceed=true，cachedResponse=null", async () => {
    state.isFirstInsert = true;
    const db = createMockDb();
    const result = await checkIdempotency(db as any, "key-new", "create_order", REQUEST_HASH);
    expect(result.shouldProceed).toBe(true);
    expect(result.cachedResponse).toBeNull();
  });

  it("冲突时返回 shouldProceed=false，cachedResponse 为已缓存响应", async () => {
    state.isFirstInsert = false;
    const cachedResponse = JSON.stringify({ ok: true, orderId: "order-123" });
    state.existingResponseJson = cachedResponse;
    state.rows = [{ responseJson: cachedResponse }];
    const db = createMockDb();
    const result = await checkIdempotency(db as any, "key-existing", "create_order", REQUEST_HASH);
    expect(result.shouldProceed).toBe(false);
    expect(result.cachedResponse).toBe(cachedResponse);
    expect(result.pending).toBe(false);
  });

  it("冲突时已有请求仍在处理中，不应继续执行业务逻辑", async () => {
    state.isFirstInsert = false;
    state.existingResponseJson = "__pending__";
    state.rows = [{ responseJson: "__pending__" }];
    const db = createMockDb();
    const result = await checkIdempotency(db as any, "key-pending", "pay_unified", REQUEST_HASH);
    expect(result.shouldProceed).toBe(false);
    expect(result.cachedResponse).toBeNull();
    expect(result.pending).toBe(true);
  });

  it("原子回收超时的 pending 租约，允许中断后的请求继续", async () => {
    state.isFirstInsert = false;
    state.rows = [{ responseJson: "__pending__" }];
    state.reclaimedRowsAffected = 1;

    const result = await checkIdempotency(createMockDb() as any, "key-stale", "pay_unified", REQUEST_HASH);

    expect(result).toEqual({
      shouldProceed: true,
      cachedResponse: null,
      pending: false,
      requestMismatch: false,
      resourceId: "",
      leaseVersion: expect.any(String),
    });
  });

  it("拒绝同一幂等键绑定到不同请求摘要", async () => {
    state.isFirstInsert = false;
    state.rows = [{ responseJson: '{"orderId":"order-1"}', requestHash: "b".repeat(64), resourceId: "order-1" }];

    const result = await checkIdempotency(createMockDb() as any, "key-reused", "pay_unified", REQUEST_HASH);

    expect(result.requestMismatch).toBe(true);
    expect(result.cachedResponse).toBeNull();
    expect(result.shouldProceed).toBe(false);
  });

  it("冲突时空字符串视为已缓存响应（非哨兵值）", async () => {
    // 极端场景：冲突且 responseJson 为空字符串
    // 空字符串不是哨兵 "__pending__"，因此视为已缓存响应
    state.isFirstInsert = false;
    state.existingResponseJson = "";
    state.rows = [{ responseJson: "" }];
    const db = createMockDb();
    const result = await checkIdempotency(db as any, "key-edge", "create_order", REQUEST_HASH);
    expect(result.shouldProceed).toBe(false);
    expect(result.cachedResponse).toBe("");
  });

  it("冲突时非空 JSON 响应正确返回", async () => {
    state.isFirstInsert = false;
    state.existingResponseJson = '{"ok":true,"order":{"id":"ord-456"}}';
    state.rows = [{ responseJson: '{"ok":true,"order":{"id":"ord-456"}}' }];
    const db = createMockDb();
    const result = await checkIdempotency(db as any, "key-json", "pay_unified", REQUEST_HASH);
    expect(result.shouldProceed).toBe(false);
    expect(result.cachedResponse).toBe('{"ok":true,"order":{"id":"ord-456"}}');
  });

  it("不同 action 的幂等键互不影响", async () => {
    // create_order 的 key
    state.isFirstInsert = true;
    const db1 = createMockDb();
    const r1 = await checkIdempotency(db1 as any, "same-key", "create_order", REQUEST_HASH);
    expect(r1.shouldProceed).toBe(true);

    // pay_unified 的同一个 key（不同 action）
    state.isFirstInsert = true;
    const db2 = createMockDb();
    const r2 = await checkIdempotency(db2 as any, "same-key", "pay_unified", REQUEST_HASH);
    expect(r2.shouldProceed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// saveIdempotentResponse
// ---------------------------------------------------------------------------
// saveIdempotentResponse 使用 db.insert().values().onConflictDoUpdate()

describe("saveIdempotentResponse", () => {
  beforeEach(() => {
    setRows([]);
    clearInserted();
  });

  it("通过 ORM insert 保存响应", async () => {
    clearInserted();
    const db = createMockDb();
    const response = { ok: true, order: { id: "order-new" } };
    await saveIdempotentResponse(db as any, "key-new", "create_order", REQUEST_HASH, LEASE_VERSION, "order-new", response);
    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0]).toHaveProperty("resourceId", "order-new");
    expect(state.inserted[0]).toHaveProperty("responseJson", JSON.stringify(response));
  });

  it("通过 ORM insert 更新已有 key", async () => {
    clearInserted();
    const db = createMockDb();
    const response = { ok: true, updated: true };
    await saveIdempotentResponse(db as any, "key-existing", "create_order", REQUEST_HASH, LEASE_VERSION, "order-updated", response);
    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0]).toHaveProperty("resourceId", "order-updated");
    expect(state.inserted[0]).toHaveProperty("responseJson", JSON.stringify(response));
  });

  it("序列化响应为 JSON 字符串", async () => {
    clearInserted();
    const db = createMockDb();
    const response = { ok: true, nested: { a: 1, b: [2, 3] } };
    await saveIdempotentResponse(db as any, "key-json", "pay_order", REQUEST_HASH, LEASE_VERSION, "order-1", response);
    expect(state.inserted[0].responseJson).toBe('{"ok":true,"nested":{"a":1,"b":[2,3]}}');
  });
});

describe("clearPendingIdempotency", () => {
  beforeEach(() => {
    clearInserted();
  });

  it("deletes only the pending sentinel record for a retryable failed request", async () => {
    const db = createMockDb();
    await clearPendingIdempotency(db as any, "key-pending", "pay_unified", REQUEST_HASH, LEASE_VERSION);
    expect(state.inserted).toHaveLength(0);
  });
});

describe("clearCachedIdempotentResponse", () => {
  it("deletes only the exact recovery response for a completed failed attempt", async () => {
    const db = createMockDb();
    const deleteWhere = vi.fn(() => Promise.resolve({ rowsAffected: 1 }));
    (db as any).delete = vi.fn(() => ({ where: deleteWhere }));

    await clearCachedIdempotentResponse(
      db as any,
      "balance-key",
      "pay_unified",
      REQUEST_HASH,
      LEASE_VERSION,
      { mode: "balance", status: "pending", orderId: "order-1" },
    );

    expect(deleteWhere).toHaveBeenCalledTimes(1);
  });
});

describe("hashIdempotencyRequest", () => {
  it("produces the same digest regardless of object key order", async () => {
    await expect(hashIdempotencyRequest({ quantity: 1, productId: "p1" })).resolves.toBe(
      await hashIdempotencyRequest({ productId: "p1", quantity: 1 }),
    );
  });
});
