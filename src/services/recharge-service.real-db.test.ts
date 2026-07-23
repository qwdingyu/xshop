import { createClient, type Client } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { MIGRATION_FILES } from "../db/migration-files";
import { createRechargeOrder, expirePendingRechargeOrders, settleRechargeOrder } from "./recharge-service";

async function applyMigration(client: Client, version: string): Promise<void> {
  const content = MIGRATION_FILES[version];
  const up = content.split("-- DOWN")[0].replace("-- UP", "");
  const statements = up.split(";").map((statement) => statement.trim()).filter(Boolean);
  for (const statement of statements) await client.execute(statement);
}

describe("recharge-service - real libSQL", () => {
  it("expires only abandoned pending recharge orders", async () => {
    const client = createClient({ url: "file::memory:?cache=shared" });
    try {
      await applyMigration(client, "0001");
      await applyMigration(client, "0009");
      const db = createDb(client);
      for (const [id, status, expiresAt] of [
        ["expired-pending", "pending", "2026-07-19T00:00:00.000Z"],
        ["future-pending", "pending", "2026-07-19T02:00:00.000Z"],
        ["already-paid", "paid", "2026-07-19T00:00:00.000Z"],
      ] as const) {
        await createRechargeOrder(db, {
          id,
          orderNo: `R-${id}`,
          buyerEmail: `${id}@example.com`,
          amountCents: 100,
          paymentProvider: "easypay",
          orderTokenHash: `hash-${id}`,
          createdAt: "2026-07-18T23:00:00.000Z",
          expiresAt,
        });
        if (status === "paid") {
          await settleRechargeOrder(db, {
            id,
            paymentProvider: "easypay",
            paymentRef: "TRADE-PAID",
            paidAt: "2026-07-18T23:30:00.000Z",
          });
        }
      }

      await expect(expirePendingRechargeOrders(db, "2026-07-19T01:00:00.000Z")).resolves.toBe(1);
      const rows = await client.execute("SELECT id, status FROM balance_recharge_orders ORDER BY id");
      expect(rows.rows).toEqual([
        { id: "already-paid", status: "paid" },
        { id: "expired-pending", status: "expired" },
        { id: "future-pending", status: "pending" },
      ]);
    } finally {
      client.close();
    }
  });

  it("credits a recharge exactly once across duplicate callbacks", async () => {
    const client = createClient({ url: "file::memory:?cache=shared" });
    try {
      await applyMigration(client, "0001");
      await applyMigration(client, "0009");
      const db = createDb(client);
      await createRechargeOrder(db, {
        id: "recharge-1",
        orderNo: "RTEST0001",
        buyerEmail: "Buyer@Example.com",
        amountCents: 2500,
        paymentProvider: "easypay",
        orderTokenHash: "hash",
        createdAt: "2026-07-19T00:00:00.000Z",
        expiresAt: "2026-07-19T00:30:00.000Z",
      });

      const first = await settleRechargeOrder(db, {
        id: "recharge-1",
        paymentProvider: "easypay",
        paymentRef: "TRADE-1",
        paidAt: "2026-07-19T00:01:00.000Z",
      });
      const duplicate = await settleRechargeOrder(db, {
        id: "recharge-1",
        paymentProvider: "easypay",
        paymentRef: "TRADE-1",
        paidAt: "2026-07-19T00:01:00.000Z",
      });

      expect(first).toMatchObject({ ok: true, alreadyPaid: false, balanceCents: 2500 });
      expect(duplicate).toMatchObject({ ok: true, alreadyPaid: true, balanceCents: 2500 });
      const balance = await client.execute("SELECT balance_cents FROM user_balances WHERE email = 'buyer@example.com'");
      const ledger = await client.execute("SELECT COUNT(*) AS count FROM balance_transactions WHERE reference_id = 'recharge-1'");
      expect(Number(balance.rows[0].balance_cents)).toBe(2500);
      expect(Number(ledger.rows[0].count)).toBe(1);
    } finally {
      client.close();
    }
  });
});
