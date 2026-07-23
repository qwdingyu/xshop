import { describe, expect, it, vi } from "vitest";
import { withDbTransaction, type DbType } from "./client";

describe("withDbTransaction", () => {
  it("遇到短暂 SQLITE_BUSY 时应退避重试并最终提交", async () => {
    const callback = vi.fn(async () => "ok");
    let attempts = 0;
    const db = {
      transaction: vi.fn(async (fn: (tx: unknown) => Promise<string>) => {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error("database is locked");
          (error as Error & { code?: string }).code = "SQLITE_BUSY";
          throw error;
        }
        return fn({ tx: true });
      }),
    } as unknown as DbType;

    const result = await withDbTransaction(db, callback, { retries: 1, baseDelayMs: 1 });

    expect(result).toBe("ok");
    expect(db.transaction).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenCalledWith({ tx: true });
  });

  it("非锁错误不应被吞掉或重试", async () => {
    const db = {
      transaction: vi.fn(async () => {
        throw new Error("业务校验失败");
      }),
    } as unknown as DbType;

    await expect(withDbTransaction(db, async () => "ok")).rejects.toThrow("业务校验失败");
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });
});
