/**
 * 充值码服务 — 预付费凭证的创建、兑付与余额管理。
 *
 * 充值码业务流程：
 * 1. 管理员生成批量充值码（voucher_codes），在第三方收款后交付给买家
 * 2. 买家在站点兑换充值码（兑换后余额存入 user_balances）
 * 3. 买家选购商品时，使用余额支付（绕过外部支付渠道）
 * 4. 余额支付成功后直接走 markPaidAndIssue 发卡
 *
 * 充值码 vs 优惠码（coupons）：
 * - 充值码：预付费凭证，先付款后兑换，存入余额再消费
 * - 优惠码：折扣凭证，下单时直接减免金额
 *
 * 关键设计：
 * - 兑付使用条件 UPDATE（WHERE status='active'），天然防并发重复兑付
 * - 余额增减使用 UPDATE ... WHERE balance_cents >= amount，原子扣减
 * - 所有金额以「分」(cents) 为单位，避免浮点精度问题
 */

import { eq, and, lt, sql, desc, count, inArray, type SQL } from "drizzle-orm";
import { isSqliteBusyError, withDbTransaction, type DbType } from "../db/client";
import { voucherCodes, userBalances, balanceTransactions } from "../db/schema";
import { formatMoney } from "../../shared/money";

// ── 兑换结果类型 ──

export type RedeemResult = {
  success: boolean;
  amountCents: number;
  message: string;
};

export type BalanceResult = {
  email: string;
  balanceCents: number;
  totalDepositedCents: number;
  totalSpentCents: number;
};

export type BalanceTransactionFilter = {
  email?: string;
  type?: BalanceTxType | "";
  referenceType?: string;
  referenceId?: string;
  limit?: number;
  offset?: number;
};

export type BalanceTransactionList = {
  total: number;
  transactions: Array<{
    id: string;
    email: string;
    type: string;
    amountCents: number;
    balanceAfterCents: number;
    referenceType: string;
    referenceId: string;
    note: string;
    createdAt: string;
  }>;
};

export type UserBalanceFilter = {
  /** 邮箱精确匹配或子串（不区分大小写，按小写规范化后 LIKE） */
  email?: string;
  /** 仅返回余额大于 0 的账户 */
  positiveOnly?: boolean;
  limit?: number;
  offset?: number;
};

export type UserBalanceList = {
  total: number;
  items: Array<{
    email: string;
    balanceCents: number;
    totalDepositedCents: number;
    totalSpentCents: number;
    updatedAt: string;
  }>;
};

export type AdjustUserBalanceResult = {
  email: string;
  balanceCents: number;
  amountCents: number;
};

type BalanceTxType = "voucher_redeem" | "recharge" | "order_spend" | "refund" | "adjustment";

type BalanceTxOptions = {
  referenceType?: string;
  referenceId?: string;
  note?: string;
};

type VoucherDb = Pick<DbType, "select" | "insert" | "update">;

// ── 通用常量 ──

/** 充值码业务前缀；分隔符在生成时统一拼接，避免常量和展示格式两套口径漂移。 */
export const VOUCHER_CODE_PREFIX = "VCH";

/** 充值码字符集（排除易混淆字符 O/0/I/1） */
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** 充值码主体长度：8 位在当前字符集下约 1.1e12 种组合，足够个人站长批量发售使用。 */
const VOUCHER_CODE_BODY_LENGTH = 8;

/** 候选码查库撞码最多补齐轮数；超过说明随机源或数据库状态异常，直接失败让管理员重试。 */
const VOUCHER_CODE_DB_COLLISION_ROUNDS = 20;

/** 查询后插入前仍可能被并发写入抢占主键；这种竞态最多重生成 3 轮。 */
const VOUCHER_CODE_INSERT_CONFLICT_RETRIES = 3;

async function writeBalanceTransaction(
  db: VoucherDb,
  email: string,
  type: BalanceTxType,
  amountCents: number,
  balanceAfterCents: number,
  options: BalanceTxOptions = {},
) {
  await db.insert(balanceTransactions).values({
    id: crypto.randomUUID(),
    email: email.trim().toLowerCase(),
    type,
    amountCents,
    balanceAfterCents,
    referenceType: options.referenceType || "",
    referenceId: options.referenceId || "",
    note: options.note || "",
    createdAt: new Date().toISOString(),
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// 充值码查询
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 查询单条充值码（按 code 精确匹配）。
 * 注意：code 字段使用大写存储，查询时自动转大写。
 */
export async function getVoucher(db: DbType, code: string) {
  const [v] = await db
    .select()
    .from(voucherCodes)
    .where(eq(voucherCodes.code, code.toUpperCase()))
    .limit(1);
  return v || null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 充值码兑付（原子操作）
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 原子兑付充值码。
 *
 * 使用条件 UPDATE（WHERE status='active'）保证：同一充值码只能被兑付一次，
 * 并发请求下仅一个成功。之后将余额存入或追加到 user_balances 表。
 *
 * @param db   - Drizzle ORM 实例
 * @param code - 充值码（大小写不敏感，自动转大写）
 * @param email - 兑付人邮箱
 * @returns { success, amountCents, message }
 */
export async function redeemVoucher(db: DbType, code: string, email: string): Promise<RedeemResult> {
  const normalizedCode = code.toUpperCase().trim();
  const normalizedEmail = email.trim().toLowerCase();

  // 查充值码有效性
  const [v] = await db
    .select({
      code: voucherCodes.code,
      amountCents: voucherCodes.amountCents,
      status: voucherCodes.status,
      expiresAt: voucherCodes.expiresAt,
    })
    .from(voucherCodes)
    .where(eq(voucherCodes.code, normalizedCode))
    .limit(1);

  if (!v) {
    return { success: false, amountCents: 0, message: "充值码不存在" };
  }
  if (v.status !== "active") {
    return { success: false, amountCents: 0, message: "充值码已使用或已失效" };
  }
  if (v.expiresAt && new Date(v.expiresAt).getTime() < Date.now()) {
    await db
      .update(voucherCodes)
      .set({ status: "expired" })
      .where(and(
        eq(voucherCodes.code, normalizedCode),
        eq(voucherCodes.status, "active"),
      ));
    return { success: false, amountCents: 0, message: "充值码已过期" };
  }

  let amountCents: number;
  try {
    amountCents = await withDbTransaction(db, async (tx) => {
      // 原子兑付：条件 UPDATE，只在 status='active' 时执行。与余额入账、流水写入放在同一事务内，
      // 避免“充值码已 used 但余额未增加”的权益损失。
      const nowStr = new Date().toISOString();
      const updated = await tx
        .update(voucherCodes)
        .set({
          status: "used",
          usedByEmail: normalizedEmail,
          usedAt: nowStr,
        })
        .where(and(
          eq(voucherCodes.code, normalizedCode),
          eq(voucherCodes.status, "active"),
        ))
        .returning({ amountCents: voucherCodes.amountCents });

      if (updated.length === 0) {
        throw new Error("充值码已被他人使用");
      }

      const redeemedCents = updated[0].amountCents;
      if (redeemedCents <= 0) {
        throw new Error("充值码金额无效");
      }

      const [balanceRow] = await tx
        .insert(userBalances)
        .values({
          email: normalizedEmail,
          balanceCents: redeemedCents,
          totalDepositedCents: redeemedCents,
          totalSpentCents: 0,
          updatedAt: nowStr,
        })
        .onConflictDoUpdate({
          target: userBalances.email,
          set: {
            balanceCents: sql`${userBalances.balanceCents} + ${redeemedCents}`,
            totalDepositedCents: sql`${userBalances.totalDepositedCents} + ${redeemedCents}`,
            updatedAt: nowStr,
          },
        })
        .returning({ balanceCents: userBalances.balanceCents });

      await writeBalanceTransaction(tx, normalizedEmail, "voucher_redeem", redeemedCents, balanceRow.balanceCents, {
        referenceType: "voucher",
        referenceId: normalizedCode,
        note: "充值码兑换入账",
      });

      return redeemedCents;
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "充值码兑换失败";
    return { success: false, amountCents: 0, message };
  }

  return { success: true, amountCents, message: `充值成功，已存入 ${formatMoney(amountCents, "CNY")}` };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 用户余额查询 & 管理
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 查询用户余额。
 * 无记录时返回默认零值结构，确保前端始终能拿到 { email, balanceCents, ... }。
 */
export async function getUserBalance(db: DbType, email: string): Promise<BalanceResult> {
  const [b] = await db
    .select()
    .from(userBalances)
    .where(eq(userBalances.email, email.trim().toLowerCase()))
    .limit(1);

  if (!b) {
    return { email: email.trim().toLowerCase(), balanceCents: 0, totalDepositedCents: 0, totalSpentCents: 0 };
  }
  return b;
}

/**
 * 管理端查询余额流水。
 * 支持按邮箱、流水类型、业务来源筛选，给个人站长处理客诉、核账和退款复盘使用。
 */
export async function listBalanceTransactions(
  db: DbType,
  filter: BalanceTransactionFilter = {},
): Promise<BalanceTransactionList> {
  const limit = Math.min(Math.max(Number(filter.limit || 50), 1), 200);
  const offset = Math.max(Number(filter.offset || 0), 0);
  const conditions: SQL<unknown>[] = [];

  if (filter.email) conditions.push(eq(balanceTransactions.email, filter.email.trim().toLowerCase()));
  if (filter.type) conditions.push(eq(balanceTransactions.type, filter.type));
  if (filter.referenceType) conditions.push(eq(balanceTransactions.referenceType, filter.referenceType.trim()));
  if (filter.referenceId) conditions.push(eq(balanceTransactions.referenceId, filter.referenceId.trim()));

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const [countRow] = await db
    .select({ count: count() })
    .from(balanceTransactions)
    .where(where);

  const rows = await db
    .select({
      id: balanceTransactions.id,
      email: balanceTransactions.email,
      type: balanceTransactions.type,
      amountCents: balanceTransactions.amountCents,
      balanceAfterCents: balanceTransactions.balanceAfterCents,
      referenceType: balanceTransactions.referenceType,
      referenceId: balanceTransactions.referenceId,
      note: balanceTransactions.note,
      createdAt: balanceTransactions.createdAt,
    })
    .from(balanceTransactions)
    .where(where)
    .orderBy(desc(balanceTransactions.createdAt))
    .limit(limit)
    .offset(offset);

  return { total: countRow?.count ?? 0, transactions: rows };
}

/**
 * 原子扣减用户余额。
 *
 * 使用条件 UPDATE（WHERE email=? AND balance_cents >= ?）保证：
 * - 余额不足时 UPDATE 影响 0 行，不会扣成负数
 * - 并发下仅一个请求能成功扣减
 *
 * @returns 扣减是否成功
 */
export async function deductBalance(
  db: DbType,
  email: string,
  amountCents: number,
  options: BalanceTxOptions = {},
): Promise<boolean> {
  if (amountCents === 0) return true;
  if (amountCents < 0) return false;

  const nowStr = new Date().toISOString();
  const normalizedEmail = email.trim().toLowerCase();
  try {
    return await withDbTransaction(db, async (tx) => {
      const result = await tx
        .update(userBalances)
        .set({
          balanceCents: sql`${userBalances.balanceCents} - ${amountCents}`,
          totalSpentCents: sql`${userBalances.totalSpentCents} + ${amountCents}`,
          updatedAt: nowStr,
        })
        .where(and(
          eq(userBalances.email, normalizedEmail),
          sql`${userBalances.balanceCents} >= ${amountCents}`,
        ))
        .returning({ email: userBalances.email, balanceCents: userBalances.balanceCents });

      if (result.length === 0) return false;
      await writeBalanceTransaction(tx, normalizedEmail, "order_spend", -amountCents, result[0].balanceCents, {
        referenceType: options.referenceType || "order",
        referenceId: options.referenceId || "",
        note: options.note || "余额支付扣款",
      });
      return true;
    });
  } catch (error) {
    // 锁竞争表示本次扣款事务未提交。将其收敛为“未扣款”，让上层按正常业务失败处理，
    // 避免把 SQLite_BUSY 暴露成 500 并诱发重复支付/重试。
    if (isSqliteBusyError(error)) return false;
    throw error;
  }
}

/**
 * 管理端分页列出 user_balances 账户（按邮箱聚合的真实余额，非流水估算）。
 * 默认按余额降序，便于运营先看到大额账户。
 */
export async function listUserBalances(
  db: DbType,
  filter: UserBalanceFilter = {},
): Promise<UserBalanceList> {
  const limit = Math.min(Math.max(Number(filter.limit || 50), 1), 200);
  const offset = Math.max(Number(filter.offset || 0), 0);
  const conditions: SQL<unknown>[] = [];

  const emailRaw = (filter.email || "").trim().toLowerCase();
  if (emailRaw) {
    const escaped = emailRaw.replace(/[\\%_]/g, "\\$&");
    conditions.push(sql`${userBalances.email} LIKE ${`%${escaped}%`} ESCAPE '\\'`);
  }
  if (filter.positiveOnly) {
    conditions.push(sql`${userBalances.balanceCents} > 0`);
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const [countRow] = await db
    .select({ count: count() })
    .from(userBalances)
    .where(where);

  const rows = await db
    .select({
      email: userBalances.email,
      balanceCents: userBalances.balanceCents,
      totalDepositedCents: userBalances.totalDepositedCents,
      totalSpentCents: userBalances.totalSpentCents,
      updatedAt: userBalances.updatedAt,
    })
    .from(userBalances)
    .where(where)
    .orderBy(desc(userBalances.balanceCents), desc(userBalances.updatedAt))
    .limit(limit)
    .offset(offset);

  return { total: countRow?.count ?? 0, items: rows };
}

/**
 * 管理员手工为指定邮箱增加余额（退款/补偿/赠送场景）。
 * upsert 模式：用户不存在则创建，已存在则追加。
 */
export async function addBalance(db: DbType, email: string, amountCents: number, note?: string) {
  const result = await adjustUserBalance(db, email, amountCents, note || "管理员手工调账");
  return result;
}

/**
 * 管理员调账：amountCents 为正表示加款，为负表示扣款。
 *
 * - 加款：upsert 账户，累计 totalDepositedCents，写 adjustment 流水。
 * - 扣款：条件 UPDATE（余额充足才成功），不改 totalSpent/totalDeposited（非真实消费/充值），写 adjustment 流水。
 * - 金额为 0 或非法时拒绝；扣款不足时抛错，由路由层转 400。
 */
export async function adjustUserBalance(
  db: DbType,
  email: string,
  amountCents: number,
  note: string,
): Promise<AdjustUserBalanceResult> {
  if (!Number.isInteger(amountCents) || amountCents === 0) {
    throw new Error("调账金额必须是非零整数（分）");
  }
  const noteText = (note || "").trim();
  if (noteText.length < 2 || noteText.length > 200) {
    throw new Error("调账备注需 2–200 字，便于审计");
  }

  const nowStr = new Date().toISOString();
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail || !normalizedEmail.includes("@")) {
    throw new Error("邮箱无效");
  }

  if (amountCents > 0) {
    return withDbTransaction(db, async (tx) => {
      const [balanceRow] = await tx
        .insert(userBalances)
        .values({
          email: normalizedEmail,
          balanceCents: amountCents,
          totalDepositedCents: amountCents,
          totalSpentCents: 0,
          updatedAt: nowStr,
        })
        .onConflictDoUpdate({
          target: userBalances.email,
          set: {
            balanceCents: sql`${userBalances.balanceCents} + ${amountCents}`,
            totalDepositedCents: sql`${userBalances.totalDepositedCents} + ${amountCents}`,
            updatedAt: nowStr,
          },
        })
        .returning({ balanceCents: userBalances.balanceCents });

      await writeBalanceTransaction(tx, normalizedEmail, "adjustment", amountCents, balanceRow.balanceCents, {
        referenceType: "admin",
        note: noteText,
      });
      return { email: normalizedEmail, balanceCents: balanceRow.balanceCents, amountCents };
    });
  }

  // 扣款：禁止把余额扣成负数
  const debit = -amountCents;
  return withDbTransaction(db, async (tx) => {
    const result = await tx
      .update(userBalances)
      .set({
        balanceCents: sql`${userBalances.balanceCents} - ${debit}`,
        updatedAt: nowStr,
      })
      .where(and(
        eq(userBalances.email, normalizedEmail),
        sql`${userBalances.balanceCents} >= ${debit}`,
      ))
      .returning({ balanceCents: userBalances.balanceCents });

    if (result.length === 0) {
      throw new Error("余额不足或账户不存在，无法扣款");
    }

    await writeBalanceTransaction(tx, normalizedEmail, "adjustment", amountCents, result[0].balanceCents, {
      referenceType: "admin",
      note: noteText,
    });
    return { email: normalizedEmail, balanceCents: result[0].balanceCents, amountCents };
  });
}

/**
 * 余额支付失败后的退款补偿。
 * 退款只增加可用余额并写入流水，不增加 totalDepositedCents，避免把补偿误算为新充值。
 */
export async function refundBalance(
  db: DbType,
  email: string,
  amountCents: number,
  options: BalanceTxOptions = {},
) {
  const nowStr = new Date().toISOString();
  const normalizedEmail = email.trim().toLowerCase();
  await withDbTransaction(db, async (tx) => {
    const [balanceRow] = await tx
      .insert(userBalances)
      .values({
        email: normalizedEmail,
        balanceCents: amountCents,
        totalDepositedCents: 0,
        totalSpentCents: 0,
        updatedAt: nowStr,
      })
      .onConflictDoUpdate({
        target: userBalances.email,
        set: {
          balanceCents: sql`${userBalances.balanceCents} + ${amountCents}`,
          totalSpentCents: sql`MAX(${userBalances.totalSpentCents} - ${amountCents}, 0)`,
          updatedAt: nowStr,
        },
      })
      .returning({ balanceCents: userBalances.balanceCents });

    await writeBalanceTransaction(tx, normalizedEmail, "refund", amountCents, balanceRow.balanceCents, {
      referenceType: options.referenceType || "order",
      referenceId: options.referenceId || "",
      note: options.note || "余额支付失败退款",
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// 充值码批量生成（管理员功能）
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 生成单个充值码（8 位随机字母数字，排除易混淆字符）。
 * 格式：VCH-A1B2C3D4
 */
function secureRandomIndex(maxExclusive: number): number {
  // 充值码等价于有金额权益的 bearer 凭证，必须使用 Web Crypto；
  // 拒绝采样可以避免 Uint32 直接取模造成的字符分布偏差。
  const bucket = new Uint32Array(1);
  const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
  do {
    crypto.getRandomValues(bucket);
  } while (bucket[0] >= limit);
  return bucket[0] % maxExclusive;
}

function generateSingleCode(): string {
  const chars = new Array(VOUCHER_CODE_BODY_LENGTH);
  for (let i = 0; i < VOUCHER_CODE_BODY_LENGTH; i++) {
    chars[i] = CODE_CHARS[secureRandomIndex(CODE_CHARS.length)];
  }
  return `${VOUCHER_CODE_PREFIX}-${chars.join("")}`;
}

function isVoucherCodeUniqueConflict(error: unknown): boolean {
  const err = error as { code?: unknown; message?: unknown; cause?: { message?: unknown } };
  const haystack = [err.code, err.message, err.cause?.message]
    .filter(Boolean)
    .join(" ");
  // 只捕获 voucher_codes 主键/唯一键冲突用于重试；其他约束错误必须原样抛出，避免吞掉真实数据问题。
  const isUniqueOrPrimaryKeyConstraint = (
    haystack.includes("SQLITE_CONSTRAINT_UNIQUE") ||
    haystack.includes("SQLITE_CONSTRAINT_PRIMARYKEY") ||
    haystack.includes("UNIQUE constraint failed") ||
    haystack.includes("PRIMARY KEY")
  );
  return isUniqueOrPrimaryKeyConstraint && haystack.includes("voucher_codes");
}

/**
 * 批量生成充值码。
 *
 * @param db         - Drizzle ORM 实例
 * @param count      - 生成数量
 * @param amountCents - 每张充值码面值（分）
 * @param batchId    - 批次号（用于管理分组，如"202606-001"）
 * @param expiresAt  - 过期时间（ISO 格式），null 表示永不过期
 * @param notes      - 备注信息（如"客户王总-微信付款"）
 * @returns 生成的充值码列表
 */
export async function generateVoucherCodes(
  db: DbType,
  count: number,
  amountCents: number,
  batchId: string,
  expiresAt: string | null,
  notes?: string,
): Promise<string[]> {
  if (!Number.isInteger(count) || count < 1 || count > 500) {
    throw new Error("充值码生成数量无效");
  }
  if (!Number.isInteger(amountCents) || amountCents < 1) {
    throw new Error("充值码金额无效");
  }

  const nowStr = new Date().toISOString();

  const buildFreshUniqueCandidates = async (): Promise<string[]> => {
    const codes: string[] = [];
    const generatedCodes = new Set<string>();
    const existingCodes = new Set<string>();

    const appendCandidateCodes = () => {
      let attempts = 0;
      while (codes.length < count) {
        const code = generateSingleCode();
        attempts++;
        if (attempts > count * VOUCHER_CODE_DB_COLLISION_ROUNDS) {
          throw new Error("充值码生成碰撞次数过多，请重试");
        }
        if (generatedCodes.has(code) || existingCodes.has(code)) continue;
        generatedCodes.add(code);
        codes.push(code);
      }
    };

    // 批量生成必须同时避开本批次和数据库已有 code：
    // - 本批次重复会让同一次 INSERT 多行直接失败；
    // - 数据库重复虽然概率极低，但充值码是有金额权益的凭证，不能把碰撞暴露给管理员；
    // - 采用“候选集合 -> 单次 IN 查询 -> 冲突补齐”的方式，避免在 Worker 中对每个 code 发起一次 DB 查询。
    appendCandidateCodes();
    for (let round = 0; round < VOUCHER_CODE_DB_COLLISION_ROUNDS; round++) {
      const existing = await db
        .select({ code: voucherCodes.code })
        .from(voucherCodes)
        .where(inArray(voucherCodes.code, codes));
      if (existing.length === 0) return codes;

      const conflicts = new Set(existing.map((row) => row.code));
      for (let i = codes.length - 1; i >= 0; i--) {
        if (!conflicts.has(codes[i])) continue;
        existingCodes.add(codes[i]);
        generatedCodes.delete(codes[i]);
        codes.splice(i, 1);
      }
      appendCandidateCodes();
    }

    throw new Error("充值码生成碰撞次数过多，请重试");
  };

  for (let insertAttempt = 0; insertAttempt <= VOUCHER_CODE_INSERT_CONFLICT_RETRIES; insertAttempt++) {
    const codes = await buildFreshUniqueCandidates();
    const values: Array<{ code: string; amountCents: number; status: string; batchId: string; notes: string; createdAt: string; expiresAt: string | null }> = codes.map((code) => ({
      code,
      amountCents,
      status: "active",
      batchId,
      notes: notes || "",
      createdAt: nowStr,
      expiresAt,
    }));

    try {
      // Drizzle libsql 的批量 insert 语法。
      // 主键仍是最终一致性边界：若查询后插入前被并发请求抢占 code，就重新生成整批候选再插入。
      await db.insert(voucherCodes).values(values);
      return codes;
    } catch (error) {
      if (!isVoucherCodeUniqueConflict(error) || insertAttempt >= VOUCHER_CODE_INSERT_CONFLICT_RETRIES) {
        throw error;
      }
    }
  }

  throw new Error("充值码生成碰撞次数过多，请重试");
}

/**
 * 管理员批量作废充值码（revoked）。
 * 使用 IN 子句批量更新。
 */
export async function revokeVoucherCodes(db: DbType, codes: string[]) {
  if (codes.length === 0) return 0;
  const nowStr = new Date().toISOString();
  const result = await db
    .update(voucherCodes)
    .set({ status: "revoked" })
    .where(and(
      eq(voucherCodes.status, "active"),
      // 使用 sql.inArray 替代逐条更新
      sql`${voucherCodes.code} IN (${sql.join(codes.map(c => sql`${c.toUpperCase()}`), sql`, `)})`,
    ))
    .returning({ code: voucherCodes.code });
  return result.length;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 管理统计
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 充值码统计（管理员 Dashboard 用）。
 */
export async function getVoucherStats(db: DbType) {
  await expireVoucherCodes(db);
  const rows = await db
    .select({
      status: voucherCodes.status,
      count: sql`COUNT(*)`.as<number>(),
      totalAmount: sql`COALESCE(SUM(${voucherCodes.amountCents}), 0)`.as<number>(),
    })
    .from(voucherCodes)
    .groupBy(voucherCodes.status);

  const stats = { active: 0, used: 0, expired: 0, revoked: 0, totalAmount: 0, usedAmount: 0 };
  for (const row of rows) {
    if (row.status === "active") {
      stats.active = row.count;
      stats.totalAmount += Number(row.totalAmount);
    } else if (row.status === "used") {
      stats.used = row.count;
      stats.usedAmount = Number(row.totalAmount);
    } else if (row.status === "expired") {
      stats.expired = row.count;
    } else if (row.status === "revoked") {
      stats.revoked = row.count;
    }
  }
  return stats;
}

/**
 * 查询充值码列表（支持分页、状态过滤）。
 */
export async function listVoucherCodes(
  db: DbType,
  options: { status?: string; batchId?: string; search?: string; limit?: number; offset?: number },
) {
  await expireVoucherCodes(db);
  const { status, batchId, search, limit = 50, offset = 0 } = options;
  const conditions: SQL<unknown>[] = [];

  if (status) conditions.push(eq(voucherCodes.status, status));
  if (batchId) conditions.push(eq(voucherCodes.batchId, batchId));
  if (search) {
    const escaped = search.trim().toUpperCase().replace(/[\\%_]/g, "\\$&");
    conditions.push(sql`${voucherCodes.code} LIKE ${`%${escaped}%`} ESCAPE '\\'`);
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const [countRow] = await db
    .select({ count: count() })
    .from(voucherCodes)
    .where(where);

  const rows = await db
    .select()
    .from(voucherCodes)
    .where(where)
    .orderBy(sql`${voucherCodes.createdAt} DESC`)
    .limit(limit)
    .offset(offset);

  return { total: Number(countRow?.count || 0), items: rows };
}

async function expireVoucherCodes(db: DbType): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(voucherCodes)
    .set({ status: "expired" })
    .where(and(
      eq(voucherCodes.status, "active"),
      sql`${voucherCodes.expiresAt} IS NOT NULL`,
      sql`${voucherCodes.expiresAt} <> ''`,
      lt(voucherCodes.expiresAt, now),
    ));
}
