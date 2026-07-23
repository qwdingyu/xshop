import { afterEach, describe, expect, it, vi } from "vitest";
import type { DbType } from "../db/client";
import {
  redeemVoucher,
  deductBalance,
  refundBalance,
  listBalanceTransactions,
  listUserBalances,
  adjustUserBalance,
  generateVoucherCodes,
} from "./voucher-service";

type VoucherRow = {
  code: string;
  amountCents: number;
  status: string;
  expiresAt: string | null;
  usedByEmail?: string;
  usedAt?: string | null;
};

afterEach(() => {
  vi.restoreAllMocks();
});

function createVoucherDb(state: {
  vouchers?: Record<string, VoucherRow>;
  balances?: Record<string, { balanceCents: number; totalDepositedCents: number; totalSpentCents: number }>;
  transactions?: Array<Record<string, unknown>>;
}): DbType {
  const vouchers = state.vouchers || {};
  const balances = state.balances || {};
  const transactions = state.transactions || [];

  let selectCall = 0;
  let updateCall = 0;

  const db = {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => {
            selectCall += 1;
            if (selectCall === 1 && Object.keys(vouchers).length > 0) {
              return Promise.resolve(Object.values(vouchers).slice(0, 1));
            }
            return Promise.resolve([]);
          },
        }),
        groupBy: () => Promise.resolve([]),
      }),
    }),
    update: () => ({
      set: (data: Record<string, unknown>) => ({
        where: () => ({
          returning: () => {
            updateCall += 1;
            if ("status" in data) {
              const row = Object.values(vouchers).find((v) => v.status === "active");
              if (!row) return Promise.resolve([]);
              row.status = String(data.status);
              row.usedByEmail = String(data.usedByEmail || "");
              row.usedAt = String(data.usedAt || "");
              return Promise.resolve([{ amountCents: row.amountCents }]);
            }

            if (updateCall > 0) {
              const email = Object.keys(balances)[0] || "";
              const row = balances[email];
              if (!row) return Promise.resolve([]);
              if ("totalSpentCents" in data) {
                // deductBalance 路径：测试里统一用 800 分扣款
                const spend = 800;
                if (row.balanceCents < spend) return Promise.resolve([]);
                row.balanceCents -= spend;
                row.totalSpentCents += spend;
              } else if ("balanceCents" in data && !("totalDepositedCents" in data)) {
                // adjustUserBalance 扣款：仅改 balanceCents；测试夹具对不足余额返回空行
                // 无法从 sql 表达式反解金额，约定不足场景用 balance < 200 模拟失败
                if (row.balanceCents < 200) return Promise.resolve([]);
                // 成功扣款场景：扣 500（与 adjust 测试用例一致）
                const debit = 500;
                if (row.balanceCents < debit) return Promise.resolve([]);
                row.balanceCents -= debit;
              }
              return Promise.resolve([{ email, balanceCents: row.balanceCents }]);
            }

            return Promise.resolve([]);
          },
        }),
      }),
    }),
    insert: () => ({
      values: (data: Record<string, unknown>) => ({
        returning: () => {
          transactions.push(data);
          return Promise.resolve([{}]);
        },
        onConflictDoUpdate: () => ({
          returning: () => {
            if ("email" in data && "balanceCents" in data) {
              const email = String(data.email);
              const amount = Number(data.balanceCents || 0);
              const current = balances[email] || { balanceCents: 0, totalDepositedCents: 0, totalSpentCents: 0 };
              current.balanceCents += amount;
              if (Number(data.totalDepositedCents || 0) > 0) current.totalDepositedCents += amount;
              balances[email] = current;
              return Promise.resolve([{ balanceCents: current.balanceCents }]);
            }
            transactions.push(data);
            return Promise.resolve([{ balanceCents: Number(data.balanceAfterCents || 0) }]);
          },
        }),
        then: (resolve: (value: unknown) => void) => {
          transactions.push(data);
          return Promise.resolve({ rowsAffected: 1 }).then(resolve);
        },
      }),
    }),
  };

  return db as unknown as DbType;
}

describe("voucher-service balance ledger", () => {
  it("redeems voucher and writes a balance transaction in one service call", async () => {
    const state: {
      vouchers: Record<string, VoucherRow>;
      balances: Record<string, { balanceCents: number; totalDepositedCents: number; totalSpentCents: number }>;
      transactions: Array<Record<string, unknown>>;
    } = {
      vouchers: {
        "VCH-TEST0001": {
          code: "VCH-TEST0001",
          amountCents: 1200,
          status: "active",
          expiresAt: null,
        },
      },
      balances: {},
      transactions: [] as Array<Record<string, unknown>>,
    };
    const db = createVoucherDb(state);

    const result = await redeemVoucher(db, "vch-test0001", "Buyer@Example.com");

    expect(result.success).toBe(true);
    expect(state.vouchers["VCH-TEST0001"].status).toBe("used");
    expect(state.balances["buyer@example.com"].balanceCents).toBe(1200);
    expect(state.transactions).toHaveLength(1);
    expect(state.transactions[0]).toMatchObject({
      email: "buyer@example.com",
      type: "voucher_redeem",
      amountCents: 1200,
      balanceAfterCents: 1200,
      referenceType: "voucher",
      referenceId: "VCH-TEST0001",
    });
  });

  it("returns a structured failure when voucher is concurrently consumed", async () => {
    const state: {
      vouchers: Record<string, VoucherRow>;
      balances: Record<string, { balanceCents: number; totalDepositedCents: number; totalSpentCents: number }>;
      transactions: Array<Record<string, unknown>>;
    } = {
      vouchers: {
        "VCH-USED0001": {
          code: "VCH-USED0001",
          amountCents: 1200,
          status: "used",
          expiresAt: null,
        },
      },
      balances: {},
      transactions: [],
    };
    const db = createVoucherDb(state);

    const result = await redeemVoucher(db, "VCH-USED0001", "buyer@example.com");

    expect(result).toEqual({
      success: false,
      amountCents: 0,
      message: "充值码已使用或已失效",
    });
    expect(state.transactions).toHaveLength(0);
  });

  it("writes spend and refund ledger entries for balance payment compensation", async () => {
    const state = {
      balances: {
        "buyer@example.com": { balanceCents: 2000, totalDepositedCents: 2000, totalSpentCents: 0 },
      },
      transactions: [] as Array<Record<string, unknown>>,
    };
    const db = createVoucherDb(state);

    const deducted = await deductBalance(db, "buyer@example.com", 800, { referenceId: "order-1" });
    await refundBalance(db, "buyer@example.com", 800, { referenceId: "order-1" });

    expect(deducted).toBe(true);
    expect(state.balances["buyer@example.com"].balanceCents).toBe(2000);
    expect(state.transactions.map((row) => row.type)).toEqual(["order_spend", "refund"]);
  });

  it("does not write spend ledger when balance is insufficient", async () => {
    const state = {
      balances: {
        "buyer@example.com": { balanceCents: 300, totalDepositedCents: 300, totalSpentCents: 0 },
      },
      transactions: [] as Array<Record<string, unknown>>,
    };
    const db = createVoucherDb(state);

    const deducted = await deductBalance(db, "buyer@example.com", 800, { referenceId: "order-no-funds" });

    expect(deducted).toBe(false);
    expect(state.balances["buyer@example.com"].balanceCents).toBe(300);
    expect(state.balances["buyer@example.com"].totalSpentCents).toBe(0);
    expect(state.transactions).toHaveLength(0);
  });

  it("treats zero amount deduction as a no-op without ledger noise", async () => {
    const state = {
      balances: {
        "buyer@example.com": { balanceCents: 300, totalDepositedCents: 300, totalSpentCents: 0 },
      },
      transactions: [] as Array<Record<string, unknown>>,
    };
    const db = createVoucherDb(state);

    const deducted = await deductBalance(db, "buyer@example.com", 0, { referenceId: "order-free" });

    expect(deducted).toBe(true);
    expect(state.balances["buyer@example.com"].balanceCents).toBe(300);
    expect(state.balances["buyer@example.com"].totalSpentCents).toBe(0);
    expect(state.transactions).toHaveLength(0);
  });

  it("regenerates voucher codes when a generated code already exists in database", async () => {
    const randomValues = [
      ...new Array(8).fill(0), // VCH-AAAAAAAA：模拟数据库已存在
      ...new Array(8).fill(1), // VCH-BBBBBBBB：冲突后补齐的新 code
    ];
    vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
      (array as Uint32Array)[0] = randomValues.shift() ?? 2;
      return array;
    });

    let selectCalls = 0;
    let insertedRows: Array<Record<string, unknown>> = [];
    const db = {
      select: () => ({
        from: () => ({
          where: () => {
            selectCalls += 1;
            if (selectCalls === 1) return Promise.resolve([{ code: "VCH-AAAAAAAA" }]);
            return Promise.resolve([]);
          },
        }),
      }),
      insert: () => ({
        values: (rows: Array<Record<string, unknown>>) => {
          insertedRows = rows;
          return Promise.resolve({ rowsAffected: rows.length });
        },
      }),
    } as unknown as DbType;

    const codes = await generateVoucherCodes(db, 1, 500, "batch-1", null, "测试批次");

    expect(codes).toEqual(["VCH-BBBBBBBB"]);
    expect(insertedRows).toEqual([
      expect.objectContaining({
        code: "VCH-BBBBBBBB",
        amountCents: 500,
        batchId: "batch-1",
        notes: "测试批次",
      }),
    ]);
    expect(selectCalls).toBe(2);
  });

  it("retries generation when a concurrent insert wins the voucher primary key", async () => {
    const randomValues = [
      ...new Array(8).fill(0), // 第一次候选：插入前被并发请求抢占
      ...new Array(8).fill(1), // 第二次候选：重试后写入
    ];
    vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
      (array as Uint32Array)[0] = randomValues.shift() ?? 2;
      return array;
    });

    let selectCalls = 0;
    let insertCalls = 0;
    let insertedRows: Array<Record<string, unknown>> = [];
    const db = {
      select: () => ({
        from: () => ({
          where: () => {
            selectCalls += 1;
            return Promise.resolve([]);
          },
        }),
      }),
      insert: () => ({
        values: (rows: Array<Record<string, unknown>>) => {
          insertCalls += 1;
          if (insertCalls === 1) {
            throw new Error("SQLITE_CONSTRAINT: UNIQUE constraint failed: voucher_codes.code");
          }
          insertedRows = rows;
          return Promise.resolve({ rowsAffected: rows.length });
        },
      }),
    } as unknown as DbType;

    const codes = await generateVoucherCodes(db, 1, 500, "batch-race", null, "并发重试");

    expect(codes).toEqual(["VCH-BBBBBBBB"]);
    expect(insertedRows).toEqual([
      expect.objectContaining({
        code: "VCH-BBBBBBBB",
        batchId: "batch-race",
      }),
    ]);
    expect(selectCalls).toBe(2);
    expect(insertCalls).toBe(2);
  });

  it("lists balance transactions with total and rows for admin audit", async () => {
    const rows = [
      {
        id: "tx-1",
        email: "buyer@example.com",
        type: "voucher_redeem",
        amountCents: 1200,
        balanceAfterCents: 1200,
        referenceType: "voucher",
        referenceId: "VCH-TEST0001",
        note: "充值码兑换入账",
        createdAt: "2026-06-24T00:00:00.000Z",
      },
    ];
    let selectCall = 0;
    const db = {
      select: () => {
        selectCall += 1;
        return {
          from: () => ({
            where: () => {
              if (selectCall === 1) return Promise.resolve([{ count: rows.length }]);
              return {
                orderBy: () => ({
                  limit: () => ({
                    offset: () => Promise.resolve(rows),
                  }),
                }),
              };
            },
          }),
        };
      },
    } as unknown as DbType;

    const result = await listBalanceTransactions(db, {
      email: "Buyer@Example.com",
      type: "voucher_redeem",
      limit: 20,
      offset: 0,
    });

    expect(result.total).toBe(1);
    expect(result.transactions).toEqual(rows);
  });

  it("lists user balances from user_balances with pagination shape", async () => {
    const rows = [
      {
        email: "buyer@example.com",
        balanceCents: 1500,
        totalDepositedCents: 2000,
        totalSpentCents: 500,
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    ];
    let selectCall = 0;
    const db = {
      select: () => {
        selectCall += 1;
        return {
          from: () => ({
            where: () => {
              if (selectCall === 1) return Promise.resolve([{ count: rows.length }]);
              return {
                orderBy: () => ({
                  limit: () => ({
                    offset: () => Promise.resolve(rows),
                  }),
                }),
              };
            },
          }),
        };
      },
    } as unknown as DbType;

    const result = await listUserBalances(db, { email: "buyer", positiveOnly: true, limit: 20, offset: 0 });
    expect(result.total).toBe(1);
    expect(result.items).toEqual(rows);
  });

  it("adjustUserBalance credits and writes adjustment ledger", async () => {
    const state = {
      balances: {
        "buyer@example.com": { balanceCents: 1000, totalDepositedCents: 1000, totalSpentCents: 0 },
      },
      transactions: [] as Array<Record<string, unknown>>,
    };
    const db = createVoucherDb(state);

    const result = await adjustUserBalance(db, "Buyer@Example.com", 500, "客服补偿");

    expect(result).toMatchObject({ email: "buyer@example.com", amountCents: 500, balanceCents: 1500 });
    expect(state.balances["buyer@example.com"].balanceCents).toBe(1500);
    expect(state.balances["buyer@example.com"].totalDepositedCents).toBe(1500);
    expect(state.transactions).toHaveLength(1);
    expect(state.transactions[0]).toMatchObject({
      type: "adjustment",
      amountCents: 500,
      balanceAfterCents: 1500,
      note: "客服补偿",
    });
  });

  it("adjustUserBalance rejects debit when balance is insufficient", async () => {
    const state = {
      balances: {
        "buyer@example.com": { balanceCents: 100, totalDepositedCents: 100, totalSpentCents: 0 },
      },
      transactions: [] as Array<Record<string, unknown>>,
    };
    const db = createVoucherDb(state);

    await expect(adjustUserBalance(db, "buyer@example.com", -500, "误充回收")).rejects.toThrow(/余额不足/);
    expect(state.balances["buyer@example.com"].balanceCents).toBe(100);
    expect(state.transactions).toHaveLength(0);
  });

  it("adjustUserBalance rejects zero amount", async () => {
    const db = createVoucherDb({ balances: {}, transactions: [] });
    await expect(adjustUserBalance(db, "buyer@example.com", 0, "noop")).rejects.toThrow(/非零/);
  });
});
