/**
 * 数据库迁移管理模块
 *
 * 职责：
 * 1. 跟踪已执行的迁移，避免重复执行
 * 2. 提供按顺序执行迁移的能力
 * 3. 支持回滚迁移
 *
 * 迁移文件命名规则：0001_*.sql, 0002_*.sql, ...
 * 每个迁移文件应该包含：
 * - -- UP: 正向 SQL
 * - -- DOWN: 反向 SQL（可选，用于回滚）
 */

import { eq, sql } from "drizzle-orm";
import type { DbType } from "./client";
import { MIGRATION_FILES } from "./migration-files";

/** 迁移记录 */
export interface MigrationRecord {
  version: string;
  name: string;
  executedAt: string;
}

/** 迁移文件内容 */
export interface MigrationFile {
  version: string;
  name: string;
  up: string[];
  down?: string[];
}

/**
 * 从 SQL 文件中解析迁移内容
 * 格式：
 *   -- UP
 *   CREATE TABLE ...
 *   -- DOWN
 *   DROP TABLE ...
 */
export function parseMigrationFile(content: string): { up: string[]; down?: string[] } {
  const upMatch = content.match(/--\s*UP\s*\n([\s\S]*?)(?=--\s*DOWN|$)/);
  const downMatch = content.match(/--\s*DOWN\s*\n([\s\S]*)/);

  const parseStatements = (sqlText: string): string[] => {
    return sqlText
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

/**
 * 获取已执行的迁移列表
 */
export async function getExecutedMigrations(db: DbType): Promise<MigrationRecord[]> {
  try {
    const result = await db.run(sql`
      SELECT version, name, executed_at as "executedAt"
      FROM schema_migrations
      ORDER BY version ASC
    `);
    return (result.rows || []) as unknown as MigrationRecord[];
  } catch {
    // 表不存在时返回空数组
    return [];
  }
}

/**
 * 记录迁移执行
 */
export async function recordMigration(db: DbType, version: string, name: string): Promise<void> {
  try {
    await db.run(sql`
      INSERT INTO schema_migrations (version, name, executed_at)
      VALUES (${version}, ${name}, ${new Date().toISOString()})
      ON CONFLICT (version) DO NOTHING
    `);
  } catch (err) {
    console.warn(`[migrate] Failed to record migration ${version}: ${err}`);
  }
}

/**
 * 删除迁移记录（用于回滚）
 */
export async function deleteMigrationRecord(db: DbType, version: string): Promise<void> {
  try {
    await db.run(sql`
      DELETE FROM schema_migrations WHERE version = ${version}
    `);
  } catch (err) {
    console.warn(`[migrate] Failed to delete migration record ${version}: ${err}`);
  }
}

/**
 * 检查迁移是否已执行
 */
export async function isMigrationExecuted(db: DbType, version: string): Promise<boolean> {
  try {
    const result = await db.run(sql`
      SELECT 1 FROM schema_migrations WHERE version = ${version} LIMIT 1
    `);
    return (result.rows?.length || 0) > 0;
  } catch {
    return false;
  }
}

/**
 * 执行单个迁移文件
 */
export async function executeMigration(db: DbType, file: MigrationFile): Promise<void> {
  const executed = await isMigrationExecuted(db, file.version);
  if (executed) {
    console.log(`  [skip] ${file.version} ${file.name} (already applied)`);
    return;
  }

  console.log(`  [apply] ${file.version} ${file.name}`);

  // 执行 UP SQL
  for (const stmt of file.up) {
    try {
      await db.run(sql.raw(stmt));
    } catch (err) {
      if (isBenignMigrationError(err, file, stmt)) {
        console.warn(`  [skip] benign migration conflict in ${file.version}: ${errorMessage(err)}`);
        continue;
      }
      console.error(`  [error] Failed to execute statement in ${file.version}: ${stmt.slice(0, 100)}...`);
      throw err;
    }
  }

  // 记录迁移
  await recordMigration(db, file.version, file.name);
  console.log(`  [ok] ${file.version} ${file.name}`);
}

function errorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as Error & { cause?: unknown }).cause;
  return cause ? `${err.message} ${errorMessage(cause)}` : err.message;
}

function isBenignMigrationError(err: unknown, file: MigrationFile, stmt: string): boolean {
  const message = errorMessage(err).toLowerCase();
  const normalizedStmt = stmt.trim().toLowerCase();
  if (message.includes("duplicate column name") && normalizedStmt.startsWith("alter table")) {
    return true;
  }
  if (file.version === "0003" && message.includes("no such column") && normalizedStmt.startsWith("update ")) {
    return true;
  }
  return false;
}

/**
 * 回滚单个迁移
 */
export async function rollbackMigration(db: DbType, file: MigrationFile): Promise<void> {
  const executed = await isMigrationExecuted(db, file.version);
  if (!executed) {
    console.log(`  [skip] ${file.version} ${file.name} (not applied)`);
    return;
  }

  if (!file.down || file.down.length === 0) {
    throw new Error(`Migration ${file.version} ${file.name} has no DOWN script for rollback`);
  }

  console.log(`  [rollback] ${file.version} ${file.name}`);

  // 执行 DOWN SQL
  for (const stmt of file.down) {
    try {
      await db.run(sql.raw(stmt));
    } catch (err) {
      console.error(`  [error] Failed to execute rollback statement in ${file.version}: ${stmt.slice(0, 100)}...`);
      throw err;
    }
  }

  // 删除迁移记录
  await deleteMigrationRecord(db, file.version);
  console.log(`  [ok] Rolled back ${file.version} ${file.name}`);
}

/**
 * 解析所有迁移文件
 *
 * 加载顺序：
 * 1. 优先使用 import.meta.glob（Vite 开发环境）
 * 2. 回退到构建时生成的 MIGRATION_FILES（生产环境）
 */
export async function loadMigrations(): Promise<MigrationFile[]> {
  const files: MigrationFile[] = [];

  // 1. 优先尝试 import.meta.glob（Vite 环境）
  try {
    const migrationModules = (import.meta as any).glob?.("../../migrations/*.sql", { 
      as: "raw",
      eager: true,
    });

    if (migrationModules && Object.keys(migrationModules).length > 0) {
      const paths = Object.keys(migrationModules).sort();
      for (const path of paths) {
        const match = path.match(/\/(\d+)_/);
        if (!match) continue;

        const version = match[1];
        const name = path.split('/').pop()?.replace(/\.sql$/, '') || version;
        const content = migrationModules[path] as string;
        const { up, down } = parseMigrationFile(content);

        files.push({ version, name, up, down });
      }
      return files;
    }
  } catch {
    // import.meta.glob 不可用，回退到构建时生成的映射
  }

  // 2. 回退到构建时生成的 MIGRATION_FILES
  const entries = Object.entries(MIGRATION_FILES);
  if (entries.length > 0) {
    for (const [version, content] of entries) {
      const name = `migration_${version}`;
      const { up, down } = parseMigrationFile(content);
      files.push({ version, name, up, down });
    }
    return files;
  }

  // 3. 两者都不可用，返回空数组（记录警告）
  console.warn("[migrate] No migration files found. Run 'node scripts/generate-migration-files.mjs' to generate migration mapping.");
  return files;
}

/**
 * 执行所有待处理的迁移
 */
export async function runMigrations(db: DbType): Promise<void> {
  console.log("[migrate] Checking for pending migrations...");
  
  // 确保 schema_migrations 表存在
  try {
    await db.run(sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        executed_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  } catch (err) {
    console.warn("[migrate] schema_migrations table creation warning:", err);
  }

  const migrations = await loadMigrations();
  const executed = await getExecutedMigrations(db);
  const executedSet = new Set(executed.map(m => m.version));

  let appliedCount = 0;
  for (const file of migrations) {
    if (!executedSet.has(file.version)) {
      await executeMigration(db, file);
      appliedCount++;
    }
  }

  if (appliedCount > 0) {
    console.log(`[migrate] ${appliedCount} migration(s) applied successfully`);
  } else {
    console.log("[migrate] No pending migrations");
  }
}
