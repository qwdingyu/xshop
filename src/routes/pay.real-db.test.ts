import { createClient, type Client } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { MIGRATION_FILES } from "../db/migration-files";
import { saveIdempotentResponse } from "../lib/idempotency";
import {
  buildPaymentCreationRecoveryResponse,
  createOfflineOrder,
  handleInternalSettlement,
  normalizePaymentRedirectUrl,
  parseCachedIdempotentSuccessResponse,
} from "./pay";

async function applyMigration(client: Client, version: string): Promise<void> {
  const content = MIGRATION_FILES[version];
  const up = content.match(/--\s*UP\s*\n([\s\S]*?)(?=--\s*DOWN|$)/)?.[1] || content;
  for (const raw of up.split(";")) {
    const lines = raw.trim().split("\n");
    while (lines[0]?.trim().startsWith("--")) lines.shift();
    const statement = lines.join("\n").trim();
    if (!statement) continue;
    try {
      await client.execute(statement);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("duplicate column") && !message.includes("already exists")) throw error;
    }
  }
}

async function applyIdempotencyBindingMigration(client: Client): Promise<void> {
  const columns = await client.execute("PRAGMA table_info(idempotency_keys)");
  if (!columns.rows.some((row) => row.name === "request_hash")) {
    await applyMigration(client, "0006");
  }
}

describe("balance payment - real libSQL compensation", () => {
  it("refunds a failed fulfillment exactly once across retries", async () => {
    const client = createClient({ url: "file::memory:?cache=shared" });
    try {
      await applyMigration(client, "0001");
      await client.execute({
        sql: `INSERT INTO products
          (id, slug, title, price_cents, fulfillment_mode, issue_mode)
          VALUES (?, ?, ?, ?, ?, ?)`,
        args: ["balance-real-product", "balance-real-product", "Balance Real Product", 1200, "card", "manual"],
      });
      await client.execute({
        sql: `INSERT INTO orders
          (id, order_no, product_id, buyer_email, amount_cents, status, fulfillment_mode, issue_mode, payment_method, payment_provider, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          "balance-real-order",
          "BALANCE-REAL-ORDER",
          "balance-real-product",
          "buyer@example.com",
          1200,
          "pending",
          "card",
          "manual",
          "online",
          "balance",
          new Date(Date.now() + 30 * 60_000).toISOString(),
        ],
      });
      await client.execute({
        sql: `INSERT INTO order_items
          (id, order_id, product_id, product_title, fulfillment_mode, quantity, unit_price_cents, amount_cents)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: ["balance-real-item", "balance-real-order", "balance-real-product", "Balance Real Product", "card", 1, 1200, 1200],
      });
      await client.execute({
        sql: `INSERT INTO user_balances
          (email, balance_cents, total_deposited_cents, total_spent_cents)
          VALUES (?, ?, ?, ?)`,
        args: ["buyer@example.com", 2000, 2000, 0],
      });

      const db = createDb(client);
      const product = { id: "balance-real-product", title: "Balance Real Product", fulfillmentMode: "card" as const };
      const first = await handleInternalSettlement(db, "balance-real-order", "buyer@example.com", 1200, product);
      const retry = await handleInternalSettlement(db, "balance-real-order", "buyer@example.com", 1200, product);

      expect(first.ok).toBe(false);
      expect(retry.ok).toBe(false);

      const order = await client.execute("SELECT status FROM orders WHERE id = 'balance-real-order'");
      const balance = await client.execute("SELECT balance_cents, total_spent_cents FROM user_balances WHERE email = 'buyer@example.com'");
      const ledger = await client.execute(`
        SELECT type, amount_cents
        FROM balance_transactions
        WHERE reference_type = 'order' AND reference_id = 'balance-real-order'
        ORDER BY created_at, type
      `);

      expect(order.rows[0]?.status).toBe("failed");
      expect(balance.rows[0]?.balance_cents).toBe(2000);
      expect(balance.rows[0]?.total_spent_cents).toBe(0);
      expect(ledger.rows).toEqual([
        expect.objectContaining({ type: "order_spend", amount_cents: -1200 }),
        expect.objectContaining({ type: "refund", amount_cents: 1200 }),
      ]);
    } finally {
      client.close();
    }
  });
});

describe("payment idempotency - real libSQL transaction", () => {
  it("rejects a stale lease owner after the pending reservation is reclaimed", async () => {
    const client = createClient({ url: "file::memory:?cache=shared" });
    try {
      await applyMigration(client, "0001");
      await applyMigration(client, "0013");
      await applyIdempotencyBindingMigration(client);
      const activeLease = "2026-07-16T00:02:01.000Z";
      await client.execute({
        sql: `INSERT INTO idempotency_keys
          (key, action, resource_id, request_hash, response_json, created_at)
          VALUES (?, ?, '', ?, '__pending__', ?)`,
        args: ["fenced-key", "pay_unified", "c".repeat(64), activeLease],
      });

      const db = createDb(client);
      await expect(saveIdempotentResponse(
        db,
        "fenced-key",
        "pay_unified",
        "c".repeat(64),
        "2026-07-16T00:00:00.000Z",
        "stale-order",
        { orderId: "stale-order" },
      )).rejects.toThrow("租约已失效");

      await saveIdempotentResponse(
        db,
        "fenced-key",
        "pay_unified",
        "c".repeat(64),
        activeLease,
        "active-order",
        { orderId: "active-order" },
      );
      const row = await client.execute(
        "SELECT resource_id, response_json FROM idempotency_keys WHERE key = 'fenced-key'",
      );
      expect(row.rows[0]).toMatchObject({
        resource_id: "active-order",
        response_json: JSON.stringify({ orderId: "active-order" }),
      });
    } finally {
      client.close();
    }
  });

  it("rolls back order creation when its idempotency lease is stale", async () => {
    const client = createClient({ url: "file::memory:?cache=shared" });
    try {
      await applyMigration(client, "0001");
      await applyMigration(client, "0013");
      await applyIdempotencyBindingMigration(client);
      await client.execute({
        sql: `INSERT INTO idempotency_keys
          (key, action, resource_id, request_hash, response_json, created_at)
          VALUES (?, ?, '', ?, '__pending__', ?)`,
        args: ["offline-key", "pay_unified", "a".repeat(64), new Date().toISOString()],
      });

      const db = createDb(client);
      await expect(createOfflineOrder(
        db,
        {
          id: "virtual-product",
          title: "Virtual Product",
          priceCents: 1200,
          currency: "CNY",
          fulfillmentMode: "virtual",
          salesCopy: "private-content",
        },
        "buyer@example.com",
        1,
        1200,
        0,
        "manual",
        undefined,
        undefined,
        "",
        "ip-hash",
        "test-agent",
        undefined,
        undefined,
        (tx, result) => saveIdempotentResponse(
          tx,
          "offline-key",
          "pay_unified",
          "a".repeat(64),
          "stale-lease",
          result.orderId,
          { mode: "offline", orderId: result.orderId, orderToken: result.orderToken },
        ),
      )).rejects.toThrow("订单创建失败");

      const orders = await client.execute("SELECT id FROM orders WHERE product_id = 'virtual-product'");
      const items = await client.execute("SELECT id FROM order_items WHERE product_id = 'virtual-product'");
      const idempotency = await client.execute(
        "SELECT resource_id, response_json FROM idempotency_keys WHERE key = 'offline-key'",
      );

      expect(orders.rows).toHaveLength(0);
      expect(items.rows).toHaveLength(0);
      expect(idempotency.rows[0]).toMatchObject({ resource_id: "", response_json: "__pending__" });
    } finally {
      client.close();
    }
  });
});

describe("payment creation recovery contracts", () => {
  it("requires HTTPS for non-local payment redirects", () => {
    expect(normalizePaymentRedirectUrl("https://pay.example.com/checkout")).toBe("https://pay.example.com/checkout");
    expect(normalizePaymentRedirectUrl("http://localhost:8787/checkout")).toBe("http://localhost:8787/checkout");
    expect(normalizePaymentRedirectUrl("http://pay.example.com/checkout")).toBe("");
  });

  it("keeps enough order credentials to resume status polling", () => {
    const response = buildPaymentCreationRecoveryResponse({
      provider: "easypay",
      orderId: "order-recovery",
      orderNo: "PAY-RECOVERY",
      orderToken: "secret-order-token",
      amountCents: 1200,
      productId: "product-recovery",
      productTitle: "Recovery Product",
      quantity: 1,
      currency: "CNY",
      fulfillmentMode: "card",
      expiresAt: "2026-07-15T12:30:00.000Z",
      expireMinutes: 30,
      status: "pending",
    });

    expect(response).toEqual(expect.objectContaining({
      mode: "online",
      provider: "easypay",
      orderId: "order-recovery",
      orderNo: "PAY-RECOVERY",
      orderToken: "secret-order-token",
      status: "pending",
      qrcode: "",
      redirectUrl: "",
      message: expect.stringContaining("正在确认"),
    }));
  });

  it("restores the successful response envelope on idempotent replay", () => {
    expect(parseCachedIdempotentSuccessResponse(JSON.stringify({
      mode: "online",
      orderId: "order-recovery",
    }))).toEqual({
      ok: true,
      mode: "online",
      orderId: "order-recovery",
    });
  });

  it("does not let a legacy cached ok=false override a successful replay envelope", () => {
    expect(parseCachedIdempotentSuccessResponse(JSON.stringify({
      ok: false,
      mode: "online",
      orderId: "order-recovery",
    }))).toMatchObject({
      ok: true,
      mode: "online",
      orderId: "order-recovery",
    });
  });
});
