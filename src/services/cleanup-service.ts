/**
 * 过期订单懒加载清理服务
 *
 * 由 GitHub Actions 定时任务（每 2 小时）调用 /admin/cleanup 触发执行：
 * 1. 将超时未支付的 pending 订单标记为 expired
 * 2. 释放这些订单关联的 Soft Lock 卡密
 * 3. 兜底：释放 lock_expires_at 已过期且不再属于活跃订单的卡密
 *
 * 设计原则：
 * - 幂等：多次执行结果一致
 * - 安全：只处理 pending 状态订单，只释放过期 locked 卡密
 *
 * 使用 Drizzle ORM 进行所有数据库操作，不再依赖原始 SQL。
 */

import type { DbType } from "../db/client";
import type { Bindings } from "../bindings";
import { eq, and, lt, isNotNull, sql } from "drizzle-orm";
import {
  adminAuditLogs,
  cards,
  cardLogs,
  emailLogs,
  idempotencyKeys,
  orderEvents,
  orders,
  products,
  rateLimitWindows,
  requestLogs,
} from "../db/schema";
import { checkAndExpireOrder } from "./order-service";
import type { RuntimeConfig } from "../lib/runtime-config";
import { readOperationalRetentionPolicy, type OperationalRetentionPolicy } from "../lib/system-config-registry";
import { reconcileOnlineOrderPayment } from "./payment-reconciliation-service";
import { expirePendingRechargeOrders } from "./recharge-service";

export type OperationalDataTableCounts = {
  rateLimitWindows: number;
  idempotencyKeys: number;
  requestLogs: number;
  emailLogs: number;
  cardLogs: number;
  orderEvents: number;
  adminAuditLogs: number;
};

export type OperationalDataCleanupResult = {
  enabled: boolean;
  retentionDays: OperationalDataTableCounts;
  deleted: OperationalDataTableCounts;
};

/** 清理结果 */
export interface CleanupResult {
  /** 清理前通过上游查单找回的已支付订单数 */
  reconciledPayments: number;
  /** 标记为 expired 的订单数 */
  expiredOrders: number;
  /** 标记为 expired 的在线充值订单数 */
  expiredRechargeOrders: number;
  /** 释放的 locked 卡密数 */
  releasedCards: number;
  /** 标记为 disabled 的过期卡密数 */
  disabledExpiredCards: number;
  /** 运营数据保留策略及逐表删除数量 */
  operationalData: OperationalDataCleanupResult;
}

/**
 * 释放 lock_expires_at 已过期且没有活跃订单归属的 locked 卡密（兜底机制）。
 *
 * 正常情况下，cleanupExpiredOrders 在过期订单时会释放关联卡密。
 * 但存在卡密遗漏释放的场景（例如订单已被其他流程标记为 expired、
 * 或上一次定时任务执行时卡密释放失败）。
 * 此兜底步骤直接扫描 cards 表，确保不遗留僵尸 locked 卡密。
 */
async function releaseOrphanedLockedCards(db: DbType): Promise<number> {
  const now = new Date().toISOString();

  // 释放条件必须在 UPDATE 时重新校验，避免扫描后订单已付款仍被释放。
  const released = await db
    .update(cards)
    .set({
      status: "available",
      lockedOrderId: null,
      lockExpiresAt: null,
    })
    .where(and(
      eq(cards.status, "locked"),
      isNotNull(cards.lockExpiresAt),
      lt(cards.lockExpiresAt, now),
      sql`NOT EXISTS (
        SELECT 1 FROM ${orders}
        WHERE ${orders.id} = ${cards.lockedOrderId}
          AND ${orders.status} IN ('pending', 'paid', 'issued')
      )`,
    ))
    .returning({ id: cards.id });

  if (released.length === 0) return 0;

  for (const card of released) {
    await db.insert(cardLogs).values({
      id: crypto.randomUUID(),
      cardId: card.id,
      action: "released_orphaned",
      orderId: "",
      operator: "system",
      detail: "定时任务兜底释放过期 locked 卡密",
      createdAt: new Date().toISOString(),
    }).catch(() => {
      console.warn(`[card_logs] failed to write orphaned release log for card ${card.id}`);
    });
  }

  return released.length;
}

/**
 * 禁用所有已过期的可用卡密（防止过期资料继续流出）。
 *
 * 扫描 cards 表，将 expires_at < now 且 status = 'available' 的卡密
 * 标记为 disabled，并写入 disabled_reason = 'auto_expired'。
 * 已过期且已 issued/locked 的卡密不做处理（由其他流程回收）。
 */
async function disableExpiredCards(db: DbType): Promise<number> {
  const now = new Date().toISOString();

  const disabled = await db
    .update(cards)
    .set({
      status: "disabled",
      disabledReason: "auto_expired",
    })
    .where(and(
      eq(cards.status, "available"),
      isNotNull(cards.expiresAt),
      lt(cards.expiresAt, now),
    ))
    .returning({ id: cards.id, accountLabel: cards.accountLabel });

  if (disabled.length === 0) return 0;

  for (const card of disabled) {
    await db.insert(cardLogs).values({
      id: crypto.randomUUID(),
      cardId: card.id,
      action: "auto_expired",
      orderId: "",
      operator: "system",
      detail: `定时任务自动禁用过期卡密（账号: ${card.accountLabel}）`,
      createdAt: new Date().toISOString(),
    }).catch(() => {
      console.warn(`[card_logs] failed to write auto-expired log for card ${card.id}`);
    });
  }

  return disabled.length;
}

function retentionCutoff(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

const emptyOperationalCounts = (): OperationalDataTableCounts => ({
  rateLimitWindows: 0,
  idempotencyKeys: 0,
  requestLogs: 0,
  emailLogs: 0,
  cardLogs: 0,
  orderEvents: 0,
  adminAuditLogs: 0,
});

function retentionDays(policy: OperationalRetentionPolicy): OperationalDataTableCounts {
  return {
    rateLimitWindows: policy.rateLimitDays,
    idempotencyKeys: policy.idempotencyDays,
    requestLogs: policy.requestLogDays,
    emailLogs: policy.emailLogDays,
    cardLogs: policy.businessLogDays,
    orderEvents: policy.businessLogDays,
    adminAuditLogs: policy.adminAuditDays,
  };
}

async function rowsDeleted(operation: PromiseLike<unknown>): Promise<number> {
  const result = await operation as { rowsAffected?: unknown };
  const count = Number(result?.rowsAffected ?? 0);
  return Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
}

async function pruneOperationalData(db: DbType): Promise<OperationalDataCleanupResult> {
  const policy = await readOperationalRetentionPolicy(db);
  const result: OperationalDataCleanupResult = {
    enabled: policy.enabled,
    retentionDays: retentionDays(policy),
    deleted: emptyOperationalCounts(),
  };
  if (!policy.enabled) return result;

  const rateLimitCutoff = Math.floor((Date.now() - policy.rateLimitDays * 24 * 60 * 60 * 1000) / 1000);
  result.deleted.rateLimitWindows = await rowsDeleted(
    db.delete(rateLimitWindows).where(lt(rateLimitWindows.windowStart, rateLimitCutoff)),
  );
  result.deleted.idempotencyKeys = await rowsDeleted(
    db.delete(idempotencyKeys).where(lt(idempotencyKeys.createdAt, retentionCutoff(policy.idempotencyDays))),
  );
  result.deleted.requestLogs = await rowsDeleted(
    db.delete(requestLogs).where(lt(requestLogs.createdAt, retentionCutoff(policy.requestLogDays))),
  );
  result.deleted.emailLogs = await rowsDeleted(
    db.delete(emailLogs).where(lt(emailLogs.createdAt, retentionCutoff(policy.emailLogDays))),
  );
  result.deleted.cardLogs = await rowsDeleted(
    db.delete(cardLogs).where(lt(cardLogs.createdAt, retentionCutoff(policy.businessLogDays))),
  );
  result.deleted.orderEvents = await rowsDeleted(
    db.delete(orderEvents).where(lt(orderEvents.createdAt, retentionCutoff(policy.businessLogDays))),
  );
  result.deleted.adminAuditLogs = await rowsDeleted(
    db.delete(adminAuditLogs).where(lt(adminAuditLogs.createdAt, retentionCutoff(policy.adminAuditDays))),
  );
  return result;
}

/**
 * 清理过期订单：将 expires_at < now 且 status = 'pending' 的订单标记为 expired，
 * 同时释放关联的 Soft Lock 卡密，并发送过期邮件通知买家。
 * 最后执行兜底步骤：释放过期且已无活跃订单归属的 locked 卡密。
 *
 * @param env 环境变量（用于发送邮件通知），由 /admin/cleanup 端点传入
 */
export async function cleanupExpiredOrders(
  db: DbType,
  env?: RuntimeConfig,
  executionCtx?: ExecutionContext,
  paymentEnv?: Partial<Bindings>,
): Promise<CleanupResult> {
  const now = new Date().toISOString();

  // 1. 查找所有已过期但仍为 pending 的订单（含买家邮箱和商品名，用于发邮件）
  //    使用 LEFT JOIN 而非 INNER JOIN，确保 tg_custom 等无对应 products 记录的订单也能被清理
  const expired = await db
    .select({
      id: orders.id,
      status: orders.status,
      expiresAt: orders.expiresAt,
      orderNo: orders.orderNo,
      buyerEmail: orders.buyerEmail,
      amountCents: orders.amountCents,
      currency: orders.currency,
      paymentProvider: orders.paymentProvider,
      paymentRef: orders.paymentRef,
      createdAt: orders.createdAt,
      productTitle: products.title,
    })
    .from(orders)
    .leftJoin(products, eq(products.id, orders.productId))
    .where(and(
      eq(orders.status, "pending"),
      lt(orders.expiresAt, now),
      sql`${orders.expiresAt} != ''`
    ));

  let expiredOrders = 0;
  let releasedCards = 0;
  let reconciledPayments = 0;

  // 2. 逐条使用 checkAndExpireOrder 处理（复用发邮件逻辑，保证与 /pay/status 行为一致）
  for (const order of expired) {
    // 外部支付订单在过期释放库存前先查上游状态。若回调丢失但上游已收款，
    // reconcileOnlineOrderPayment 会先核验金额/币种/时间，再恢复为 paid 并尝试履约。
    const reconciliation = await reconcileOnlineOrderPayment(db, paymentEnv, order, env, executionCtx);
    if (reconciliation.reconciled) {
      reconciledPayments++;
      continue;
    }

    const result = await checkAndExpireOrder(
      db, order.id, order.expiresAt, order.status, env,
      { orderNo: order.orderNo || "", productTitle: order.productTitle || "", buyerEmail: order.buyerEmail || "" },
      executionCtx
    );
    if (result.expired) {
      expiredOrders++;
      releasedCards += result.releasedCards;
    }
  }

  // 3. 兜底：释放超时且已无活跃订单归属的僵尸 locked 卡密
  const orphanedReleased = await releaseOrphanedLockedCards(db);
  releasedCards += orphanedReleased;

  // 4. 禁用所有已过期的可用卡密（防止过期资料继续流出）
  const disabledExpiredCards = await disableExpiredCards(db);

  // 5. 充值没有库存可释放，到期后只做 pending -> expired 状态收敛。
  // 后续回调或用户回查仍可在证明到期前已付款后恢复入账。
  const expiredRechargeOrders = await expirePendingRechargeOrders(db, now);

  // 6. 正式调度入口负责数据保留；请求内的随机清理只能作为低成本兜底。
  const operationalData = await pruneOperationalData(db);

  return { reconciledPayments, expiredOrders, expiredRechargeOrders, releasedCards, disabledExpiredCards, operationalData };
}
