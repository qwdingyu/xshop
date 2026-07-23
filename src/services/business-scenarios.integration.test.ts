import { createClient, type Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "hono";
import type { AppEnv, FulfillmentMode, IssueMode } from "../bindings";
import { createDb, type DbType } from "../db/client";
import { products, cards, orders, orderItems, voucherCodes, userBalances, balanceTransactions, systemConfig, coupons } from "../db/schema";
import { runMigrations } from "../db/migrations";
import { createOrder, getOrderByToken, markPaidAndIssue, checkAndExpireOrder } from "./order-service";
import { cancelOrder, getAdminProducts, getAdminSummary, getLowStockProducts } from "./admin-service";
import { getProduct, listProducts } from "./product-service";
import { redeemVoucher } from "./voucher-service";
import { createOfflineOrder, handleInternalSettlement } from "../routes/pay";
import { cleanupExpiredOrders } from "./cleanup-service";

vi.mock("./email-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./email-service")>();
  return {
    ...actual,
    sendEmail: vi.fn().mockResolvedValue({ ok: true }),
  };
});

declare const process: { env: Record<string, string | undefined> };

const scenarioClients = new Set<Client>();

afterEach(() => {
  // 每个场景使用独立真实数据库；测试结束必须关闭客户端，否则全量并发时 worker 无法退出。
  for (const client of scenarioClients) client.close();
  scenarioClients.clear();
});

function createContext(db: DbType): Context<AppEnv> {
  return {
    get: (key: string) => {
      if (key === "db") return db;
      if (key === "executionCtx") return { waitUntil: (promise: Promise<unknown>) => promise.catch(() => {}) };
      return undefined;
    },
    env: {
      ADMIN_TOKEN: "test-admin-token",
    },
    req: {
      header: (name: string) => name.toLowerCase() === "user-agent" ? "business-scenario-test" : undefined,
      url: "https://shop.example.test/api/orders",
      method: "POST",
    },
  } as unknown as Context<AppEnv>;
}

async function createScenarioDb() {
  const dbUrl = `file:${process.env.TMPDIR || "/tmp"}/cf-shop-business-${crypto.randomUUID()}.db`;
  const client = createClient({ url: dbUrl });
  scenarioClients.add(client);
  const db = createDb(client);
  await runMigrations(db);
  return { client, db };
}

async function seedProduct(db: DbType, input: {
  id: string;
  title: string;
  priceCents: number;
  issueMode: IssueMode;
  fulfillmentMode: FulfillmentMode;
  salesCopy?: string;
  purchaseLimit?: number | null;
  active?: boolean;
}) {
  await db.insert(products).values({
    id: input.id,
    slug: input.id,
    title: input.title,
    description: "",
    salesCopy: input.salesCopy || "",
    coverUrl: "",
    tagsJson: "[]",
    priceCents: input.priceCents,
    currency: "CNY",
    issueMode: input.issueMode,
    fulfillmentMode: input.fulfillmentMode,
    active: input.active === false ? 0 : 1,
    sortOrder: 100,
    category: "test",
    purchaseLimit: input.purchaseLimit ?? null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

async function seedCard(db: DbType, input: {
  id: string;
  productId: string;
  secret: string;
  accountLabel?: string;
}) {
  await db.insert(cards).values({
    id: input.id,
    productId: input.productId,
    batchId: "",
    accountLabel: input.accountLabel ?? input.id,
    deliverySecret: input.secret,
    deliveryNote: "",
    status: "available",
    createdAt: new Date().toISOString(),
  });
}

describe("核心业务场景集成测试（真实 libSQL + 真实服务层）", () => {
  it("低库存预警只统计在售卡密商品并排除下架商品", async () => {
    const { db } = await createScenarioDb();
    await seedProduct(db, {
      id: "active-low-stock",
      title: "在售低库存",
      priceCents: 100,
      issueMode: "manual",
      fulfillmentMode: "card",
    });
    await seedProduct(db, {
      id: "inactive-low-stock",
      title: "下架零库存",
      priceCents: 100,
      issueMode: "manual",
      fulfillmentMode: "card",
      active: false,
    });

    const lowStock = await getLowStockProducts(db, 3);
    expect(lowStock.map((product) => product.id)).toEqual(["active-low-stock"]);

    const summary = await getAdminSummary(db);
    expect(summary?.lowStockCount).toBe(1);
  });

  it("后台首页和商品列表应使用真实库存统计闭环，分页 total 不被卡密行放大", async () => {
    const { db } = await createScenarioDb();
    const now = new Date();
    const expiredLock = new Date(now.getTime() - 60_000).toISOString();
    const futureLock = new Date(now.getTime() + 60_000).toISOString();

    await seedProduct(db, {
      id: "prod-low",
      title: "低库存商品",
      priceCents: 100,
      issueMode: "manual",
      fulfillmentMode: "card",
    });
    await seedProduct(db, {
      id: "prod-ok",
      title: "正常库存商品",
      priceCents: 100,
      issueMode: "manual",
      fulfillmentMode: "card",
    });
    await seedProduct(db, {
      id: "prod-link",
      title: "虚拟资料链接",
      priceCents: 100,
      issueMode: "direct",
      fulfillmentMode: "link",
    });

    await db.insert(cards).values([
      {
        id: "card-low-1",
        productId: "prod-low",
        accountLabel: "低库存-可用",
        deliverySecret: "secret-low-1",
        status: "available",
        createdAt: now.toISOString(),
      },
      {
        id: "card-low-2",
        productId: "prod-low",
        accountLabel: "低库存-过期锁",
        deliverySecret: "secret-low-2",
        status: "locked",
        lockExpiresAt: expiredLock,
        createdAt: now.toISOString(),
      },
      {
        id: "card-low-expired-card",
        productId: "prod-low",
        accountLabel: "低库存-卡密自身已过期",
        deliverySecret: "secret-low-expired-card",
        status: "available",
        expiresAt: new Date(now.getTime() - 60_000).toISOString(),
        createdAt: now.toISOString(),
      },
      {
        id: "card-low-3",
        productId: "prod-low",
        accountLabel: "低库存-未过期锁",
        deliverySecret: "secret-low-3",
        status: "locked",
        lockExpiresAt: futureLock,
        createdAt: now.toISOString(),
      },
      {
        id: "card-ok-1",
        productId: "prod-ok",
        accountLabel: "正常库存-1",
        deliverySecret: "secret-ok-1",
        status: "available",
        createdAt: now.toISOString(),
      },
      {
        id: "card-ok-2",
        productId: "prod-ok",
        accountLabel: "正常库存-2",
        deliverySecret: "secret-ok-2",
        status: "available",
        createdAt: now.toISOString(),
      },
      {
        id: "card-ok-3",
        productId: "prod-ok",
        accountLabel: "正常库存-3",
        deliverySecret: "secret-ok-3",
        status: "available",
        createdAt: now.toISOString(),
      },
    ]);
    await db.insert(systemConfig).values({
      key: "inventory_warning_threshold",
      value: "3",
      updatedAt: now.toISOString(),
    });

    const storefrontProducts = await listProducts(db);
    expect(storefrontProducts.find((p) => p.id === "prod-low")?.stock).toBe(2);
    expect(storefrontProducts.find((p) => p.id === "prod-ok")?.stock).toBe(3);

    const adminProducts = await getAdminProducts(db, {
      q: "",
      active: "",
      category: "",
      page: 1,
      limit: 20,
    });
    expect(adminProducts.total).toBe(3);
    expect(adminProducts.products.find((p) => p.id === "prod-low")?.stock).toBe(2);

    const lowStock = await getLowStockProducts(db, 3);
    expect(lowStock.map((p) => p.id)).toEqual(["prod-low"]);

    const summary = await getAdminSummary(db);
    expect(summary?.products).toBe(3);
    expect(summary?.totalCards).toBe(7);
    expect(summary?.availableCards).toBe(4);
    expect(summary?.lowStockCount).toBe(1);
  });

  it("卡密自身过期时：前台库存、详情库存和下单锁卡必须一致排除", async () => {
    const { db } = await createScenarioDb();
    const now = new Date();
    await seedProduct(db, {
      id: "expired-card-product",
      title: "Expired Card Product",
      priceCents: 900,
      issueMode: "manual",
      fulfillmentMode: "card",
    });
    await db.insert(cards).values({
      id: "expired-card-only",
      productId: "expired-card-product",
      batchId: "",
      accountLabel: "EXPIRED",
      deliverySecret: "EXPIRED-SECRET",
      deliveryNote: "",
      status: "available",
      expiresAt: new Date(now.getTime() - 60_000).toISOString(),
      createdAt: now.toISOString(),
    });

    const listProduct = (await listProducts(db)).find((product) => product.id === "expired-card-product");
    const detailProduct = await getProduct(db, "expired-card-product");
    const orderResult = await createOrder(createContext(db), {
      productId: "expired-card-product",
      buyerEmail: "expired-card@example.com",
    }, "ip-hash");
    const [expiredCard] = await db.select().from(cards).where(eq(cards.id, "expired-card-only"));

    expect(listProduct?.stock).toBe(0);
    expect(detailProduct?.stock).toBe(0);
    expect(orderResult).toMatchObject({ ok: false, status: 409, message: "当前商品库存不足" });
    expect(expiredCard.status).toBe("available");
    expect(expiredCard.lockedOrderId).toBeNull();
  });

  it("已锁定订单付款时如果卡密自身过期，不得继续发放过期卡密", async () => {
    const { db } = await createScenarioDb();
    const now = new Date();
    await seedProduct(db, {
      id: "locked-then-card-expired",
      title: "Locked Then Card Expired",
      priceCents: 900,
      issueMode: "manual",
      fulfillmentMode: "card",
    });
    await seedCard(db, { id: "locked-then-card-expired-1", productId: "locked-then-card-expired", secret: "EXPIRES-AFTER-LOCK" });

    const orderResult = await createOrder(createContext(db), {
      productId: "locked-then-card-expired",
      buyerEmail: "locked-expired@example.com",
    }, "ip-hash");
    expect(orderResult.ok).toBe(true);
    if (!orderResult.ok) return;

    await db
      .update(cards)
      .set({ expiresAt: new Date(now.getTime() - 60_000).toISOString() })
      .where(eq(cards.id, "locked-then-card-expired-1"));

    const issueResult = await markPaidAndIssue(db, String(orderResult.order.id));
    const [card] = await db.select().from(cards).where(eq(cards.id, "locked-then-card-expired-1"));
    const [order] = await db.select().from(orders).where(eq(orders.id, String(orderResult.order.id)));

    expect(issueResult).toMatchObject({ ok: false, status: 409, message: "当前商品库存不足" });
    expect(card.status).toBe("locked");
    expect(card.issuedOrderId).toBeNull();
    expect(order.status).toBe("paid");
  });

  it("清理任务不得释放已付款订单的过期锁定卡密", async () => {
    const { db } = await createScenarioDb();
    const now = new Date();
    await seedProduct(db, {
      id: "paid-lock-cleanup",
      title: "Paid Lock Cleanup",
      priceCents: 900,
      issueMode: "manual",
      fulfillmentMode: "card",
    });
    await seedCard(db, { id: "paid-lock-cleanup-card", productId: "paid-lock-cleanup", secret: "KEEP-LOCKED-FOR-PAID" });

    const orderResult = await createOrder(createContext(db), {
      productId: "paid-lock-cleanup",
      buyerEmail: "paid-lock-cleanup@example.com",
    }, "ip-hash");
    expect(orderResult.ok).toBe(true);
    if (!orderResult.ok) return;

    await db.update(orders).set({ status: "paid", paidAt: now.toISOString() }).where(eq(orders.id, String(orderResult.order.id)));
    await db.update(cards).set({ lockExpiresAt: new Date(now.getTime() - 60_000).toISOString() }).where(eq(cards.id, "paid-lock-cleanup-card"));

    const cleanup = await cleanupExpiredOrders(db);
    const [card] = await db.select().from(cards).where(eq(cards.id, "paid-lock-cleanup-card"));
    const [order] = await db.select().from(orders).where(eq(orders.id, String(orderResult.order.id)));

    expect(cleanup.releasedCards).toBe(0);
    expect(card.status).toBe("locked");
    expect(card.lockedOrderId).toBe(String(orderResult.order.id));
    expect(order.status).toBe("paid");
  });

  it("新下单不得把已付款订单的过期锁当作可售库存并重新锁走", async () => {
    const { db } = await createScenarioDb();
    const now = new Date();
    await seedProduct(db, {
      id: "paid-lock-resale",
      title: "Paid Lock Resale",
      priceCents: 900,
      issueMode: "manual",
      fulfillmentMode: "card",
    });
    await seedCard(db, { id: "paid-lock-resale-card", productId: "paid-lock-resale", secret: "KEEP-FOR-PAID" });

    const paidOrderResult = await createOrder(createContext(db), {
      productId: "paid-lock-resale",
      buyerEmail: "paid-owner@example.com",
    }, "ip-hash-paid-owner");
    expect(paidOrderResult.ok).toBe(true);
    if (!paidOrderResult.ok) return;

    const paidOrderId = String(paidOrderResult.order.id);
    await db.update(orders).set({ status: "paid", paidAt: now.toISOString() }).where(eq(orders.id, paidOrderId));
    await db.update(cards).set({ lockExpiresAt: new Date(now.getTime() - 60_000).toISOString() }).where(eq(cards.id, "paid-lock-resale-card"));

    const product = await getProduct(db, "paid-lock-resale");
    const competingOrder = await createOrder(createContext(db), {
      productId: "paid-lock-resale",
      buyerEmail: "competing-buyer@example.com",
    }, "ip-hash-competing");
    const [card] = await db.select().from(cards).where(eq(cards.id, "paid-lock-resale-card"));

    expect(product?.stock).toBe(0);
    expect(competingOrder).toMatchObject({ ok: false, status: 409, message: "当前商品库存不足" });
    expect(card.status).toBe("locked");
    expect(card.lockedOrderId).toBe(paidOrderId);
  });

  it("回调到达前不得重新分配仍属于 pending 订单的过期锁", async () => {
    const { db } = await createScenarioDb();
    const now = new Date();
    await seedProduct(db, {
      id: "pending-lock-resale",
      title: "Pending Lock Resale",
      priceCents: 900,
      issueMode: "manual",
      fulfillmentMode: "card",
    });
    await seedCard(db, { id: "pending-lock-resale-card", productId: "pending-lock-resale", secret: "KEEP-FOR-PENDING" });

    const pendingOrderResult = await createOrder(createContext(db), {
      productId: "pending-lock-resale",
      buyerEmail: "pending-owner@example.com",
    }, "ip-hash-pending-owner");
    expect(pendingOrderResult.ok).toBe(true);
    if (!pendingOrderResult.ok) return;

    const pendingOrderId = String(pendingOrderResult.order.id);
    await db.update(cards).set({ lockExpiresAt: new Date(now.getTime() - 60_000).toISOString() }).where(eq(cards.id, "pending-lock-resale-card"));

    const product = await getProduct(db, "pending-lock-resale");
    const competingOrder = await createOrder(createContext(db), {
      productId: "pending-lock-resale",
      buyerEmail: "pending-competing@example.com",
    }, "ip-hash-pending-competing");
    const [card] = await db.select().from(cards).where(eq(cards.id, "pending-lock-resale-card"));

    expect(product?.stock).toBe(0);
    expect(competingOrder).toMatchObject({ ok: false, status: 409, message: "当前商品库存不足" });
    expect(card.status).toBe("locked");
    expect(card.lockedOrderId).toBe(pendingOrderId);
  });

  it("下架商品不能通过详情或下单入口继续售卖", async () => {
    const { db } = await createScenarioDb();
    await seedProduct(db, {
      id: "inactive-card",
      title: "Inactive Card",
      priceCents: 900,
      issueMode: "manual",
      fulfillmentMode: "card",
    });
    await seedCard(db, { id: "inactive-card-1", productId: "inactive-card", secret: "INACTIVE-SECRET" });
    await db.update(products).set({ active: 0 }).where(eq(products.id, "inactive-card"));

    const storefrontProducts = await listProducts(db);
    const detail = await getProduct(db, "inactive-card");
    const orderResult = await createOrder(createContext(db), {
      productId: "inactive-card",
      buyerEmail: "inactive@example.com",
    }, "ip-hash");
    const [card] = await db.select().from(cards).where(eq(cards.id, "inactive-card-1"));

    expect(storefrontProducts.some((product) => product.id === "inactive-card")).toBe(false);
    expect(detail).toBeNull();
    expect(orderResult).toMatchObject({ ok: false, status: 404, message: "商品不存在或已下架" });
    expect(card.status).toBe("available");
    expect(card.lockedOrderId).toBeNull();
  });

  it("manual 卡密订单：下单锁库存，确认付款后发同一张卡，并可用 token 查到交付内容", async () => {
    const { db } = await createScenarioDb();
    await seedProduct(db, {
      id: "manual-card",
      title: "Manual Card",
      priceCents: 1200,
      issueMode: "manual",
      fulfillmentMode: "card",
    });
    await seedCard(db, { id: "card-1", productId: "manual-card", secret: "SECRET-1", accountLabel: "ACC-1" });

    const orderResult = await createOrder(createContext(db), {
      productId: "manual-card",
      buyerEmail: "buyer@example.com",
    }, "ip-hash");

    expect(orderResult.ok).toBe(true);
    if (!orderResult.ok) return;
    const orderId = String(orderResult.order.id);
    const orderToken = String(orderResult.order.orderToken);
    const [lockedCard] = await db.select().from(cards).where(eq(cards.id, "card-1"));
    expect(lockedCard.status).toBe("locked");
    expect(lockedCard.lockedOrderId).toBe(orderId);

    const issueResult = await markPaidAndIssue(db, orderId);
    expect(issueResult.ok).toBe(true);

    const [issuedOrder] = await db.select().from(orders).where(eq(orders.id, orderId));
    const [issuedCard] = await db.select().from(cards).where(eq(cards.id, "card-1"));
    expect(issuedOrder.status).toBe("issued");
    expect(issuedOrder.issuedCardId).toBe("card-1");
    expect(issuedCard.status).toBe("issued");
    expect(issuedCard.issuedOrderId).toBe(orderId);
    expect(issuedCard.buyerEmail).toBe("buyer@example.com");

    const publicOrder = await getOrderByToken(db, orderToken);
    expect(publicOrder?.delivery).toMatchObject({
      accountLabel: "ACC-1",
      deliverySecret: "SECRET-1",
    });
  });

  it("商品限购按购买件数累计，超过限购时不再锁库存", async () => {
    const { db } = await createScenarioDb();
    await seedProduct(db, {
      id: "limited-quantity-card",
      title: "Limited Quantity Card",
      priceCents: 1000,
      issueMode: "manual",
      fulfillmentMode: "card",
      purchaseLimit: 2,
    });
    await seedCard(db, { id: "limited-quantity-card-1", productId: "limited-quantity-card", secret: "LIMIT-1" });
    await seedCard(db, { id: "limited-quantity-card-2", productId: "limited-quantity-card", secret: "LIMIT-2" });
    await seedCard(db, { id: "limited-quantity-card-3", productId: "limited-quantity-card", secret: "LIMIT-3" });

    const first = await createOrder(createContext(db), {
      productId: "limited-quantity-card",
      buyerEmail: "limited@example.com",
      quantity: 1,
    }, "ip-hash");
    expect(first.ok).toBe(true);

    const second = await createOrder(createContext(db), {
      productId: "limited-quantity-card",
      buyerEmail: "limited@example.com",
      quantity: 2,
    }, "ip-hash");
    const cardRows = await db.select().from(cards).where(eq(cards.productId, "limited-quantity-card"));

    expect(second).toMatchObject({ ok: false, status: 429, message: "该商品每人限购 2 件，您已达到上限" });
    expect(cardRows.filter((card) => card.status === "locked")).toHaveLength(1);
    expect(cardRows.filter((card) => card.status === "available")).toHaveLength(2);
  });

  it("商品限购应将历史订单邮箱大小写视为同一邮箱", async () => {
    const { db } = await createScenarioDb();
    await seedProduct(db, {
      id: "case-insensitive-limit-card",
      title: "Case Insensitive Limit Card",
      priceCents: 1000,
      issueMode: "manual",
      fulfillmentMode: "card",
      purchaseLimit: 1,
    });
    await seedCard(db, { id: "case-insensitive-limit-card-1", productId: "case-insensitive-limit-card", secret: "CASE-LIMIT-1" });
    await db.insert(orders).values({
      id: "historical-uppercase-order",
      orderNo: "ORD-UPPERCASE",
      productId: "case-insensitive-limit-card",
      buyerContact: "legacy",
      buyerEmail: "Buyer@Example.COM",
      quantity: 1,
      amountCents: 1000,
      currency: "CNY",
      status: "issued",
      fulfillmentMode: "card",
      issueMode: "manual",
      createdAt: new Date().toISOString(),
    });

    const result = await createOrder(createContext(db), {
      productId: "case-insensitive-limit-card",
      buyerEmail: "buyer@example.com",
    }, "ip-hash");
    const [availableCard] = await db.select().from(cards).where(eq(cards.id, "case-insensitive-limit-card-1"));

    expect(result).toMatchObject({ ok: false, status: 429 });
    expect(availableCard.status).toBe("available");
  });

  it("已发卡密即使账号标签为空，token 查单也必须返回卡密 secret", async () => {
    const { db } = await createScenarioDb();
    await seedProduct(db, {
      id: "secret-only-card",
      title: "Secret Only Card",
      priceCents: 700,
      issueMode: "manual",
      fulfillmentMode: "card",
    });
    await seedCard(db, {
      id: "secret-only-card-1",
      productId: "secret-only-card",
      secret: "ONLY-SECRET",
      accountLabel: "",
    });

    const orderResult = await createOrder(createContext(db), {
      productId: "secret-only-card",
      buyerEmail: "secret-only@example.com",
    }, "ip-hash");
    expect(orderResult.ok).toBe(true);
    if (!orderResult.ok) return;

    const issueResult = await markPaidAndIssue(db, String(orderResult.order.id));
    expect(issueResult.ok).toBe(true);

    const publicOrder = await getOrderByToken(db, String(orderResult.order.orderToken));
    expect(publicOrder?.delivery).toMatchObject({
      accountLabel: "",
      deliverySecret: "ONLY-SECRET",
    });
  });

  it("manual 卡密订单：取消 pending 订单会释放软锁库存，库存可再次出售", async () => {
    const { db } = await createScenarioDb();
    await seedProduct(db, {
      id: "cancel-card",
      title: "Cancel Card",
      priceCents: 800,
      issueMode: "manual",
      fulfillmentMode: "card",
    });
    await seedCard(db, { id: "cancel-card-1", productId: "cancel-card", secret: "CANCEL-SECRET" });

    const orderResult = await createOrder(createContext(db), {
      productId: "cancel-card",
      buyerEmail: "cancel@example.com",
    }, "ip-hash");
    expect(orderResult.ok).toBe(true);
    if (!orderResult.ok) return;

    const cancelResult = await cancelOrder(db, String(orderResult.order.id));
    expect(cancelResult.releasedCards).toBe(1);

    const [releasedCard] = await db.select().from(cards).where(eq(cards.id, "cancel-card-1"));
    const [canceledOrder] = await db.select().from(orders).where(eq(orders.id, String(orderResult.order.id)));
    expect(canceledOrder.status).toBe("canceled");
    expect(releasedCard.status).toBe("available");
    expect(releasedCard.lockedOrderId).toBeNull();
  });

  it("后台取消不得取消已付款未发货订单，也不得释放已付款锁定库存", async () => {
    const { db } = await createScenarioDb();
    await seedProduct(db, {
      id: "cancel-paid-card",
      title: "Cancel Paid Card",
      priceCents: 800,
      issueMode: "manual",
      fulfillmentMode: "card",
    });
    await seedCard(db, { id: "cancel-paid-card-1", productId: "cancel-paid-card", secret: "PAID-CANCEL-SECRET" });

    const orderResult = await createOrder(createContext(db), {
      productId: "cancel-paid-card",
      buyerEmail: "cancel-paid@example.com",
    }, "ip-hash");
    expect(orderResult.ok).toBe(true);
    if (!orderResult.ok) return;

    await db.update(orders).set({ status: "paid", paidAt: new Date().toISOString() }).where(eq(orders.id, String(orderResult.order.id)));
    await expect(cancelOrder(db, String(orderResult.order.id))).rejects.toThrow("状态为 paid 的订单不可取消");

    const [lockedCard] = await db.select().from(cards).where(eq(cards.id, "cancel-paid-card-1"));
    const [paidOrder] = await db.select().from(orders).where(eq(orders.id, String(orderResult.order.id)));
    expect(paidOrder.status).toBe("paid");
    expect(lockedCard.status).toBe("locked");
    expect(lockedCard.lockedOrderId).toBe(String(orderResult.order.id));
  });

  it("余额支付：余额不足时关闭订单并释放库存；余额足够时扣款、发卡、写流水", async () => {
    const { db } = await createScenarioDb();
    await seedProduct(db, {
      id: "balance-card",
      title: "Balance Card",
      priceCents: 5000,
      issueMode: "manual",
      fulfillmentMode: "card",
    });
    await seedCard(db, { id: "balance-card-1", productId: "balance-card", secret: "BALANCE-1" });
    await db.insert(userBalances).values({
      email: "balance@example.com",
      balanceCents: 1000,
      totalDepositedCents: 1000,
      totalSpentCents: 0,
      updatedAt: new Date().toISOString(),
    });

    const insufficientOrder = await createOrder(createContext(db), {
      productId: "balance-card",
      buyerEmail: "balance@example.com",
    }, "ip-hash");
    expect(insufficientOrder.ok).toBe(true);
    if (!insufficientOrder.ok) return;
    // 生产统一下单会在创建事务中写入 balance；通用 createOrder 夹具默认不带支付渠道。
    await db.update(orders).set({ paymentProvider: "balance" }).where(eq(orders.id, String(insufficientOrder.order.id)));

    const insufficient = await handleInternalSettlement(db, String(insufficientOrder.order.id), "balance@example.com", 5000, {
      id: "balance-card",
      title: "Balance Card",
      fulfillmentMode: "card",
    });
    expect(insufficient.ok).toBe(false);
    expect(insufficient.status).toBe(402);
    const [releasedAfterInsufficient] = await db.select().from(cards).where(eq(cards.id, "balance-card-1"));
    expect(releasedAfterInsufficient.status).toBe("available");

    await db.insert(voucherCodes).values({
      code: "VCH-BALANCE-OK",
      amountCents: 5000,
      status: "active",
      createdAt: new Date().toISOString(),
    });
    const redeemResult = await redeemVoucher(db, "VCH-BALANCE-OK", "balance@example.com");
    expect(redeemResult.success).toBe(true);

    const paidOrder = await createOrder(createContext(db), {
      productId: "balance-card",
      buyerEmail: "balance@example.com",
    }, "ip-hash");
    expect(paidOrder.ok).toBe(true);
    if (!paidOrder.ok) return;
    await db.update(orders).set({ paymentProvider: "balance" }).where(eq(orders.id, String(paidOrder.order.id)));

    const paid = await handleInternalSettlement(db, String(paidOrder.order.id), "balance@example.com", 5000, {
      id: "balance-card",
      title: "Balance Card",
      fulfillmentMode: "card",
    });
    expect(paid.ok).toBe(true);

    const [balance] = await db.select().from(userBalances).where(eq(userBalances.email, "balance@example.com"));
    const [issuedCard] = await db.select().from(cards).where(eq(cards.id, "balance-card-1"));
    const txRows = await db.select().from(balanceTransactions);
    expect(balance.balanceCents).toBe(1000);
    expect(balance.totalSpentCents).toBe(5000);
    expect(issuedCard.status).toBe("issued");
    expect(txRows.some((row) => row.type === "voucher_redeem")).toBe(true);
    expect(txRows.some((row) => row.type === "order_spend")).toBe(true);
  });

  it("余额支付已发卡订单重试时不能二次扣款或释放已交付卡密", async () => {
    const { db } = await createScenarioDb();
    await seedProduct(db, {
      id: "balance-issued-guard",
      title: "Balance Issued Guard",
      priceCents: 1000,
      issueMode: "manual",
      fulfillmentMode: "card",
    });
    await seedCard(db, { id: "balance-issued-guard-1", productId: "balance-issued-guard", secret: "ISSUED-GUARD" });
    await db.insert(coupons).values({
      code: "BALANCE-ONCE",
      productId: "balance-issued-guard",
      discountType: "fixed",
      discountValue: 200,
      maxUses: 1,
      usedCount: 0,
      active: 1,
      createdAt: new Date().toISOString(),
    });
    await db.insert(userBalances).values({
      email: "balance-issued@example.com",
      balanceCents: 2000,
      totalDepositedCents: 2000,
      totalSpentCents: 0,
      updatedAt: new Date().toISOString(),
    });

    const orderResult = await createOrder(createContext(db), {
      productId: "balance-issued-guard",
      buyerEmail: "balance-issued@example.com",
      couponCode: "BALANCE-ONCE",
    }, "ip-hash");
    expect(orderResult.ok).toBe(true);
    if (!orderResult.ok) return;
    await db.update(orders).set({ paymentProvider: "balance" }).where(eq(orders.id, String(orderResult.order.id)));

    const paid = await handleInternalSettlement(db, String(orderResult.order.id), "balance-issued@example.com", 800, {
      id: "balance-issued-guard",
      title: "Balance Issued Guard",
      fulfillmentMode: "card",
    });
    expect(paid.ok).toBe(true);

    const secondPass = await handleInternalSettlement(db, String(orderResult.order.id), "balance-issued@example.com", 800, {
      id: "balance-issued-guard",
      title: "Balance Issued Guard",
      fulfillmentMode: "card",
    });
    const [card] = await db.select().from(cards).where(eq(cards.id, "balance-issued-guard-1"));
    const [order] = await db.select().from(orders).where(eq(orders.id, String(orderResult.order.id)));
    const [balance] = await db.select().from(userBalances).where(eq(userBalances.email, "balance-issued@example.com"));
    const [coupon] = await db.select().from(coupons).where(eq(coupons.code, "BALANCE-ONCE"));

    expect(secondPass.ok).toBe(true);
    expect(card.status).toBe("issued");
    expect(card.issuedOrderId).toBe(String(orderResult.order.id));
    expect(order.status).toBe("issued");
    expect(balance.balanceCents).toBe(1200);
    expect(balance.totalSpentCents).toBe(800);
    expect(coupon.usedCount).toBe(1);
  });

  it("数量购买闭环：一笔订单写入 order_items 并按数量发放多张卡密", async () => {
    const { db } = await createScenarioDb();
    await seedProduct(db, {
      id: "quantity-card",
      title: "Quantity Card",
      priceCents: 1200,
      issueMode: "manual",
      fulfillmentMode: "card",
    });
    await seedCard(db, { id: "quantity-card-1", productId: "quantity-card", accountLabel: "QTY-1", secret: "SEC-1" });
    await seedCard(db, { id: "quantity-card-2", productId: "quantity-card", accountLabel: "QTY-2", secret: "SEC-2" });

    const orderResult = await createOrder(createContext(db), {
      productId: "quantity-card",
      buyerEmail: "quantity@example.com",
      quantity: 2,
    }, "ip-hash");
    expect(orderResult.ok).toBe(true);
    if (!orderResult.ok) return;

    const orderId = String(orderResult.order.id);
    const [item] = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
    const [createdOrder] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(createdOrder.quantity).toBe(2);
    expect(createdOrder.amountCents).toBe(2400);
    expect(item).toMatchObject({
      orderId,
      productId: "quantity-card",
      quantity: 2,
      unitPriceCents: 1200,
      amountCents: 2400,
    });

    const issueResult = await markPaidAndIssue(db, orderId);
    expect(issueResult.ok).toBe(true);
    if (!issueResult.ok) return;
    expect(issueResult.cards).toHaveLength(2);

    const publicOrder = await getOrderByToken(db, String(orderResult.order.orderToken));
    expect(publicOrder?.quantity).toBe(2);
    expect(publicOrder?.cards).toHaveLength(2);
    expect(publicOrder?.cards?.map((card) => card.deliverySecret).sort()).toEqual(["SEC-1", "SEC-2"]);
  });

  it("虚拟资料付费订单：不占用 cards，确认付款后交付 delivery_json", async () => {
    const { db } = await createScenarioDb();
    await seedProduct(db, {
      id: "paid-link",
      title: "Paid Link",
      priceCents: 1900,
      issueMode: "manual",
      fulfillmentMode: "link",
      salesCopy: "https://example.test/private.pdf",
    });

    const orderResult = await createOrder(createContext(db), {
      productId: "paid-link",
      buyerEmail: "link@example.com",
    }, "ip-hash");
    expect(orderResult.ok).toBe(true);
    if (!orderResult.ok) return;

    const issueResult = await markPaidAndIssue(db, String(orderResult.order.id));
    expect(issueResult.ok).toBe(true);
    expect(issueResult).toMatchObject({
      delivery: {
        accountLabel: "Paid Link",
        deliverySecret: "https://example.test/private.pdf",
      },
    });

    const cardRows = await db.select().from(cards);
    const [issuedOrder] = await db.select().from(orders).where(eq(orders.id, String(orderResult.order.id)));
    expect(cardRows).toHaveLength(0);
    expect(issuedOrder.status).toBe("issued");
    expect(JSON.parse(issuedOrder.deliveryJson).deliverySecret).toBe("https://example.test/private.pdf");
  });

  it("活动免费兑换码：同一份卡密可无限次直接交付，每次领取都形成订单和查单闭环", async () => {
    const { db } = await createScenarioDb();
    await seedProduct(db, {
      id: "qq-free-code",
      title: "QQ 群活动兑换码",
      priceCents: 0,
      issueMode: "direct",
      fulfillmentMode: "code",
      salesCopy: "ACTIVITY-CODE-2026",
      purchaseLimit: null,
    });

    const first = await createOrder(createContext(db), {
      productId: "qq-free-code",
      buyerEmail: "first@qq.example",
      buyerContact: "QQ群公告用户A",
      campaignCode: "qq-group",
    }, "ip-hash-a");
    const second = await createOrder(createContext(db), {
      productId: "qq-free-code",
      buyerEmail: "second@qq.example",
      buyerContact: "QQ群公告用户B",
      campaignCode: "qq-group",
    }, "ip-hash-b");

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.order.delivery).toMatchObject({
      accountLabel: "QQ 群活动兑换码",
      deliverySecret: "ACTIVITY-CODE-2026",
      deliveryNote: "虚拟资料直接交付",
    });
    expect(second.order.delivery).toMatchObject({
      deliverySecret: "ACTIVITY-CODE-2026",
    });

    const orderRows = await db.select().from(orders).where(eq(orders.productId, "qq-free-code"));
    const itemRows = await db.select().from(orderItems);
    const cardRows = await db.select().from(cards);
    expect(orderRows).toHaveLength(2);
    expect(orderRows.every((order) => order.status === "issued")).toBe(true);
    expect(orderRows.every((order) => order.campaignCode === "qq-group")).toBe(true);
    expect(itemRows).toHaveLength(2);
    expect(itemRows.every((item) => JSON.parse(item.deliveryJson).deliverySecret === "ACTIVITY-CODE-2026")).toBe(true);
    expect(cardRows).toHaveLength(0);

    const firstLookup = await getOrderByToken(db, String(first.order.orderToken));
    const secondLookup = await getOrderByToken(db, String(second.order.orderToken));
    expect(firstLookup?.delivery).toMatchObject({ deliverySecret: "ACTIVITY-CODE-2026" });
    expect(secondLookup?.delivery).toMatchObject({ deliverySecret: "ACTIVITY-CODE-2026" });
  });

  it("支付入口线下虚拟资料订单：创建时写入 delivery_json，管理员确认收款后可交付", async () => {
    const { db } = await createScenarioDb();
    await seedProduct(db, {
      id: "offline-link",
      title: "Offline Link",
      priceCents: 2900,
      issueMode: "manual",
      fulfillmentMode: "link",
      salesCopy: "https://example.test/offline-private.pdf",
    });

    const offlineOrder = await createOfflineOrder(
      db,
      {
        id: "offline-link",
        title: "Offline Link",
        priceCents: 2900,
        currency: "CNY",
        fulfillmentMode: "link",
        salesCopy: "https://example.test/offline-private.pdf",
      },
      "offline-link@example.com",
      1,
      2900,
      0,
      "manual",
      undefined,
      undefined,
      "",
      "ip-hash",
      "business-scenario-test",
    );

    const [pendingOrder] = await db.select().from(orders).where(eq(orders.id, offlineOrder.orderId));
    expect(pendingOrder.status).toBe("pending");
    expect(JSON.parse(pendingOrder.deliveryJson)).toMatchObject({
      accountLabel: "Offline Link",
      deliverySecret: "https://example.test/offline-private.pdf",
      deliveryNote: "已交付",
    });

    const issueResult = await markPaidAndIssue(db, offlineOrder.orderId);
    expect(issueResult.ok).toBe(true);
    expect(issueResult).toMatchObject({
      delivery: {
        accountLabel: "Offline Link",
        deliverySecret: "https://example.test/offline-private.pdf",
      },
    });

    const [issuedOrder] = await db.select().from(orders).where(eq(orders.id, offlineOrder.orderId));
    const cardRows = await db.select().from(cards);
    expect(issuedOrder.status).toBe("issued");
    expect(cardRows).toHaveLength(0);
  });

  it("已交付订单过期检查不应回滚或释放已发卡密", async () => {
    const { db } = await createScenarioDb();
    await seedProduct(db, {
      id: "issued-expiry",
      title: "Issued Expiry",
      priceCents: 0,
      issueMode: "direct",
      fulfillmentMode: "card",
    });
    await seedCard(db, { id: "issued-expiry-card", productId: "issued-expiry", secret: "NO-RECYCLE" });

    const orderResult = await createOrder(createContext(db), {
      productId: "issued-expiry",
      buyerEmail: "issued@example.com",
    }, "ip-hash");
    expect(orderResult.ok).toBe(true);
    if (!orderResult.ok) return;

    const expired = await checkAndExpireOrder(
      db,
      String(orderResult.order.id),
      new Date(Date.now() - 60_000).toISOString(),
      "issued",
    );
    expect(expired).toEqual({ expired: false, releasedCards: 0 });

    const [order] = await db.select().from(orders).where(eq(orders.id, String(orderResult.order.id)));
    const [card] = await db.select().from(cards).where(eq(cards.id, "issued-expiry-card"));
    expect(order.status).toBe("issued");
    expect(card.status).toBe("issued");
    expect(card.issuedOrderId).toBe(String(orderResult.order.id));
  });
});
