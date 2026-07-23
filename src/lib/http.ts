/**
 * HTTP 工具模块
 *
 * 6 个纯函数从 @usethink/cf-core 复用，仅保留项目专属的 getDb 适配器。
 * 使用 import + export（而非 export ... from）因为 requireAdmin 等本地函数
 * 需要在本文件内引用 fail。
 */

import type { Context } from "hono";
import type { AppEnv } from "../bindings";
import type { DbType } from "../db/client";

import {
  ok,
  fail,
  getOrigin,
  safeJsonBody,
  normalizeCode,
  maskContact,
} from "@usethink/cf-core";

export {
  ok,
  fail,
  getOrigin,
  safeJsonBody,
  normalizeCode,
  maskContact,
};

/**
 * 从 Hono Context 获取已初始化的 Drizzle ORM 实例。
 *
 * 中间件保证：非 /health 路由的 db 一定已初始化（非 undefined）。
 * 如果运行时 db 为 undefined（不应发生），抛出 500 错误，而不是让业务代码崩溃。
 *
 * 仅在非 health 路由中使用。health 路由直接用 c.get("db") 并自行处理 undefined。
 */
export function getDb(c: Context<AppEnv>): DbType {
  const db = c.get("db");
  if (!db) throw new Error("database not initialized");
  return db;
}
