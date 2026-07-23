import { createClient, type Client } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { MIGRATION_FILES } from "../db/migration-files";
import { cleanupExpiredOrders } from "./cleanup-service";

async function applyMigration(client: Client, version: string): Promise<void> {
  const content = MIGRATION_FILES[version];
  const up = content.match(/--\s*UP\s*\n([\s\S]*?)(?=--\s*DOWN|$)/)?.[1] || content;
  for (const raw of up.split(";")) {
    const lines = raw.trim().split("\n");
    while (lines[0]?.trim().startsWith("--")) lines.shift();
    const statement = lines.join("\n").trim();
    if (statement) await client.execute(statement);
  }
}

describe("cleanup-service - real libSQL retention", () => {
  it("applies configured cutoffs, preserves recent rows, and reports exact delete counts", async () => {
    const dbUrl = `file:/tmp/cf-shop-cleanup-${crypto.randomUUID()}.db`;
    const client = createClient({ url: dbUrl });
    try {
      await applyMigration(client, "0001");
      await applyMigration(client, "0009");
      const now = Date.now();
      const oldAt = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString();
      const recentAt = new Date(now - 24 * 60 * 60 * 1000).toISOString();
      const oldEpoch = Math.floor((now - 10 * 24 * 60 * 60 * 1000) / 1000);
      const recentEpoch = Math.floor((now - 24 * 60 * 60 * 1000) / 1000);

      for (const [key, value] of [
        ["rate_limit_retention_days", "5"],
        ["idempotency_retention_days", "5"],
        ["request_log_retention_days", "5"],
        ["email_log_retention_days", "5"],
        ["business_log_retention_days", "7"],
        ["admin_audit_retention_days", "7"],
      ]) {
        await client.execute({
          sql: "INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)",
          args: [key, value],
        });
      }

      for (const [suffix, createdAt, windowStart] of [["old", oldAt, oldEpoch], ["recent", recentAt, recentEpoch]] as const) {
        await client.execute({
          sql: "INSERT INTO rate_limit_windows (action, ip_hash, window_start, request_count) VALUES (?, ?, ?, ?)",
          args: [`action-${suffix}`, `ip-${suffix}`, windowStart, 1],
        });
        await client.execute({
          sql: "INSERT INTO idempotency_keys (key, action, resource_id, response_json, created_at) VALUES (?, ?, ?, ?, ?)",
          args: [`idem-${suffix}`, "pay", "", "", createdAt],
        });
        await client.execute({
          sql: "INSERT INTO request_logs (id, ip_hash, method, path, action, status_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          args: [`request-${suffix}`, "ip", "GET", "/test", "test", 200, createdAt],
        });
        await client.execute({
          sql: "INSERT INTO email_logs (id, to_email, template, status, created_at) VALUES (?, ?, ?, ?, ?)",
          args: [`email-${suffix}`, `${suffix}@example.com`, "test", "sent", createdAt],
        });
        await client.execute({
          sql: "INSERT INTO card_logs (id, card_id, action, created_at) VALUES (?, ?, ?, ?)",
          args: [`card-log-${suffix}`, `card-${suffix}`, "test", createdAt],
        });
        await client.execute({
          sql: "INSERT INTO order_events (id, order_id, type, created_at) VALUES (?, ?, ?, ?)",
          args: [`order-event-${suffix}`, `order-${suffix}`, "test", createdAt],
        });
        await client.execute({
          sql: "INSERT INTO admin_audit_logs (id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?)",
          args: [`audit-${suffix}`, "test", "system", suffix, createdAt],
        });
      }

      const result = await cleanupExpiredOrders(createDb(client));

      expect(result.operationalData.deleted).toEqual({
        rateLimitWindows: 1,
        idempotencyKeys: 1,
        requestLogs: 1,
        emailLogs: 1,
        cardLogs: 1,
        orderEvents: 1,
        adminAuditLogs: 1,
      });
      for (const table of [
        "rate_limit_windows",
        "idempotency_keys",
        "request_logs",
        "email_logs",
        "card_logs",
        "order_events",
        "admin_audit_logs",
      ]) {
        const remaining = await client.execute(`SELECT COUNT(*) AS count FROM ${table}`);
        expect(Number(remaining.rows[0]?.count)).toBe(1);
      }
    } finally {
      client.close();
    }
  });
});
