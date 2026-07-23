import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { MIGRATION_FILES } from "../db/migration-files";
import { batchDeleteOrders, cancelOrder, clearAllMergedLogs, clearBusinessDataPreservingConfig, countProviderOrdersRequiringCredentials, exportOrders, getAdminSummary, getDailyIncomeTrend, getEmailLogList, getMergedLogs, getOrderDetail, getOrderList, recordPaidOrderFulfillmentProgress } from "./admin-service";

const openClearClients: Client[] = [];

afterEach(() => {
  while (openClearClients.length > 0) {
    openClearClients.pop()?.close();
  }
});

/** 独立文件库，避免 file::memory 在事务连接上丢表，也不引入 node:fs（Workers tsconfig 无 Node types）。 */
function createIsolatedClient(): Client {
  const client = createClient({ url: `file:/tmp/cf-shop-admin-clear-${crypto.randomUUID()}.db` });
  openClearClients.push(client);
  return client;
}

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

describe("admin-service - real libSQL order snapshots", () => {
  it("atomically records fulfillment progress only while the order is paid", async () => {
    const client = createClient({ url: "file::memory:?cache=shared" });
    try {
      await applyMigration(client, "0001");
      await client.batch([
        {
          sql: "INSERT INTO orders (id, order_no, product_id, buyer_email, status) VALUES (?, ?, ?, ?, ?)",
          args: ["progress-paid", "PROGRESS-PAID", "product", "buyer@example.com", "paid"],
        },
        {
          sql: "INSERT INTO orders (id, order_no, product_id, buyer_email, status) VALUES (?, ?, ?, ?, ?)",
          args: ["progress-issued", "PROGRESS-ISSUED", "product", "buyer@example.com", "issued"],
        },
      ]);

      const db = createDb(client);
      await expect(recordPaidOrderFulfillmentProgress(
        db,
        "progress-paid",
        "供应商处理中：备注：已提交",
        { stage: "supplier_processing", supplierOrderRef: "SUP-20260721-1" },
      )).resolves.toBe("recorded");
      await expect(recordPaidOrderFulfillmentProgress(
        db,
        "progress-issued",
        "供应商处理中：备注：迟到请求",
        { stage: "supplier_processing", supplierOrderRef: "" },
      )).resolves.toBe("status_conflict");
      await expect(recordPaidOrderFulfillmentProgress(
        db,
        "progress-missing",
        "人工复核：备注：不存在",
        { stage: "manual_review", supplierOrderRef: "" },
      )).resolves.toBe("not_found");

      const events = await client.execute("SELECT order_id, type, message, metadata_json FROM order_events WHERE order_id LIKE 'progress-%'");
      expect(events.rows).toEqual([
        expect.objectContaining({
          order_id: "progress-paid",
          type: "fulfillment_supplier_processing",
          message: "供应商处理中：备注：已提交",
          metadata_json: JSON.stringify({ stage: "supplier_processing", supplierOrderRef: "SUP-20260721-1" }),
        }),
      ]);
    } finally {
      await client.execute("DELETE FROM order_events WHERE order_id LIKE 'progress-%'").catch(() => undefined);
      await client.execute("DELETE FROM orders WHERE id LIKE 'progress-%'").catch(() => undefined);
      client.close();
    }
  });

  it("counts active and recently expired orders that still require provider credentials", async () => {
    const client = createClient({ url: "file::memory:?cache=shared" });
    try {
      await applyMigration(client, "0001");
      await applyMigration(client, "0009");
      const recent = new Date().toISOString();
      const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      for (const [id, provider, status, createdAt] of [
        ["pending", "easypay", "pending", old],
        ["paid", "easypay", "paid", old],
        ["recent-expired", "easypay", "expired", recent],
        ["old-expired", "easypay", "expired", old],
        ["issued", "easypay", "issued", recent],
        ["other-provider", "other", "pending", recent],
      ]) {
        await client.execute({
          sql: `INSERT INTO orders
            (id, order_no, product_id, buyer_contact, buyer_email, status, payment_provider, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [id, `NO-${id}`, "product", "buyer", "buyer@example.com", status, provider, createdAt],
        });
      }

      for (const [id, status, createdAt] of [
        ["recharge-pending", "pending", recent],
        ["recharge-recent-expired", "expired", recent],
        ["recharge-old-expired", "expired", old],
        ["recharge-paid", "paid", recent],
      ]) {
        await client.execute({
          sql: `INSERT INTO balance_recharge_orders
            (id, order_no, buyer_email, amount_cents, status, payment_provider, order_token_hash, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [id, `RNO-${id}`, "buyer@example.com", 100, status, "easypay", `hash-${id}`, createdAt, recent],
        });
      }

      await expect(countProviderOrdersRequiringCredentials(createDb(client), "easypay")).resolves.toBe(5);
    } finally {
      await client.execute("DELETE FROM balance_recharge_orders").catch(() => undefined);
      await client.execute("DELETE FROM orders").catch(() => undefined);
      client.close();
    }
  });

  it("clears request and admin logs atomically while retaining one purge audit", async () => {
    // libSQL 事务会占用独立连接；shared cache 保证事务与断言读取同一内存库。
    const client = createClient({ url: "file::memory:?cache=shared" });
    try {
      await applyMigration(client, "0001");
      await client.batch([
        {
          sql: "INSERT INTO request_logs (id, ip_hash, method, path, action, status_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          args: ["request-1", "ip", "GET", "/one", "one", 200, "2026-07-17T00:00:00.000Z"],
        },
        {
          sql: "INSERT INTO request_logs (id, ip_hash, method, path, action, status_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          args: ["request-2", "ip", "GET", "/two", "two", 200, "2026-07-17T00:00:01.000Z"],
        },
        {
          sql: "INSERT INTO admin_audit_logs (id, action, target_type, target_id, metadata_json, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          args: ["admin-1", "old_action", "system", "old", "{}", "ip", "2026-07-17T00:00:02.000Z"],
        },
      ]);

      const result = await clearAllMergedLogs(createDb(client), "admin-ip");
      const requestCount = await client.execute("SELECT COUNT(*) AS count FROM request_logs");
      const auditRows = await client.execute("SELECT id, action, target_type, metadata_json, ip_hash FROM admin_audit_logs");

      expect(result).toMatchObject({ deleted: 3, request: 2, admin: 1 });
      expect(Number(requestCount.rows[0]?.count || 0)).toBe(0);
      expect(auditRows.rows).toHaveLength(1);
      expect(auditRows.rows[0]).toMatchObject({
        id: result.retainedAuditId,
        action: "clear_all_logs",
        target_type: "log",
        ip_hash: "admin-ip",
      });
      expect(JSON.parse(String(auditRows.rows[0]?.metadata_json))).toMatchObject({
        deleted: 3,
        request: 2,
        admin: 1,
      });
    } finally {
      // 事务连接可能被客户端短暂复用，主动清理保留凭证，避免污染同文件中的后续用例。
      await client.execute("DELETE FROM request_logs").catch(() => undefined);
      await client.execute("DELETE FROM admin_audit_logs").catch(() => undefined);
      client.close();
    }
  });

  it("clears business and transient tables while preserving configuration tables", async () => {
    const client = createIsolatedClient();
    try {
      await applyMigration(client, "0001");
      await applyMigration(client, "0002");
      await applyMigration(client, "0006");
      await applyMigration(client, "0009");
      await applyMigration(client, "0011");
      await client.execute(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          executed_at TEXT NOT NULL
        )
      `);

      const now = "2026-07-18T00:00:00.000Z";
      // 0011 会预置默认渠道；system_config 也可能已有 key，使用 upsert / 非默认渠道避免冲突。
      await client.batch([
        {
          sql: "INSERT INTO system_config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
          args: ["shop_name", "保留店铺", now],
        },
        {
          sql: "INSERT INTO system_config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
          args: ["payment_provider:easypay", "enc:payment-config", now],
        },
        { sql: "INSERT INTO product_categories (id, name, sort_order, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", args: ["cat-full", "保留分类", 1, 1, now, now] },
        { sql: "INSERT INTO admin_audit_logs (id, action, target_type, target_id, metadata_json, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", args: ["audit-full-old", "old_action", "system", "old", "{}", "ip", now] },
        { sql: "INSERT INTO api_keys (id, name, key_hash, user_id, tier, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", args: ["api-full", "保留 API Key", "hash-full", "", "free", 1, now, now] },
        { sql: "INSERT INTO schema_migrations (version, name, executed_at) VALUES (?, ?, ?)", args: ["0001", "init", now] },
        { sql: "INSERT INTO products (id, slug, title, fulfillment_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", args: ["prod-full", "prod-full", "商品", "card", now, now] },
        { sql: "INSERT INTO storefronts (id, slug, name, active, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", args: ["sf-full", "sf-full", "副店", 1, 0, now, now] },
        { sql: "INSERT INTO storefront_products (storefront_id, product_id, visible, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", args: ["sf-full", "prod-full", 1, 1, now, now] },
        { sql: "INSERT INTO card_batches (id, product_id, name, total_count, created_at) VALUES (?, ?, ?, ?, ?)", args: ["batch-full", "prod-full", "批次", 1, now] },
        { sql: "INSERT INTO cards (id, product_id, batch_id, account_label, delivery_secret, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", args: ["card-full", "prod-full", "batch-full", "账号", "secret-full", "available", now] },
        { sql: "INSERT INTO orders (id, order_no, product_id, buyer_contact, buyer_email, amount_cents, status, fulfillment_mode, payment_provider, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", args: ["order-full", "NO-FULL", "prod-full", "buyer@example.com", "buyer@example.com", 100, "pending", "card", "easypay", now] },
        { sql: "INSERT INTO order_items (id, order_id, product_id, product_title, created_at) VALUES (?, ?, ?, ?, ?)", args: ["item-full", "order-full", "prod-full", "商品", now] },
        { sql: "INSERT INTO order_events (id, order_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)", args: ["event-full", "order-full", "created", "created", now] },
        { sql: "INSERT INTO campaigns (code, name, active, created_at) VALUES (?, ?, ?, ?)", args: ["camp-full", "活动", 1, now] },
        { sql: "INSERT INTO referral_codes (code, owner_contact, active, created_at) VALUES (?, ?, ?, ?)", args: ["ref-full", "owner", 1, now] },
        { sql: "INSERT INTO referral_events (id, referral_code, order_id, buyer_contact, status, created_at) VALUES (?, ?, ?, ?, ?, ?)", args: ["ref-event-full", "ref-full", "order-full", "buyer", "created", now] },
        { sql: "INSERT INTO coupons (code, product_id, discount_type, discount_value, active, created_at) VALUES (?, ?, ?, ?, ?, ?)", args: ["coupon-full", "prod-full", "fixed", 10, 1, now] },
        { sql: "INSERT INTO card_logs (id, card_id, order_id, action, operator, created_at) VALUES (?, ?, ?, ?, ?, ?)", args: ["card-log-full", "card-full", "order-full", "import", "admin", now] },
        { sql: "INSERT INTO request_logs (id, ip_hash, method, path, action, status_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", args: ["request-full", "ip", "GET", "/api/products", "products", 200, now] },
        { sql: "INSERT INTO email_logs (id, order_id, to_email, template, status, created_at) VALUES (?, ?, ?, ?, ?, ?)", args: ["email-full", "order-full", "buyer@example.com", "order_pending", "sent", now] },
        { sql: "INSERT INTO voucher_codes (code, amount_cents, status, batch_id, created_at) VALUES (?, ?, ?, ?, ?)", args: ["VCH-FULL0001", 100, "active", "vbatch-full", now] },
        { sql: "INSERT INTO user_balances (email, balance_cents, total_deposited_cents, total_spent_cents, updated_at) VALUES (?, ?, ?, ?, ?)", args: ["full@example.com", 100, 100, 0, now] },
        { sql: "INSERT INTO balance_transactions (id, email, type, amount_cents, balance_after_cents, reference_type, reference_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", args: ["balance-tx-full", "full@example.com", "voucher_redeem", 100, 100, "voucher", "VCH-FULL0001", now] },
        { sql: "INSERT INTO balance_recharge_orders (id, order_no, buyer_email, amount_cents, status, payment_provider, order_token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", args: ["recharge-full", "RNO-FULL", "full@example.com", 100, "pending", "easypay", "token-hash", now, now] },
        { sql: "INSERT INTO rate_limit_windows (action, ip_hash, window_start, request_count) VALUES (?, ?, ?, ?)", args: ["admin:test-full", "ip", 1, 1] },
        { sql: "INSERT INTO idempotency_keys (key, action, resource_id, response_json, created_at, request_hash) VALUES (?, ?, ?, ?, ?, ?)", args: ["idem-full", "pay", "order-full", "{}", now, "hash"] },
      ]);

      const result = await clearBusinessDataPreservingConfig(createDb(client), "admin-ip", { profile: "full" });

      const clearedTables = [
        "order_items",
        "order_events",
        "referral_events",
        "balance_transactions",
        "balance_recharge_orders",
        "card_logs",
        "orders",
        "cards",
        "user_balances",
        "voucher_codes",
        "campaigns",
        "referral_codes",
        "coupons",
        "card_batches",
        "storefront_products",
        "products",
        "request_logs",
        "email_logs",
        "rate_limit_windows",
        "idempotency_keys",
      ];
      for (const table of clearedTables) {
        const count = await client.execute(`SELECT COUNT(*) AS count FROM ${table}`);
        expect(Number(count.rows[0]?.count || 0), table).toBe(0);
      }

      const systemConfigRows = await client.execute("SELECT key, value FROM system_config ORDER BY key");
      const categoryCount = await client.execute("SELECT COUNT(*) AS count FROM product_categories");
      const apiKeyCount = await client.execute("SELECT COUNT(*) AS count FROM api_keys");
      const migrationCount = await client.execute("SELECT COUNT(*) AS count FROM schema_migrations");
      const storefrontCount = await client.execute("SELECT COUNT(*) AS count FROM storefronts");
      const auditRows = await client.execute("SELECT action, target_type, target_id, metadata_json, ip_hash FROM admin_audit_logs ORDER BY created_at, id");

      expect(result.profile).toBe("full");
      expect(result.cardStrategy).toBe("clear_all");
      expect(result.tables.orders).toBe(1);
      expect(result.tables.storefront_products).toBeGreaterThanOrEqual(1);
      expect(result.tables.admin_audit_logs).toBe(1);
      expect(result.reservedTables).toEqual(["system_config", "product_categories", "api_keys", "schema_migrations", "storefronts"]);
      expect(systemConfigRows.rows).toEqual(expect.arrayContaining([
        { key: "payment_provider:easypay", value: "enc:payment-config" },
        { key: "shop_name", value: "保留店铺" },
      ]));
      expect(Number(categoryCount.rows[0]?.count || 0)).toBe(1);
      expect(Number(apiKeyCount.rows[0]?.count || 0)).toBe(1);
      expect(Number(migrationCount.rows[0]?.count || 0)).toBe(1);
      // full 清商品与映射，但渠道定义本身保留（含 0011 默认渠道 + 测试副店）
      expect(Number(storefrontCount.rows[0]?.count || 0)).toBeGreaterThanOrEqual(2);
      expect(auditRows.rows).toHaveLength(1);
      expect(auditRows.rows[0]).toMatchObject({
        action: "clear_business_data",
        target_type: "database",
        target_id: "full",
        ip_hash: "admin-ip",
      });
      expect(JSON.parse(String(auditRows.rows[0]?.metadata_json))).toMatchObject({
        profile: "full",
        cardStrategy: "clear_all",
        reservedTables: ["system_config", "product_categories", "api_keys", "schema_migrations", "storefronts"],
      });
    } finally {
      await client.execute("DELETE FROM admin_audit_logs").catch(() => undefined);
      await client.execute("DELETE FROM request_logs").catch(() => undefined);
      client.close();
    }
  });

  it("full profile remains compatible when storefront tables are absent (pre-0011)", async () => {
    const client = createIsolatedClient();
    try {
      await applyMigration(client, "0001");
      await applyMigration(client, "0006");
      await applyMigration(client, "0009");

      const now = "2026-07-18T00:00:00.000Z";
      await client.batch([
        { sql: "INSERT INTO products (id, slug, title, fulfillment_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", args: ["prod-pre", "prod-pre", "商品", "card", now, now] },
        { sql: "INSERT INTO orders (id, order_no, product_id, buyer_contact, buyer_email, amount_cents, status, fulfillment_mode, payment_provider, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", args: ["order-pre", "NO-PRE", "prod-pre", "buyer@example.com", "buyer@example.com", 100, "pending", "card", "easypay", now] },
        { sql: "INSERT INTO request_logs (id, ip_hash, method, path, action, status_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", args: ["request-pre", "ip", "GET", "/api/products", "products", 200, now] },
      ]);

      const result = await clearBusinessDataPreservingConfig(createDb(client), "admin-ip", { profile: "full" });

      expect(result.profile).toBe("full");
      expect(result.tables.storefront_products).toBeUndefined();
      expect(Number((await client.execute("SELECT COUNT(*) AS c FROM products")).rows[0]?.c || 0)).toBe(0);
      expect(Number((await client.execute("SELECT COUNT(*) AS c FROM orders")).rows[0]?.c || 0)).toBe(0);
      expect(Number((await client.execute("SELECT COUNT(*) AS c FROM request_logs")).rows[0]?.c || 0)).toBe(0);
      expect(Number((await client.execute("SELECT COUNT(*) AS c FROM admin_audit_logs")).rows[0]?.c || 0)).toBe(1);
    } finally {
      await client.execute("DELETE FROM admin_audit_logs").catch(() => undefined);
      client.close();
    }
  });

  it("keep_catalog clears trade inventory and wallet but keeps products", async () => {
    const client = createIsolatedClient();
    try {
      await applyMigration(client, "0001");
      await applyMigration(client, "0002");
      await applyMigration(client, "0006");
      await applyMigration(client, "0009");
      await applyMigration(client, "0011");

      const now = "2026-07-18T00:00:00.000Z";
      // 0011 会预置默认渠道；system_config 也可能已有 key，使用 upsert / 非默认渠道避免冲突。
      await client.batch([
        {
          sql: "INSERT INTO system_config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
          args: ["shop_name", "保留店铺", now],
        },
        { sql: "INSERT INTO products (id, slug, title, fulfillment_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", args: ["prod-keep", "prod-keep", "商品", "card", now, now] },
        { sql: "INSERT INTO storefronts (id, slug, name, active, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", args: ["sf-keep", "main-keep", "副店", 1, 0, now, now] },
        { sql: "INSERT INTO storefront_products (storefront_id, product_id, visible, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", args: ["sf-keep", "prod-keep", 1, 1, now, now] },
        { sql: "INSERT INTO card_batches (id, product_id, name, total_count, created_at) VALUES (?, ?, ?, ?, ?)", args: ["batch-keep", "prod-keep", "批次", 1, now] },
        { sql: "INSERT INTO cards (id, product_id, batch_id, account_label, delivery_secret, status, issued_order_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", args: ["card-keep", "prod-keep", "batch-keep", "账号", "secret-keep", "issued", "order-keep", now] },
        { sql: "INSERT INTO orders (id, order_no, product_id, buyer_contact, buyer_email, amount_cents, status, fulfillment_mode, payment_provider, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", args: ["order-keep", "NO-KEEP", "prod-keep", "buyer@example.com", "buyer@example.com", 100, "issued", "card", "easypay", now] },
        { sql: "INSERT INTO order_items (id, order_id, product_id, product_title, created_at) VALUES (?, ?, ?, ?, ?)", args: ["item-keep", "order-keep", "prod-keep", "商品", now] },
        { sql: "INSERT INTO user_balances (email, balance_cents, total_deposited_cents, total_spent_cents, updated_at) VALUES (?, ?, ?, ?, ?)", args: ["keep@example.com", 100, 100, 0, now] },
        { sql: "INSERT INTO balance_transactions (id, email, type, amount_cents, balance_after_cents, reference_type, reference_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", args: ["balance-tx-keep", "keep@example.com", "voucher_redeem", 100, 100, "voucher", "VCH", now] },
        { sql: "INSERT INTO request_logs (id, ip_hash, method, path, action, status_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", args: ["request-keep", "ip", "GET", "/api/products", "products", 200, now] },
        { sql: "INSERT INTO admin_audit_logs (id, action, target_type, target_id, metadata_json, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", args: ["audit-keep-old", "old", "system", "old", "{}", "ip", now] },
      ]);

      const result = await clearBusinessDataPreservingConfig(createDb(client), "admin-ip", { profile: "keep_catalog" });

      expect(result.profile).toBe("keep_catalog");
      expect(result.cardStrategy).toBe("clear_all");
      expect(Number((await client.execute("SELECT COUNT(*) AS c FROM orders")).rows[0]?.c || 0)).toBe(0);
      expect(Number((await client.execute("SELECT COUNT(*) AS c FROM cards")).rows[0]?.c || 0)).toBe(0);
      expect(Number((await client.execute("SELECT COUNT(*) AS c FROM card_batches")).rows[0]?.c || 0)).toBe(0);
      expect(Number((await client.execute("SELECT COUNT(*) AS c FROM user_balances")).rows[0]?.c || 0)).toBe(0);
      expect(Number((await client.execute("SELECT COUNT(*) AS c FROM request_logs")).rows[0]?.c || 0)).toBe(0);
      expect(Number((await client.execute("SELECT COUNT(*) AS c FROM products")).rows[0]?.c || 0)).toBe(1);
      expect(Number((await client.execute("SELECT COUNT(*) AS c FROM storefronts WHERE id = 'sf-keep'")).rows[0]?.c || 0)).toBe(1);
      expect(Number((await client.execute("SELECT COUNT(*) AS c FROM storefront_products WHERE product_id = 'prod-keep'")).rows[0]?.c || 0)).toBe(1);
      expect(Number((await client.execute("SELECT COUNT(*) AS c FROM system_config WHERE key = 'shop_name'")).rows[0]?.c || 0)).toBe(1);
      expect(Number((await client.execute("SELECT COUNT(*) AS c FROM admin_audit_logs")).rows[0]?.c || 0)).toBe(1);
      expect(result.reservedTables).toEqual(expect.arrayContaining([
        "system_config",
        "products",
        "storefronts",
        "storefront_products",
      ]));
    } finally {
      await client.execute("DELETE FROM admin_audit_logs").catch(() => undefined);
      client.close();
    }
  });

  it("runtime profile only clears logs and transient state", async () => {
    const client = createIsolatedClient();
    try {
      await applyMigration(client, "0001");
      await applyMigration(client, "0006");
      await applyMigration(client, "0009");

      const now = "2026-07-18T00:00:00.000Z";
      await client.batch([
        { sql: "INSERT INTO products (id, slug, title, fulfillment_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", args: ["prod-rt", "prod-rt", "商品", "card", now, now] },
        { sql: "INSERT INTO cards (id, product_id, account_label, delivery_secret, status, created_at) VALUES (?, ?, ?, ?, ?, ?)", args: ["card-rt", "prod-rt", "账号", "secret-rt", "available", now] },
        { sql: "INSERT INTO orders (id, order_no, product_id, buyer_contact, buyer_email, amount_cents, status, fulfillment_mode, payment_provider, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", args: ["order-rt", "NO-RT", "prod-rt", "buyer@example.com", "buyer@example.com", 100, "issued", "card", "easypay", now] },
        { sql: "INSERT INTO user_balances (email, balance_cents, total_deposited_cents, total_spent_cents, updated_at) VALUES (?, ?, ?, ?, ?)", args: ["runtime@example.com", 50, 50, 0, now] },
        { sql: "INSERT INTO request_logs (id, ip_hash, method, path, action, status_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", args: ["request-rt", "ip", "GET", "/api/products", "products", 200, now] },
        { sql: "INSERT INTO email_logs (id, order_id, to_email, template, status, created_at) VALUES (?, ?, ?, ?, ?, ?)", args: ["email-rt", "order-rt", "buyer@example.com", "order_pending", "sent", now] },
        { sql: "INSERT INTO rate_limit_windows (action, ip_hash, window_start, request_count) VALUES (?, ?, ?, ?)", args: ["admin:test-rt", "ip", 1, 1] },
        { sql: "INSERT INTO idempotency_keys (key, action, resource_id, response_json, created_at, request_hash) VALUES (?, ?, ?, ?, ?, ?)", args: ["idem-rt", "pay", "order-rt", "{}", now, "hash"] },
        { sql: "INSERT INTO admin_audit_logs (id, action, target_type, target_id, metadata_json, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", args: ["audit-rt-old", "old", "system", "old", "{}", "ip", now] },
      ]);

      const result = await clearBusinessDataPreservingConfig(createDb(client), "admin-ip", { profile: "runtime" });

      expect(result.profile).toBe("runtime");
      expect(result.cardStrategy).toBe("none");
      expect(Number((await client.execute("SELECT COUNT(*) AS c FROM orders")).rows[0]?.c || 0)).toBe(1);
      expect(Number((await client.execute("SELECT COUNT(*) AS c FROM cards")).rows[0]?.c || 0)).toBe(1);
      expect(Number((await client.execute("SELECT COUNT(*) AS c FROM products")).rows[0]?.c || 0)).toBe(1);
      expect(Number((await client.execute("SELECT COUNT(*) AS c FROM user_balances")).rows[0]?.c || 0)).toBe(1);
      expect(Number((await client.execute("SELECT COUNT(*) AS c FROM request_logs")).rows[0]?.c || 0)).toBe(0);
      expect(Number((await client.execute("SELECT COUNT(*) AS c FROM email_logs")).rows[0]?.c || 0)).toBe(0);
      expect(Number((await client.execute("SELECT COUNT(*) AS c FROM rate_limit_windows")).rows[0]?.c || 0)).toBe(0);
      expect(Number((await client.execute("SELECT COUNT(*) AS c FROM idempotency_keys")).rows[0]?.c || 0)).toBe(0);
      expect(Number((await client.execute("SELECT COUNT(*) AS c FROM admin_audit_logs")).rows[0]?.c || 0)).toBe(1);
      expect(result.tables.products).toBeUndefined();
      expect(result.tables.orders).toBeUndefined();
    } finally {
      await client.execute("DELETE FROM admin_audit_logs").catch(() => undefined);
      client.close();
    }
  });

  it("keeps merged log pages stable when new rows arrive between requests", async () => {
    const client = createClient({ url: "file::memory:?cache=shared" });
    try {
      await applyMigration(client, "0001");
      await applyMigration(client, "0005");
      await applyMigration(client, "0007");
      const now = Date.now();
      for (const [id, secondsAgo] of [["r1", 3], ["r2", 2], ["r3", 1]] as const) {
        await client.execute({
          sql: `INSERT INTO request_logs
            (id, ip_hash, method, path, action, status_code, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: [id, "ip", "GET", "/api/test", "test", 200, new Date(now - secondsAgo * 1000).toISOString()],
        });
      }

      const db = createDb(client);
      const first = await getMergedLogs(db, 2);
      await client.execute({
        sql: `INSERT INTO request_logs
          (id, ip_hash, method, path, action, status_code, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: ["r4", "ip", "GET", "/api/test", "test", 200, new Date(now + 60_000).toISOString()],
      });
      await client.execute("DELETE FROM request_logs WHERE id IN ('r2', 'r3')");
      const second = await getMergedLogs(db, 2, { cursor: first.nextCursor });

      expect(first.logs.map((log) => log.id)).toEqual(["r3", "r2"]);
      expect(second.logs.map((log) => log.id)).toEqual(["r1"]);
      expect(first.hasMore).toBe(true);
      expect(second.hasMore).toBe(false);
      expect(second.total).toBe(first.total);
    } finally {
      client.close();
    }
  });

  it("keeps email log pages on the first-request snapshot", async () => {
    const client = createClient({ url: "file::memory:?cache=shared" });
    try {
      await applyMigration(client, "0001");
      const now = Date.now();
      for (const [id, secondsAgo] of [["e1", 3], ["e2", 2], ["e3", 1]] as const) {
        await client.execute({
          sql: `INSERT INTO email_logs
            (id, to_email, template, status, created_at)
            VALUES (?, ?, ?, ?, ?)`,
          args: [id, "buyer@example.com", "test", "sent", new Date(now - secondsAgo * 1000).toISOString()],
        });
      }

      const db = createDb(client);
      const first = await getEmailLogList(db, { status: "", search: "", limit: 2 });
      await client.execute({
        sql: `INSERT INTO email_logs
          (id, to_email, template, status, created_at)
          VALUES (?, ?, ?, ?, ?)`,
        args: ["e4", "buyer@example.com", "test", "sent", new Date(now + 60_000).toISOString()],
      });
      await client.execute("DELETE FROM email_logs WHERE id IN ('e2', 'e3')");
      const second = await getEmailLogList(db, {
        status: "",
        search: "",
        limit: 2,
        cursor: first.nextCursor,
      });

      expect(first.results.map((log) => log.id)).toEqual(["e3", "e2"]);
      expect(second.results.map((log) => log.id)).toEqual(["e1"]);
      expect(second.total).toBe(first.total);
    } finally {
      client.close();
    }
  });

  it("uses the complete merged-log sort key when timestamps collide", async () => {
    const client = createClient({ url: "file::memory:?cache=shared" });
    try {
      await applyMigration(client, "0001");
      const createdAt = new Date(Date.now() - 1_000).toISOString();
      for (const id of ["tie-r1", "tie-r2"]) {
        await client.execute({
          sql: `INSERT INTO request_logs
            (id, ip_hash, method, path, action, status_code, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: [id, "ip", "GET", "/api/test", "tie-action", 200, createdAt],
        });
      }
      for (const id of ["tie-a1", "tie-a2"]) {
        await client.execute({
          sql: `INSERT INTO admin_audit_logs
            (id, action, target_type, target_id, metadata_json, ip_hash, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: [id, "tie-action", "system", id, "{}", "ip", createdAt],
        });
      }

      const db = createDb(client);
      const first = await getMergedLogs(db, 3, { action: "tie-action" });
      const second = await getMergedLogs(db, 3, { action: "tie-action", cursor: first.nextCursor });

      expect(first.logs.map((log) => log.id)).toEqual(["tie-r2", "tie-r1", "tie-a2"]);
      expect(second.logs.map((log) => log.id)).toEqual(["tie-a1"]);
    } finally {
      client.close();
    }
  });

  it("rejects malformed and cross-filter log cursors", async () => {
    const client = createClient({ url: "file::memory:" });
    try {
      await applyMigration(client, "0001");
      const db = createDb(client);

      await expect(getMergedLogs(db, 20, { cursor: "not-a-cursor" })).rejects.toMatchObject({
        name: "InvalidLogCursorError",
      });

      for (const [id, secondsAgo] of [["filter-r1", 2], ["filter-r2", 1]] as const) {
        await client.execute({
          sql: `INSERT INTO request_logs
            (id, ip_hash, method, path, action, status_code, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: [id, "ip", "GET", "/api/test", "test", 200, new Date(Date.now() - secondsAgo * 1000).toISOString()],
        });
      }
      const first = await getMergedLogs(db, 1, { action: "test" });
      await expect(getMergedLogs(db, 1, { action: "other", cursor: first.nextCursor })).rejects.toMatchObject({
        name: "InvalidLogCursorError",
      });
    } finally {
      client.close();
    }
  });

  it("uses the order-item fulfillment snapshot in list, export, and detail queries", async () => {
    const client = createClient({ url: "file::memory:?cache=shared" });
    try {
      for (const version of ["0001", "0002", "0003", "0004"]) {
        await applyMigration(client, version);
      }
      await applyMigration(client, "0011");
      await applyMigration(client, "0013");

      await client.execute({
        sql: "INSERT INTO products (id, slug, title, fulfillment_mode) VALUES (?, ?, ?, ?)",
        args: ["product-1", "product-1", "Current Product", "link"],
      });
      await client.execute({
        sql: `INSERT INTO orders
          (id, order_no, product_id, order_source, storefront_id, storefront_slug_snapshot, storefront_name_snapshot,
           buyer_contact, buyer_email, status, fulfillment_mode, fulfillment_input_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: ["order-1", "ORDER-1", "product-1", "storefront", "sf_default", "shop", "Shop", "buyer", "buyer@example.com", "issued", "card", JSON.stringify({ type: "uid", label: "用户 ID", value: "user_123" })],
      });
      await client.execute({
        sql: "INSERT INTO order_items (id, order_id, product_id, product_title, fulfillment_mode) VALUES (?, ?, ?, ?, ?)",
        args: ["item-1", "order-1", "product-1", "Snapshot Product", "virtual"],
      });

      const db = createDb(client);
      const list = await getOrderList(db, {
        status: "",
        productId: "",
        q: "",
        buyerContact: "",
        paymentMethod: "",
        page: 1,
        limit: 10,
      });
      const exported = await exportOrders(db, {
        status: "",
        productId: "",
        q: "",
        paymentMethod: "",
        cursor: "",
        limit: 10,
      });
      const detail = await getOrderDetail(db, "order-1");

      expect(list.orders[0]?.fulfillmentMode).toBe("virtual");
      expect(exported.rows[0]?.fulfillmentMode).toBe("virtual");
      expect(detail?.fulfillmentMode).toBe("virtual");
      expect(detail?.fulfillmentInput).toEqual({ type: "uid", label: "用户 ID", value: "user_123" });
    } finally {
      client.close();
    }
  });

  it("keeps tg_custom collection orders visible without inventing product fulfillment", async () => {
    const client = createClient({ url: "file::memory:?cache=shared" });
    try {
      await applyMigration(client, "0001");
      await applyMigration(client, "0011");
      await applyMigration(client, "0013");

      await client.execute({
        sql: `INSERT INTO orders
          (id, order_no, product_id, order_source, storefront_id, storefront_slug_snapshot, storefront_name_snapshot,
           buyer_contact, buyer_email, amount_cents, status, fulfillment_mode, payment_method)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: ["tg-order-1", "TG-ORDER-1", "tg_custom", "telegram", null, "", "", "tg:123", "", 8800, "paid", "card", "tg_easypay"],
      });
      await client.execute({
        sql: "INSERT INTO order_events (id, order_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)",
        args: ["tg-event-1", "tg-order-1", "notification_failed", "Telegram 支付成功通知发送失败", "2026-07-14T10:00:00Z"],
      });

      const db = createDb(client);
      const list = await getOrderList(db, {
        status: "",
        productId: "tg_custom",
        q: "",
        buyerContact: "",
        paymentMethod: "",
        page: 1,
        limit: 10,
      });
      const exported = await exportOrders(db, {
        status: "",
        productId: "tg_custom",
        q: "",
        paymentMethod: "",
        cursor: "",
        limit: 10,
      });
      const detail = await getOrderDetail(db, "tg-order-1");

      expect(list.total).toBe(1);
      expect(list.orders[0]).toMatchObject({
        productTitle: "Telegram 自定义收款",
        fulfillmentMode: "",
      });
      expect(exported.rows[0]).toMatchObject({
        productTitle: "Telegram 自定义收款",
        fulfillmentMode: "",
      });
      expect(detail).toMatchObject({
        productTitle: "Telegram 自定义收款",
        fulfillmentMode: "",
        events: [
          expect.objectContaining({
            type: "notification_failed",
            message: "Telegram 支付成功通知发送失败",
          }),
        ],
      });
    } finally {
      client.close();
    }
  });

  it("counts dashboard income by payment time instead of order creation time", async () => {
    const client = createClient({ url: "file::memory:" });
    try {
      await applyMigration(client, "0001");

      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
      const createdYesterday = new Date(yesterdayStart.getTime() + 12 * 60 * 60 * 1000).toISOString();
      const paidToday = new Date(todayStart.getTime() + 12 * 60 * 60 * 1000).toISOString();
      const createdToday = new Date(todayStart.getTime() + 13 * 60 * 60 * 1000).toISOString();
      const paidYesterday = new Date(yesterdayStart.getTime() + 13 * 60 * 60 * 1000).toISOString();
      const todayLabel = `${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

      await client.execute({
        sql: "INSERT INTO products (id, slug, title, fulfillment_mode) VALUES (?, ?, ?, ?)",
        args: ["income-product", "income-product", "Income Product", "card"],
      });
      await client.execute({
        sql: `INSERT INTO orders
          (id, order_no, product_id, buyer_contact, buyer_email, amount_cents, status, fulfillment_mode, payment_provider, created_at, paid_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: ["income-paid-today", "INCOME-TODAY", "income-product", "buyer", "buyer@example.com", 1234, "paid", "card", "easypay", createdYesterday, paidToday],
      });
      await client.execute({
        sql: `INSERT INTO orders
          (id, order_no, product_id, buyer_contact, buyer_email, amount_cents, status, fulfillment_mode, payment_provider, created_at, paid_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: ["income-created-today", "INCOME-OLDPAY", "income-product", "buyer", "buyer@example.com", 9000, "paid", "card", "alipay", createdToday, paidYesterday],
      });
      await client.execute({
        sql: `INSERT INTO orders
          (id, order_no, product_id, buyer_contact, buyer_email, amount_cents, currency, status, fulfillment_mode, payment_provider, created_at, paid_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: ["income-jpy-today", "INCOME-JPY", "income-product", "buyer", "buyer@example.com", 5000, "JPY", "paid", "card", "future-provider", createdYesterday, paidToday],
      });

      const db = createDb(client);
      const summary = await getAdminSummary(db);
      const trend = await getDailyIncomeTrend(db);
      const todayTrend = trend.find((row) => row.date === todayLabel);

      expect(summary?.totalIncomeCents).toBe(10234);
      expect(summary?.todayIncomeCents).toBe(1234);
      expect(summary?.todayEasyPayCents).toBe(1234);
      expect(summary?.todayAlipayCents).toBe(0);
      expect(todayTrend?.amountCents).toBe(1234);
    } finally {
      client.close();
    }
  });

  it("rolls back the canceled status when locked-card release fails", async () => {
    const client = createClient({ url: "file::memory:?cache=shared" });
    try {
      await applyMigration(client, "0001");
      await client.execute({
        sql: "INSERT INTO products (id, slug, title, fulfillment_mode) VALUES (?, ?, ?, ?)",
        args: ["cancel-product", "cancel-product", "Cancel Product", "card"],
      });
      await client.execute({
        sql: `INSERT INTO orders
          (id, order_no, product_id, buyer_contact, buyer_email, status, fulfillment_mode)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: ["cancel-order", "CANCEL-ORDER", "cancel-product", "buyer", "buyer@example.com", "pending", "card"],
      });
      await client.execute({
        sql: `INSERT INTO cards
          (id, product_id, status, locked_order_id, lock_expires_at)
          VALUES (?, ?, ?, ?, ?)`,
        args: ["cancel-card", "cancel-product", "locked", "cancel-order", "2099-01-01T00:00:00.000Z"],
      });
      await client.execute(`
        CREATE TRIGGER abort_cancel_card_release
        BEFORE UPDATE OF status ON cards
        WHEN OLD.locked_order_id = 'cancel-order'
        BEGIN
          SELECT RAISE(ABORT, 'forced card release failure');
        END
      `);

      const db = createDb(client);
      await expect(cancelOrder(db, "cancel-order")).rejects.toThrow();

      const order = await client.execute({
        sql: "SELECT status FROM orders WHERE id = ?",
        args: ["cancel-order"],
      });
      expect(order.rows[0]?.status).toBe("pending");
    } finally {
      client.close();
    }
  });

  it("deletes only terminal orders and their dependent operational records", async () => {
    const client = createClient({ url: "file::memory:?cache=shared" });
    try {
      await applyMigration(client, "0001");
      await client.execute({
        sql: "INSERT INTO products (id, slug, title, fulfillment_mode) VALUES (?, ?, ?, ?)",
        args: ["delete-product", "delete-product", "Delete Product", "card"],
      });
      for (const [id, status] of [["terminal-order", "canceled"], ["protected-order", "issued"], ["referenced-order", "expired"]] as const) {
        await client.execute({
          sql: `INSERT INTO orders
            (id, order_no, product_id, buyer_contact, buyer_email, status, fulfillment_mode, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [id, id.toUpperCase(), "delete-product", "buyer", "buyer@example.com", status, "card", "2026-01-01T00:00:00.000Z"],
        });
      }
      await client.execute({
        sql: `INSERT INTO order_items
          (id, order_id, product_id, product_title, fulfillment_mode, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
        args: ["terminal-item", "terminal-order", "delete-product", "Delete Product", "card", "2026-01-01T00:00:00.000Z"],
      });
      await client.execute({
        sql: `INSERT INTO order_events (id, order_id, type, message, created_at)
          VALUES (?, ?, ?, ?, ?)`,
        args: ["terminal-event", "terminal-order", "canceled", "canceled", "2026-01-01T00:00:00.000Z"],
      });
      await client.execute({
        sql: `INSERT INTO email_logs (id, order_id, to_email, template, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
        args: ["terminal-email", "terminal-order", "buyer@example.com", "order_pending", "sent", "2026-01-01T00:00:00.000Z"],
      });
      await client.execute({
        sql: `INSERT INTO referral_events (id, referral_code, order_id, buyer_contact, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
        args: ["terminal-referral", "REF", "terminal-order", "buyer", "created", "2026-01-01T00:00:00.000Z"],
      });
      await client.execute({
        sql: `INSERT INTO cards (id, product_id, account_label, delivery_secret, status, locked_order_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: ["referenced-card", "delete-product", "account", "secret", "locked", "referenced-order", "2026-01-01T00:00:00.000Z"],
      });

      const db = createDb(client);
      await expect(batchDeleteOrders(db, ["terminal-order", "protected-order"]))
        .resolves.toEqual({ deleted: 0, blocked: 1 });
      await expect(batchDeleteOrders(db, ["referenced-order"]))
        .resolves.toEqual({ deleted: 0, blocked: 1 });

      await client.execute(`
        CREATE TRIGGER abort_terminal_order_delete
        BEFORE DELETE ON orders
        WHEN OLD.id = 'terminal-order'
        BEGIN
          SELECT RAISE(ABORT, 'forced order delete failure');
        END
      `);
      await expect(batchDeleteOrders(db, ["terminal-order"])).rejects.toThrow();
      const itemAfterRollback = await client.execute("SELECT COUNT(*) AS count FROM order_items WHERE order_id = 'terminal-order'");
      expect(Number(itemAfterRollback.rows[0]?.count)).toBe(1);
      await client.execute("DROP TRIGGER abort_terminal_order_delete");

      const result = await batchDeleteOrders(db, ["terminal-order"]);
      expect(result).toEqual({ deleted: 1, blocked: 0 });

      for (const table of ["orders", "order_items", "order_events", "email_logs", "referral_events"]) {
        const remaining = await client.execute(`SELECT COUNT(*) AS count FROM ${table} WHERE ${table === "orders" ? "id" : "order_id"} = 'terminal-order'`);
        expect(Number(remaining.rows[0]?.count)).toBe(0);
      }
      const protectedOrder = await client.execute("SELECT status FROM orders WHERE id = 'protected-order'");
      expect(protectedOrder.rows[0]?.status).toBe("issued");
      const referencedOrder = await client.execute("SELECT status FROM orders WHERE id = 'referenced-order'");
      expect(referencedOrder.rows[0]?.status).toBe("expired");
    } finally {
      client.close();
    }
  });
});
