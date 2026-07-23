import type { DbType } from "../db/client";
import { orderEvents, adminAuditLogs } from "../db/schema";

/**
 * 写入订单事件日志
 * @param db - Drizzle ORM 实例
 * @param orderId - 订单 ID
 * @param type - 事件类型（如 issued, expired, paid）
 * @param message - 事件描述
 * @param metadata - 附加元数据
 */
export async function writeOrderEvent(db: DbType, orderId: string, type: string, message = "", metadata: unknown = {}) {
  try {
    await db.insert(orderEvents).values({
      id: crypto.randomUUID(),
      orderId,
      type,
      message,
      metadataJson: JSON.stringify(metadata),
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    console.warn("[audit] failed to write order event:", error);
    return;
  }
}

/**
 * 写入管理员审计日志
 * @param db - Drizzle ORM 实例
 * @param input - 审计日志内容
 */
export async function writeAdminAudit(db: DbType, input: {
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: unknown;
  ipHash?: string;
}) {
  try {
    await db.insert(adminAuditLogs).values({
      id: crypto.randomUUID(),
      action: input.action,
      targetType: input.targetType || "",
      targetId: input.targetId || "",
      metadataJson: JSON.stringify(input.metadata || {}),
      ipHash: input.ipHash || "",
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    console.warn("[audit] failed to write admin audit:", error);
    return;
  }
}
