import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DbType } from "../db/client";
import { getCoupon, quoteCoupon, consumeCoupon, releaseCouponReservation, restoreCouponReservation } from "./coupon-service";

// ---------------------------------------------------------------------------
// Coupon service unit tests — Drizzle ORM version
// ---------------------------------------------------------------------------
// coupon-service uses Drizzle ORM for all DB operations.
// We mock the DB object at ORM level to intercept select/update calls.

type CouponRow = {
  code: string;
  productId: string;
  discountType: "fixed" | "percent";
  discountValue: number;
  maxUses: number;
  usedCount: number;
  active: number;
  expiresAt: string | null;
};

// ── Mock state ──
const state: {
  coupons: CouponRow[];
  updateReturning: { code: string }[];
} = {
  coupons: [],
  updateReturning: [],
};

function setCoupon(coupon: {
  code: string;
  productId?: string;
  discountType?: "fixed" | "percent";
  discountValue?: number;
  maxUses?: number;
  usedCount?: number;
  active?: number;
  expiresAt?: string | null;
}) {
  state.coupons = [{
    code: coupon.code,
    productId: coupon.productId ?? "",
    discountType: coupon.discountType ?? "fixed",
    discountValue: coupon.discountValue ?? 0,
    maxUses: coupon.maxUses ?? 0,
    usedCount: coupon.usedCount ?? 0,
    active: coupon.active ?? 1,
    expiresAt: coupon.expiresAt ?? null,
  }];
}

function clearCoupons() {
  state.coupons = [];
}

function setUpdateReturning(rows: { code: string }[]) {
  state.updateReturning = rows;
}

function createMockDb(): DbType {
  return {
    select: (_cols?: unknown) => ({
      from: (_table?: unknown) => ({
        where: (_cond?: unknown) => ({
          limit: (_n?: unknown) => Promise.resolve(state.coupons),
          orderBy: (..._args: unknown[]) => ({
            limit: (_n?: unknown) => Promise.resolve(state.coupons),
          }),
        }),
        limit: (_n?: unknown) => Promise.resolve(state.coupons),
      }),
    }),
    insert: (_table?: unknown) => ({
      values: (_data?: unknown) => ({
        onConflictDoUpdate: (_cfg?: unknown) => ({
          returning: (_cols?: unknown) => Promise.resolve([{}]),
        }),
        onConflictDoNothing: () => ({
          returning: (_cols?: unknown) => Promise.resolve([{}]),
        }),
      }),
    }),
    update: (_table?: unknown) => ({
      set: (_data?: unknown) => ({
        where: (_cond?: unknown) => ({
          returning: (_cols?: unknown) => Promise.resolve(state.updateReturning),
        }),
      }),
    }),
    run: () => Promise.resolve({ rows: [] }),
    delete: (_table?: unknown) => ({
      where: (_cond?: unknown) => Promise.resolve({ rowsAffected: 0 }),
    }),
  } as unknown as DbType;
}

beforeEach(() => {
  clearCoupons();
  setUpdateReturning([]);
});

// ── getCoupon tests ──

describe("getCoupon", () => {
  it("returns null for empty coupon code", async () => {
    const db = createMockDb();
    const result = await getCoupon(db, "");
    expect(result).toBeNull();
  });

  it("returns null for whitespace coupon code", async () => {
    const db = createMockDb();
    const result = await getCoupon(db, "   ");
    expect(result).toBeNull();
  });

  it("returns null for undefined coupon code", async () => {
    const db = createMockDb();
    const result = await getCoupon(db, undefined as unknown as string);
    expect(result).toBeNull();
  });

  it("returns coupon when found", async () => {
    setCoupon({ code: "SAVE10" });
    const db = createMockDb();
    const result = await getCoupon(db, "SAVE10");
    expect(result).not.toBeNull();
    expect(result!.code).toBe("SAVE10");
  });

  it("is case-insensitive", async () => {
    setCoupon({ code: "Save10" });
    const db = createMockDb();
    const result = await getCoupon(db, "save10");
    expect(result).not.toBeNull();
  });

  it("returns null when coupon not found", async () => {
    const db = createMockDb();
    const result = await getCoupon(db, "NOTEXIST");
    expect(result).toBeNull();
  });
});

// ── quoteCoupon tests ──

describe("quoteCoupon", () => {
  it("returns no-discount quote when couponCode is empty", async () => {
    const db = createMockDb();
    const result = await quoteCoupon(db, 1000, "prod-1", "");
    expect(result.couponCode).toBe("");
    expect(result.valid).toBe(true);
    expect(result.discountCents).toBe(0);
    expect(result.payableCents).toBe(1000);
  });

  it("returns no-discount quote when couponCode is whitespace", async () => {
    const db = createMockDb();
    const result = await quoteCoupon(db, 1000, "prod-1", "   ");
    expect(result.couponCode).toBe("");
    expect(result.valid).toBe(true);
    expect(result.discountCents).toBe(0);
  });

  it("returns invalid quote when coupon not found", async () => {
    const db = createMockDb();
    const result = await quoteCoupon(db, 1000, "prod-1", "NOTEXIST");
    expect(result.valid).toBe(false);
    expect(result.message).toContain("折扣码不存在");
  });

  it("returns invalid quote when coupon is inactive", async () => {
    setCoupon({ code: "INACTIVE", active: 0 });
    const db = createMockDb();
    const result = await quoteCoupon(db, 1000, "prod-1", "INACTIVE");
    expect(result.valid).toBe(false);
    expect(result.message).toContain("已停用");
  });

  it("returns invalid quote when coupon is expired", async () => {
    setCoupon({ code: "EXPIRED", expiresAt: "2020-01-01T00:00:00Z" });
    const db = createMockDb();
    const result = await quoteCoupon(db, 1000, "prod-1", "EXPIRED");
    expect(result.valid).toBe(false);
    expect(result.message).toContain("已过期");
  });

  it("returns invalid quote when coupon maxUses exceeded", async () => {
    setCoupon({ code: "MAXED", maxUses: 1, usedCount: 1 });
    const db = createMockDb();
    const result = await quoteCoupon(db, 1000, "prod-1", "MAXED");
    expect(result.valid).toBe(false);
    expect(result.message).toContain("次数已用完");
  });

  it("returns valid fixed discount quote", async () => {
    setCoupon({ code: "SAVE10", discountType: "fixed", discountValue: 100 });
    const db = createMockDb();
    const result = await quoteCoupon(db, 1000, "prod-1", "SAVE10");
    expect(result.valid).toBe(true);
    expect(result.discountCents).toBe(100);
    expect(result.payableCents).toBe(900);
  });

  it("returns valid percent discount quote", async () => {
    setCoupon({ code: "PERCENT20", discountType: "percent", discountValue: 20 });
    const db = createMockDb();
    const result = await quoteCoupon(db, 1000, "prod-1", "PERCENT20");
    expect(result.valid).toBe(true);
    expect(result.discountCents).toBe(200);
    expect(result.payableCents).toBe(800);
  });

  it("caps percent discount to price", async () => {
    setCoupon({ code: "PERCENT200", discountType: "percent", discountValue: 200 });
    const db = createMockDb();
    const result = await quoteCoupon(db, 1000, "prod-1", "PERCENT200");
    expect(result.valid).toBe(true);
    expect(result.discountCents).toBe(1000); // capped to price
    expect(result.payableCents).toBe(0);
  });

  it("returns invalid quote when coupon product mismatch", async () => {
    // quoteCoupon 的 WHERE 条件已包含产品匹配过滤：
    //   or(eq(coupons.productId, ""), eq(coupons.productId, productId))
    // 所以 productId 不匹配且非空时，SQL 层面查不到该优惠券。
    // mock 的 where 不做过滤，始终返回 state.coupons；但生产代码
    // 会在 SQL 层过滤掉不匹配的优惠券（WHERE 里不可能返回 prod-2 的记录）。
    // 我们需要在 mock 层模拟 WHERE 过滤行为：让产品不匹配时返回空结果。
    setCoupon({ code: "mismatch", productId: "prod-2" });
    const db = createMockDb();
    // 因为 mock 的 where 不做过滤，MISMATCH 优惠券会被返回，
    // 生产代码不再有 "不适用于该商品" 的检查逻辑（过滤已移到 SQL WHERE），
    // 所以 mock 需要在 where 层过滤掉不匹配的优惠券。
    // 但我们的 mock 没有 WHERE 过滤能力，所以直接让 select 返回空结果：
    const dbFiltered = createMockDb();
    // Override select for this test: productId "prod-2" doesn't match "prod-1"
    // so SQL WHERE would return empty — mock returns empty
    (dbFiltered as any).select = (_cols?: unknown) => ({
      from: (_table?: unknown) => ({
        where: (_cond?: unknown) => ({
          limit: (_n?: unknown) => Promise.resolve([]), // No match in SQL WHERE
          orderBy: (..._args: unknown[]) => ({
            limit: (_n?: unknown) => Promise.resolve([]),
          }),
        }),
        limit: (_n?: unknown) => Promise.resolve([]),
      }),
    });
    const result = await quoteCoupon(dbFiltered, 1000, "prod-1", "mismatch");
    expect(result.valid).toBe(false);
    expect(result.message).toContain("折扣码不存在或已停用");
  });

  it("returns valid quote when coupon is for same product", async () => {
    setCoupon({ code: "MATCH", productId: "prod-1" });
    const db = createMockDb();
    const result = await quoteCoupon(db, 1000, "prod-1", "MATCH");
    expect(result.valid).toBe(true);
    expect(result.discountCents).toBe(0); // 0% discount, no value set
  });

  it("returns valid quote when coupon is universal (empty productId)", async () => {
    setCoupon({ code: "UNIVERSAL", productId: "" });
    const db = createMockDb();
    const result = await quoteCoupon(db, 1000, "prod-1", "UNIVERSAL");
    expect(result.valid).toBe(true);
  });

  it("rejects universal fixed discounts for non-CNY products", async () => {
    setCoupon({ code: "GLOBALFIXED", productId: "", discountType: "fixed", discountValue: 100 });
    const db = createMockDb();
    const result = await quoteCoupon(db, 1000, "prod-usd", "GLOBALFIXED", "USD");
    expect(result.valid).toBe(false);
    expect(result.payableCents).toBe(1000);
    expect(result.message).toContain("通用固定金额折扣码仅支持 CNY");
  });

  it("allows universal percentage discounts for non-CNY products", async () => {
    setCoupon({ code: "GLOBALPERCENT", productId: "", discountType: "percent", discountValue: 10 });
    const db = createMockDb();
    const result = await quoteCoupon(db, 1000, "prod-jpy", "GLOBALPERCENT", "JPY");
    expect(result.valid).toBe(true);
    expect(result.discountCents).toBe(100);
    expect(result.payableCents).toBe(900);
  });

  it("allows product-bound fixed discounts to use that product's minor units", async () => {
    setCoupon({ code: "JPYFIXED", productId: "prod-jpy", discountType: "fixed", discountValue: 100 });
    const db = createMockDb();
    const result = await quoteCoupon(db, 1000, "prod-jpy", "JPYFIXED", "JPY");
    expect(result.valid).toBe(true);
    expect(result.discountCents).toBe(100);
    expect(result.payableCents).toBe(900);
  });
});

// ── consumeCoupon tests ──

describe("consumeCoupon", () => {
  it("returns false when coupon code is empty", async () => {
    const db = createMockDb();
    const result = await consumeCoupon(db, "");
    expect(result.success).toBe(false);
  });

  it("returns false when coupon code is whitespace", async () => {
    const db = createMockDb();
    const result = await consumeCoupon(db, "   ");
    expect(result.success).toBe(false);
  });

  it("returns success when coupon is consumed", async () => {
    setCoupon({ code: "SAVE10" });
    setUpdateReturning([{ code: "SAVE10" }]);
    const db = createMockDb();
    const result = await consumeCoupon(db, "SAVE10");
    expect(result.success).toBe(true);
    expect(result.changes).toBe(1);
  });

  it("returns false when update returns no rows (coupon already fully used or inactive)", async () => {
    setCoupon({ code: "SAVE10" });
    setUpdateReturning([]);
    const db = createMockDb();
    const result = await consumeCoupon(db, "SAVE10");
    expect(result.success).toBe(false);
    expect(result.changes).toBe(0);
  });

  it("returns success with changes count matching update rows", async () => {
    setCoupon({ code: "SAVE10" });
    setUpdateReturning([{ code: "SAVE10" }]);
    const db = createMockDb();
    const result = await consumeCoupon(db, "SAVE10");
    expect(result.success).toBe(true);
    expect(result.changes).toBe(1);
  });

  it("returns false for undefined coupon code", async () => {
    const db = createMockDb();
    const result = await consumeCoupon(db, undefined as unknown as string);
    expect(result.success).toBe(false);
    expect(result.changes).toBe(0);
  });
});

describe("releaseCouponReservation", () => {
  it("treats empty coupon code as no-op success", async () => {
    const db = createMockDb();
    const result = await releaseCouponReservation(db, "");
    expect(result.success).toBe(true);
    expect(result.changes).toBe(0);
  });

  it("returns success when a reserved coupon use is released", async () => {
    setUpdateReturning([{ code: "SAVE10" }]);
    const db = createMockDb();
    const result = await releaseCouponReservation(db, "SAVE10");
    expect(result.success).toBe(true);
    expect(result.changes).toBe(1);
  });

  it("does not report success when there is no used count to release", async () => {
    setUpdateReturning([]);
    const db = createMockDb();
    const result = await releaseCouponReservation(db, "SAVE10");
    expect(result.success).toBe(false);
    expect(result.changes).toBe(0);
  });
});

describe("restoreCouponReservation", () => {
  it("treats empty coupon code as a no-op", async () => {
    const db = createMockDb();
    const result = await restoreCouponReservation(db, "");
    expect(result).toEqual({ success: true, changes: 0 });
  });

  it("restores one previously released use for a verified payment", async () => {
    setUpdateReturning([{ code: "SAVE10" }]);
    const db = createMockDb();
    const result = await restoreCouponReservation(db, "SAVE10");
    expect(result).toEqual({ success: true, changes: 1 });
  });
});
