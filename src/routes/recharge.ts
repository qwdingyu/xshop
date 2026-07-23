import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../bindings";
import { withDbTransaction } from "../db/client";
import { fail, getDb, getOrigin, ok, safeJsonBody } from "../lib/http";
import { checkIdempotency, clearCachedIdempotentResponse, clearPendingIdempotency, hashIdempotencyRequest, isStrongIdempotencyKey, saveIdempotentResponse } from "../lib/idempotency";
import { getBalanceRechargeConfig, getOrderExpireMinutes } from "../lib/system-config-registry";
import { createOrderToken, hashOrderToken } from "../lib/token";
import { enforceRateLimit, writeRequestLog } from "../lib/rate-limit";
import { getEmailAccessSecret, verifyEmailAccessCode } from "../lib/email-access";
import { normalizeSecurePaymentUrl } from "../lib/payment-url";
import { createDbProviderRegistry, createDbProviderRegistryForCallback, easyPayPayTypeLabel, isAmbiguousEasyPayProviderError, isValidProviderName, normalizeEasyPayPayType, selectOnlineProviderForCurrency } from "../services/payments";
import { didPaymentHappenBeforeExpiry, inferEasyPayPaidAt, type TimedPaymentStatus } from "../services/payment-reconciliation-service";
import { createRechargeOrder, expireRechargeOrder, getRechargeOrderById, getRechargeOrderByNo, markRechargeOrderFailed, settleRechargeOrder } from "../services/recharge-service";
import { formatMoney, tryNormalizeCurrencyCode } from "../../shared/money";

const CreateRechargeSchema = z.object({
  buyerEmail: z.string().trim().email().max(160),
  emailAccessCode: z.string().trim().regex(/^\d{6}$/),
  amountCents: z.number().int().positive(),
  paymentChannel: z.enum(["alipay", "wxpay", "qqpay"]).optional(),
});

const RechargeStatusSchema = z.object({
  orderId: z.string().uuid(),
  orderToken: z.string().trim().min(32).max(200),
});

export const rechargeRoute = new Hono<AppEnv>();

function createRechargeOrderNo(): string {
  const stamp = Date.now().toString(36).toUpperCase();
  const random = crypto.randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase();
  return `R${stamp}${random}`;
}

function paymentEntry(result: { qrCode?: string; redirectUrl?: string; raw?: Record<string, unknown> }) {
  const raw = result.raw || {};
  const rawImage = typeof raw.qrImageUrl === "string" ? raw.qrImageUrl : typeof raw.img === "string" ? raw.img : "";
  const rawContent = typeof raw.qrContent === "string" ? raw.qrContent : typeof raw.qrcode === "string" ? raw.qrcode : "";
  return {
    qrImageUrl: normalizeSecurePaymentUrl(rawImage),
    redirectUrl: normalizeSecurePaymentUrl(result.redirectUrl || rawContent || result.qrCode || ""),
  };
}

function paymentChannel(providerName: string, result: { raw?: Record<string, unknown> }) {
  if (providerName !== "easypay") return { paymentChannel: "", paymentChannelLabel: "" };
  const channel = normalizeEasyPayPayType(result.raw?.payType);
  return { paymentChannel: channel, paymentChannelLabel: easyPayPayTypeLabel(channel) };
}

function parseCachedResponse(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("充值幂等响应格式无效");
  return { ...(parsed as Record<string, unknown>), ok: true };
}

async function resolveVerifiedPaidAt(
  order: Awaited<ReturnType<typeof getRechargeOrderById>> & {},
  providerName: string,
  status: TimedPaymentStatus,
  referenceTradeNo: string,
): Promise<string | null> {
  const expired = order.status === "expired" || Date.parse(order.expiresAt) < Date.now();
  if (providerName === "easypay") {
    const inferred = inferEasyPayPaidAt(status, order.createdAt, referenceTradeNo);
    if (inferred) return inferred;
    if (expired) return null;
  }
  const parsed = Date.parse(status.paidAt || "");
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : (expired ? null : new Date().toISOString());
}

async function settleVerifiedPayment(
  db: ReturnType<typeof getDb>,
  order: NonNullable<Awaited<ReturnType<typeof getRechargeOrderById>>>,
  input: { providerName: string; providerTradeNo: string; paidAt: string },
) {
  const allowExpired = order.status === "expired" || Date.parse(order.expiresAt) < Date.now();
  if (allowExpired && !didPaymentHappenBeforeExpiry(input.paidAt, order.expiresAt)) {
    return { ok: false as const, reason: "paid_after_expiry" };
  }
  return settleRechargeOrder(db, {
    id: order.id,
    paymentProvider: input.providerName,
    paymentRef: input.providerTradeNo,
    paidAt: input.paidAt,
    allowExpired,
  });
}

rechargeRoute.post("/recharge/create", async (c) => {
  const limit = await enforceRateLimit(c, "balance_recharge_create", 6);
  if (!limit.ok) return fail(c, limit.message || "请求过于频繁，请稍后再试", limit.status || 429);
  const body = CreateRechargeSchema.safeParse(await safeJsonBody(c));
  if (!body.success) return fail(c, "充值参数无效", 400, body.error.flatten());

  // 充值会直接增加可消费余额，幂等键必须先于邮箱验证和支付创建校验，且只接受标准请求头。
  const idempotencyKey = c.req.header("Idempotency-Key")?.trim() || "";
  if (!idempotencyKey) {
    return fail(c, "缺少 Idempotency-Key 请求头", 400, { code: "IDEMPOTENCY_KEY_REQUIRED" });
  }
  if (!isStrongIdempotencyKey(idempotencyKey)) {
    return fail(c, "Idempotency-Key 必须是 UUID 或至少 32 位 URL 安全随机字符串", 400, { code: "INVALID_IDEMPOTENCY_KEY" });
  }

  const db = getDb(c);
  const config = await getBalanceRechargeConfig(db);
  if (!config.enabled) return fail(c, "在线充值未启用", 403, { code: "BALANCE_RECHARGE_DISABLED" });
  if (body.data.amountCents < config.minCents || body.data.amountCents > config.maxCents) {
    return fail(c, `单笔充值金额必须在 ${formatMoney(config.minCents, "CNY")} 到 ${formatMoney(config.maxCents, "CNY")} 之间`, 400, {
      code: "BALANCE_RECHARGE_AMOUNT_OUT_OF_RANGE",
      minCents: config.minCents,
      maxCents: config.maxCents,
    });
  }

  const buyerEmail = body.data.buyerEmail.toLowerCase();
  const accessSecret = getEmailAccessSecret(c.env.ADMIN_TOKEN, c.req.url);
  if (!accessSecret) return fail(c, "邮箱验证服务未安全配置，请联系管理员", 503, { code: "EMAIL_ACCESS_UNAVAILABLE" });
  if (!(await verifyEmailAccessCode(buyerEmail, body.data.emailAccessCode, accessSecret))) {
    await writeRequestLog(c, "balance_recharge_create", 403, limit.ipHash);
    return fail(c, "邮箱验证码无效或已过期", 403, { code: "EMAIL_VERIFICATION_REQUIRED" });
  }

  const requestHash = await hashIdempotencyRequest({
    amountCents: body.data.amountCents,
    buyerEmail,
    paymentChannel: body.data.paymentChannel || "",
  });
  const idem = await checkIdempotency(db, idempotencyKey, "balance_recharge", requestHash);
  if (idem.requestMismatch) return fail(c, "幂等键已用于不同的充值请求", 409, { code: "IDEMPOTENCY_REQUEST_MISMATCH" });
  if (idem.pending) return fail(c, "充值订单正在处理中，请稍后查询", 409, { code: "IDEMPOTENCY_PENDING" });
  if (!idem.shouldProceed && idem.cachedResponse) return c.json(parseCachedResponse(idem.cachedResponse), 200);
  if (!idem.shouldProceed) return fail(c, "充值订单正在处理中，请稍后查询", 409, { code: "IDEMPOTENCY_PENDING" });

  const registry = await createDbProviderRegistry(c.env, db, c.env.CREDENTIALS_ENCRYPTION_KEY);
  const provider = selectOnlineProviderForCurrency(registry, "CNY");
  if (!provider) {
    await clearPendingIdempotency(db, idempotencyKey, "balance_recharge", requestHash, idem.leaseVersion);
    return fail(c, "暂无可用在线支付渠道", 503, { code: "PAYMENT_PROVIDER_UNAVAILABLE" });
  }

  const orderId = crypto.randomUUID();
  const orderNo = createRechargeOrderNo();
  const orderToken = createOrderToken();
  const orderTokenHash = await hashOrderToken(orderToken);
  const createdAt = new Date().toISOString();
  const expireMinutes = await getOrderExpireMinutes(db);
  const expiresAt = new Date(Date.now() + expireMinutes * 60_000).toISOString();
  const recoveryResponse = {
    mode: "online",
    provider: provider.name,
    orderId,
    orderNo,
    orderToken,
    amountCents: body.data.amountCents,
    currency: "CNY",
    status: "pending",
    qrImageUrl: "",
    redirectUrl: "",
    expiresAt,
    message: "充值支付入口正在创建",
  };

  await withDbTransaction(db, async (tx) => {
    await createRechargeOrder(tx, { id: orderId, orderNo, buyerEmail, amountCents: body.data.amountCents, paymentProvider: provider.name, orderTokenHash, createdAt, expiresAt });
    await saveIdempotentResponse(tx, idempotencyKey, "balance_recharge", requestHash, idem.leaseVersion, orderId, recoveryResponse);
  });

  try {
    const origin = getOrigin(c);
    const result = await provider.createPayment({
      orderNo,
      amountCents: body.data.amountCents,
      currency: "CNY",
      notifyUrl: `${origin}/api/recharge/callback/${provider.name}`,
      returnUrl: `${origin}/shop`,
      metadata: {
        subject: "余额充值",
        clientIp: c.req.header("CF-Connecting-IP") || "127.0.0.1",
        ...(provider.name === "easypay" && body.data.paymentChannel ? { payType: body.data.paymentChannel } : {}),
      },
    });
    const entry = paymentEntry(result);
    if (!entry.qrImageUrl && !entry.redirectUrl) throw new Error("支付渠道未返回可用付款入口");
    const response = { ...recoveryResponse, ...entry, ...paymentChannel(provider.name, result), message: "" };
    await saveIdempotentResponse(db, idempotencyKey, "balance_recharge", requestHash, idem.leaseVersion, orderId, response);
    return ok(c, response);
  } catch (error) {
    if (isAmbiguousEasyPayProviderError(error)) {
      const response = { ...recoveryResponse, message: "支付渠道响应不确定，正在确认充值结果" };
      await saveIdempotentResponse(db, idempotencyKey, "balance_recharge", requestHash, idem.leaseVersion, orderId, response);
      return fail(c, response.message, 503, { code: "PAYMENT_CREATION_UNCERTAIN", ...response });
    }
    await markRechargeOrderFailed(db, orderId);
    await clearCachedIdempotentResponse(db, idempotencyKey, "balance_recharge", requestHash, idem.leaseVersion, recoveryResponse);
    return fail(c, error instanceof Error ? error.message : "充值支付创建失败", 502, { code: "PAYMENT_CREATION_FAILED" });
  }
});

rechargeRoute.post("/recharge/status", async (c) => {
  c.header("Cache-Control", "no-store");
  const limit = await enforceRateLimit(c, "balance_recharge_status", 30);
  if (!limit.ok) return fail(c, limit.message || "查询过于频繁", limit.status || 429);
  const body = RechargeStatusSchema.safeParse(await safeJsonBody(c));
  if (!body.success) return fail(c, "查询参数无效", 400, body.error.flatten());
  const db = getDb(c);
  const tokenHash = await hashOrderToken(body.data.orderToken);
  let order = await getRechargeOrderById(db, body.data.orderId);
  if (!order || order.orderTokenHash !== tokenHash) return fail(c, "充值订单不存在或凭证无效", 404);

  if (["pending", "expired"].includes(order.status)) {
    const registry = await createDbProviderRegistryForCallback(c.env, db, c.env?.CREDENTIALS_ENCRYPTION_KEY);
    const provider = registry.get(order.paymentProvider);
    if (provider?.queryStatus) {
      try {
        const status = await provider.queryStatus(order.orderNo);
        const tradeNo = status.providerTradeNo || "";
        const amountMatches = Number(status.amountCents) === order.amountCents;
        // 查单结果必须自己证明金额、币种和平台流水号；任何字段缺失都不能自动给余额入账。
        const reportedCurrency = tryNormalizeCurrencyCode(status.currency);
        const expectedCurrency = tryNormalizeCurrencyCode(order.currency);
        const currencyMatches = reportedCurrency !== null && reportedCurrency === expectedCurrency;
        if (status.paid && tradeNo && amountMatches && currencyMatches) {
          const paidAt = await resolveVerifiedPaidAt(order, order.paymentProvider, status, tradeNo);
          if (paidAt) await settleVerifiedPayment(db, order, { providerName: order.paymentProvider, providerTradeNo: tradeNo, paidAt });
        }
      } catch (error) {
        console.warn("[recharge_status] provider query failed", error);
      }
    }
    order = await getRechargeOrderById(db, body.data.orderId);
    if (order?.status === "pending") {
      await expireRechargeOrder(db, order.id);
      order = await getRechargeOrderById(db, order.id);
    }
  }

  if (!order) return fail(c, "充值订单不存在", 404);
  return ok(c, {
    orderId: order.id,
    orderNo: order.orderNo,
    status: order.status,
    amountCents: order.amountCents,
    currency: order.currency,
    paidAt: order.paidAt,
    expiresAt: order.expiresAt,
  });
});

rechargeRoute.all("/recharge/callback/:provider", async (c) => {
  const limit = await enforceRateLimit(c, "balance_recharge_callback", 60);
  if (!limit.ok) return c.text("fail", 429);
  const providerName = c.req.param("provider");
  if (!isValidProviderName(providerName)) return c.text("invalid provider", 400);
  const db = getDb(c);
  const registry = await createDbProviderRegistryForCallback(c.env, db, c.env?.CREDENTIALS_ENCRYPTION_KEY);
  const provider = registry.get(providerName);
  if (!provider) return c.text("provider not configured", 500);

  try {
    const params = c.req.method === "GET"
      ? Object.fromEntries(Object.entries(c.req.queries()).map(([key, values]) => [key, values[0] || ""]))
      : Object.fromEntries(new URLSearchParams(await c.req.text()).entries());
    const result = await provider.verifyCallback(params);
    const order = await getRechargeOrderByNo(db, result.orderNo);
    if (!order) return c.text("order not found", 404);
    if (order.paymentProvider !== providerName) return c.text("fail", 400);
    if (result.amountCents !== order.amountCents) return c.text("fail", 400);
    const callbackCurrency = tryNormalizeCurrencyCode(result.currency);
    const orderCurrency = tryNormalizeCurrencyCode(order.currency);
    if (!callbackCurrency || callbackCurrency !== orderCurrency) return c.text("fail", 400);
    if (order.status === "paid" && order.paymentRef === result.providerTradeNo) return c.text("success");
    if (!["pending", "expired"].includes(order.status)) return c.text("fail", 409);

    let status: TimedPaymentStatus = { paid: true, providerTradeNo: result.providerTradeNo, paidAt: result.paidAt };
    if ((order.status === "expired" || Date.parse(order.expiresAt) < Date.now()) && provider.queryStatus) {
      status = await provider.queryStatus(order.orderNo);
      // 过期订单恢复比普通回调更严格：查单结果也必须完整证明币种一致。
      const queriedCurrency = tryNormalizeCurrencyCode(status.currency);
      const currencyMatches = queriedCurrency !== null && queriedCurrency === orderCurrency;
      if (!status.paid || status.providerTradeNo !== result.providerTradeNo || Number(status.amountCents) !== order.amountCents || !currencyMatches) {
        return c.text("fail", 400);
      }
    }
    const paidAt = await resolveVerifiedPaidAt(order, providerName, status, result.providerTradeNo);
    if (!paidAt) return c.text("fail", 503);
    const settled = await settleVerifiedPayment(db, order, { providerName, providerTradeNo: result.providerTradeNo, paidAt });
    return settled.ok ? c.text("success") : c.text("fail", 409);
  } catch (error) {
    console.warn("[recharge_callback] rejected", error);
    return c.text("fail", 400);
  }
});
