/**
 * 支付主动对账服务。
 *
 * 目标：
 * - 支付回调丢失时，仍能通过上游查单确认已付款订单；
 * - 定时清理过期订单前先查单，避免“上游已收款、本地先过期释放库存”；
 * - 只在金额、币种、支付渠道、付款时间全部通过校验后推进本地订单状态。
 */

import { and, eq, or } from "drizzle-orm";
import type { Bindings } from "../bindings";
import type { DbType } from "../db/client";
import { withDbTransaction } from "../db/client";
import { orders } from "../db/schema";
import type { RuntimeConfig } from "../lib/runtime-config";
import { writeOrderEvent } from "./audit-service";
import { restoreCouponReservation } from "./coupon-service";
import { markPaidAndIssue } from "./order-service";
import { createDbProviderRegistryForCallback, isValidProviderName } from "./payments";
import type { QueryStatusResult } from "./payments";
import { tryNormalizeCurrencyCode } from "../../shared/money";

export type TimedPaymentStatus = QueryStatusResult;

export type ReconcileOnlineOrderSnapshot = {
  id: string;
  orderNo?: string | null;
  status: string;
  paymentProvider?: string | null;
  paymentRef?: string | null;
  amountCents?: number | null;
  currency?: string | null;
  createdAt?: string | null;
  expiresAt?: string | null;
};

export type PaymentReconciliationResult = {
  reconciled: boolean;
  issueOk?: boolean;
  reason?: string;
};

function parseProviderLocalTimestamp(value: string | undefined): number {
  if (!value) return Number.NaN;
  const trimmed = value.trim();
  // 易支付查单常返回无时区的 "YYYY-MM-DD HH:mm:ss"。这里只用于计算 addtime→endtime 的耗时，
  // 绝对时区不重要；后续会把该耗时加回本系统订单 createdAt，避免服务商本地时区影响过期判断。
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(trimmed)
    ? `${trimmed.replace(" ", "T")}Z`
    : trimmed;
  return Date.parse(normalized);
}

export function didPaymentHappenBeforeExpiry(paidAt: unknown, expiresAt?: string | null): boolean {
  if (!expiresAt || typeof paidAt !== "string" || !paidAt.trim()) return false;
  const paidAtMs = Date.parse(paidAt);
  const expiresAtMs = Date.parse(expiresAt);
  return Number.isFinite(paidAtMs) && Number.isFinite(expiresAtMs) && paidAtMs <= expiresAtMs;
}

export function inferEasyPayPaidAt(
  status: TimedPaymentStatus,
  orderCreatedAt: string,
  referenceTradeNo: string,
): string | null {
  if (!status.paid) return null;
  // 查单结果必须和当前可信流水一致：回调路径传回调流水，主动对账路径传本地已记录流水。
  // 流水不一致说明可能查到其他订单或上游返回异常，不能恢复过期订单。
  if (status.providerTradeNo && referenceTradeNo && status.providerTradeNo !== referenceTradeNo) return null;

  const providerCreatedAtMs = parseProviderLocalTimestamp(status.providerCreatedAt);
  const providerPaidAtMs = parseProviderLocalTimestamp(status.paidAt);
  const orderCreatedAtMs = Date.parse(orderCreatedAt);
  const paymentElapsedMs = providerPaidAtMs - providerCreatedAtMs;
  // 只有 addtime/endtime/orderCreatedAt 全部可解析，且付款耗时非负，才用该耗时推断本系统视角的 paidAt。
  if (
    !Number.isFinite(providerCreatedAtMs) ||
    !Number.isFinite(providerPaidAtMs) ||
    !Number.isFinite(orderCreatedAtMs) ||
    paymentElapsedMs < 0
  ) {
    return null;
  }
  return new Date(orderCreatedAtMs + paymentElapsedMs).toISOString();
}

export async function restoreVerifiedExpiredPayment(
  db: DbType,
  orderId: string,
  providerName: string,
  providerTradeNo: string,
  paidAt: string,
): Promise<boolean> {
  return withDbTransaction(db, async (tx) => {
    const [restored] = await tx
      .update(orders)
      .set({
        status: "paid",
        paymentProvider: providerName,
        paymentRef: providerTradeNo,
        paidAt,
      })
      .where(and(
        eq(orders.id, orderId),
        eq(orders.status, "expired"),
        eq(orders.paymentProvider, providerName),
        or(eq(orders.paymentRef, providerTradeNo), eq(orders.paymentRef, "")),
      ))
      .returning({ id: orders.id, couponCode: orders.couponCode });
    if (!restored) return false;
    if (restored.couponCode) {
      await restoreCouponReservation(tx, restored.couponCode);
    }
    return true;
  });
}

function orderExpiredByClock(order: ReconcileOnlineOrderSnapshot): boolean {
  const expiresAtMs = Date.parse(order.expiresAt || "");
  return Number.isFinite(expiresAtMs) && expiresAtMs < Date.now();
}

function resolveReconciledPaidAt(
  providerName: string,
  status: TimedPaymentStatus,
  order: ReconcileOnlineOrderSnapshot,
): string | null {
  const expired = order.status === "expired" || orderExpiredByClock(order);

  if (providerName === "easypay") {
    const recordedTradeNo = (order.paymentRef || "").trim();
    const inferred = inferEasyPayPaidAt(status, order.createdAt || "", recordedTradeNo);
    if (inferred) return inferred;
    // 只要本地已经记录过流水号，而查单又无法反推出与之匹配的付款时间，就必须直接失败。
    // 这样可以避免“历史流水已变更 / 查到别单 / 服务商返回异常”时，误把订单恢复成已支付。
    if (recordedTradeNo) return null;
    // 订单已经过期时，不能用当前时间兜底，否则会把过期后付款误恢复成有效订单。
    if (expired) return null;
  }

  const paidAtMs = Date.parse(status.paidAt || "");
  if (Number.isFinite(paidAtMs)) return new Date(paidAtMs).toISOString();
  return expired ? null : new Date().toISOString();
}

async function readCurrentPaymentState(db: DbType, orderId: string) {
  const [currentOrder] = await db
    .select({
      status: orders.status,
      paymentProvider: orders.paymentProvider,
      paymentRef: orders.paymentRef,
    })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  return currentOrder || null;
}

/**
 * 对单笔线上订单执行主动查单。
 *
 * 该函数只处理 pending/expired 的外部支付订单：
 * - pending：确认已付款后 CAS 写入 paid，再调用 markPaidAndIssue；
 * - expired：只有能证明付款发生在本地过期时间之前，才恢复为 paid 并履约；
 * - amount/currency 缺失或不一致时 fail closed，只记事件，不入账。
 */
export async function reconcileOnlineOrderPayment(
  db: DbType,
  paymentEnv: Partial<Bindings> | undefined,
  order: ReconcileOnlineOrderSnapshot,
  runtimeConfig?: RuntimeConfig,
  executionCtx?: ExecutionContext,
): Promise<PaymentReconciliationResult> {
  const providerName = (order.paymentProvider || "").trim();
  const orderNo = (order.orderNo || "").trim();
  const amountCents = Number(order.amountCents || 0);
  const currency = tryNormalizeCurrencyCode(order.currency);

  if (!["pending", "expired"].includes(order.status)) return { reconciled: false, reason: "status_not_reconcilable" };
  if (!currency) return { reconciled: false, reason: "invalid_order_currency" };
  if (!orderNo || !isValidProviderName(providerName) || amountCents <= 0) {
    return { reconciled: false, reason: "not_online_provider_order" };
  }
  if (!paymentEnv) return { reconciled: false, reason: "missing_payment_env" };

  const registry = await createDbProviderRegistryForCallback(
    paymentEnv as Bindings,
    db,
    paymentEnv.CREDENTIALS_ENCRYPTION_KEY,
  );
  const provider = registry.get(providerName);
  if (!provider?.queryStatus) return { reconciled: false, reason: "provider_cannot_query" };

  let status: TimedPaymentStatus;
  try {
    status = await provider.queryStatus(orderNo);
  } catch (error) {
    console.warn(`[payment_reconcile] provider query failed for ${order.id}:`, error);
    return { reconciled: false, reason: "query_failed" };
  }
  if (!status.paid) return { reconciled: false, reason: "not_paid" };

  const providerTradeNo = (status.providerTradeNo || "").trim();
  if (!providerTradeNo) {
    await writeOrderEvent(db, order.id, "payment_reconcile_unverified", "支付查单缺少上游流水号，未自动入账", {
      provider: providerName,
      orderNo,
    });
    return { reconciled: false, reason: "missing_provider_trade_no" };
  }

  if (!Number.isInteger(status.amountCents)) {
    await writeOrderEvent(db, order.id, "payment_reconcile_unverified", "支付查单缺少金额，未自动入账", {
      provider: providerName,
      trade_no: providerTradeNo,
    });
    return { reconciled: false, reason: "missing_amount" };
  }
  if (status.amountCents !== amountCents) {
    await writeOrderEvent(db, order.id, "payment_reconcile_amount_mismatch", "支付查单金额与订单金额不一致，未自动入账", {
      provider: providerName,
      trade_no: providerTradeNo,
      expected: amountCents,
      received: status.amountCents,
    });
    return { reconciled: false, reason: "amount_mismatch" };
  }

  const providerCurrency = tryNormalizeCurrencyCode(status.currency);
  if (!providerCurrency || providerCurrency !== currency) {
    await writeOrderEvent(db, order.id, "payment_reconcile_currency_mismatch", "支付查单币种与订单币种不一致，未自动入账", {
      provider: providerName,
      trade_no: providerTradeNo,
      expected: currency,
      received: providerCurrency || "",
    });
    return { reconciled: false, reason: "currency_mismatch" };
  }

  const paidAt = resolveReconciledPaidAt(providerName, status, order);
  if (!paidAt) {
    await writeOrderEvent(db, order.id, "payment_reconcile_timing_unverified", "支付查单无法证明付款发生在订单有效期内，未自动入账", {
      provider: providerName,
      trade_no: providerTradeNo,
    });
    return { reconciled: false, reason: "timing_unverified" };
  }
  if (order.expiresAt && !didPaymentHappenBeforeExpiry(paidAt, order.expiresAt)) {
    await writeOrderEvent(db, order.id, "payment_reconcile_after_expiry", "支付查单显示付款晚于订单有效期，未自动入账", {
      provider: providerName,
      trade_no: providerTradeNo,
      paidAt,
      expiresAt: order.expiresAt,
    });
    return { reconciled: false, reason: "paid_after_expiry" };
  }

  let paymentStateRecorded = false;
  if (order.status === "expired") {
    paymentStateRecorded = await restoreVerifiedExpiredPayment(db, order.id, providerName, providerTradeNo, paidAt);
  } else {
    const updated = await db
      .update(orders)
      .set({ status: "paid", paymentProvider: providerName, paymentRef: providerTradeNo, paidAt })
      .where(and(
        eq(orders.id, order.id),
        eq(orders.status, "pending"),
        eq(orders.paymentProvider, providerName),
        or(eq(orders.paymentRef, providerTradeNo), eq(orders.paymentRef, "")),
      ))
      .returning({ id: orders.id });
    paymentStateRecorded = updated.length > 0;
  }

  if (!paymentStateRecorded) {
    const currentOrder = await readCurrentPaymentState(db, order.id);
    const samePayment = currentOrder?.paymentProvider === providerName && currentOrder.paymentRef === providerTradeNo;
    if (!samePayment || !currentOrder || !["paid", "issued"].includes(currentOrder.status)) {
      await writeOrderEvent(db, order.id, "payment_reconcile_state_conflict", "支付查单写入时订单状态已变更", {
        provider: providerName,
        trade_no: providerTradeNo,
        status: currentOrder?.status || "missing",
        recorded_trade_no: currentOrder?.paymentRef || "",
      });
      return { reconciled: false, reason: "state_conflict" };
    }
    if (currentOrder.status === "issued") return { reconciled: true, issueOk: true };
  }

  await writeOrderEvent(db, order.id, "payment_reconciled", "主动查单确认支付成功", {
    provider: providerName,
    trade_no: providerTradeNo,
  });

  const issueResult = await markPaidAndIssue(db, order.id, runtimeConfig, executionCtx);
  if (!issueResult.ok) {
    await writeOrderEvent(db, order.id, "payment_reconcile_issue_failed", issueResult.message, {
      provider: providerName,
      trade_no: providerTradeNo,
    });
    return { reconciled: true, issueOk: false, reason: issueResult.message };
  }

  return { reconciled: true, issueOk: true };
}
