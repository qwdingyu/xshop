/**
 * Apply SQL migrations to Turso/libSQL database.
 * Replaces the broken Turso CLI approach (CLI removed --auth-token flag).
 * Uses the libsql Node.js client directly.
 *
 * 功能：
 * 1. 按顺序执行迁移文件（0001_*.sql, 0002_*.sql, ...）
 * 2. 跟踪已执行的迁移，避免重复执行
 * 3. 支持回滚（-- DOWN）
 * 使用方式：
 *   npm run db:migrate              # 执行所有待处理的迁移
 *   npm run db:migrate -- --rollback # 回滚最后一个迁移
 *   npm run db:migrate -- --status   # 查看迁移状态
 */
import { createClient } from "@libsql/client";
import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, "..", "migrations");

const url = process.env.TURSO_URL;
const token = process.env.TURSO_TOKEN;

if (!url || !token) {
  console.error("[migrate] Missing TURSO_URL/TURSO_TOKEN, aborting migrations");
  console.error("[migrate] Set them in .dev.vars (local) or wrangler secret put (remote)");
  process.exit(1);
}

const client = createClient({ url, authToken: token });

// 解析命令行参数
const args = process.argv.slice(2);
const command = args[0]?.replace(/^--/, "");

// 迁移文件解析函数
function parseMigrationFile(content) {
  const upMatch = content.match(/--\s*UP\s*\n([\s\S]*?)(?=--\s*DOWN|$)/);
  const downMatch = content.match(/--\s*DOWN\s*\n([\s\S]*)/);

  const parseStatements = (sql) => {
    return sql
      .split(";")
      .map((s) => {
        let lines = s.trim().split("\n");
        while (lines.length > 0 && lines[0].trim().startsWith("--")) {
          lines.shift();
        }
        return lines.join("\n").trim();
      })
      .filter((s) => s.length > 0);
  };

  return {
    up: upMatch ? parseStatements(upMatch[1]) : parseStatements(content),
    down: downMatch ? parseStatements(downMatch[1]) : undefined,
  };
}

// 获取已执行的迁移
async function getExecutedMigrations() {
  await ensureMigrationTable();
  try {
    const result = await client.execute(`
      SELECT version FROM schema_migrations
      ORDER BY version ASC
    `);
    return new Set(result.rows.map((row) => row.version));
  } catch {
    return new Set();
  }
}

async function ensureMigrationTable() {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      executed_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

// 记录迁移执行
async function recordMigration(version, name) {
  await ensureMigrationTable();
  try {
    await client.execute({
      sql: `
        INSERT INTO schema_migrations (version, name, executed_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT (version) DO NOTHING
      `,
      args: [version, name],
    });
  } catch (err) {
    console.warn(`  [warn] Failed to record migration ${version}: ${err}`);
  }
}

// 删除迁移记录
async function deleteMigrationRecord(version) {
  await ensureMigrationTable();
  try {
    await client.execute({
      sql: "DELETE FROM schema_migrations WHERE version = ?",
      args: [version],
    });
  } catch (err) {
    console.warn(`  [warn] Failed to delete migration record ${version}: ${err}`);
  }
}

// 执行单个迁移文件
async function executeMigrationFile(file, executed) {
  const version = file.split('_')[0];
  if (executed.has(version)) {
    console.log(`  [skip] ${file} (already applied)`);
    return false;
  }

  console.log(`  [apply] ${file}`);
  const content = readFileSync(join(migrationsDir, file), "utf-8");
  const { up, down } = parseMigrationFile(content);

  // 执行 UP SQL
  for (const stmt of up) {
    let retries = 3;
    while (retries > 0) {
      try {
        await client.execute(stmt);
        break;
      } catch (err) {
        const msg = String(err.message || err);
        if (msg.includes("already exists") || msg.includes("duplicate column")) {
          console.log(`    (skipped — already exists)`);
          break;
        }
        if (
          msg.includes("502") ||
          msg.includes("503") ||
          msg.includes("504") ||
          msg.includes("SERVER_ERROR") ||
          msg.includes("fetch failed") ||
          msg.includes("ConnectTimeoutError") ||
          msg.includes("UND_ERR_CONNECT_TIMEOUT")
        ) {
          retries--;
          if (retries > 0) {
            const delay = (4 - retries) * 2 + 2;
            console.warn(`    ⚠️ Turso 临时错误 (${msg.slice(0, 60)}), ${delay}s 后重试 (剩余 ${retries} 次)...`);
            await new Promise((r) => setTimeout(r, delay * 1000));
            continue;
          }
        }
        console.error(`    ❌ Error: ${msg}`);
        console.error(`    SQL: ${stmt.slice(0, 200)}...`);
        throw err;
      }
    }
  }

  // 记录迁移
  const name = file.replace(/^\d+_/, '').replace(/\.sql$/, '');
  await recordMigration(version, name);
  console.log(`  [ok] ${file}`);
  return true;
}

// 回滚单个迁移文件
async function rollbackMigrationFile(file, executed) {
  const version = file.split('_')[0];
  if (!executed.has(version)) {
    console.log(`  [skip] ${file} (not applied)`);
    return false;
  }

  const content = readFileSync(join(migrationsDir, file), "utf-8");
  const { down } = parseMigrationFile(content);

  if (!down || down.length === 0) {
    console.log(`  [skip] ${file} (no DOWN script)`);
    return false;
  }

  console.log(`  [rollback] ${file}`);
  for (const stmt of down) {
    try {
      await client.execute(stmt);
    } catch (err) {
      console.error(`    ❌ Error: ${err.message || err}`);
      console.error(`    SQL: ${stmt.slice(0, 200)}...`);
      throw err;
    }
  }

  await deleteMigrationRecord(version);
  console.log(`  [ok] Rolled back ${file}`);
  return true;
}

// 主逻辑
async function main() {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    console.log("[migrate] No migration files found in migrations/");
    process.exit(0);
  }

  console.log(`[migrate] Found ${files.length} migration file(s) in ${String(url).replace(/\/\/.*@/, "//***@")}\n`);

  const executed = await getExecutedMigrations();

  if (command === "status") {
    console.log("Migration status:");
    for (const file of files) {
      const version = file.split('_')[0];
      const status = executed.has(version) ? "✓ applied" : "○ pending";
      console.log(`  ${status} ${file}`);
    }
    process.exit(0);
  }

  if (command === "rollback") {
    console.log("[migrate] Rolling back last migration...\n");
    // 找到最后一个已执行的迁移
    const appliedFiles = files.filter((f) => executed.has(f.split('_')[0]));
    if (appliedFiles.length === 0) {
      console.log("[migrate] No migrations to roll back");
      process.exit(0);
    }

    const lastFile = appliedFiles[appliedFiles.length - 1];
    await rollbackMigrationFile(lastFile, executed);
    console.log("\n[migrate] Rollback completed successfully");
    process.exit(0);
  }

  if (command === "reset") {
    console.log("[migrate] Resetting database...\n");
    // 按逆序回滚所有迁移
    const appliedFiles = files.filter((f) => executed.has(f.split('_')[0])).reverse();
    for (const file of appliedFiles) {
      await rollbackMigrationFile(file, executed);
    }
    // 清理 schema_migrations 表（兜底）
    try {
      await client.execute("DROP TABLE IF EXISTS schema_migrations");
    } catch {
      // ignore
    }
    executed.clear();
    console.log("\n[migrate] Reset completed, applying fresh migrations...\n");
    // 重新执行所有迁移
    let appliedCount = 0;
    for (const file of files) {
      const applied = await executeMigrationFile(file, executed);
      if (applied) appliedCount++;
    }
    console.log(`\n[migrate] ${appliedCount} migration(s) applied after reset`);
    process.exit(0);
  }

  // 默认：执行所有待处理的迁移
  console.log("[migrate] Applying pending migrations...\n");
  let appliedCount = 0;
  for (const file of files) {
    const applied = await executeMigrationFile(file, executed);
    if (applied) appliedCount++;
  }

  console.log(`\n[migrate] ${appliedCount} migration(s) applied successfully`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[migrate] Fatal error:", err);
  process.exit(1);
});
