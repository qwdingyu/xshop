import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../bindings";
import { createEmailAccessCode, emailAccessSubject, getEmailAccessSecret } from "../lib/email-access";
import { fail, getDb, ok, safeJsonBody } from "../lib/http";
import { enforceRateLimit, releaseCooldown, reserveCooldown, writeRequestLog } from "../lib/rate-limit";
import { mergeRuntimeConfig, readRuntimeConfig } from "../lib/runtime-config";
import { verifyTurnstile } from "../lib/security";
import { sendEmail } from "../services/email-service";

const EmailAccessSchema = z.object({
  email: z.string().trim().email().max(160),
  turnstileToken: z.string().trim().optional().or(z.literal("")),
});

export const emailAccessRoute = new Hono<AppEnv>();
const EMAIL_ACCESS_CODE_RESEND_COOLDOWN_SECONDS = 60;

emailAccessRoute.post("/email/access-code", async (c) => {
  c.header("Cache-Control", "no-store");
  const limit = await enforceRateLimit(c, "email_access_code", 3);
  if (!limit.ok) return fail(c, limit.message || "请求过于频繁，请稍后再试", limit.status || 429);

  const body = EmailAccessSchema.safeParse(await safeJsonBody(c));
  if (!body.success) return fail(c, "请求参数无效", 400, body.error.flatten());

  const db = getDb(c);
  const runtimeConfig = mergeRuntimeConfig(
    await readRuntimeConfig(db, c.env?.CREDENTIALS_ENCRYPTION_KEY),
    c.env,
  );
  const turnstile = await verifyTurnstile(c, body.data.turnstileToken, runtimeConfig);
  if (!turnstile.ok) {
    await writeRequestLog(c, "email_access_code", turnstile.status || 403, limit.ipHash);
    return fail(c, turnstile.message || "安全校验失败", turnstile.status || 403);
  }
  if (!runtimeConfig.resendApiKey) {
    return fail(c, "邮件验证服务未配置，请联系管理员", 503, { code: "EMAIL_ACCESS_UNAVAILABLE" });
  }

  const secret = getEmailAccessSecret(c.env.ADMIN_TOKEN, c.req.url);
  if (!secret) {
    return fail(c, "邮箱验证服务未安全配置，请联系管理员", 503, { code: "EMAIL_ACCESS_UNAVAILABLE" });
  }

  // 投递仍用用户填写的小写邮箱；冷却与 HMAC 主体用 canonical，防止 +tag / Gmail 点号刷码。
  const deliveryEmail = body.data.email.trim().toLowerCase();
  const subjectEmail = emailAccessSubject(deliveryEmail);
  const cooldown = await reserveCooldown(
    c,
    "email_access_code_recipient",
    subjectEmail,
    EMAIL_ACCESS_CODE_RESEND_COOLDOWN_SECONDS,
  );
  if (!cooldown.ok) {
    await writeRequestLog(c, "email_access_code_recipient", cooldown.status, limit.ipHash);
    return fail(c, cooldown.message, cooldown.status, {
      code: "EMAIL_CODE_COOLDOWN",
      retryAfterSeconds: cooldown.retryAfterSeconds,
    });
  }

  const code = await createEmailAccessCode(deliveryEmail, secret);
  const result = await sendEmail(db, runtimeConfig, {
    to: deliveryEmail,
    template: "email_access_code",
    templateData: { code, expiresInMinutes: "10" },
  });
  if (!result.ok) {
    try {
      await releaseCooldown(c, "email_access_code_recipient", cooldown);
    } catch (error) {
      console.warn("Failed to release email access code cooldown", { error });
    }
    await writeRequestLog(c, "email_access_code", 502, limit.ipHash);
    return fail(c, "验证码邮件发送失败，请稍后重试", 502);
  }

  return ok(c, {
    sent: true,
    expiresInSeconds: 600,
    resendCooldownSeconds: EMAIL_ACCESS_CODE_RESEND_COOLDOWN_SECONDS,
  });
});
