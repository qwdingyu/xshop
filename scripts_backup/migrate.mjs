/**
 * 数据库迁移脚本（Turso/libSQL HTTP 模式）
 *
 * 读取 migrations/ 目录下的 SQL 文件，按序号顺序逐条执行。
 * 支持 Turso 远程数据库和本地 SQLite。
 *
 * 用法：
 *   TURSO_URL=libsql://xxx.turso.io TURSO_TOKEN=xxx node scripts/migrate.mjs
 *   TURSO_URL=file:local.db node scripts/migrate.mjs
 */

import { createClient } from "@libsql/client";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const TURSO_URL = process.env.TURSO_URL;
const TURSO_TOKEN = process.env.TURSO_TOKEN;

if (!TURSO_URL) {
  console.error("❌ TURSO_URL is required");
  console.error("   Usage: TURSO_URL=libsql://xxx.turso.io TURSO_TOKEN=xxx node scripts/migrate.mjs");
  process.exit(1);
}

const migrationsDir = join(process.cwd(), "migrations");

// 读取并排序迁移文件
const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

if (files.length === 0) {
  console.log("ℹ️  No migration files found in migrations/");
  process.exit(0);
}

console.log(`\n📦 Applying ${files.length} migration(s) to ${TURSO_URL.replace(/\/\/.*@/, "//***@")}\n`);

const client = createClient({
  url: TURSO_URL,
  authToken: TURSO_TOKEN || undefined,
});

for (const file of files) {
  const sql = readFileSync(join(migrationsDir, file), "utf-8");

  // 去除 SQL 注释行（-- 开头），再按分号分割为独立语句
  const statements = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  console.log(`  📄 ${file} (${statements.length} statements)`);

  for (const stmt of statements) {
    let retries = 3;
    while (retries > 0) {
      try {
        await client.execute(stmt);
        break;
      } catch (err) {
        // CREATE TABLE IF NOT EXISTS 等幂等语句可能报 "already exists"
        // 这类错误可以安全忽略
        if (err.message?.includes("already exists")) {
          break;
        }
        // Turso 服务端临时故障（502/503/504）可重试
        if (err.message?.includes("502") || err.message?.includes("503") || err.message?.includes("504") || err.message?.includes("SERVER_ERROR")) {
          retries--;
          if (retries > 0) {
            const delay = (4 - retries) * 2 + 2;
            console.warn(`    ⚠️ Turso 临时错误 (${err.message.slice(0, 60)})，${delay}s 后重试 (剩余 ${retries} 次)...`);
            await new Promise((r) => setTimeout(r, delay * 1000));
            continue;
          }
        }
        console.error(`    ❌ Error: ${err.message}`);
        console.error(`    SQL: ${stmt.slice(0, 100)}...`);
        process.exit(1);
      }
    }
  }
}

console.log(`\n✅ All migrations applied successfully\n`);
