/**
 * 迁移系统单元测试
 *
 * 覆盖：
 * 1. parseMigrationFile 解析 UP/DOWN
 * 2. loadMigrations 加载迁移（import.meta.glob 和 MIGRATION_FILES 回退）
 * 3. runMigrations 执行迁移
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createClient } from "@libsql/client";
import { parseMigrationFile, loadMigrations, executeMigration, rollbackMigration, runMigrations } from "../db/migrations";
import { createDb } from "../db/client";
import type { DbType } from "../db/client";
import { MIGRATION_FILES } from "../db/migration-files";

// ── parseMigrationFile 测试 ──

describe("parseMigrationFile", () => {
  it("应解析包含 UP 和 DOWN 的迁移文件", () => {
    const content = `-- UP
CREATE TABLE users (id TEXT PRIMARY KEY);
INSERT INTO users VALUES ('1');

-- DOWN
DROP TABLE users;
`;

    const result = parseMigrationFile(content);
    expect(result.up).toHaveLength(2);
    expect(result.up[0]).toBe("CREATE TABLE users (id TEXT PRIMARY KEY)");
    expect(result.up[1]).toBe("INSERT INTO users VALUES ('1')");
    expect(result.down).toHaveLength(1);
    expect(result.down![0]).toBe("DROP TABLE users");
  });

  it("应解析仅包含 UP 的迁移文件", () => {
    const content = `-- UP
CREATE TABLE products (id TEXT PRIMARY KEY);
`;

    const result = parseMigrationFile(content);
    expect(result.up).toHaveLength(1);
    expect(result.up[0]).toBe("CREATE TABLE products (id TEXT PRIMARY KEY)");
    expect(result.down).toBeUndefined();
  });

  it("应忽略注释行", () => {
    const content = `-- UP
-- 创建用户表
CREATE TABLE users (id TEXT PRIMARY KEY);
-- 插入测试数据
INSERT INTO users VALUES ('1');

-- DOWN
-- 删除用户表
DROP TABLE users;
`;

    const result = parseMigrationFile(content);
    expect(result.up).toHaveLength(2);
    expect(result.up[0]).toBe("CREATE TABLE users (id TEXT PRIMARY KEY)");
    expect(result.up[1]).toBe("INSERT INTO users VALUES ('1')");
    expect(result.down).toHaveLength(1);
    expect(result.down![0]).toBe("DROP TABLE users");
  });

  it("应处理空语句（分号分隔）", () => {
    const content = `-- UP
CREATE TABLE users (id TEXT PRIMARY KEY);;

-- DOWN
DROP TABLE users;;
`;

    const result = parseMigrationFile(content);
    expect(result.up).toHaveLength(1);
    expect(result.down).toHaveLength(1);
  });
});

// ── loadMigrations 测试 ──

describe("loadMigrations", () => {
  it("应返回构建时生成的迁移", async () => {
    // 确保 MIGRATION_FILES 有内容
    const entries = Object.entries(MIGRATION_FILES);
    expect(entries.length).toBeGreaterThan(0);

    const migrations = await loadMigrations();
    expect(migrations.length).toBeGreaterThan(0);
    expect(migrations[0]).toHaveProperty("version");
    expect(migrations[0]).toHaveProperty("name");
    expect(migrations[0]).toHaveProperty("up");
  });

  it("应正确解析迁移版本和名称", async () => {
    const migrations = await loadMigrations();
    const first = migrations[0];
    expect(first.version).toMatch(/^\d{4}$/);
    expect(first.name).toBeTruthy();
  });

  it("operational retention migration indexes every scheduled cleanup predicate", () => {
    const migration = MIGRATION_FILES["0005"];

    expect(migration).toContain("idx_rate_limit_windows_window_start");
    expect(migration).toContain("idx_idempotency_keys_created_at");
    expect(migration).toContain("idx_request_logs_created_at");
    expect(migration).toContain("idx_email_logs_created_at");
    expect(migration).toContain("idx_card_logs_created_at");
    expect(migration).toContain("idx_order_events_created_at");
    expect(migration).toContain("idx_admin_audit_logs_created_at");
  });

  it("binds idempotency records to a request digest", () => {
    const migration = MIGRATION_FILES["0006"];

    expect(migration).toContain("ALTER TABLE idempotency_keys ADD COLUMN request_hash");
    expect(migration).toContain("DEFAULT ''");
    expect(migration).toContain("ALTER TABLE idempotency_keys DROP COLUMN request_hash");
  });

  it("indexes every stable log cursor sort key", () => {
    const migration = MIGRATION_FILES["0007"];

    expect(migration).toContain("idx_request_logs_cursor");
    expect(migration).toContain("idx_admin_audit_logs_cursor");
    expect(migration).toContain("idx_email_logs_cursor");
    expect(migration).toContain("created_at DESC, id DESC");
  });

  it("adds an explicit per-product storefront stock visibility policy", () => {
    const migration = MIGRATION_FILES["0008"];

    expect(migration).toContain("ALTER TABLE products ADD COLUMN stock_display_mode");
    expect(migration).toContain("DEFAULT 'exact'");
    expect(migration).toContain("CHECK (stock_display_mode IN ('exact', 'availability_only', 'hidden'))");
  });

  it("adds isolated and idempotent balance recharge orders", () => {
    const migration = MIGRATION_FILES["0009"];

    expect(migration).toContain("CREATE TABLE IF NOT EXISTS balance_recharge_orders");
    expect(migration).toContain("idx_balance_recharge_payment_ref_unique");
    expect(migration).toContain("WHERE payment_ref <> ''");
  });

  it("prevents one external payment reference from settling multiple product orders", () => {
    const migration = MIGRATION_FILES["0010"];

    expect(migration).toContain("idx_orders_external_payment_ref_unique");
    expect(migration).toContain("ON orders(payment_provider, payment_ref)");
    expect(migration).toContain("payment_provider NOT IN ('balance', 'free')");
    expect(migration).toContain("payment_ref NOT LIKE 'last4:%'");
  });

  it("adds same-operator storefront channels and immutable order attribution", () => {
    const migration = MIGRATION_FILES["0011"];

    expect(migration).toContain("CREATE TABLE IF NOT EXISTS storefronts");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS storefront_products");
    expect(migration).toContain("idx_storefronts_single_default");
    expect(migration).toContain("order_source TEXT NOT NULL DEFAULT 'storefront'");
    expect(migration).toContain("storefront_name_snapshot");
    expect(migration).toContain("buyer_contact LIKE 'redeem:%'");
  });

  it("adds a controlled storefront template without introducing arbitrary themes", () => {
    const migration = MIGRATION_FILES["0012"];

    expect(migration).toContain("ALTER TABLE storefronts ADD COLUMN template_key");
    expect(migration).toContain("CHECK (template_key IN ('catalog', 'compact'))");
    expect(migration).toContain("UPDATE storefronts");
    expect(migration).toContain("WHEN is_default = 1 THEN 'catalog'");
    expect(migration).toContain("ELSE 'compact'");
  });

  it("adds generic fulfillment input configuration and an order-time snapshot", () => {
    const migration = MIGRATION_FILES["0013"];

    expect(migration).toContain("fulfillment_input_type");
    expect(migration).toContain("CHECK (fulfillment_input_type IN ('none', 'phone', 'qq', 'uid', 'account', 'text'))");
    expect(migration).toContain("fulfillment_input_required");
    expect(migration).toContain("ALTER TABLE orders ADD COLUMN fulfillment_input_json");
    expect(migration).toContain("ALTER TABLE orders DROP COLUMN fulfillment_input_json");
  });

  it("adds a separate storefront purchase-limit display switch", () => {
    const migration = MIGRATION_FILES["0014"];

    expect(migration).toContain("ALTER TABLE products ADD COLUMN purchase_limit_display");
    expect(migration).toContain("DEFAULT 0");
    expect(migration).toContain("CHECK (purchase_limit_display IN (0, 1))");
  });
});

// ── executeMigration 测试 ──

describe("executeMigration", () => {
  it("应执行未执行的迁移", async () => {
    const executed: string[] = [];
    const db = createMockDb(executed);

    const migration = {
      version: "0001",
      name: "test_migration",
      up: ["CREATE TABLE test (id TEXT PRIMARY KEY)"],
      down: ["DROP TABLE test"],
    };

    await executeMigration(db, migration);
    // 验证至少执行了一次 SQL（不验证具体 SQL 内容，因为 sql.raw 对象难以在 mock 中解析）
    expect(executed.length).toBeGreaterThan(0);
  });

  it("应跳过已执行的迁移", async () => {
    const executed: string[] = [];
    const db = createMockDb(executed, ["0001"]);

    const migration = {
      version: "0001",
      name: "test_migration",
      up: ["CREATE TABLE test (id TEXT PRIMARY KEY)"],
    };

    await executeMigration(db, migration);
    // 已执行的迁移只应执行检查 SQL，不应执行 UP SQL 或记录 SQL
    expect(executed.length).toBe(1);
    expect(executed[0]).toContain("select");
    expect(executed[0]).not.toContain("create table");
  });
});

// ── rollbackMigration 测试 ──

describe("rollbackMigration", () => {
  it("应回滚已执行的迁移", async () => {
    const executed: string[] = [];
    const db = createMockDb(executed, ["0001"]);

    const migration = {
      version: "0001",
      name: "test_migration",
      up: ["CREATE TABLE test (id TEXT PRIMARY KEY)"],
      down: ["DROP TABLE test"],
    };

    await rollbackMigration(db, migration);
    // 验证至少执行了一次 SQL
    expect(executed.length).toBeGreaterThan(0);
  });

  it("应跳过未执行的迁移", async () => {
    const executed: string[] = [];
    const db = createMockDb(executed);

    const migration = {
      version: "0001",
      name: "test_migration",
      up: ["CREATE TABLE test (id TEXT PRIMARY KEY)"],
      down: ["DROP TABLE test"],
    };

    await rollbackMigration(db, migration);
    // 未执行的迁移只应执行检查 SQL，不应执行 DOWN SQL 或删除记录 SQL
    expect(executed.length).toBe(1);
    expect(executed[0]).toContain("select");
    expect(executed[0]).not.toContain("drop table");
  });

  it("应在无 DOWN 脚本时抛出错误", async () => {
    const executed: string[] = [];
    const db = createMockDb(executed, ["0001"]);

    const migration = {
      version: "0001",
      name: "test_migration",
      up: ["CREATE TABLE test (id TEXT PRIMARY KEY)"],
    };

    await expect(rollbackMigration(db, migration)).rejects.toThrow("has no DOWN script");
  });
});

// ── runMigrations 测试 ──

describe("runMigrations", () => {
  it("应执行所有待处理的迁移", async () => {
    const executed: string[] = [];
    const db = createMockDb(executed);

    // 模拟 loadMigrations 返回迁移
    vi.spyOn(await import("../db/migrations"), "loadMigrations").mockResolvedValue([
      {
        version: "0001",
        name: "test_migration",
        up: ["CREATE TABLE test (id TEXT PRIMARY KEY)"],
      },
    ]);

    await runMigrations(db);
    // 验证至少执行了一次 SQL
    expect(executed.length).toBeGreaterThan(0);
  });

  it("应能在全新 libSQL 数据库上执行完整迁移链", async () => {
    const client = createClient({ url: "file::memory:" });
    try {
      const db = createDb(client);

      await runMigrations(db);

      const tables = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table'");
      const tableNames = new Set(tables.rows.map((row) => String(row.name)));

      expect(tableNames).toContain("products");
      expect(tableNames).toContain("orders");
      expect(tableNames).toContain("cards");
      expect(tableNames).toContain("voucher_codes");
      expect(tableNames).toContain("user_balances");
      expect(tableNames).toContain("balance_transactions");
      expect(tableNames).toContain("storefronts");
      expect(tableNames).toContain("storefront_products");
      expect(tableNames).toContain("schema_migrations");

      const orderColumns = await client.execute("PRAGMA table_info(orders)");
      const orderColumnNames = new Set(orderColumns.rows.map((row) => String(row.name)));
      expect(orderColumnNames).toContain("fulfillment_mode");
      expect(orderColumnNames).toContain("delivery_json");
      expect(orderColumnNames).toContain("delivery_visibility");
      expect(orderColumnNames).toContain("order_source");
      expect(orderColumnNames).toContain("storefront_id");
      expect(orderColumnNames).toContain("storefront_slug_snapshot");
      expect(orderColumnNames).toContain("storefront_name_snapshot");

      const defaultStorefront = await client.execute("SELECT id, slug, active, is_default FROM storefronts WHERE id = 'sf_default'");
      expect(defaultStorefront.rows[0]).toMatchObject({ id: "sf_default", slug: "shop", active: 1, is_default: 1 });

      const cardColumns = await client.execute("PRAGMA table_info(cards)");
      const cardColumnNames = new Set(cardColumns.rows.map((row) => String(row.name)));
      expect(cardColumnNames).toContain("buyer_email");
      expect(cardColumnNames).toContain("buyer_contact");
      expect(cardColumnNames).toContain("expires_at");

      await client.execute("INSERT INTO orders (id, order_no, product_id, buyer_email, payment_provider, payment_ref) VALUES ('paid-1', 'PAID-1', 'prod-1', 'a@example.com', 'easypay', 'TRADE-UNIQUE')");
      await expect(client.execute(
        "INSERT INTO orders (id, order_no, product_id, buyer_email, payment_provider, payment_ref) VALUES ('paid-2', 'PAID-2', 'prod-1', 'b@example.com', 'easypay', 'TRADE-UNIQUE')",
      )).rejects.toThrow(/UNIQUE constraint failed/);

      // 线下付款后四位不是支付平台全局流水，重复数字属于正常情况，不能被外部流水索引拦截。
      await client.execute("INSERT INTO orders (id, order_no, product_id, buyer_email, payment_provider, payment_ref) VALUES ('offline-1', 'OFFLINE-1', 'prod-1', 'a@example.com', 'manual', 'last4:1234')");
      await client.execute("INSERT INTO orders (id, order_no, product_id, buyer_email, payment_provider, payment_ref) VALUES ('offline-2', 'OFFLINE-2', 'prod-1', 'b@example.com', 'manual', 'last4:1234')");
    } finally {
      client.close();
    }
  });

  it("应在升级时按商品策略回填订单交付可见性", async () => {
    const client = createClient({ url: "file::memory:" });
    try {
      const db = createDb(client);
      vi.restoreAllMocks();
      const migrations = await loadMigrations();

      for (const migration of migrations.filter((item) => item.version <= "0003")) {
        await executeMigration(db, migration);
      }
      await client.execute("INSERT INTO products (id, slug, title, delivery_visibility) VALUES ('prod-email', 'email-product', 'Email Product', 'email_only')");
      await client.execute("INSERT INTO orders (id, order_no, product_id, buyer_contact, buyer_email, status) VALUES ('order-old', 'ORDER-OLD', 'prod-email', '', 'buyer@example.com', 'issued')");

      const snapshotMigration = migrations.find((item) => item.version === "0004");
      expect(snapshotMigration).toBeDefined();
      await executeMigration(db, snapshotMigration!);

      const result = await client.execute("SELECT delivery_visibility FROM orders WHERE id = 'order-old'");
      expect(result.rows[0]?.delivery_visibility).toBe("email_only");
    } finally {
      client.close();
    }
  });
});

// ── Mock 辅助函数 ──

function createMockDb(executed: string[], executedVersions: string[] = []): DbType {
  const executedSet = new Set(executedVersions);

  return {
    run: async (sql: any) => {
      // 提取 SQL 字符串（简化处理）
      let sqlStr = "";
      if (typeof sql === "string") {
        sqlStr = sql.toLowerCase();
      } else if (Array.isArray(sql?.queryChunks)) {
        // drizzle-orm sql`...` 对象的标准结构：queryChunks 是数组，包含字符串和 StringChunk 对象
        sqlStr = sql.queryChunks.map((chunk: any) => {
          if (typeof chunk === "string") return chunk;
          if (chunk && typeof chunk === "object" && Array.isArray(chunk.value)) {
            // StringChunk: { value: [sql片段] }
            return chunk.value.join("");
          }
          if (chunk && typeof chunk === "object") {
            return String(chunk.value ?? "");
          }
          return String(chunk ?? "");
        }).join("").toLowerCase();
      } else if (Array.isArray(sql?.value)) {
        sqlStr = sql.value.join("").toLowerCase();
      } else {
        sqlStr = String(sql || "").toLowerCase();
      }

      executed.push(sqlStr);

      // 模拟 schema_migrations 查询
      if (sqlStr.includes("schema_migrations")) {
        if (sqlStr.includes("select")) {
          // 检查是否查询已执行的版本
          const hasVersion = executedVersions.some(v => sqlStr.includes(v));
          return {
            rows: hasVersion ? [{ version: "0001", name: "migration_0001", executedAt: new Date().toISOString() }] : [],
          };
        }
        if (sqlStr.includes("insert")) {
          executedSet.add("0001");
          return {};
        }
        if (sqlStr.includes("delete")) {
          executedSet.delete("0001");
          return {};
        }
      }

      // 模拟迁移执行
      if (sqlStr.includes("create table") || sqlStr.includes("drop table")) {
        return { rows: [] };
      }

      return { rows: [] };
    },
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
          orderBy: () => ({
            limit: () => Promise.resolve([]),
          }),
        }),
      }),
    }),
    insert: () => ({
      values: () => Promise.resolve({ rowsAffected: 1 }),
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve({ rowsAffected: 1 }),
      }),
    }),
    delete: () => ({
      where: () => Promise.resolve({ rowsAffected: 0 }),
    }),
  } as unknown as DbType;
}
