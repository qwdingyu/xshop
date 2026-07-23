/**
 * 数据库模块 — 纯 Turso/libsql 模式。
 *
 * 整个应用只使用 Drizzle ORM + libsql 驱动。
 * 所有数据库操作通过 Drizzle ORM 的 query builder 完成，
 * 仅在 ORM 不支持的场景（如 UPDATE...RETURNING 原子操作）才使用 db.run(sql)。
 *
 * 连接复用：
 * Cloudflare Workers 的 isolate 在多个请求间复用。
 * 缓存 client 实例避免每次请求重新 createClient（节省 ~1ms CPU）。
 * 当 TURSO_URL 变化时（极少见）重建实例。
 */

import { createClient } from "@libsql/client";
import type { Client } from "@libsql/client";
import { createDb, type DbType } from "./client";

// Re-export for convenience — 所有 service 只需 import { db } from "../db/database"
export { createDb, type DbType } from "./client";

// Isolate 级别缓存
let _cachedUrl: string | undefined;
let _cachedToken: string | undefined;
let _cachedClient: Client | undefined;
let _cachedDb: DbType | undefined;

/**
 * 初始化数据库：创建 libsql client + Drizzle ORM 实例。
 * 同一 isolate 内复用 client 实例，节省重复创建开销。
 */
export function initDatabase(env: { TURSO_URL?: string; TURSO_TOKEN?: string }) {
  const url = env.TURSO_URL;
  if (!url) throw new Error("TURSO_URL is required");

  // 复用：同 URL + 同 token 的情况下直接返回缓存实例
  const token = env.TURSO_TOKEN || "";
  if (_cachedClient && _cachedDb && _cachedUrl === url && _cachedToken === token) {
    return { client: _cachedClient, db: _cachedDb };
  }

  const client = createClient({ url, authToken: env.TURSO_TOKEN });
  const db = createDb(client);

  // 更新缓存
  _cachedUrl = url;
  _cachedToken = token;
  _cachedClient = client;
  _cachedDb = db;

  return { client, db };
}
