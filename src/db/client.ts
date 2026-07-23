/**
 * Drizzle ORM 实例工厂 — 纯 Turso/libsql 模式。
 *
 * 创建 Drizzle ORM 实例，使用 drizzle-orm/libsql 驱动。
 * 业务代码只需调用 createDb(client)，获得类型安全的 ORM 实例。
 */
import { drizzle } from "drizzle-orm/libsql";
import type { Client } from "@libsql/client";

/**
 * 创建 Drizzle ORM 实例。
 * @param client - @libsql/client Client 实例
 * @returns Drizzle ORM 数据库实例
 */
export function createDb(client: Client) {
  return drizzle(client);
}

/** Drizzle ORM 实例类型（从 createDb 返回值推断） */
export type DbType = ReturnType<typeof createDb>;

type TransactionCapableDb<T> = {
  transaction?: (cb: (tx: unknown) => Promise<T>) => Promise<T>;
};

export type DbWriteScope = Pick<DbType, "select" | "insert" | "update" | "delete" | "run">;

const SQLITE_BUSY_PATTERNS = [
  "SQLITE_BUSY",
  "SQLITE_LOCKED",
  "database is locked",
  "database table is locked",
  "database busy",
];

/** 判断是否为可恢复的 SQLite/libSQL 写锁竞争。 */
export function isSqliteBusyError(error: unknown): boolean {
  const err = error as { code?: unknown; message?: unknown; cause?: unknown };
  const haystack = [err.code, err.message, (err.cause as { message?: unknown } | undefined)?.message]
    .filter(Boolean)
    .join(" ");
  return SQLITE_BUSY_PATTERNS.some((pattern) => haystack.includes(pattern));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 统一数据库写事务入口。
 *
 * 约束：
 * - 事务内只放必须原子提交的数据库读写，禁止支付、邮件、HTTP 等外部 I/O。
 * - SQLite/libSQL 同一时刻只有一个写事务最稳妥；这里对短暂 BUSY/LOCKED 做有界指数退避重试。
 * - 测试 mock 可能没有 transaction()，此时直接执行回调，保持单元测试轻量。
 */
export async function withDbTransaction<T, TTx = DbType>(
  db: DbType,
  fn: (tx: TTx) => Promise<T>,
  options: { retries?: number; baseDelayMs?: number } = {},
): Promise<T> {
  // 支付、余额和发卡的事务可能在提交阶段才观察到写锁竞争；75ms 的默认窗口过短，
  // 会把可恢复的并发冲突误报成业务失败。总等待约 1.55s，仍然有界，不会无限阻塞请求。
  const retries = options.retries ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 50;
  const maybeTx = db as unknown as TransactionCapableDb<T>;

  for (let attempt = 0; ; attempt += 1) {
    try {
      if (typeof maybeTx.transaction === "function") {
        return await maybeTx.transaction((tx) => fn(tx as TTx));
      }
      return await fn(db as unknown as TTx);
    } catch (error) {
      if (attempt >= retries || !isSqliteBusyError(error)) throw error;
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }
}
