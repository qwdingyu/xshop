/**
 * 幂等性模块 — 防止同一请求被重复处理。
 *
 * 使用 (key, action) 复合键作为幂等标识：
 * - key: 客户端提供的幂等键（如 Idempotency-Key 请求头）
 * - action: 操作类型（如 "create_order"）
 *
 * 流程（原子化，消除 TOCTOU 竞态）：
 * 1. 调用 checkIdempotency() — 原子 UPSERT，返回是否应继续执行业务逻辑
 * 2. 如果 shouldProceed === false 且 pending=true，提示稍后查询；如果 cachedResponse 存在，返回缓存响应
 * 3. 如果 shouldProceed === true，执行业务逻辑后调用 saveIdempotentResponse() 保存结果
 *
 * 原子性保证：INSERT ... ON CONFLICT DO NOTHING ... RETURNING 是 SQLite 原子操作，
 * 并发请求中只有第一个会获得 shouldProceed=true，其余不会重复执行业务逻辑。
 */

import type { DbType } from "../db/client";
import { idempotencyKeys } from "../db/schema";
import { eq, and, lt } from "drizzle-orm";

// pending 哨兵表示当前租约持有者尚未提交业务响应；它不是可返回给客户端的缓存内容。
const PENDING_SENTINEL = "__pending__";
// Worker 可能在预留后被中断。超过租约窗口允许同一请求摘要接管，但旧持有者会被 createdAt fencing 拒绝提交。
export const IDEMPOTENCY_PENDING_LEASE_MS = 2 * 60 * 1000;
// 只接受标准 UUID 或足够长的 URL 安全随机串，避免可猜测幂等键被用于读取其他请求的缓存结果。
export const STRONG_IDEMPOTENCY_KEY_PATTERN = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[A-Za-z0-9_-]{32,120})$/i;

export function isStrongIdempotencyKey(value: string): boolean {
  return STRONG_IDEMPOTENCY_KEY_PATTERN.test(value);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

export async function hashIdempotencyRequest(value: unknown): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * 原子检查幂等性。
 * 使用 INSERT ... ON CONFLICT DO NOTHING ... RETURNING 实现原子预留：
 * - 首次插入：response_json 设为 "__pending__"（非空哨兵），返回 shouldProceed=true
 * - 冲突时：不写入，随后读取已有响应或 pending 哨兵
 *
 * 关键设计：使用 INSERT ... ON CONFLICT DO NOTHING 区分首次插入与冲突——
 * 第一个请求插入 pending 哨兵并继续执行；并发冲突请求只读取现有记录，
 * 如果仍是 pending 则返回 pending=true，调用方应提示稍后重试而不是重复执行业务。
 *
 * @param db - Drizzle ORM 实例
 * @param key - 幂等键
 * @param action - 操作类型
 * @returns { shouldProceed, cachedResponse } — shouldProceed 为 true 时应执行业务逻辑；
 *        为 false 时 cachedResponse 包含之前缓存的响应
 */
export async function checkIdempotency(db: DbType, key: string, action: string, requestHash: string): Promise<{
  shouldProceed: boolean;
  cachedResponse: string | null;
  pending: boolean;
  requestMismatch: boolean;
  resourceId: string;
  leaseVersion: string;
}> {
  const now = new Date();
  const nowIso = now.toISOString();
  const [row] = await db
    .insert(idempotencyKeys)
    .values({
      key,
      action,
      resourceId: '',
      requestHash,
      responseJson: PENDING_SENTINEL,
      createdAt: nowIso,
    })
    .onConflictDoNothing({ target: [idempotencyKeys.key, idempotencyKeys.action] })
    .returning({ responseJson: idempotencyKeys.responseJson });

  if (row?.responseJson === PENDING_SENTINEL) {
    return {
      shouldProceed: true,
      cachedResponse: null,
      pending: false,
      requestMismatch: false,
      resourceId: "",
      leaseVersion: nowIso,
    };
  }

  // Worker 可能在预留后、保存或清理前终止。createdAt 同时充当 fencing 版本：
  // 接管者原子更新版本，后续保存/清理必须仍匹配自己取得的版本，旧请求因此无法覆盖新请求结果。
  const reclaimed = await db
    .update(idempotencyKeys)
    .set({ createdAt: nowIso })
    .where(and(
      eq(idempotencyKeys.key, key),
      eq(idempotencyKeys.action, action),
      eq(idempotencyKeys.requestHash, requestHash),
      eq(idempotencyKeys.resourceId, ""),
      eq(idempotencyKeys.responseJson, PENDING_SENTINEL),
      lt(idempotencyKeys.createdAt, new Date(now.getTime() - IDEMPOTENCY_PENDING_LEASE_MS).toISOString()),
    ));
  if (reclaimed.rowsAffected > 0) {
    return {
      shouldProceed: true,
      cachedResponse: null,
      pending: false,
      requestMismatch: false,
      resourceId: "",
      leaseVersion: nowIso,
    };
  }

  const [existing] = await db
    .select({
      requestHash: idempotencyKeys.requestHash,
      resourceId: idempotencyKeys.resourceId,
      responseJson: idempotencyKeys.responseJson,
    })
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.key, key), eq(idempotencyKeys.action, action)))
    .limit(1);

  if (!existing) {
    return {
      shouldProceed: false,
      cachedResponse: null,
      pending: true,
      requestMismatch: false,
      resourceId: "",
      leaseVersion: "",
    };
  }
  if (!existing.requestHash || existing.requestHash !== requestHash) {
    return {
      shouldProceed: false,
      cachedResponse: null,
      pending: false,
      requestMismatch: true,
      resourceId: existing.resourceId || "",
      leaseVersion: "",
    };
  }

  const pending = existing.responseJson === PENDING_SENTINEL;
  return {
    shouldProceed: false,
    cachedResponse: pending ? null : existing.responseJson,
    pending,
    requestMismatch: false,
    resourceId: existing.resourceId || "",
    leaseVersion: "",
  };
}

/**
 * 保存幂等响应（覆盖 pending 预留记录）。
 * 在 checkIdempotency 返回 shouldProceed=true 后调用。
 *
 * @param db - Drizzle ORM 实例
 * @param key - 幂等键
 * @param action - 操作类型
 * @param requestHash - 规范化业务请求摘要
 * @param leaseVersion - checkIdempotency 返回的租约版本，用于阻止旧请求提交
 * @param resourceId - 关联的资源 ID（如订单 ID）
 * @param response - 要缓存的响应对象
 */
export async function saveIdempotentResponse(
  db: DbType,
  key: string,
  action: string,
  requestHash: string,
  leaseVersion: string,
  resourceId: string,
  response: unknown,
) {
  const result = await db
    .update(idempotencyKeys)
    .set({
      responseJson: JSON.stringify(response),
      resourceId,
    })
    .where(and(
      eq(idempotencyKeys.key, key),
      eq(idempotencyKeys.action, action),
      eq(idempotencyKeys.requestHash, requestHash),
      eq(idempotencyKeys.createdAt, leaseVersion),
    ));
  if (result.rowsAffected !== 1) throw new Error("幂等响应保存失败：租约已失效或预留记录不匹配");
}

export async function clearPendingIdempotency(
  db: DbType,
  key: string,
  action: string,
  requestHash: string,
  leaseVersion: string,
) {
  await db
    .delete(idempotencyKeys)
    .where(and(
      eq(idempotencyKeys.key, key),
      eq(idempotencyKeys.action, action),
      eq(idempotencyKeys.requestHash, requestHash),
      eq(idempotencyKeys.createdAt, leaseVersion),
      eq(idempotencyKeys.responseJson, PENDING_SENTINEL),
    ));
}

/** 删除仍等于指定响应的幂等记录，避免覆盖并发写入的更新结果。 */
export async function clearCachedIdempotentResponse(
  db: DbType,
  key: string,
  action: string,
  requestHash: string,
  leaseVersion: string,
  expectedResponse: unknown,
) {
  await db
    .delete(idempotencyKeys)
    .where(and(
      eq(idempotencyKeys.key, key),
      eq(idempotencyKeys.action, action),
      eq(idempotencyKeys.requestHash, requestHash),
      eq(idempotencyKeys.createdAt, leaseVersion),
      eq(idempotencyKeys.responseJson, JSON.stringify(expectedResponse)),
    ));
}
