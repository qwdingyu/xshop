import { createClient } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DbType } from "../db/client";
import { executeMigration, loadMigrations } from "../db/migrations";
import {
  checkBalanceOrderRateLimit,
  checkFreeClaimOrderRateLimit,
  checkOrderRateLimit,
  checkProductPurchaseLimitForQuantity,
} from "./order-service";

const mockGetOrderRateLimitConfig = vi.fn();

vi.mock("../lib/system-config-registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/system-config-registry")>();
  return {
    ...actual,
    getOrderRateLimitConfig: (...args: unknown[]) => mockGetOrderRateLimitConfig(...args),
  };
});

async function createDbWithSchema(): Promise<{ client: ReturnType<typeof createClient>; db: DbType }> {
  const client = createClient({ url: "file::memory:" });
  const db = createDb(client);
  for (const migration of await loadMigrations()) {
    await executeMigration(db, migration);
  }
  return { client, db };
}

async function insertOrder(
  client: ReturnType<typeof createClient>,
  row: {
    id: string;
    productId: string;
    buyerEmail: string;
    status: string;
    quantity?: number;
    amountCents?: number;
    paymentProvider?: string;
    createdAt?: string;
  },
) {
  await client.execute({
    sql: `INSERT INTO orders (
      id, order_no, product_id, buyer_email, quantity, amount_cents, discount_cents,
      currency, status, payment_provider, payment_method, issue_mode, fulfillment_mode,
      order_token_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      row.id,
      `NO-${row.id}`,
      row.productId,
      row.buyerEmail,
      row.quantity ?? 1,
      row.amountCents ?? 0,
      0,
      "CNY",
      row.status,
      row.paymentProvider ?? "free",
      "online",
      "manual",
      "card",
      `token-${row.id}`,
      row.createdAt ?? new Date().toISOString(),
    ],
  });
}

describe("order rate/purchase limits with canonical email (real libSQL)", () => {
  beforeEach(() => {
    mockGetOrderRateLimitConfig.mockReset().mockResolvedValue({ windowSeconds: 300, maxOrders: 3 });
  });

  it("checkProductPurchaseLimitForQuantity treats Gmail +tag and dots as the same buyer", async () => {
    const { client, db } = await createDbWithSchema();
    try {
      await insertOrder(client, {
        id: "o1",
        productId: "prod-free",
        buyerEmail: "first.last@gmail.com",
        status: "issued",
        paymentProvider: "free",
        amountCents: 0,
      });

      const blocked = await checkProductPurchaseLimitForQuantity(
        db,
        "first.last+promo@gmail.com",
        "prod-free",
        1,
        1,
      );
      expect(blocked).toEqual({
        ok: false,
        status: 429,
        message: "该商品每人限购 1 件，您已达到上限",
      });

      const otherDomain = await checkProductPurchaseLimitForQuantity(
        db,
        "first.last@outlook.com",
        "prod-free",
        1,
        1,
      );
      expect(otherDomain).toEqual({ ok: true });
    } finally {
      client.close();
    }
  });

  it("does not count canceled orders toward purchase limit", async () => {
    const { client, db } = await createDbWithSchema();
    try {
      await insertOrder(client, {
        id: "o-cancel",
        productId: "prod-1",
        buyerEmail: "buyer@example.com",
        status: "canceled",
      });
      const ok = await checkProductPurchaseLimitForQuantity(db, "buyer@example.com", "prod-1", 1, 1);
      expect(ok).toEqual({ ok: true });
    } finally {
      client.close();
    }
  });

  it("checkOrderRateLimit ignores issued by default (paid path), includeIssued counts them", async () => {
    const { client, db } = await createDbWithSchema();
    try {
      mockGetOrderRateLimitConfig.mockResolvedValue({ windowSeconds: 300, maxOrders: 1 });
      await insertOrder(client, {
        id: "o-issued",
        productId: "prod-1",
        buyerEmail: "buyer@example.com",
        status: "issued",
        amountCents: 100,
        paymentProvider: "easypay",
      });

      const paidDefault = await checkOrderRateLimit(db, "buyer@example.com", "prod-1");
      expect(paidDefault).toEqual({ ok: true });

      const withIssued = await checkOrderRateLimit(db, "buyer@example.com", "prod-1", { includeIssued: true });
      expect(withIssued.ok).toBe(false);
      if (!withIssued.ok) {
        expect(withIssued.status).toBe(429);
        expect(withIssued.message).toContain("过于频繁");
      }
    } finally {
      client.close();
    }
  });

  it("checkFreeClaimOrderRateLimit counts issued free orders and uses stricter cap of 2", async () => {
    const { client, db } = await createDbWithSchema();
    try {
      // maxOrders=5 → free 上限 min(5,2)=2
      mockGetOrderRateLimitConfig.mockResolvedValue({ windowSeconds: 300, maxOrders: 5 });
      await insertOrder(client, {
        id: "f1",
        productId: "prod-free",
        buyerEmail: "a+1@gmail.com",
        status: "issued",
        paymentProvider: "free",
        amountCents: 0,
      });
      await insertOrder(client, {
        id: "f2",
        productId: "prod-free",
        buyerEmail: "a@gmail.com",
        status: "issued",
        paymentProvider: "free",
        amountCents: 0,
      });

      // a+1 与 a 同为 a@gmail；第三条 a+2 仍归同一人，count=2 >= freeMax=2 → 拒绝
      const blocked = await checkFreeClaimOrderRateLimit(db, "a+2@gmail.com", "prod-free");
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) {
        expect(blocked.status).toBe(429);
        expect(blocked.message).toContain("免费领取过于频繁");
      }

      // Gmail 点号变体是另一条 canonical（ab@gmail），不计入 a@gmail 的两条
      const dottedOther = await checkFreeClaimOrderRateLimit(db, "a.b@gmail.com", "prod-free");
      expect(dottedOther).toEqual({ ok: true });

      // 不同商品不共享计数
      const otherProduct = await checkFreeClaimOrderRateLimit(db, "a@gmail.com", "prod-other");
      expect(otherProduct).toEqual({ ok: true });
    } finally {
      client.close();
    }
  });

  it("checkFreeClaimOrderRateLimit does not count non-zero paid easypay orders", async () => {
    const { client, db } = await createDbWithSchema();
    try {
      mockGetOrderRateLimitConfig.mockResolvedValue({ windowSeconds: 300, maxOrders: 1 });
      await insertOrder(client, {
        id: "paid-1",
        productId: "prod-free",
        buyerEmail: "buyer@example.com",
        status: "issued",
        paymentProvider: "easypay",
        amountCents: 1200,
      });
      const ok = await checkFreeClaimOrderRateLimit(db, "buyer@example.com", "prod-free");
      expect(ok).toEqual({ ok: true });
    } finally {
      client.close();
    }
  });

  it("checkBalanceOrderRateLimit only counts balance pending/paid for canonical email", async () => {
    const { client, db } = await createDbWithSchema();
    try {
      mockGetOrderRateLimitConfig.mockResolvedValue({ windowSeconds: 300, maxOrders: 1 });
      await insertOrder(client, {
        id: "bal-1",
        productId: "prod-1",
        buyerEmail: "User+tag@Example.com",
        status: "pending",
        paymentProvider: "balance",
        amountCents: 100,
      });
      await insertOrder(client, {
        id: "free-1",
        productId: "prod-1",
        buyerEmail: "user@example.com",
        status: "pending",
        paymentProvider: "free",
        amountCents: 0,
      });

      const blocked = await checkBalanceOrderRateLimit(db, "user@example.com");
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) expect(blocked.status).toBe(429);
    } finally {
      client.close();
    }
  });

  it("purchase limit sums quantity and rejects when next quantity would exceed", async () => {
    const { client, db } = await createDbWithSchema();
    try {
      await insertOrder(client, {
        id: "q1",
        productId: "prod-1",
        buyerEmail: "buyer@example.com",
        status: "paid",
        quantity: 2,
        amountCents: 200,
        paymentProvider: "easypay",
      });
      const blocked = await checkProductPurchaseLimitForQuantity(db, "buyer@example.com", "prod-1", 3, 2);
      expect(blocked).toEqual({
        ok: false,
        status: 429,
        message: "该商品每人限购 3 件，您已达到上限",
      });
      const allowed = await checkProductPurchaseLimitForQuantity(db, "buyer@example.com", "prod-1", 3, 1);
      expect(allowed).toEqual({ ok: true });
    } finally {
      client.close();
    }
  });

  it("skips purchase limit when limit is null or non-positive", async () => {
    const { client, db } = await createDbWithSchema();
    try {
      await insertOrder(client, {
        id: "q-many",
        productId: "prod-1",
        buyerEmail: "buyer@example.com",
        status: "issued",
        quantity: 99,
      });
      await expect(checkProductPurchaseLimitForQuantity(db, "buyer@example.com", "prod-1", null, 1))
        .resolves.toEqual({ ok: true });
      await expect(checkProductPurchaseLimitForQuantity(db, "buyer@example.com", "prod-1", 0, 1))
        .resolves.toEqual({ ok: true });
    } finally {
      client.close();
    }
  });
});
