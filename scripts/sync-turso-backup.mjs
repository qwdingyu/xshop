import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { createClient } from "@libsql/client";

/**
 * 将 Turso CLI 导出的 snapshot/WAL 同步到远端最新可见帧。
 *
 * `turso db export --with-metadata` 提供嵌入式副本所需的 `-wal` 与 `-info` 文件，
 * 但官方明确说明导出点可能落后于最新提交；必须再执行一次 SDK sync，之后才能
 * checkpoint 成可独立恢复的 SQLite 文件。
 */
const snapshotArg = process.argv[2]?.trim();
const syncUrl = process.env.TURSO_URL?.trim();
const authToken = process.env.TURSO_TOKEN?.trim();
const expectedUrl = process.env.TURSO_EXPECTED_URL?.trim();

if (!snapshotArg || !syncUrl || !authToken || !expectedUrl) {
  console.error("用法：TURSO_EXPECTED_URL=<platform-url> TURSO_URL=<libsql-url> TURSO_TOKEN=<db-token> node scripts/sync-turso-backup.mjs <snapshot.db>");
  process.exit(1);
}

function databaseHost(value) {
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    console.error(`无效的 Turso 数据库 URL：${value}`);
    process.exit(1);
  }
}

if (databaseHost(syncUrl) !== databaseHost(expectedUrl)) {
  console.error("TURSO_DB_NAME 与 TURSO_URL 指向不同数据库，拒绝生成名称和内容不一致的备份");
  process.exit(1);
}

const snapshotPath = resolve(snapshotArg);
await Promise.all([
  access(snapshotPath),
  access(`${snapshotPath}-wal`),
  access(`${snapshotPath}-info`),
]);

const client = createClient({
  url: `file:${snapshotPath}`,
  syncUrl,
  authToken,
});

try {
  const result = await client.sync();
  console.log(`[backup-sync] 已同步远端帧：${result?.frames_synced ?? 0}`);
} finally {
  client.close();
}
