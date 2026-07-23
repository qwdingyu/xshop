/**
 * 库存服务 — 商品库存的统一读模型。
 *
 * 这里刻意不把 cards 表 JOIN 到商品列表查询里：
 * 1. 商品和卡密是一对多，JOIN 会放大分页 total；
 * 2. libSQL/SQLite 免费计划下，简单分步读比复杂聚合 JOIN 更容易稳定；
 * 3. 过期软锁只有在不再属于活跃订单时才视为可售，必须和下单锁卡逻辑保持一致；
 * 4. 卡密自身 expires_at 已过期时不可售，避免前端库存与真实锁卡结果不一致。
 */

import { and, count, eq, inArray, or, sql } from "drizzle-orm";
import type { DbType } from "../db/client";
import { cards, orders } from "../db/schema";

export async function getAvailableStockMap(
  db: DbType,
  productIds: string[],
): Promise<Map<string, number>> {
  const uniqueProductIds = Array.from(new Set(productIds.filter(Boolean)));
  if (uniqueProductIds.length === 0) return new Map();

  const rows = await db
    .select({
      productId: cards.productId,
      stock: count(),
    })
    .from(cards)
    .where(and(
      inArray(cards.productId, uniqueProductIds),
      or(sql`${cards.expiresAt} IS NULL`, sql`${cards.expiresAt} > replace(datetime('now'), ' ', 'T') || 'Z'`),
      or(
        eq(cards.status, "available"),
        and(
          eq(cards.status, "locked"),
          sql`${cards.lockExpiresAt} IS NOT NULL`,
          sql`${cards.lockExpiresAt} < replace(datetime('now'), ' ', 'T') || 'Z'`,
          sql`NOT EXISTS (
            SELECT 1 FROM ${orders}
            WHERE ${orders.id} = ${cards.lockedOrderId}
              AND ${orders.status} IN ('pending', 'paid', 'issued')
          )`,
        ),
      ),
    ))
    .groupBy(cards.productId);

  return new Map(rows.map((row) => [row.productId, Number(row.stock || 0)]));
}
