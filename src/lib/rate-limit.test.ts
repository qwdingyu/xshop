import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { enforceRateLimit, releaseCooldown, reserveCooldown, writeRequestLog } from "./rate-limit";
import type { DbType } from "../db/client";
import type { Context } from "hono";
import type { AppEnv } from "../bindings";

// ---------------------------------------------------------------------------
// 限流模块单元测试 — 原子 upsert 版本
// ---------------------------------------------------------------------------
// rate-limit 使用 insert().values().onConflictDoUpdate().returning() 原子 upsert。
// enforceRateLimit 和 writeRequestLog 通过 getDb(c) 获取 ORM 实例。
// 我们 mock 上下文的 c.get("db") 返回 ORM mock 对象。

// ── Mutable state via globalThis ──
// vi.mock 工厂函数会被 hoist 到模块顶部，在 const/let 声明之前执行。
// 使用 globalThis 存储状态，保证 mock 工厂和测试代码都能可靠读写。
(globalThis as any).__rateLimitMockState = {
  upsertCount: 0,
  insertedLogs: [] as unknown[],
  runResults: [] as unknown[],
  runCalls: [] as unknown[],
};

const state = (globalThis as any).__rateLimitMockState;

afterEach(() => {
  vi.useRealTimers();
});

// ── Mock drizzle-orm (all subpaths) ──
// rate-limit.ts 导入 sql from "drizzle-orm"，client.ts 导入 drizzle from
// "drizzle-orm/d1" 和 "drizzle-orm/libsql"。必须 mock 所有子路径，否则真实模块
// 会在测试环境加载并抛出原生绑定错误。
vi.mock("drizzle-orm", () => ({
  sql: (strings: TemplateStringsArray | string, ...values: unknown[]) => ({
    _strings: strings,
    _values: values,
    mapWithParameters: () => ({ sql: "", params: [] }),
  }),
}));

vi.mock("drizzle-orm/d1", () => ({
  drizzle: () => ({}),
}));

vi.mock("drizzle-orm/libsql", () => ({
  drizzle: () => ({}),
}));

vi.mock("../db/client", () => ({
  createDb: () => ({}),
}));

// ── Create ORM mock that handles rate-limit's query patterns ──
// enforceRateLimit calls: db.insert(rateLimitWindows).values(data).onConflictDoUpdate(cfg).returning(colMap)
// writeRequestLog calls: db.insert(requestLogs).values(data)

function createRateLimitMockDb() {
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([{ count: 0 }]),
      }),
    }),
    insert: (_table?: unknown) => ({
      values: (data: Record<string, unknown>) => {
        if ("requestCount" in data) {
          // enforceRateLimit: upsert pattern
          let returningRef: any;
          function returningFn(_colMap?: any) {
            return Promise.resolve().then(() => [{
              count: (globalThis as any).__rateLimitMockState?.upsertCount ?? 0,
            }]);
          }
          returningFn.columns = () => returningRef;
          returningFn.select = () => returningRef;
          returningRef = returningFn;
          return {
            onConflictDoUpdate: () => ({ returning: returningFn }),
          };
        } else {
          // writeRequestLog: insert request_logs
          let returningRef: any;
          function returningFn() { return Promise.resolve([{ count: 0 }]); }
          returningFn.columns = () => returningRef;
          returningFn.select = () => returningRef;
          returningRef = returningFn;
          (globalThis as any).__rateLimitMockState?.insertedLogs?.push(data);
          return {
            onConflictDoUpdate: () => ({ returning: returningFn }),
          };
        }
      },
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve({ rowsAffected: 0 }),
      }),
    }),
    delete: () => ({
      where: () => Promise.resolve({ rowsAffected: 0 }),
    }),
    run: (query?: unknown) => {
      (globalThis as any).__rateLimitMockState?.runCalls?.push(query);
      const next = (globalThis as any).__rateLimitMockState?.runResults?.shift();
      return Promise.resolve(next ?? { rowsAffected: 1, rows: [] });
    },
  };
}

// ── Minimal Hono Context mock ──

function createMockContext(overrides: Record<string, unknown> = {}): Context<AppEnv> {
  const db = createRateLimitMockDb();
  return {
    get: (key: string) => {
      if (key === "db") return db;
      return undefined;
    },
    env: {
      RATE_LIMIT_SALT: "test-salt",
      ...overrides,
    },
    req: {
      header: (name: string) => {
        if (name === "cf-connecting-ip") return "1.2.3.4";
        if (name === "user-agent") return "test-agent";
        return "";
      },
      method: "POST",
      url: "https://example.com/api/orders",
    },
  } as unknown as Context<AppEnv>;
}

// Helper to set mock state
function setMockCount(count: number) {
  state.upsertCount = count;
}

function clearInsertedLogs() {
  state.insertedLogs.length = 0;
}

function setRunResults(...results: unknown[]) {
  state.runResults = results.slice();
  state.runCalls.length = 0;
}

describe("enforceRateLimit", () => {
  beforeEach(() => {
    state.upsertCount = 0;
    state.insertedLogs.length = 0;
  });

  it("allows request when under limit", async () => {
    setMockCount(3); // 3 requests in last minute
    const c = createMockContext();
    const result = await enforceRateLimit(c, "create_order", 8);
    expect(result.ok).toBe(true);
    expect(result.ipHash).toBeDefined();
  });

  it("blocks request when over limit", async () => {
    setMockCount(9); // 9 > 8 limit
    const c = createMockContext();
    const result = await enforceRateLimit(c, "create_order", 8);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(429);
    expect(result.message).toBe("请求过于频繁，请稍后再试");
  });

  it("blocks request when way over limit", async () => {
    setMockCount(21); // way over limit
    const c = createMockContext();
    const result = await enforceRateLimit(c, "create_order", 8);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(429);
  });

  it("allows request with zero previous requests", async () => {
    setMockCount(0);
    const c = createMockContext();
    const result = await enforceRateLimit(c, "create_order", 8);
    expect(result.ok).toBe(true);
  });

  it("uses default limit of 8", async () => {
    setMockCount(7); // just under default
    const c = createMockContext();
    const result = await enforceRateLimit(c, "create_order");
    expect(result.ok).toBe(true);
  });

  it("allows request when count equals limit (strict > comparison)", async () => {
    setMockCount(8);
    const c = createMockContext();
    const result = await enforceRateLimit(c, "create_order", 8);
    expect(result.ok).toBe(true);
  });

  it("blocks request with limit=1 when count exceeds 1", async () => {
    setMockCount(2);
    const c = createMockContext();
    const result = await enforceRateLimit(c, "create_order", 1);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(429);
  });

  it("blocks request with limit=0 when count is 1", async () => {
    setMockCount(1);
    const c = createMockContext();
    const result = await enforceRateLimit(c, "create_order", 0);
    expect(result.ok).toBe(false);
  });
});

describe("writeRequestLog", () => {
  it("writes a log entry with explicit ipHash via ORM", async () => {
    clearInsertedLogs();
    const c = createMockContext();
    await expect(writeRequestLog(c, "create_order", 201, "test-hash")).resolves.toBeUndefined();
    expect(state.insertedLogs).toHaveLength(1);
    expect(state.insertedLogs[0]).toHaveProperty("ipHash", "test-hash");
    expect(state.insertedLogs[0]).toHaveProperty("action", "create_order");
    expect(state.insertedLogs[0]).toHaveProperty("statusCode", 201);
  });

  it("writes a log entry without explicit ipHash (uses getIpHash fallback)", async () => {
    clearInsertedLogs();
    const c = createMockContext();
    await expect(writeRequestLog(c, "pay_order", 200)).resolves.toBeUndefined();
    expect(state.insertedLogs).toHaveLength(1);
    expect(state.insertedLogs[0]).toHaveProperty("action", "pay_order");
  });
});

describe("reserveCooldown", () => {
  beforeEach(() => {
    setRunResults();
  });

  it("reserves a subject cooldown when no recent reservation exists", async () => {
    setRunResults({ rowsAffected: 1 });
    const c = createMockContext();
    const result = await reserveCooldown(c, "email_access_code_recipient", "Buyer@Example.com", 60);

    expect(result.ok).toBe(true);
    expect(result.subjectHash).toBeDefined();
    if (result.ok) expect(result.windowStart).toBeGreaterThan(0);
    expect(state.runCalls).toHaveLength(1);
  });

  it("returns retry seconds when a recent reservation exists", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T00:01:40Z"));
    const latestWindowStart = Math.floor(Date.now() / 1000) - 20;
    setRunResults(
      { rowsAffected: 0 },
      { rows: [{ windowStart: latestWindowStart }] },
    );

    const c = createMockContext();
    const result = await reserveCooldown(c, "email_access_code_recipient", "buyer@example.com", 60);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(429);
      expect(result.retryAfterSeconds).toBe(40);
      expect(result.message).toContain("40 秒后");
    }
    expect(state.runCalls).toHaveLength(2);
  });
});

describe("releaseCooldown", () => {
  it("deletes only the reserved cooldown row", async () => {
    setRunResults({ rowsAffected: 1 });
    const c = createMockContext();
    await expect(releaseCooldown(c, "email_access_code_recipient", {
      ok: true,
      subjectHash: "email-hash",
      windowStart: 123,
    })).resolves.toBeUndefined();
    expect(state.runCalls).toHaveLength(1);
  });
});
