/**
 * 发卡服务 — 卡密的状态变更（领取、锁定、释放）。
 *
 * 卡密状态流转：
 *   available → locked（软锁定，等待支付）
 *   available → issued（直接发卡）
 *   locked → issued（支付成功后发卡）
 *   locked → available（超时/取消后释放）
 *   issued → available（并发回滚时释放）
 *
 * 关键设计：
 * - 使用 UPDATE ... RETURNING 实现原子领取，避免 TOCTOU 竞争
 * - 所有外部输入通过 sql template literal 参数化传入，禁止字符串拼接
 * - 每次状态变更写入 card_logs 审计日志
 */

import type { DbType } from "../db/client";
import { eq, and, sql } from "drizzle-orm";
import { cards, cardLogs, orders } from "../db/schema";

/** 已发卡的卡密信息（返回给订单/用户） */
export type IssuedCard = {
  id: string;
  accountLabel: string;
  deliverySecret: string;
  deliveryNote: string;
  buyerEmail?: string;
  buyerContact?: string;
};

// ── card_logs 审计辅助 ──

/**
 * 写入卡密审计日志。失败时仅记录警告，不阻塞主流程。
 * 使用 Drizzle ORM 插入，类型安全。
 */
async function writeCardLog(db: DbType, cardId: string, action: string, orderId: string | null, detail: string) {
  await db.insert(cardLogs).values({
    id: crypto.randomUUID(),
    cardId,
    action,
    orderId: orderId || "",
    operator: "system",
    detail,
    createdAt: new Date().toISOString(),
  }).catch(() => {
    // card_logs 写入失败不应阻塞主流程，仅记录警告
    console.warn(`[card_logs] failed to write log: action=${action} cardId=${cardId}`);
  });
}

/**
 * 原子领取一张可用卡密（或该订单已锁定的卡密）。
 *
 * 使用 UPDATE ... RETURNING 保证原子性：在单条 SQL 中完成"查找 + 变更状态"，
 * 避免先 SELECT 再 UPDATE 的 TOCTOU 竞争。
 *
 * 优先级：如果该订单之前已通过 lockCardForOrder() 软锁定了一张卡密，
 * 则优先分配那张卡密；否则从该商品的可用卡密中按创建时间最早分配。
 */
export async function issueAvailableCard(db: DbType, orderId: string, productId: string, buyerEmail?: string, buyerContact?: string) {
  // 原子领取必须保留 raw SQL：这里依赖 UPDATE ... RETURNING 原子领取一条库存。
  // 这类库存一致性语句比 ORM 的"先查再改"更安全；所有外部输入通过 sql template 传入，禁止字符串拼接。
  const nowStr = new Date().toISOString();
  const result = await db.run(sql`
    UPDATE cards
    SET
      status = 'issued',
      issued_order_id = ${orderId},
      locked_order_id = NULL,
      lock_expires_at = NULL,
      issued_at = ${nowStr},
      buyer_email = ${buyerEmail || ""},
      buyer_contact = ${buyerContact || ""}
    WHERE id = (
      SELECT id
      FROM cards
      WHERE
        (locked_order_id = ${orderId} AND status = 'locked' AND (expires_at IS NULL OR expires_at > ${nowStr}))
        OR
        (product_id = ${productId} AND status = 'available' AND (expires_at IS NULL OR expires_at > ${nowStr}) AND NOT EXISTS (
          SELECT 1 FROM cards WHERE locked_order_id = ${orderId} AND status = 'locked'
        ))
      ORDER BY (CASE WHEN locked_order_id = ${orderId} THEN 0 ELSE 1 END) ASC, created_at ASC, id ASC
      LIMIT 1
    )
    RETURNING id, account_label AS accountLabel, delivery_secret AS deliverySecret, delivery_note AS deliveryNote, buyer_email AS buyerEmail, buyer_contact AS buyerContact
  `);

  const row = result.rows[0] as unknown as IssuedCard & { buyerEmail?: string; buyerContact?: string } | undefined;
  if (row) {
    await writeCardLog(db, row.id, "issued", orderId, `订单 ${orderId} 发卡，商品 ${productId}，买家 ${buyerEmail || ""}`);
  }
  return row;
}

/**
 * 软锁定一张可用卡密（用于 manual 手动支付模式）。
 *
 * 下单时锁定一张卡密，等待用户在 lockExpiresAt 之前完成支付。
 * 超时未支付则由 cleanup-service 释放。
 *
 * 使用 UPDATE ... RETURNING 原子锁定，防止并发下单重复分配同一张卡密。
 *
 * 锁卡前会兜底释放“已超时且不再属于活跃订单”的卡密，
 * 再原子锁定一张 available 卡密。pending/paid/issued 订单始终保留所属锁。
 */
export async function lockCardForOrder(db: DbType, orderId: string, productId: string, lockExpiresAt: string) {
  // 先释放该商品下不再属于活跃订单的过期锁（兜底，防止僵尸 locked 卡密）
  // 注意：使用 SQLite 的 datetime('now') 函数来比较时间，因为 lock_expires_at 存储的是 ISO 格式（含T和Z），
  // 但 datetime('now') 返回的是 SQLite 格式（空格分隔、无Z），直接字符串比较会因 'T' > ' ' 导致永远判定为未过期。
  await db.run(sql`
    UPDATE cards
    SET status = 'available', locked_order_id = NULL, lock_expires_at = NULL
    WHERE product_id = ${productId}
      AND status = 'locked'
      AND (expires_at IS NULL OR expires_at > replace(datetime('now'), ' ', 'T') || 'Z')
      AND lock_expires_at IS NOT NULL
      AND lock_expires_at < replace(datetime('now'), ' ', 'T') || 'Z'
      AND NOT EXISTS (
        SELECT 1 FROM ${orders}
        WHERE ${orders.id} = ${cards.lockedOrderId}
          AND ${orders.status} IN ('pending', 'paid', 'issued')
      )
  `);

  const result = await db.run(sql`
    UPDATE cards
    SET
      status = 'locked',
      locked_order_id = ${orderId},
      lock_expires_at = ${lockExpiresAt}
    WHERE id = (
      SELECT id
      FROM cards
      WHERE product_id = ${productId}
        AND status = 'available'
        AND (expires_at IS NULL OR expires_at > replace(datetime('now'), ' ', 'T') || 'Z')
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    )
    RETURNING id
  `);

  const row = result.rows[0] as unknown as { id: string } | undefined;
  if (row) {
    await writeCardLog(db, row.id, "locked", orderId, `订单 ${orderId} 软锁定，商品 ${productId}，过期 ${lockExpiresAt}`);
  }
  return row;
}

/**
 * 释放指定订单关联的所有非 issued 卡密（locked → available）。
 * 用于订单过期清理或取消订单场景。
 *
 * 注意：同时处理 locked 和 issued 状态的卡密。
 * issued 状态出现在 markPaidAndIssue 的补偿回滚场景——
 * 发卡成功后订单更新失败，卡密已是 "issued" 但订单回滚为 "pending"。
 * 订单过期时必须回收这类卡密，否则库存永久泄漏。
 */
export async function releaseLockedCardByOrder(db: DbType, orderId: string): Promise<number> {
  // 先查询被锁定或已发卡（补偿回滚）的卡密 ID，用于审计日志
  // locked 卡密：lockedOrderId 有值，issuedOrderId 为 NULL
  // issued 卡密（补偿回滚）：issuedOrderId 有值
  const lockedCards = await db
    .select({ id: cards.id, status: cards.status })
    .from(cards)
    .where(and(eq(cards.lockedOrderId, orderId), eq(cards.status, "locked")));

  const issuedCards = await db
    .select({ id: cards.id, status: cards.status })
    .from(cards)
    .where(and(eq(cards.issuedOrderId, orderId), eq(cards.status, "issued")));

  const affectedCards = [...lockedCards, ...issuedCards];

  // 批量更新：释放 locked 卡密
  await db
    .update(cards)
    .set({
      status: "available",
      lockedOrderId: null,
      lockExpiresAt: null,
    })
    .where(and(eq(cards.lockedOrderId, orderId), eq(cards.status, "locked")));

  // 批量更新：释放补偿回滚遗留的 issued 卡密（issuedOrderId 匹配该订单）
  await db
    .update(cards)
    .set({
      status: "available",
      issuedOrderId: null,
      issuedAt: null,
    })
    .where(and(eq(cards.issuedOrderId, orderId), eq(cards.status, "issued")));

  for (const row of affectedCards) {
    await writeCardLog(db, row.id, "released_lock", orderId, `订单 ${orderId} 释放卡密（原状态: ${row.status}）`);
  }

  return affectedCards.length;
}

/**
 * 释放已发卡的卡密（issued → available）。
 * 仅在并发回滚场景使用（markPaidAndIssue 发现订单已被其他请求处理）。
 */
export async function releaseIssuedCard(db: DbType, cardId: string, orderId: string) {
  await db
    .update(cards)
    .set({
      status: "available",
      issuedOrderId: null,
      issuedAt: null,
    })
    .where(and(eq(cards.id, cardId), eq(cards.issuedOrderId, orderId)));

  await writeCardLog(db, cardId, "released_issued", orderId, `订单 ${orderId} 释放已发卡密（并发回滚）`);
}

/**
 * 回滚已发卡的卡密（issued → available），不要求 issuedOrderId 匹配。
 * 用于 redeem 路由等无订单 ID 时发卡后需要回滚的场景。
 */
export async function rollbackIssuedCard(db: DbType, cardId: string) {
  await db
    .update(cards)
    .set({
      status: "available",
      issuedOrderId: null,
      issuedAt: null,
    })
    .where(and(eq(cards.id, cardId), eq(cards.status, "issued")));

  await writeCardLog(db, cardId, "rollback_issued", null, `回滚已发卡密（redeem 失败补偿）`);
}
