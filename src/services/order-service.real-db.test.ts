import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { executeMigration, loadMigrations } from "../db/migrations";
import { hashOrderToken } from "../lib/token";
import { getOrderByToken, getOrderSummariesByEmail } from "./order-service";

describe("order-service - real libSQL email summaries", () => {
  it("uses the order-item title snapshot and never selects private delivery fields", async () => {
    const client = createClient({ url: "file::memory:" });
    const db = createDb(client);

    try {
      for (const migration of await loadMigrations()) {
        await executeMigration(db, migration);
      }

      await client.batch([
        {
          sql: "INSERT INTO products (id, slug, title) VALUES (?, ?, ?)",
          args: ["product-1", "product-1", "后台改名后的商品"],
        },
        {
          sql: `INSERT INTO orders
            (id, order_no, product_id, buyer_contact, buyer_email, quantity, amount_cents, discount_cents,
             status, order_token_hash, coupon_code, delivery_json, fulfillment_input_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            "order-old",
            "ORDER-OLD",
            "product-1",
            "private-contact",
            "Buyer@Example.com",
            1,
            100,
            0,
            "issued",
            await hashOrderToken("secure-order-token"),
            "PRIVATE-COUPON",
            "{\"deliverySecret\":\"private-secret\"}",
            "{\"type\":\"uid\",\"label\":\"用户 ID\",\"value\":\"user_123\"}",
            "2026-07-17T09:00:00.000Z",
          ],
        },
        {
          sql: `INSERT INTO orders
            (id, order_no, product_id, buyer_contact, buyer_email, quantity, amount_cents, discount_cents,
             status, order_token_hash, delivery_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            "order-new",
            "ORDER-NEW",
            "product-1",
            "another-private-contact",
            "buyer@example.com",
            2,
            180,
            20,
            "paid",
            "another-private-token-hash",
            "{\"deliverySecret\":\"another-private-secret\"}",
            "2026-07-17T10:00:00.000Z",
          ],
        },
        {
          sql: `INSERT INTO order_items
            (id, order_id, product_id, product_title, quantity, unit_price_cents, amount_cents, delivery_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          args: ["item-new", "order-new", "product-1", "下单时商品名称", 2, 100, 180, "{\"secret\":\"private\"}"],
        },
        {
          sql: `INSERT INTO orders
            (id, order_no, product_id, buyer_contact, buyer_email, quantity, amount_cents, discount_cents,
             status, order_token_hash, delivery_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            "order-orphan-product",
            "ORDER-ORPHAN",
            "deleted-product",
            "private-contact",
            "buyer@example.com",
            1,
            0,
            0,
            "issued",
            "private-orphan-token-hash",
            "{\"deliverySecret\":\"private-orphan-secret\"}",
            "2026-07-17T11:00:00.000Z",
          ],
        },
        {
          sql: `INSERT INTO order_items
            (id, order_id, product_id, product_title, quantity, unit_price_cents, amount_cents, delivery_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          args: ["item-orphan", "order-orphan-product", "deleted-product", "已删除商品的下单快照", 1, 0, 0, "{\"secret\":\"private\"}"],
        },
      ], "write");

      const summaries = await getOrderSummariesByEmail(db, " BUYER@example.com ", 20);

      expect(summaries.map((order) => order.orderNo)).toEqual(["ORDER-ORPHAN", "ORDER-NEW", "ORDER-OLD"]);
      expect(summaries[0]?.productTitle).toBe("已删除商品的下单快照");
      expect(summaries[1]?.productTitle).toBe("下单时商品名称");
      expect(summaries[2]?.productTitle).toBe("后台改名后的商品");
      expect(summaries[0]).not.toHaveProperty("buyerEmail");
      expect(summaries[0]).not.toHaveProperty("buyerContact");
      expect(summaries[0]).not.toHaveProperty("orderToken");
      expect(summaries[0]).not.toHaveProperty("delivery");
      expect(summaries[0]).not.toHaveProperty("cards");
      expect(summaries[0]).not.toHaveProperty("couponCode");
      expect(JSON.stringify(summaries)).not.toContain("fulfillmentInput");
      expect(JSON.stringify(summaries)).not.toContain("user_123");

      const tokenOrder = await getOrderByToken(db, "secure-order-token");
      expect(tokenOrder).not.toBeNull();
      expect(tokenOrder).not.toHaveProperty("fulfillmentInput");
      expect(JSON.stringify(tokenOrder)).not.toContain("fulfillmentInput");
      expect(JSON.stringify(tokenOrder)).not.toContain("user_123");

      const limited = await getOrderSummariesByEmail(db, "buyer@example.com", 1);
      expect(limited).toHaveLength(1);
      expect(limited[0]?.orderNo).toBe("ORDER-ORPHAN");
    } finally {
      client.close();
    }
  });
});
