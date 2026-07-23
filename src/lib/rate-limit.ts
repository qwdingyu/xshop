/**
 * 限流模块 — 基于 IP + 操作类型的固定窗口限流。
 *
 * 原理：使用 rate_limit_windows 表，通过 onConflictDoUpdate().returning() 原子 upsert
 * 实现"计数+1"操作。一次数据库操作完成检查与计数，消除竞态条件。
 *
 * 注意：使用 IP 哈希（非明文 IP）保护隐私，哈希加盐防止反向查找。
 */

import type { Context } from "hono";
import type { AppEnv } from "../bindings";
import { getIpHash, sha256 } from "./security";
import { rateLimitWindows, requestLogs } from "../db/schema";
import { sql } from "drizzle-orm";
import { getDb } from "./http";

type RunResult = {
  rows?: Array<Record<string, unknown>>;
  rowsAffected?: unknown;
  changes?: unknown;
  meta?: { changes?: unknown };
};

function affectedRows(result: unknown): number {
  const value = (result as RunResult | undefined)?.rowsAffected
    ?? (result as RunResult | undefined)?.changes
    ?? (result as RunResult | undefined)?.meta?.changes
    ?? 0;
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
}

function firstRow(result: unknown): Record<string, unknown> | undefined {
  return (result as RunResult | undefined)?.rows?.[0];
}

/**
 * 检查并执行限流。
 *
 * 使用原子 upsert（INSERT ... ON CONFLICT DO UPDATE）实现：
 * 1. 计算当前 60 秒窗口的起始时间戳
 * 2. 尝试插入 (action, ipHash, windowStart) → requestCount=1
 * 3. 如果已存在，原子递增 requestCount + 1
 * 4. returning 获取最新计数，判断是否超限
 *
 * 相比旧版"SELECT COUNT + INSERT"两步模式，消除了并发竞态条件。
 *
 * @param c - Hono 上下文
 * @param action - 操作标识（如 "create_order"、"pay_callback"），不同操作独立计数
 * @param limit - 每分钟最大请求数，默认 8
 * @returns 通过时返回 { ok: true, ipHash }，被限流时返回 { ok: false, status: 429, message }
 */
export async function enforceRateLimit(c: Context<AppEnv>, action: string, limit = 8) {
  const ipHash = await getIpHash(c);
  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / 60) * 60;
  const db = getDb(c);

  // 原子 upsert：INSERT or UPDATE + RETURNING，一次数据库操作完成计数
  const qb = db
    .insert(rateLimitWindows)
    .values({
      action,
      ipHash,
      windowStart,
      requestCount: 1,
    })
    .onConflictDoUpdate({
      target: [rateLimitWindows.action, rateLimitWindows.ipHash, rateLimitWindows.windowStart],
      set: {
        requestCount: sql`${rateLimitWindows.requestCount} + 1`,
      },
    });

  const results = await ((qb.returning as any)({ count: rateLimitWindows.requestCount })) as { count: number }[] | undefined;

  const row = results?.[0];

  const currentCount = row?.count ?? 1;

  if (currentCount > limit) {
    await writeRequestLog(c, action, 429, ipHash);
    return { ok: false, status: 429, message: "请求过于频繁，请稍后再试" };
  }

  return { ok: true, ipHash };
}

export type CooldownReservation = {
  ok: true;
  subjectHash: string;
  windowStart: number;
} | {
  ok: false;
  status: 429;
  message: string;
  retryAfterSeconds: number;
  subjectHash: string;
};

/**
 * 按业务主体执行精确冷却限制。
 *
 * 和 enforceRateLimit 的 IP 固定窗口不同，本函数用于“同一邮箱 60 秒内只能发送一次验证码”：
 * - subject 会先带盐哈希，rate_limit_windows 不保存邮箱明文；
 * - 插入语句通过 NOT EXISTS 在数据库侧完成“检查 + 占位”，避免并发重复发送；
 * - window_start 记录本次占位秒级时间戳，便于精确计算剩余等待秒数。
 */
export async function reserveCooldown(
  c: Context<AppEnv>,
  action: string,
  subject: string,
  cooldownSeconds: number,
): Promise<CooldownReservation> {
  const db = getDb(c);
  const normalizedSubject = subject.trim().toLowerCase();
  const subjectHash = await sha256(`rate-limit:${action}:${c.env?.RATE_LIMIT_SALT || ""}:${normalizedSubject}`);
  const windowStart = Math.floor(Date.now() / 1000);
  const cutoff = windowStart - Math.max(1, Math.ceil(cooldownSeconds));

  const inserted = await db.run(sql`
    INSERT INTO rate_limit_windows (action, ip_hash, window_start, request_count)
    SELECT ${action}, ${subjectHash}, ${windowStart}, 1
    WHERE NOT EXISTS (
      SELECT 1
      FROM rate_limit_windows
      WHERE action = ${action}
        AND ip_hash = ${subjectHash}
        AND window_start > ${cutoff}
    )
    ON CONFLICT(action, ip_hash, window_start) DO NOTHING
  `);

  if (affectedRows(inserted) > 0) {
    return { ok: true, subjectHash, windowStart };
  }

  const latest = await db.run(sql`
    SELECT MAX(window_start) AS windowStart
    FROM rate_limit_windows
    WHERE action = ${action}
      AND ip_hash = ${subjectHash}
      AND window_start > ${cutoff}
  `);
  const latestWindowStart = Number(firstRow(latest)?.windowStart ?? windowStart);
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil(cooldownSeconds) - Math.max(0, windowStart - latestWindowStart),
  );

  return {
    ok: false,
    status: 429,
    message: `验证码发送过于频繁，请 ${retryAfterSeconds} 秒后再试`,
    retryAfterSeconds,
    subjectHash,
  };
}

/**
 * 释放刚刚占用的冷却窗口。
 *
 * 邮件供应商返回失败时调用；只删除本次 windowStart 对应的占位行，避免误删其它并发请求
 * 或更早的真实发送记录。
 */
export async function releaseCooldown(
  c: Context<AppEnv>,
  action: string,
  reservation: Extract<CooldownReservation, { ok: true }>,
) {
  const db = getDb(c);
  await db.run(sql`
    DELETE FROM rate_limit_windows
    WHERE action = ${action}
      AND ip_hash = ${reservation.subjectHash}
      AND window_start = ${reservation.windowStart}
  `);
}

/**
 * 写入请求日志到 request_logs 表。
 * 每次请求（包括被限流的请求）都应调用此函数记录，供审计使用。
 *
 * @param c - Hono 上下文
 * @param action - 操作标识
 * @param statusCode - HTTP 状态码
 * @param ipHash - 可选的 IP 哈希，不传则自动计算
 */
export async function writeRequestLog(c: Context<AppEnv>, action: string, statusCode: number, ipHash?: string) {
  const hash = ipHash || await getIpHash(c);
  const db = getDb(c);

  await db.insert(requestLogs).values({
    id: crypto.randomUUID(),
    ipHash: hash,
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    action,
    statusCode,
    createdAt: new Date().toISOString(),
  });
}
