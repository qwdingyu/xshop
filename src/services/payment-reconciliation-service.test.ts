import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DbType } from "../db/client";
import { reconcileOnlineOrderPayment } from "./payment-reconciliation-service";

const queryStatus = vi.fn();
const markPaidAndIssue = vi.fn();
const writeOrderEvent = vi.fn();
const restoreCouponReservation = vi.fn();

vi.mock("./payments", () => ({
  createDbProviderRegistryForCallback: vi.fn().mockResolvedValue({
    get: () => ({
      name: "easypay",
      queryStatus: (...args: unknown[]) => queryStatus(...args),
    }),
  }),
  isValidProviderName: (name: string) => name === "easypay",
}));

vi.mock("./order-service", () => ({
  markPaidAndIssue: (...args: unknown[]) => markPaidAndIssue(...args),
}));

vi.mock("./audit-service", () => ({
  writeOrderEvent: (...args: unknown[]) => writeOrderEvent(...args),
}));

vi.mock("./coupon-service", () => ({
  restoreCouponReservation: (...args: unknown[]) => restoreCouponReservation(...args),
}));

function createDb(updateRows: Array<Record<string, unknown>> = [{ id: "order-1" }]) {
  const updateSets: unknown[] = [];
  const db = {
    update: () => ({
      set: (data: unknown) => {
        updateSets.push(data);
        return {
          where: () => ({
            returning: () => Promise.resolve(updateRows),
          }),
        };
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    }),
  } as unknown as DbType & { updateSets: unknown[] };
  db.updateSets = updateSets;
  return db;
}

describe("payment-reconciliation-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    markPaidAndIssue.mockResolvedValue({ ok: true, card: { id: "card-1" }, cards: [{ id: "card-1" }] });
  });

  it("marks a pending online order paid and retries fulfillment when provider query is verified", async () => {
    queryStatus.mockResolvedValueOnce({
      paid: true,
      providerTradeNo: "EP-001",
      providerCreatedAt: "2026-07-18 10:00:00",
      paidAt: "2026-07-18 10:03:00",
      amountCents: 1200,
      currency: "CNY",
    });
    const db = createDb();

    const result = await reconcileOnlineOrderPayment(db, { CREDENTIALS_ENCRYPTION_KEY: "a".repeat(64) }, {
      id: "order-1",
      orderNo: "PORDER001",
      status: "pending",
      paymentProvider: "easypay",
      amountCents: 1200,
      currency: "CNY",
      createdAt: "2026-07-18T10:00:00.000Z",
      expiresAt: "2026-07-18T10:30:00.000Z",
    });

    expect(result).toMatchObject({ reconciled: true, issueOk: true });
    expect(queryStatus).toHaveBeenCalledWith("PORDER001");
    expect(db.updateSets).toContainEqual(expect.objectContaining({
      status: "paid",
      paymentProvider: "easypay",
      paymentRef: "EP-001",
    }));
    expect(markPaidAndIssue).toHaveBeenCalledWith(db, "order-1", undefined, undefined);
    expect(writeOrderEvent).toHaveBeenCalledWith(
      db,
      "order-1",
      "payment_reconciled",
      "主动查单确认支付成功",
      { provider: "easypay", trade_no: "EP-001" },
    );
  });

  it("refuses to reconcile when provider amount does not match the local order", async () => {
    queryStatus.mockResolvedValueOnce({
      paid: true,
      providerTradeNo: "EP-MISMATCH",
      amountCents: 1,
      currency: "CNY",
    });
    const db = createDb();

    const result = await reconcileOnlineOrderPayment(db, { CREDENTIALS_ENCRYPTION_KEY: "a".repeat(64) }, {
      id: "order-mismatch",
      orderNo: "PMISMATCH001",
      status: "pending",
      paymentProvider: "easypay",
      amountCents: 1200,
      currency: "CNY",
      createdAt: "2026-07-18T10:00:00.000Z",
      expiresAt: "2026-07-18T10:30:00.000Z",
    });

    expect(result).toMatchObject({ reconciled: false, reason: "amount_mismatch" });
    expect(db.updateSets).toHaveLength(0);
    expect(markPaidAndIssue).not.toHaveBeenCalled();
    expect(writeOrderEvent).toHaveBeenCalledWith(
      db,
      "order-mismatch",
      "payment_reconcile_amount_mismatch",
      "支付查单金额与订单金额不一致，未自动入账",
      expect.objectContaining({ expected: 1200, received: 1 }),
    );
  });

  it("refuses to query or settle an order whose currency snapshot is missing", async () => {
    const db = createDb();

    const result = await reconcileOnlineOrderPayment(db, { CREDENTIALS_ENCRYPTION_KEY: "a".repeat(64) }, {
      id: "order-missing-currency",
      orderNo: "PMISSINGCURRENCY001",
      status: "pending",
      paymentProvider: "easypay",
      amountCents: 1200,
      currency: "",
      createdAt: "2026-07-18T10:00:00.000Z",
      expiresAt: "2026-07-18T10:30:00.000Z",
    });

    expect(result).toEqual({ reconciled: false, reason: "invalid_order_currency" });
    expect(queryStatus).not.toHaveBeenCalled();
    expect(db.updateSets).toHaveLength(0);
    expect(markPaidAndIssue).not.toHaveBeenCalled();
  });

  it("returns a state conflict when the order disappears during the paid-state CAS", async () => {
    queryStatus.mockResolvedValueOnce({
      paid: true,
      providerTradeNo: "EP-MISSING",
      providerCreatedAt: "2026-07-18 10:00:00",
      paidAt: "2026-07-18 10:03:00",
      amountCents: 1200,
      currency: "CNY",
    });
    const db = createDb([]);

    const result = await reconcileOnlineOrderPayment(db, { CREDENTIALS_ENCRYPTION_KEY: "a".repeat(64) }, {
      id: "order-deleted",
      orderNo: "PDELETED001",
      status: "pending",
      paymentProvider: "easypay",
      amountCents: 1200,
      currency: "CNY",
      createdAt: "2026-07-18T10:00:00.000Z",
      expiresAt: "2026-07-18T10:30:00.000Z",
    });

    expect(result).toEqual({ reconciled: false, reason: "state_conflict" });
    expect(markPaidAndIssue).not.toHaveBeenCalled();
    expect(writeOrderEvent).toHaveBeenCalledWith(
      db,
      "order-deleted",
      "payment_reconcile_state_conflict",
      "支付查单写入时订单状态已变更",
      expect.objectContaining({ status: "missing" }),
    );
  });

  it("refuses to reconcile when EasyPay query trade number conflicts with the recorded payment ref", async () => {
    queryStatus.mockResolvedValueOnce({
      paid: true,
      providerTradeNo: "EP-NEW",
      providerCreatedAt: "2026-07-18 10:00:00",
      paidAt: "2026-07-18 10:03:00",
      amountCents: 1200,
      currency: "CNY",
    });
    const db = createDb();

    const result = await reconcileOnlineOrderPayment(db, { CREDENTIALS_ENCRYPTION_KEY: "a".repeat(64) }, {
      id: "order-trade-conflict",
      orderNo: "PTRADECONFLICT001",
      status: "expired",
      paymentProvider: "easypay",
      paymentRef: "EP-OLD",
      amountCents: 1200,
      currency: "CNY",
      createdAt: "2026-07-18T10:00:00.000Z",
      expiresAt: "2026-07-18T10:30:00.000Z",
    });

    expect(result).toMatchObject({ reconciled: false, reason: "timing_unverified" });
    expect(db.updateSets).toHaveLength(0);
    expect(markPaidAndIssue).not.toHaveBeenCalled();
    expect(writeOrderEvent).toHaveBeenCalledWith(
      db,
      "order-trade-conflict",
      "payment_reconcile_timing_unverified",
      "支付查单无法证明付款发生在订单有效期内，未自动入账",
      expect.objectContaining({ provider: "easypay", trade_no: "EP-NEW" }),
    );
  });

  it("restores an expired order only when EasyPay timing proves payment happened before expiry", async () => {
    queryStatus.mockResolvedValueOnce({
      paid: true,
      providerTradeNo: "EP-BEFORE-EXPIRY",
      providerCreatedAt: "2026-07-18 10:00:00",
      paidAt: "2026-07-18 10:29:00",
      amountCents: 1200,
      currency: "CNY",
    });
    const db = createDb([{ id: "order-expired", couponCode: "SAVE10" }]);

    const result = await reconcileOnlineOrderPayment(db, { CREDENTIALS_ENCRYPTION_KEY: "a".repeat(64) }, {
      id: "order-expired",
      orderNo: "PEXPIRED001",
      status: "expired",
      paymentProvider: "easypay",
      amountCents: 1200,
      currency: "CNY",
      createdAt: "2026-07-18T10:00:00.000Z",
      expiresAt: "2026-07-18T10:30:00.000Z",
    });

    expect(result).toMatchObject({ reconciled: true, issueOk: true });
    expect(db.updateSets).toContainEqual(expect.objectContaining({
      status: "paid",
      paymentProvider: "easypay",
      paymentRef: "EP-BEFORE-EXPIRY",
      paidAt: "2026-07-18T10:29:00.000Z",
    }));
    expect(restoreCouponReservation).toHaveBeenCalledWith(db, "SAVE10");
    expect(markPaidAndIssue).toHaveBeenCalledWith(db, "order-expired", undefined, undefined);
  });
});
