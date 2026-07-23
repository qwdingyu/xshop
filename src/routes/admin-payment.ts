/**
 * 支付配置管理后台 API — cf-shop
 *
 * 管理端通过 Web UI 配置支付渠道，不再需要 wrangler secret put。
 * 配置加密后存储到 systemConfig 表，运行时自动解密加载。
 *
 * 路由前缀：/admin/payment（由 admin.ts 挂载）
 *
 * API 设计：
 *   GET    /admin/payment/providers  — 获取所有 Provider 元数据 + 配置状态
 *   GET    /admin/payment/configs    — 获取已配置的 Provider 列表（含脱敏）
 *   PUT    /admin/payment/configs/:name — 加密保存指定 Provider 配置
 *   DELETE /admin/payment/configs/:name — 删除指定 Provider 配置
 */

import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../bindings";
import { fail, ok, getDb, safeJsonBody } from "../lib/http";
import {
  getPaymentProviderConfigs,
  countProviderOrdersRequiringCredentials,
  upsertPaymentProviderConfig,
  deletePaymentProviderConfig,
  setPaymentProviderEnabled,
} from "../services/admin-service";
import { writeAdminAudit } from "../services/audit-service";
import { getIpHash } from "../lib/security";
import {
  PAYMENT_PROVIDER_CATALOG,
  getProviderMeta,
  normalizeEasyPayApiBaseUrl,
  normalizeEasyPayEnabledPayTypes,
  normalizeEasyPayPayType,
  type PaymentProviderCatalogItem,
} from "../services/payments";
import { isSecurePaymentUrl } from "../lib/payment-url";

const SENSITIVE_CONFIG_PLACEHOLDER = "••••••••";
const CALLBACK_CRITICAL_FIELDS = ["EASYPAY_PID", "EASYPAY_KEY", "EASYPAY_API_BASE"] as const;

function isValidEncryptionKey(value: string | undefined): value is string {
  return Boolean(value && /^[a-fA-F0-9]{64}$/.test(value));
}

/**
 * 动态生成 Zod schema：根据支付渠道目录的 fields 构建运行时校验规则。
 * 只有 catalog 中定义的字段才接受，非法字段会被 strict 拒绝。
 */
function buildProviderSchema(meta: PaymentProviderCatalogItem) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of meta.fields) {
    let s = z.string().trim();
    if (field.required) {
      s = s.min(1, `${field.label} 不能为空`);
    }
    let schema: z.ZodTypeAny = s;
    if (field.type === "url") {
      // 支付类 URL 会承载回调或商户密钥相关请求；生产环境只接受 HTTPS，本地回环地址由底层工具放行。
      schema = schema.refine(
        (value) => !value || isSecurePaymentUrl(value),
        `${field.label} 必须使用 HTTPS（仅本机开发允许 HTTP）`,
      );
    }
    if (field.key === "EASYPAY_PAY_TYPE") {
      schema = schema.refine(
        (value) => !value || ["alipay", "wxpay", "qqpay"].includes(value.toLowerCase()),
        `${field.label} 只能填写 alipay、wxpay 或 qqpay`,
      );
    }
    if (field.key === "EASYPAY_ENABLED_PAY_TYPES") {
      schema = schema.refine(
        (value: string) => {
          if (!value) return true;
          const tokens = value.split(",").map((item: string) => item.trim().toLowerCase()).filter(Boolean);
          return tokens.length > 0 && tokens.every((item: string) => ["alipay", "wxpay", "qqpay"].includes(item));
        },
        `${field.label} 至少选择 alipay、wxpay 或 qqpay 中的一项`,
      );
    }
    if (!field.required) schema = schema.optional().default("");
    shape[field.key] = schema;
  }
  return z.object(shape).strict();
}

function normalizeProviderConfigForStorage(providerName: string, config: Record<string, string>): Record<string, string> {
  if (providerName !== "easypay") return config;
  const defaultPayType = normalizeEasyPayPayType(config.EASYPAY_PAY_TYPE);
  const enabledPayTypes = normalizeEasyPayEnabledPayTypes(config.EASYPAY_ENABLED_PAY_TYPES, defaultPayType);
  const nextEnabledPayTypes = enabledPayTypes.includes(defaultPayType)
    ? enabledPayTypes
    : [defaultPayType, ...enabledPayTypes];
  // 易支付服务商文档常给出 submit.php/mapi.php/api.php 任一端点；入库前收敛成根地址，
  // 让后端统一派生下单和查单 URL。这里不保存“查询接口”字段，避免运营把 submit.php 当成查单地址。
  return {
    ...config,
    EASYPAY_API_BASE: normalizeEasyPayApiBaseUrl(config.EASYPAY_API_BASE),
    EASYPAY_PAY_TYPE: defaultPayType,
    EASYPAY_ENABLED_PAY_TYPES: nextEnabledPayTypes.join(","),
  };
}

async function resolveSensitiveConfigPlaceholders(
  db: ReturnType<typeof getDb>,
  providerName: string,
  meta: PaymentProviderCatalogItem,
  config: Record<string, string>,
  encryptionKey: string,
): Promise<{ ok: true; config: Record<string, string> } | { ok: false; message: string }> {
  const nextConfig = { ...config };
  const placeholderFields = meta.fields.filter((field) => (
    field.sensitive && nextConfig[field.key]?.trim() === SENSITIVE_CONFIG_PLACEHOLDER
  ));
  if (placeholderFields.length === 0) return { ok: true, config: nextConfig };

  const existing = await getPaymentProviderConfigs(db, encryptionKey);
  const existingConfig = existing[providerName]?.config || {};
  for (const field of placeholderFields) {
    const preservedValue = existingConfig[field.key];
    if (!preservedValue) {
      return { ok: false, message: `${field.label} 不能为空` };
    }
    nextConfig[field.key] = preservedValue;
  }

  return { ok: true, config: nextConfig };
}

export const adminPaymentRoute = new Hono<AppEnv>();

/**
 * GET /admin/payment/health
 * 返回支付配置基础健康状态，不泄露任何密钥内容。
 */
adminPaymentRoute.get("/health", (c) => {
  const encryptionKey = c.env.CREDENTIALS_ENCRYPTION_KEY || "";
  return ok(c, {
    credentialsEncryptionKey: {
      configured: encryptionKey.length > 0,
      valid: isValidEncryptionKey(encryptionKey),
    },
  });
});

/**
 * GET /admin/payment/providers
 * 返回所有支持的支付渠道元数据 + 配置状态。
 * 前端据此动态渲染配置表单。
 */
adminPaymentRoute.get("/providers", async (c) => {
  const db = getDb(c);
  const configStatuses = await getPaymentProviderConfigs(db, c.env.CREDENTIALS_ENCRYPTION_KEY);

  const providers = PAYMENT_PROVIDER_CATALOG.map((meta) => {
    const status = configStatuses[meta.name];
    return {
      name: meta.name,
      displayName: meta.displayName,
      description: meta.description,
      supportedCurrencies: [...meta.supportedCurrencies],
      configured: status?.configured ?? false,
      enabled: status?.enabled ?? false,
      fields: meta.fields.map((f) => ({
        key: f.key,
        label: f.label,
        type: f.type || "text",
        required: f.required,
        sensitive: f.sensitive,
        placeholder: f.placeholder || "",
        hint: f.hint || "",
      })),
    };
  });

  return ok(c, { providers });
});

/**
 * GET /admin/payment/configs
 * 返回已配置的 Provider 列表（仅存在加密值的）。
 * 敏感字段以 "••••••••" 返回。
 */
adminPaymentRoute.get("/configs", async (c) => {
  const db = getDb(c);
  const configStatuses = await getPaymentProviderConfigs(db, c.env.CREDENTIALS_ENCRYPTION_KEY);

  const result = Object.entries(configStatuses).map(([name, status]) => ({
    name,
    enabled: status.enabled,
    configured: status.configured,
    values: Object.fromEntries(
      (getProviderMeta(name)?.fields || [])
        .filter((field) => !field.sensitive)
        .map((field) => [field.key, status.config[field.key] || ""]),
    ),
  }));

  return ok(c, { configs: result });
});

/**
 * PUT /admin/payment/configs/:name
 * 加密保存指定 Provider 的完整配置。
 *
 * 前置条件：
 * - CREDENTIALS_ENCRYPTION_KEY 必须在环境变量中配置
 * - provider 名称必须在 PAYMENT_PROVIDER_CATALOG 中
 *
 * 安全设计：
 * - 请求体中的字段必须与支付渠道目录 fields 定义一致
 * - 整个 payload 经 AES-256-GCM 加密后存储
 * - 敏感字段（sensitive=true）在 UI 显示时脱敏
 */
adminPaymentRoute.put("/configs/:name", async (c) => {
  const providerName = c.req.param("name");
  const meta = getProviderMeta(providerName);
  if (!meta) {
    return fail(c, `不支持的支付渠道: ${providerName}`, 400);
  }

  // 检查加密密钥是否可用
  const encryptionKey = c.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!isValidEncryptionKey(encryptionKey)) {
    return fail(c, "CREDENTIALS_ENCRYPTION_KEY 未配置或格式无效（需要 64 字符 hex）", 503);
  }

  const body = buildProviderSchema(meta).safeParse(await safeJsonBody(c));
  if (!body.success) {
    return fail(c, "请求参数无效", 400, body.error.flatten());
  }

  const db = getDb(c);
  const resolvedConfig = await resolveSensitiveConfigPlaceholders(
    db,
    providerName,
    meta,
    body.data as Record<string, string>,
    encryptionKey,
  );
  if (!resolvedConfig.ok) return fail(c, resolvedConfig.message, 400);
  const normalizedConfig = normalizeProviderConfigForStorage(providerName, resolvedConfig.config);

  const existingConfigs = await getPaymentProviderConfigs(db, encryptionKey);
  const existingStatus = existingConfigs[providerName];
  const existingConfig = existingStatus?.config;
  const changesCallbackCredentials = Boolean(existingConfig && CALLBACK_CRITICAL_FIELDS.some(
    (key) => (existingConfig[key] || "") !== (normalizedConfig[key] || ""),
  ));
  if (changesCallbackCredentials) {
    const dependentOrders = await countProviderOrdersRequiringCredentials(db, providerName);
    if (dependentOrders > 0) {
      return fail(c, `仍有 ${dependentOrders} 笔订单依赖当前支付凭据，请先禁用新收款并完成待处理订单`, 409, {
        code: "PAYMENT_PROVIDER_HAS_DEPENDENT_ORDERS",
        dependentOrders,
      });
    }
  }

  // 加密并保存（各配置项保持明文对应的键名，运行时合入 env 即可直接使用）。
  // normalizedConfig 是最终入库值，审计也记录归一化后的字段，方便排查运营粘贴了哪个端点。
  // 配置保存与启用操作分离：新配置默认关闭，已启用配置编辑后保持启用。
  const savedEnabled = await upsertPaymentProviderConfig(db, providerName, normalizedConfig, encryptionKey);

  const auditIpHash = await getIpHash(c);
  await writeAdminAudit(db, {
    action: "update_payment_provider",
    targetType: "system_config",
    targetId: `payment_provider:${providerName}`,
    metadata: { provider: providerName, fields: Object.keys(normalizedConfig).join(",") },
    ipHash: auditIpHash,
  });

  return ok(c, {
    provider: providerName,
    enabled: savedEnabled,
    message: savedEnabled ? "支付配置已保存，当前仍保持启用" : "支付配置已保存，当前未启用，请验证后手动启用",
  });
});

const paymentEnabledSchema = z.object({
  enabled: z.boolean(),
});

adminPaymentRoute.patch("/configs/:name/enabled", async (c) => {
  const providerName = c.req.param("name");
  const meta = getProviderMeta(providerName);
  if (!meta) {
    return fail(c, `不支持的支付渠道: ${providerName}`, 400);
  }

  const encryptionKey = c.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!isValidEncryptionKey(encryptionKey)) {
    return fail(c, "CREDENTIALS_ENCRYPTION_KEY 未配置或格式无效（需要 64 字符 hex）", 503);
  }

  const body = paymentEnabledSchema.safeParse(await safeJsonBody(c));
  if (!body.success) return fail(c, "请求参数无效", 400, body.error.flatten());

  const db = getDb(c);
  const updated = await setPaymentProviderEnabled(db, providerName, body.data.enabled, encryptionKey);
  if (!updated) return fail(c, "支付配置不存在，请先保存完整配置", 404);

  await writeAdminAudit(db, {
    action: body.data.enabled ? "enable_payment_provider" : "disable_payment_provider",
    targetType: "system_config",
    targetId: `payment_provider:${providerName}`,
    metadata: { provider: providerName, enabled: body.data.enabled },
    ipHash: await getIpHash(c),
  });

  return ok(c, { provider: providerName, enabled: body.data.enabled, message: body.data.enabled ? "支付渠道已启用" : "支付渠道已禁用" });
});

/**
 * DELETE /admin/payment/configs/:name
 * 删除指定 Provider 的配置（禁用此支付渠道）。
 */
adminPaymentRoute.delete("/configs/:name", async (c) => {
  const providerName = c.req.param("name");
  const meta = getProviderMeta(providerName);
  if (!meta) {
    return fail(c, `不支持的支付渠道: ${providerName}`, 400);
  }

  const db = getDb(c);
  const dependentOrders = await countProviderOrdersRequiringCredentials(db, providerName);
  if (dependentOrders > 0) {
    return fail(c, `仍有 ${dependentOrders} 笔订单依赖当前支付凭据，请改为禁用渠道`, 409, {
      code: "PAYMENT_PROVIDER_HAS_DEPENDENT_ORDERS",
      dependentOrders,
    });
  }
  await deletePaymentProviderConfig(db, providerName);

  const delIpHash = await getIpHash(c);
  await writeAdminAudit(db, {
    action: "delete_payment_provider",
    targetType: "system_config",
    targetId: `payment_provider:${providerName}`,
    metadata: { provider: providerName },
    ipHash: delIpHash,
  });

  return ok(c, { provider: providerName, message: "支付配置已删除" });
});
