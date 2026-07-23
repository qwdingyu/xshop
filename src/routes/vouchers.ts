/**
 * Voucher 兑换路由 — 充值码兑付与余额查询。
 *
 * 充值码是"预付费凭证"：用户先在站外付款获取充值码，
 * 然后在 /vouchers/redeem 兑付为余额，最后用余额购买商品。
 *
 * 关键安全设计：
 * - 兑换接口受 Turnstile 保护，防止批量枚举兑付
 * - 兑换接口有限流（每 IP 每分钟 5 次），防止暴力尝试
 * - 余额查询只返回余额信息，不暴露充值码明细
 *
 * 注意：充值码不是 PaymentProvider（它是独立路由），
 * 余额支付在 /pay/unified 中通过 balancePayment 标记处理。
 */

import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../bindings";
import { fail, ok, getDb, safeJsonBody } from "../lib/http";
import { enforceRateLimit, writeRequestLog } from "../lib/rate-limit";
import { verifyTurnstile } from "../lib/security";
import { redeemVoucher, getUserBalance } from "../services/voucher-service";
import { readRuntimeConfig, mergeRuntimeConfig } from "../lib/runtime-config";
import { getEmailAccessSecret, verifyEmailAccessCode } from "../lib/email-access";
import { minorToMajorString } from "../../shared/money";

// ── 请求体验证 Schema ──

/** 充值码兑换请求体 */
const RedeemSchema = z.object({
  code: z.string().trim().min(8, "请输入完整充值码").max(80, "充值码过长"),          // 充值码（大小写不敏感）
  email: z.string().trim().email("请输入有效邮箱").max(160, "邮箱过长"),        // 兑付人邮箱
  turnstileToken: z.string().trim().optional().or(z.literal("")),
});

/** 余额查询请求体 */
const BalanceSchema = z.object({
  email: z.string().trim().email("请输入有效邮箱").max(160, "邮箱过长"),
  emailAccessCode: z.string().trim().regex(/^\d{6}$/, "请输入 6 位邮箱验证码").optional().or(z.literal("")),
  turnstileToken: z.string().trim().optional().or(z.literal("")),
});

function voucherRedeemValidationMessage(error: z.ZodError): string {
  const codeErrors = error.flatten().fieldErrors.code || [];
  if (codeErrors.length > 0) return "请输入完整充值码";
  return "请求参数无效";
}

export const voucherRoute = new Hono<AppEnv>();

// ═══════════════════════════════════════════════════════════════════════════════
// 用户端接口
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 充值码兑付接口。
 *
 * 用户输入充值码和邮箱，兑换成功后余额自动转入 user_balances 表。
 * 兑付使用条件 UPDATE 保证原子性，并发下不会超兑。
 *
 * 限流：每 IP 每分钟 5 次（防止批量暴力尝试）。
 */
voucherRoute.post("/vouchers/redeem", async (c) => {
  const limit = await enforceRateLimit(c, "voucher_redeem", 5);
  if (!limit.ok) return fail(c, limit.message || "请求过于频繁，请稍后再试", limit.status || 429);

  const body = RedeemSchema.safeParse(await safeJsonBody(c));
  if (!body.success) {
    await writeRequestLog(c, "voucher_redeem", 400, limit.ipHash);
    return fail(c, voucherRedeemValidationMessage(body.error), 400, {
      code: "VOUCHER_REDEEM_INVALID_INPUT",
      ...body.error.flatten(),
    });
  }

  const db = getDb(c);
  const dbConfig = await readRuntimeConfig(db, c.env?.CREDENTIALS_ENCRYPTION_KEY);
  const turnstileConfig = mergeRuntimeConfig(dbConfig, c.env);
  // Turnstile 人机验证（可选，配置后强制启用）
  const turnstile = await verifyTurnstile(c, body.data.turnstileToken, turnstileConfig);
  if (!turnstile.ok) {
    await writeRequestLog(c, "voucher_redeem", 403, limit.ipHash);
    return fail(c, turnstile.message || "安全校验失败", turnstile.status || 403);
  }

  // 调用原子兑换逻辑
  const result = await redeemVoucher(db, body.data.code, body.data.email);
  if (!result.success) {
    await writeRequestLog(c, "voucher_redeem", 400, limit.ipHash);
    return fail(c, result.message, 400);
  }

  return ok(c, {
    success: true,
    amountCents: result.amountCents,
    amountYuan: minorToMajorString(result.amountCents, "CNY"),
    message: result.message,
  });
});

/**
 * 用户余额查询接口。
 *
 * 前端可通过此接口在结算前展示余额。
 * 余额属于用户隐私，查询需要短时邮箱验证码 + 限流。
 */
voucherRoute.post("/vouchers/balance", async (c) => {
  c.header("Cache-Control", "no-store");
  const limit = await enforceRateLimit(c, "voucher_balance", 10);
  if (!limit.ok) return fail(c, limit.message || "请求过于频繁，请稍后再试", limit.status || 429);

  const body = BalanceSchema.safeParse(await safeJsonBody(c));
  if (!body.success) {
    return fail(c, "请求参数无效", 400, body.error.flatten());
  }

  const db = getDb(c);
  const email = body.data.email.toLowerCase();
  const emailAccessSecret = getEmailAccessSecret(c.env.ADMIN_TOKEN, c.req.url);
  if (!emailAccessSecret) {
    return fail(c, "邮箱验证服务未安全配置，请联系管理员", 503, { code: "EMAIL_ACCESS_UNAVAILABLE" });
  }
  const mailboxVerified = await verifyEmailAccessCode(email, body.data.emailAccessCode, emailAccessSecret);
  if (!mailboxVerified) {
    await writeRequestLog(c, "voucher_balance", 403, limit.ipHash);
    return fail(c, "邮箱验证码无效或已过期", 403, { code: "EMAIL_VERIFICATION_REQUIRED" });
  }

  const balance = await getUserBalance(db, email);

  return ok(c, {
    balanceCents: balance.balanceCents,
    balanceYuan: minorToMajorString(balance.balanceCents, "CNY"),
  });
});
