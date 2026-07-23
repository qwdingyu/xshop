import { beforeEach, describe, it, expect, vi } from "vitest";
import type { DbType } from "../db/client";

// ---------------------------------------------------------------------------
// cleanupExpiredOrders 现在调用 checkAndExpireOrder（复用发邮件逻辑）
// 我们 mock order-service 的 checkAndExpireOrder
// ---------------------------------------------------------------------------

vi.mock("./order-service", () => ({
  checkAndExpireOrder: vi.fn().mockResolvedValue({ expired: true, releasedCards: 1 }),
}));

vi.mock("./payment-reconciliation-service", () => ({
  reconcileOnlineOrderPayment: vi.fn().mockResolvedValue({ reconciled: false }),
}));

vi.mock("./recharge-service", () => ({
  expirePendingRechargeOrders: vi.fn().mockResolvedValue(0),
}));

import { cleanupExpiredOrders } from "./cleanup-service";
import { checkAndExpireOrder } from "./order-service";
import { reconcileOnlineOrderPayment } from "./payment-reconciliation-service";
import { expirePendingRechargeOrders } from "./recharge-service";
import { adminAuditLogs, cardLogs, emailLogs, idempotencyKeys, orderEvents, rateLimitWindows, requestLogs, systemConfig } from "../db/schema";
const mockCheckAndExpire = vi.mocked(checkAndExpireOrder);
const mockReconcileOnlineOrderPayment = vi.mocked(reconcileOnlineOrderPayment);
const mockExpirePendingRechargeOrders = vi.mocked(expirePendingRechargeOrders);

/**
 * Create a mock DbType that supports the Drizzle ORM operations used by cleanupExpiredOrders.
 *
 * The cleanup service now does:
 *   1. db.select({id, status, expiresAt, orderNo, buyerEmail, productTitle})
 *      .from(orders).innerJoin(products, ...).where(...)
 *      → returns expired order rows
 *   2. For each expired order, calls checkAndExpireOrder(db, id, expiresAt, status, env, orderInfo)
 *   3. db.update(cards).set({...}).where(...).returning(...) — atomically release orphaned cards
 *   4. db.update(cards).set({...}).where(...).returning(...) — atomically disable expired cards
 *   5. db.insert(cardLogs).values({...}).catch(...) — audit logs for rows actually updated
 */
function createMockDb(options: {
  expiredOrders?: Array<{
    id: string; status: string; expiresAt: string;
    orderNo: string | null; buyerEmail: string | null; productTitle: string;
  }>;
  orphanedCards?: Array<{ id: string; lockedOrderId: string | null; orderStatus?: string | null }>;
  orphanReleaseRows?: Array<{ id: string }>;
  expiredAvailableCards?: Array<{ id: string; accountLabel: string }>;
  disableRows?: Array<{ id: string; accountLabel: string }>;
  retentionConfig?: Record<string, string>;
  deletedRowCounts?: number[];
} = {}): DbType {
  const {
    expiredOrders = [],
    orphanedCards = [],
    expiredAvailableCards = [],
  } = options;
  const orphanReleaseRows = options.orphanReleaseRows ?? orphanedCards
    .filter((card) => !["pending", "paid", "issued"].includes(card.orderStatus || ""))
    .map((card) => ({ id: card.id }));
  const disableRows = options.disableRows ?? expiredAvailableCards;
  const insertedLogs: Array<{ cardId: string; action: string }> = [];
  const deletedTables: unknown[] = [];
  let updateCall = 0;
  let deleteCall = 0;

  const mockInsert = () => ({
    values: (data: Record<string, unknown>) => {
      // Capture audit log inserts
      if (data.cardId && data.action) {
        insertedLogs.push({ cardId: String(data.cardId), action: String(data.action) });
      }
      return {
        onConflictDoUpdate: () => ({ returning: () => Promise.resolve([{}]) }),
        onConflictDoNothing: () => ({ returning: () => Promise.resolve([{}]) }),
        // .catch() chain for audit logs (orphaned card release)
        catch: (_handler: (err: unknown) => void) => Promise.resolve(),
      };
    },
  });

  return {
    _insertedLogs: insertedLogs, // exposed for test assertions
    _deletedTables: deletedTables,
    select: (cols?: Record<string, unknown>) => ({
      from: (table: unknown) => table === systemConfig ? {
        where: () => Promise.resolve(Object.entries(options.retentionConfig || {}).map(([key, value]) => ({ key, value }))),
      } : ({
        innerJoin: () => ({
          where: () => Promise.resolve(expiredOrders),
        }),
        // leftJoin 同时用于订单清理扫描和过期 locked 卡密兜底扫描。
        leftJoin: () => ({
          where: () => Promise.resolve(cols && "lockedOrderId" in cols ? orphanedCards : expiredOrders),
        }),
        where: () => Promise.resolve(cols && "accountLabel" in cols ? expiredAvailableCards : orphanedCards),
      }),
    }),
    update: () => {
      const rows = updateCall++ === 0 ? orphanReleaseRows : disableRows;
      return {
        set: (_data: unknown) => ({
          where: () => ({
            returning: () => Promise.resolve(rows),
          }),
        }),
      };
    },
    insert: mockInsert,
    run: () => Promise.resolve({ rows: [] }),
    delete: (table: unknown) => ({
      where: () => {
        deletedTables.push(table);
        return Promise.resolve({ rowsAffected: options.deletedRowCounts?.[deleteCall++] ?? 0 });
      },
    }),
  } as unknown as DbType & { _insertedLogs: typeof insertedLogs; _deletedTables: typeof deletedTables };
}

describe("cleanupExpiredOrders", () => {
  beforeEach(() => {
    mockCheckAndExpire.mockReset();
    mockCheckAndExpire.mockResolvedValue({ expired: true, releasedCards: 1 });
    mockReconcileOnlineOrderPayment.mockReset();
    mockReconcileOnlineOrderPayment.mockResolvedValue({ reconciled: false });
    mockExpirePendingRechargeOrders.mockReset();
    mockExpirePendingRechargeOrders.mockResolvedValue(0);
  });

  it("returns zero counts when no expired orders", async () => {
    const db = createMockDb({ expiredOrders: [] });
    const result = await cleanupExpiredOrders(db);
    expect(result.expiredOrders).toBe(0);
    expect(result.releasedCards).toBe(0);
    expect(result.expiredRechargeOrders).toBe(0);
  });

  it("expires abandoned pending recharge orders without deleting their audit records", async () => {
    const db = createMockDb({ expiredOrders: [] });
    mockExpirePendingRechargeOrders.mockResolvedValueOnce(3);

    const result = await cleanupExpiredOrders(db);

    expect(result.expiredRechargeOrders).toBe(3);
    expect(mockExpirePendingRechargeOrders).toHaveBeenCalledWith(db, expect.any(String));
  });

  it("prunes bounded-lifetime operational data during the scheduled cleanup", async () => {
    const db = createMockDb({
      expiredOrders: [],
      retentionConfig: {
        rate_limit_retention_days: "7",
        idempotency_retention_days: "45",
        request_log_retention_days: "60",
        email_log_retention_days: "75",
        business_log_retention_days: "180",
        admin_audit_retention_days: "365",
      },
      deletedRowCounts: [1, 2, 3, 4, 5, 6, 7],
    });

    const result = await cleanupExpiredOrders(db);

    expect((db as any)._deletedTables).toEqual([
      rateLimitWindows,
      idempotencyKeys,
      requestLogs,
      emailLogs,
      cardLogs,
      orderEvents,
      adminAuditLogs,
    ]);
    expect(result.operationalData).toEqual({
      enabled: true,
      retentionDays: {
        rateLimitWindows: 7,
        idempotencyKeys: 45,
        requestLogs: 60,
        emailLogs: 75,
        cardLogs: 180,
        orderEvents: 180,
        adminAuditLogs: 365,
      },
      deleted: {
        rateLimitWindows: 1,
        idempotencyKeys: 2,
        requestLogs: 3,
        emailLogs: 4,
        cardLogs: 5,
        orderEvents: 6,
        adminAuditLogs: 7,
      },
    });
  });

  it("can pause operational data retention without skipping order and card cleanup", async () => {
    const db = createMockDb({
      expiredOrders: [
        { id: "order-1", status: "pending", expiresAt: "2020-01-01T00:00:00Z", orderNo: "NO-1", buyerEmail: "a@b.com", productTitle: "Product A" },
      ],
      retentionConfig: { operational_data_retention_enabled: "false" },
    });

    const result = await cleanupExpiredOrders(db);

    expect(result.expiredOrders).toBe(1);
    expect((db as any)._deletedTables).toEqual([]);
    expect(result.operationalData.enabled).toBe(false);
    expect(Object.values(result.operationalData.deleted).every((count) => count === 0)).toBe(true);
  });

  it("expires pending orders via checkAndExpireOrder", async () => {
    const db = createMockDb({
      expiredOrders: [
        { id: "order-1", status: "pending", expiresAt: "2020-01-01T00:00:00Z", orderNo: "NO-1", buyerEmail: "a@b.com", productTitle: "Product A" },
        { id: "order-2", status: "pending", expiresAt: "2020-01-01T00:00:00Z", orderNo: "NO-2", buyerEmail: "c@d.com", productTitle: "Product B" },
      ],
    });
    mockCheckAndExpire.mockResolvedValue({ expired: true, releasedCards: 1 });
    const result = await cleanupExpiredOrders(db);
    expect(result.expiredOrders).toBe(2);
    expect(result.releasedCards).toBeGreaterThanOrEqual(2); // 2 from checkAndExpire + orphaned
    expect(mockCheckAndExpire).toHaveBeenCalledTimes(2);
  });

  it("does not expire an order that active payment reconciliation has recovered", async () => {
    const db = createMockDb({
      expiredOrders: [
        { id: "order-paid-upstream", status: "pending", expiresAt: "2020-01-01T00:00:00Z", orderNo: "NO-PAID", buyerEmail: "a@b.com", productTitle: "Product A" },
      ],
    });
    mockReconcileOnlineOrderPayment.mockResolvedValueOnce({ reconciled: true, issueOk: true });

    const paymentEnv = { CREDENTIALS_ENCRYPTION_KEY: "a".repeat(64) };
    const result = await cleanupExpiredOrders(db, undefined, undefined, paymentEnv);

    expect(result.reconciledPayments).toBe(1);
    expect(result.expiredOrders).toBe(0);
    expect(mockCheckAndExpire).not.toHaveBeenCalled();
    expect(mockReconcileOnlineOrderPayment).toHaveBeenCalledWith(
      db,
      paymentEnv,
      expect.objectContaining({ id: "order-paid-upstream", orderNo: "NO-PAID" }),
      undefined,
      undefined,
    );
  });

  it("passes env and orderInfo to checkAndExpireOrder for email notification", async () => {
    const db = createMockDb({
      expiredOrders: [
        { id: "order-1", status: "pending", expiresAt: "2020-01-01T00:00:00Z", orderNo: "NO-1", buyerEmail: "a@b.com", productTitle: "Product A" },
      ],
    });
    mockCheckAndExpire.mockResolvedValue({ expired: true, releasedCards: 1 });
    const env = { resendApiKey: "re_key", emailFrom: "xshop contributors <noreply@users.noreply.github.com>", turnstileEnabled: false, turnstileSecretKey: "", allowTurnstileBypassForSmoke: false, inventoryWarningEmailTo: "" };
    await cleanupExpiredOrders(db, env);
    expect(mockCheckAndExpire).toHaveBeenCalledWith(
      db,
      "order-1",
      "2020-01-01T00:00:00Z",
      "pending",
      env,
      { orderNo: "NO-1", productTitle: "Product A", buyerEmail: "a@b.com" },
      undefined // no executionCtx
    );
  });

  it("counts only orders where checkAndExpireOrder returns true", async () => {
    const db = createMockDb({
      expiredOrders: [
        { id: "order-1", status: "pending", expiresAt: "2020-01-01T00:00:00Z", orderNo: "NO-1", buyerEmail: "a@b.com", productTitle: "Product A" },
        { id: "order-2", status: "pending", expiresAt: "2020-01-01T00:00:00Z", orderNo: "NO-2", buyerEmail: "c@d.com", productTitle: "Product B" },
      ],
    });
    mockCheckAndExpire
      .mockResolvedValueOnce({ expired: true, releasedCards: 1 })   // order-1 expired
      .mockResolvedValueOnce({ expired: false, releasedCards: 0 }); // order-2 already handled
    const result = await cleanupExpiredOrders(db);
    expect(result.expiredOrders).toBe(1);
    expect(result.releasedCards).toBeGreaterThanOrEqual(1); // at least 1 from order-1
  });

  it("releases orphaned locked cards and writes audit logs", async () => {
    mockCheckAndExpire.mockResolvedValue({ expired: false, releasedCards: 0 });
    const db = createMockDb({
      expiredOrders: [],
      orphanedCards: [
        { id: "card-1", lockedOrderId: "old-order-1", orderStatus: null },
        { id: "card-2", lockedOrderId: null },
      ],
    });
    const result = await cleanupExpiredOrders(db);
    expect(result.expiredOrders).toBe(0);
    expect(result.releasedCards).toBe(2);
    expect(result.disabledExpiredCards).toBeGreaterThanOrEqual(0);

    // 验证审计日志已写入（releaseOrphanedLockedCards + disableExpiredCards 都会写日志）
    const logs = (db as any)._insertedLogs;
    expect(logs.length).toBeGreaterThanOrEqual(2);
    expect(logs[0]).toEqual({ cardId: "card-1", action: "released_orphaned" });
    expect(logs[1]).toEqual({ cardId: "card-2", action: "released_orphaned" });
  });

  it("does not release expired locks that still belong to active orders", async () => {
    mockCheckAndExpire.mockResolvedValue({ expired: false, releasedCards: 0 });
    const db = createMockDb({
      expiredOrders: [],
      orphanedCards: [
        { id: "card-paid", lockedOrderId: "order-paid", orderStatus: "paid" },
        { id: "card-issued", lockedOrderId: "order-issued", orderStatus: "issued" },
        { id: "card-pending", lockedOrderId: "order-pending", orderStatus: "pending" },
        { id: "card-expired", lockedOrderId: "order-expired", orderStatus: "expired" },
      ],
    });
    const result = await cleanupExpiredOrders(db);
    const logs = (db as any)._insertedLogs;

    expect(result.releasedCards).toBe(1);
    expect(logs).toEqual([{ cardId: "card-expired", action: "released_orphaned" }]);
  });

  it("does not count or log an orphaned card when the guarded release updates no row", async () => {
    mockCheckAndExpire.mockResolvedValue({ expired: false, releasedCards: 0 });
    const db = createMockDb({
      expiredOrders: [],
      orphanedCards: [
        { id: "card-raced-to-paid", lockedOrderId: "order-raced", orderStatus: "pending" },
      ],
      orphanReleaseRows: [],
    });

    const result = await cleanupExpiredOrders(db);
    const logs = (db as any)._insertedLogs;

    expect(result.releasedCards).toBe(0);
    expect(logs).toEqual([]);
  });

  it("counts and logs only expired cards actually disabled", async () => {
    mockCheckAndExpire.mockResolvedValue({ expired: false, releasedCards: 0 });
    const db = createMockDb({
      expiredOrders: [],
      expiredAvailableCards: [
        { id: "card-raced-to-locked", accountLabel: "RACED" },
      ],
      disableRows: [],
    });

    const result = await cleanupExpiredOrders(db);
    const logs = (db as any)._insertedLogs;

    expect(result.disabledExpiredCards).toBe(0);
    expect(logs).toEqual([]);
  });
});
