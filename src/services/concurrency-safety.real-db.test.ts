import { afterEach, describe, expect, it } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { count, eq } from "drizzle-orm";
import { createDb, type DbType } from "../db/client";
import { runMigrations } from "../db/migrations";
import {
  balanceRechargeOrders,
  balanceTransactions,
  cards,
  orderItems,
  orders,
  products,
  userBalances,
  voucherCodes,
} from "../db/schema";
import { lockCardForOrder } from "./issue-service";
import { deductBalance, redeemVoucher } from "./voucher-service";
import { settleRechargeOrder } from "./recharge-service";
import { createOfflineOrder, handleInternalSettlement } from "../routes/pay";

const openClients: Array<{ client: Client }> = [];

async function createConcurrencyDbs(): Promise<[DbType, DbType]> {
  const path = `/tmp/cf-shop-concurrency-${crypto.randomUUID()}.db`;
  // 使用两个独立客户端模拟两个并发请求/Worker 连接。本地 file: 驱动的 busy timeout 会同步阻塞
  // Node 事件循环，因此保持默认 0，让失败方立即进入 withDbTransaction 的异步有界退避。
  const clients = [
    createClient({ url: `file:${path}` }),
    createClient({ url: `file:${path}` }),
  ];
  openClients.push(...clients.map((client) => ({ client })));
  const dbs = clients.map(createDb) as [DbType, DbType];
  await runMigrations(dbs[0]);
  return dbs;
}

afterEach(() => {
  for (const { client } of openClients.splice(0)) {
    client.close();
  }
});

describe("real libSQL concurrency safety", () => {
  it("locks one inventory card exactly once under concurrent reservations", async () => {
    const [db, concurrentDb] = await createConcurrencyDbs();
    await db.insert(cards).values({
      id: "card-concurrent-1",
      productId: "product-concurrent",
      accountLabel: "account",
      deliverySecret: "secret",
      status: "available",
      createdAt: new Date().toISOString(),
    });

    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const results = await Promise.all([
      lockCardForOrder(db, "order-concurrent-a", "product-concurrent", expiresAt),
      lockCardForOrder(concurrentDb, "order-concurrent-b", "product-concurrent", expiresAt),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    const rows = await db.select({ status: cards.status, lockedOrderId: cards.lockedOrderId }).from(cards);
    expect(rows).toEqual([{ status: "locked", lockedOrderId: expect.stringMatching(/^order-concurrent-/) }]);
  });

  it("never drives a balance below zero under concurrent deductions", async () => {
    const [db, concurrentDb] = await createConcurrencyDbs();
    await db.insert(userBalances).values({
      email: "concurrent-balance@example.com",
      balanceCents: 1000,
      totalDepositedCents: 1000,
      totalSpentCents: 0,
      updatedAt: new Date().toISOString(),
    });

    const results = await Promise.allSettled([
      deductBalance(db, "concurrent-balance@example.com", 700, { referenceId: "spend-a" }),
      deductBalance(concurrentDb, "concurrent-balance@example.com", 700, { referenceId: "spend-b" }),
    ]);

    const successfulDeductions = results.filter((result) => result.status === "fulfilled" && result.value);
    const rejectedDeductions = results.filter((result) => result.status === "rejected");
    const [balance] = await db.select().from(userBalances);
    const [ledgerCount] = await db.select({ value: count() }).from(balanceTransactions);

    // 即使本地 file: 驱动把并发写锁暴露为 SQLITE_BUSY，数据库最终状态也必须满足资金守恒。
    // 业务层随后还应把可恢复的锁冲突收敛为一个正常的“余额不足”结果，而不是向调用方抛 500。
    expect(successfulDeductions).toHaveLength(1);
    expect(rejectedDeductions).toHaveLength(0);
    expect(balance).toMatchObject({ balanceCents: 300, totalSpentCents: 700 });
    expect(Number(ledgerCount?.value || 0)).toBe(1);
  });

  it("redeems one voucher only once under concurrent requests", async () => {
    const [db, concurrentDb] = await createConcurrencyDbs();
    await db.insert(voucherCodes).values({
      code: "VCH-CONCURRENT",
      amountCents: 500,
      status: "active",
      createdAt: new Date().toISOString(),
    });

    const results = await Promise.all([
      redeemVoucher(concurrentDb, "VCH-CONCURRENT", "voucher-buyer@example.com"),
      redeemVoucher(db, "VCH-CONCURRENT", "voucher-buyer@example.com"),
    ]);

    expect(results.filter((result) => result.success)).toHaveLength(1);
    const [voucher] = await db.select().from(voucherCodes);
    const [balance] = await db.select().from(userBalances);
    expect(voucher?.status).toBe("used");
    expect(balance).toMatchObject({ balanceCents: 500, totalDepositedCents: 500 });
  });

  it("credits one recharge order once when the provider callback races with itself", async () => {
    const [db, concurrentDb] = await createConcurrencyDbs();
    const now = new Date().toISOString();
    await db.insert(balanceRechargeOrders).values({
      id: "recharge-concurrent-1",
      orderNo: "R-CONCURRENT-1",
      buyerEmail: "recharge-buyer@example.com",
      amountCents: 900,
      currency: "CNY",
      status: "pending",
      paymentProvider: "easypay",
      paymentRef: "",
      orderTokenHash: "token-hash",
      createdAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const results = await Promise.allSettled([
      settleRechargeOrder(concurrentDb, { id: "recharge-concurrent-1", paymentProvider: "easypay", paymentRef: "TRADE-CONCURRENT", paidAt: now }),
      settleRechargeOrder(db, { id: "recharge-concurrent-1", paymentProvider: "easypay", paymentRef: "TRADE-CONCURRENT", paidAt: now }),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled").map((result) => result.value);
    const rejected = results.filter((result) => result.status === "rejected");
    const [balance] = await db.select().from(userBalances);
    const [recharge] = await db.select().from(balanceRechargeOrders);
    const [ledgerCount] = await db.select({ value: count() }).from(balanceTransactions);

    expect(rejected).toHaveLength(0);
    expect(fulfilled.filter((result) => result.ok && !result.alreadyPaid)).toHaveLength(1);
    expect(fulfilled.filter((result) => result.ok && result.alreadyPaid)).toHaveLength(1);
    expect(balance).toMatchObject({ balanceCents: 900, totalDepositedCents: 900 });
    expect(recharge).toMatchObject({ status: "paid", paymentRef: "TRADE-CONCURRENT" });
    expect(Number(ledgerCount?.value || 0)).toBe(1);
  });

  it("charges and fulfills one balance order exactly once under concurrent settlement", async () => {
    const [db, concurrentDb] = await createConcurrencyDbs();
    const now = new Date().toISOString();
    await db.insert(products).values({
      id: "product-balance-concurrent",
      slug: "product-balance-concurrent",
      title: "Concurrent balance product",
      priceCents: 400,
      currency: "CNY",
      fulfillmentMode: "card",
      issueMode: "manual",
      active: 1,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(orders).values({
      id: "order-balance-concurrent",
      orderNo: "O-BALANCE-CONCURRENT",
      productId: "product-balance-concurrent",
      buyerContact: "balance@example.com",
      buyerEmail: "balance@example.com",
      amountCents: 400,
      currency: "CNY",
      status: "pending",
      fulfillmentMode: "card",
      issueMode: "manual",
      paymentMethod: "online",
      paymentProvider: "balance",
      createdAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await db.insert(orderItems).values({
      id: "item-balance-concurrent",
      orderId: "order-balance-concurrent",
      productId: "product-balance-concurrent",
      productTitle: "Concurrent balance product",
      fulfillmentMode: "card",
      quantity: 1,
      unitPriceCents: 400,
      amountCents: 400,
      createdAt: now,
    });
    await db.insert(cards).values({
      id: "card-balance-concurrent",
      productId: "product-balance-concurrent",
      accountLabel: "account",
      deliverySecret: "secret",
      status: "locked",
      lockedOrderId: "order-balance-concurrent",
      lockExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: now,
    });
    await db.insert(userBalances).values({
      email: "balance@example.com",
      balanceCents: 1000,
      totalDepositedCents: 1000,
      totalSpentCents: 0,
      updatedAt: now,
    });

    const product = {
      id: "product-balance-concurrent",
      title: "Concurrent balance product",
      fulfillmentMode: "card" as const,
    };
    const results = await Promise.allSettled([
      handleInternalSettlement(db, "order-balance-concurrent", "balance@example.com", 400, product),
      handleInternalSettlement(concurrentDb, "order-balance-concurrent", "balance@example.com", 400, product),
    ]);

    expect(results.filter((result) => result.status === "rejected")).toHaveLength(0);
    expect(results.every((result) => result.status === "fulfilled" && result.value.ok)).toBe(true);
    const [order] = await db.select().from(orders).where(eq(orders.id, "order-balance-concurrent"));
    const [card] = await db.select().from(cards).where(eq(cards.id, "card-balance-concurrent"));
    const [balance] = await db.select().from(userBalances).where(eq(userBalances.email, "balance@example.com"));
    const [ledgerCount] = await db
      .select({ value: count() })
      .from(balanceTransactions)
      .where(eq(balanceTransactions.referenceId, "order-balance-concurrent"));

    expect(order?.status).toBe("issued");
    expect(card).toMatchObject({ status: "issued", issuedOrderId: "order-balance-concurrent" });
    expect(balance).toMatchObject({ balanceCents: 600, totalSpentCents: 400 });
    expect(Number(ledgerCount?.value || 0)).toBe(1);
  });

  it("does not exceed a one-item email purchase limit under concurrent offline orders", async () => {
    const [db, concurrentDb] = await createConcurrencyDbs();
    const now = new Date().toISOString();
    await db.insert(products).values({
      id: "product-limit-concurrent",
      slug: "product-limit-concurrent",
      title: "Concurrent limit product",
      priceCents: 100,
      currency: "CNY",
      fulfillmentMode: "card",
      issueMode: "manual",
      active: 1,
      purchaseLimit: 1,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(cards).values([
      {
        id: "card-limit-concurrent-1",
        productId: "product-limit-concurrent",
        accountLabel: "account-1",
        deliverySecret: "secret-1",
        status: "available",
        createdAt: now,
      },
      {
        id: "card-limit-concurrent-2",
        productId: "product-limit-concurrent",
        accountLabel: "account-2",
        deliverySecret: "secret-2",
        status: "available",
        createdAt: now,
      },
    ]);

    const orderInput = {
      id: "product-limit-concurrent",
      currency: "CNY",
      title: "Concurrent limit product",
      priceCents: 100,
      fulfillmentMode: "card" as const,
      purchaseLimit: 1,
    };
    const results = await Promise.allSettled([
      createOfflineOrder(concurrentDb, orderInput, "limit-buyer@example.com", 1, 100, 0, "manual", undefined, undefined, "", "", "concurrency-test"),
      createOfflineOrder(db, orderInput, "limit-buyer@example.com", 1, 100, 0, "manual", undefined, undefined, "", "", "concurrency-test"),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected" && String(result.reason).includes("限购"))).toHaveLength(1);
    const [orderCount] = await db.select({ value: count() }).from(orders).where(eq(orders.buyerEmail, "limit-buyer@example.com"));
    const [lockedCount] = await db.select({ value: count() }).from(cards).where(eq(cards.status, "locked"));
    expect(Number(orderCount?.value || 0)).toBe(1);
    expect(Number(lockedCount?.value || 0)).toBe(1);
  });
});
