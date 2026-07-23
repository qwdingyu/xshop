import { and, count, desc, eq, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import type { DbType } from "../db/client";
import { isSqliteBusyError, withDbTransaction } from "../db/client";
import { balanceRechargeOrders, balanceTransactions, userBalances } from "../db/schema";

export type RechargeOrderInput = {
  id: string;
  orderNo: string;
  buyerEmail: string;
  amountCents: number;
  paymentProvider: string;
  orderTokenHash: string;
  createdAt: string;
  expiresAt: string;
};

export async function createRechargeOrder(db: DbType, input: RechargeOrderInput): Promise<void> {
  await db.insert(balanceRechargeOrders).values({
    ...input,
    buyerEmail: input.buyerEmail.trim().toLowerCase(),
    currency: "CNY",
    status: "pending",
    paymentRef: "",
  });
}

export async function getRechargeOrderByNo(db: DbType, orderNo: string) {
  const [order] = await db
    .select()
    .from(balanceRechargeOrders)
    .where(eq(balanceRechargeOrders.orderNo, orderNo))
    .limit(1);
  return order || null;
}

export async function getRechargeOrderById(db: DbType, id: string) {
  const [order] = await db
    .select()
    .from(balanceRechargeOrders)
    .where(eq(balanceRechargeOrders.id, id))
    .limit(1);
  return order || null;
}

export async function listRechargeOrders(
  db: DbType,
  filter: { email?: string; status?: string; limit?: number; offset?: number } = {},
) {
  const conditions: SQL<unknown>[] = [];
  if (filter.email) conditions.push(eq(balanceRechargeOrders.buyerEmail, filter.email.trim().toLowerCase()));
  if (filter.status) conditions.push(eq(balanceRechargeOrders.status, filter.status));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const limit = Math.min(Math.max(Number(filter.limit || 50), 1), 200);
  const offset = Math.max(Number(filter.offset || 0), 0);
  const [countRow] = await db.select({ count: count() }).from(balanceRechargeOrders).where(where);
  const items = await db
    .select({
      id: balanceRechargeOrders.id,
      orderNo: balanceRechargeOrders.orderNo,
      buyerEmail: balanceRechargeOrders.buyerEmail,
      amountCents: balanceRechargeOrders.amountCents,
      currency: balanceRechargeOrders.currency,
      status: balanceRechargeOrders.status,
      paymentProvider: balanceRechargeOrders.paymentProvider,
      paymentRef: balanceRechargeOrders.paymentRef,
      createdAt: balanceRechargeOrders.createdAt,
      paidAt: balanceRechargeOrders.paidAt,
      expiresAt: balanceRechargeOrders.expiresAt,
    })
    .from(balanceRechargeOrders)
    .where(where)
    .orderBy(desc(balanceRechargeOrders.createdAt), desc(balanceRechargeOrders.id))
    .limit(limit)
    .offset(offset);
  return { total: Number(countRow?.count || 0), items };
}

export async function markRechargeOrderFailed(db: DbType, id: string): Promise<void> {
  await db
    .update(balanceRechargeOrders)
    .set({ status: "failed" })
    .where(and(eq(balanceRechargeOrders.id, id), eq(balanceRechargeOrders.status, "pending")));
}

export async function expireRechargeOrder(db: DbType, id: string, now = new Date().toISOString()): Promise<boolean> {
  const rows = await db
    .update(balanceRechargeOrders)
    .set({ status: "expired" })
    .where(and(
      eq(balanceRechargeOrders.id, id),
      eq(balanceRechargeOrders.status, "pending"),
      sql`${balanceRechargeOrders.expiresAt} < ${now}`,
    ))
    .returning({ id: balanceRechargeOrders.id });
  return rows.length > 0;
}

export async function expirePendingRechargeOrders(db: DbType, now = new Date().toISOString()): Promise<number> {
  const rows = await db
    .update(balanceRechargeOrders)
    .set({ status: "expired" })
    .where(and(
      eq(balanceRechargeOrders.status, "pending"),
      lt(balanceRechargeOrders.expiresAt, now),
    ))
    .returning({ id: balanceRechargeOrders.id });
  return rows.length;
}

export type SettleRechargeResult =
  | { ok: true; alreadyPaid: boolean; balanceCents: number; amountCents: number; buyerEmail: string }
  | { ok: false; reason: "state_conflict" | "payment_conflict" | "not_found" };

async function readRechargeSettlementState(
  db: DbType,
  input: { id: string; paymentProvider: string; paymentRef: string },
): Promise<SettleRechargeResult> {
  const [current] = await db
    .select({
      status: balanceRechargeOrders.status,
      paymentProvider: balanceRechargeOrders.paymentProvider,
      paymentRef: balanceRechargeOrders.paymentRef,
      buyerEmail: balanceRechargeOrders.buyerEmail,
      amountCents: balanceRechargeOrders.amountCents,
    })
    .from(balanceRechargeOrders)
    .where(eq(balanceRechargeOrders.id, input.id))
    .limit(1);
  if (!current) return { ok: false, reason: "not_found" };
  if (current.status !== "paid") return { ok: false, reason: "state_conflict" };
  if (current.paymentProvider !== input.paymentProvider || current.paymentRef !== input.paymentRef) {
    return { ok: false, reason: "payment_conflict" };
  }
  const [balance] = await db
    .select({ balanceCents: userBalances.balanceCents })
    .from(userBalances)
    .where(eq(userBalances.email, current.buyerEmail))
    .limit(1);
  return {
    ok: true,
    alreadyPaid: true,
    balanceCents: Number(balance?.balanceCents || 0),
    amountCents: current.amountCents,
    buyerEmail: current.buyerEmail,
  };
}

export async function settleRechargeOrder(
  db: DbType,
  input: { id: string; paymentProvider: string; paymentRef: string; paidAt: string; allowExpired?: boolean },
): Promise<SettleRechargeResult> {
  return withDbTransaction(db, async (tx) => {
    // 第一步只允许可信渠道在 pending（或已验证可恢复的 expired）状态认领订单。
    // status + provider + payment_ref 共同构成 CAS，重复回调不能再次进入余额累加分支。
    const allowedStatuses = input.allowExpired ? ["pending", "expired"] : ["pending"];
    const [claimed] = await tx
      .update(balanceRechargeOrders)
      .set({
        status: "paid",
        paymentProvider: input.paymentProvider,
        paymentRef: input.paymentRef,
        paidAt: input.paidAt,
      })
      .where(and(
        eq(balanceRechargeOrders.id, input.id),
        inArray(balanceRechargeOrders.status, allowedStatuses),
        eq(balanceRechargeOrders.paymentProvider, input.paymentProvider),
        or(eq(balanceRechargeOrders.paymentRef, ""), eq(balanceRechargeOrders.paymentRef, input.paymentRef)),
      ))
      .returning({
        buyerEmail: balanceRechargeOrders.buyerEmail,
        amountCents: balanceRechargeOrders.amountCents,
      });

    if (!claimed) {
      // CAS 未命中后重新读取当前状态：同一流水的 paid 是幂等成功；
      // 其他状态或不同流水必须显式返回冲突，不能把重复通知误当成新充值。
      return readRechargeSettlementState(tx, input);
    }

    const [balance] = await tx
      .insert(userBalances)
      .values({
        email: claimed.buyerEmail,
        balanceCents: claimed.amountCents,
        totalDepositedCents: claimed.amountCents,
        totalSpentCents: 0,
        updatedAt: input.paidAt,
      })
      .onConflictDoUpdate({
        target: userBalances.email,
        set: {
          balanceCents: sql`${userBalances.balanceCents} + ${claimed.amountCents}`,
          totalDepositedCents: sql`${userBalances.totalDepositedCents} + ${claimed.amountCents}`,
          updatedAt: input.paidAt,
        },
      })
      .returning({ balanceCents: userBalances.balanceCents });

    // 余额累加和资金流水与订单 paid 状态处于同一数据库事务。
    // 任一步失败都会整体回滚，禁止出现“余额已增加但无流水”或“订单已支付但余额未到账”。
    await tx.insert(balanceTransactions).values({
      id: crypto.randomUUID(),
      email: claimed.buyerEmail,
      type: "recharge",
      amountCents: claimed.amountCents,
      balanceAfterCents: balance.balanceCents,
      referenceType: "recharge_order",
      referenceId: input.id,
      note: "在线充值入账",
      createdAt: input.paidAt,
    });

    return {
      ok: true as const,
      alreadyPaid: false,
      balanceCents: balance.balanceCents,
      amountCents: claimed.amountCents,
      buyerEmail: claimed.buyerEmail,
    };
  }).catch(async (error) => {
    if (!isSqliteBusyError(error)) throw error;
    // 事务可能已在另一个连接提交而本连接只在提交阶段观察到 BUSY。
    // 读取 CAS 结果可把重复回调收敛为 alreadyPaid，而不是让支付平台收到 500 后重复通知。
    return readRechargeSettlementState(db, input);
  });
}
