import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../bindings";
import { fail, getDb, ok, safeJsonBody } from "../lib/http";
import { getIpHash } from "../lib/security";
import {
  adminSystemConfigDefinitions,
  evaluateTurnstileConfigCompleteness,
  isSensitiveSystemConfigKey,
  isSupportedSystemConfigKey,
  normalizeSystemConfigValue,
} from "../lib/system-config-registry";
import { writeAdminAudit } from "../services/audit-service";
import { clearBusinessDataPreservingConfig, deleteSystemConfig, getSystemConfig, upsertSystemConfig } from "../services/admin-service";
import { isValidSecretEncryptionKey } from "../lib/secret-config";

export const adminSystemConfigRoute = new Hono<AppEnv>();

const CLEAR_BUSINESS_DATA_CONFIRMATION = "清除所有业务数据";

adminSystemConfigRoute.get("/", async (c) => {
  const config = await getSystemConfig(getDb(c), c.env?.CREDENTIALS_ENCRYPTION_KEY);
  const effectiveConfig: Record<string, string> = {
    ...config,
    resend_api_key: config.resend_api_key || c.env?.RESEND_API_KEY || "",
    turnstile_site_key: config.turnstile_site_key || c.env?.TURNSTILE_SITE_KEY || "",
    turnstile_secret_key: config.turnstile_secret_key || c.env?.TURNSTILE_SECRET_KEY || "",
  };
  const safeConfig = { ...config };
  const definitions = adminSystemConfigDefinitions().map((definition) => {
    if (!definition.sensitive) return definition;
    safeConfig[definition.key] = "";
    return { ...definition, configured: Boolean(effectiveConfig[definition.key]?.trim()) };
  });
  return ok(c, {
    config: safeConfig,
    definitions,
    turnstileStatus: evaluateTurnstileConfigCompleteness(effectiveConfig),
  });
});

const systemConfigSchema = z.object({
  key: z.string().trim().min(1).max(80),
  value: z.string().trim().max(500),
});

adminSystemConfigRoute.put("/", async (c) => {
  const body = systemConfigSchema.safeParse(await safeJsonBody(c));
  if (!body.success) return fail(c, "请求参数无效", 400, body.error.flatten());
  const normalized = normalizeSystemConfigValue(body.data.key, body.data.value);
  if (!normalized.ok) return fail(c, normalized.message, 400);
  if (
    isSensitiveSystemConfigKey(body.data.key)
    && normalized.value
    && !isValidSecretEncryptionKey(c.env?.CREDENTIALS_ENCRYPTION_KEY)
  ) {
    return fail(c, "保存敏感配置前必须配置 64 位 hex CREDENTIALS_ENCRYPTION_KEY", 503);
  }

  const db = getDb(c);
  const currentConfig = await getSystemConfig(db, c.env?.CREDENTIALS_ENCRYPTION_KEY);
  const nextConfig = {
    ...currentConfig,
    [body.data.key]: normalized.value,
  };
  const effectiveNextConfig: Record<string, string> = {
    ...nextConfig,
    resend_api_key: nextConfig.resend_api_key || c.env?.RESEND_API_KEY || "",
    turnstile_site_key: nextConfig.turnstile_site_key || c.env?.TURNSTILE_SITE_KEY || "",
    turnstile_secret_key: nextConfig.turnstile_secret_key || c.env?.TURNSTILE_SECRET_KEY || "",
  };
  const turnstileStatus = evaluateTurnstileConfigCompleteness(effectiveNextConfig);
  const isTurnstileConfigKey = ["turnstile_enabled", "turnstile_site_key", "turnstile_secret_key"].includes(body.data.key);
  if (isTurnstileConfigKey && !turnstileStatus.complete) {
    return fail(c, "启用 Turnstile 前必须先完整配置 Site Key 和 Secret Key", 400);
  }

  await upsertSystemConfig(db, body.data.key, normalized.value, c.env?.CREDENTIALS_ENCRYPTION_KEY);
  await writeAdminAudit(db, {
    action: "update_system_config",
    targetType: "system_config",
    targetId: body.data.key,
    metadata: { key: body.data.key },
    ipHash: await getIpHash(c),
  });
  const sensitive = isSensitiveSystemConfigKey(body.data.key);
  return ok(c, {
    key: body.data.key,
    value: sensitive ? "" : normalized.value,
    ...(sensitive ? { configured: Boolean(effectiveNextConfig[body.data.key]?.trim()) } : {}),
    turnstileStatus,
  });
});

const clearBusinessDataSchema = z.object({
  // 这里使用中文固定短语，与后台 UI 输入框一致。危险接口不能接受空 body 或布尔开关。
  confirmation: z.literal(CLEAR_BUSINESS_DATA_CONFIRMATION),
  // 明确把“保留配置/系统参数”写进请求契约，防止未来误把接口语义改成全库清空。
  preserveConfigAndSystemParams: z.literal(true),
});

adminSystemConfigRoute.post("/clear-business-data", async (c) => {
  const body = clearBusinessDataSchema.safeParse(await safeJsonBody(c));
  if (!body.success) return fail(c, "请明确确认清除所有业务数据", 400, body.error.flatten());

  const result = await clearBusinessDataPreservingConfig(getDb(c), await getIpHash(c));
  return ok(c, result);
});

adminSystemConfigRoute.delete("/:key", async (c) => {
  const key = c.req.param("key");
  if (isSupportedSystemConfigKey(key)) {
    return fail(c, `内置配置项 "${key}" 不可删除，请使用 PUT 接口修改其值`, 400);
  }
  const db = getDb(c);
  await deleteSystemConfig(db, key);
  await writeAdminAudit(db, {
    action: "delete_system_config",
    targetType: "system_config",
    targetId: key,
    metadata: { key },
    ipHash: await getIpHash(c),
  });
  return ok(c, { deleted: key });
});
