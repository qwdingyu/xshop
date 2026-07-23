import { inArray } from "drizzle-orm";
import type { DbType } from "../db/client";
import { systemConfig } from "../db/schema";
import definitions from "./system-config-definitions.json";

export type SystemConfigValueType = "string" | "integer" | "boolean";

/** integer 存储单位；cents 表示后台 UI 按「元」编辑、库内仍是分 */
export type SystemConfigIntegerUnit = "cents" | "count";

export type SystemConfigDefinition = {
  key: string;
  label: string;
  description: string;
  effect: string;
  scope: "public" | "admin";
  type: SystemConfigValueType;
  /** 仅 type=integer：cents=金额（分存储，Admin 按元展示）；count/缺省=纯整数 */
  unit?: SystemConfigIntegerUnit;
  sensitive?: boolean;
  configured?: boolean;
  defaultValue: string;
  format?: "email";
  maxLength?: number;
  /** type=integer 时与存储单位一致（cents 时为分） */
  min?: number;
  max?: number;
  group?: string;
  order?: number;
};

export const SYSTEM_CONFIG_DEFINITIONS = definitions as readonly SystemConfigDefinition[];

export type SupportedSystemConfigKey = typeof SYSTEM_CONFIG_DEFINITIONS[number]["key"];

const definitionByKey = new Map<string, SystemConfigDefinition>(
  SYSTEM_CONFIG_DEFINITIONS.map((definition) => [definition.key, definition]),
);

export const SYSTEM_CONFIG_KEYS = SYSTEM_CONFIG_DEFINITIONS.map((definition) => definition.key);
export const PUBLIC_SYSTEM_CONFIG_KEYS = SYSTEM_CONFIG_DEFINITIONS
  .filter((definition) => definition.scope === "public")
  .map((definition) => definition.key);
const systemConfigKeySet = new Set<string>(SYSTEM_CONFIG_KEYS);

export function getSystemConfigDefinition(key: string): SystemConfigDefinition | undefined {
  return definitionByKey.get(key);
}

export function isSupportedSystemConfigKey(key: string): key is SupportedSystemConfigKey {
  return definitionByKey.has(key);
}

export function isSensitiveSystemConfigKey(key: string): boolean {
  return Boolean(getSystemConfigDefinition(key)?.sensitive);
}

/** unit=cents 的 min/max 以分存储，错误提示按元展示（CNY 两位小数） */
function formatCentsBoundForMessage(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${sign}${whole}.${frac}`;
}

export function normalizeSystemConfigValue(key: string, value: string): { ok: true; value: string } | { ok: false; message: string } {
  const definition = getSystemConfigDefinition(key);
  if (!definition) {
    return { ok: false, message: `系统参数 "${key}" 未注册，保存后不会被业务代码读取，已拒绝写入` };
  }

  const trimmed = value.trim();
  if (definition.type === "boolean") {
    if (trimmed !== "true" && trimmed !== "false") {
      return { ok: false, message: `${definition.label} 只能填写 true 或 false` };
    }
    return { ok: true, value: trimmed };
  }

  if (definition.type === "integer") {
    if (!/^-?\d+$/.test(trimmed)) {
      // unit=cents：API/库仍是分整数；Admin UI 已按元转换后再提交
      return {
        ok: false,
        message: definition.unit === "cents"
          ? `${definition.label} 必须是整数（库内以分为单位存储）`
          : `${definition.label} 必须是整数`,
      };
    }
    const parsed = Number(trimmed);
    if (definition.min !== undefined && parsed < definition.min) {
      return {
        ok: false,
        message: definition.unit === "cents"
          ? `${definition.label} 不能小于 ${formatCentsBoundForMessage(definition.min)} 元`
          : `${definition.label} 不能小于 ${definition.min}`,
      };
    }
    if (definition.max !== undefined && parsed > definition.max) {
      return {
        ok: false,
        message: definition.unit === "cents"
          ? `${definition.label} 不能大于 ${formatCentsBoundForMessage(definition.max)} 元`
          : `${definition.label} 不能大于 ${definition.max}`,
      };
    }
    return { ok: true, value: String(parsed) };
  }

  if (definition.maxLength !== undefined && trimmed.length > definition.maxLength) {
    return { ok: false, message: `${definition.label} 不能超过 ${definition.maxLength} 个字符` };
  }
  if (definition.format === "email" && trimmed && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return { ok: false, message: `${definition.label} 必须是有效邮箱地址` };
  }
  return { ok: true, value: trimmed };
}

export function buildSystemConfigMap(rows: Array<{ key: string; value: string }>, keys = SYSTEM_CONFIG_KEYS): Record<string, string> {
  const config: Record<string, string> = {};
  for (const key of keys) {
    const definition = getSystemConfigDefinition(key);
    if (definition) config[key] = definition.defaultValue;
  }
  for (const row of rows) {
    if (systemConfigKeySet.has(row.key) && keys.some((key) => key === row.key)) {
      config[row.key] = row.value;
    }
  }
  return config;
}

export async function readSystemConfigMap(db: DbType, keys = SYSTEM_CONFIG_KEYS): Promise<Record<string, string>> {
  const rows = await db
    .select({ key: systemConfig.key, value: systemConfig.value })
    .from(systemConfig)
    .where(inArray(systemConfig.key, keys));
  return buildSystemConfigMap(rows, keys);
}

export async function getOrderExpireMinutes(db: DbType): Promise<number> {
  const config = await readSystemConfigMap(db, ["order_expire_minutes"]);
  const parsed = Number(config.order_expire_minutes);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
}

export async function isBalancePaymentEnabled(db: DbType): Promise<boolean> {
  const config = await readSystemConfigMap(db, ["balance_payment_enabled"]);
  return config.balance_payment_enabled === "true";
}

export type BalanceRechargeConfig = { enabled: boolean; minCents: number; maxCents: number };

function boundedInteger(config: Record<string, string>, key: string, fallback: number): number {
  const value = Number(config[key]);
  const definition = getSystemConfigDefinition(key);
  if (!Number.isInteger(value)) return fallback;
  if (definition?.min !== undefined && value < definition.min) return fallback;
  if (definition?.max !== undefined && value > definition.max) return fallback;
  return value;
}

/**
 * 充值限额同时约束前端展示和后端入账，必须从同一注册表边界构建。
 * 即使数据库被绕过后台校验直接写入非法值，也回落到声明的默认值，不能让 NaN 绕过金额比较。
 */
export function buildBalanceRechargeConfig(config: Record<string, string>): BalanceRechargeConfig {
  const minDefinition = getSystemConfigDefinition("balance_recharge_min_cents");
  const maxDefinition = getSystemConfigDefinition("balance_recharge_max_cents");
  const defaultMin = Number(minDefinition?.defaultValue || 100);
  const defaultMax = Number(maxDefinition?.defaultValue || 500000);
  const minCents = boundedInteger(config, "balance_recharge_min_cents", defaultMin);
  const configuredMax = boundedInteger(config, "balance_recharge_max_cents", defaultMax);
  return {
    enabled: config.balance_recharge_enabled === "true",
    minCents,
    maxCents: Math.max(minCents, configuredMax),
  };
}

export async function getBalanceRechargeConfig(db: DbType): Promise<BalanceRechargeConfig> {
  const config = await readSystemConfigMap(db, [
    "balance_recharge_enabled",
    "balance_recharge_min_cents",
    "balance_recharge_max_cents",
  ]);
  return buildBalanceRechargeConfig(config);
}

export async function getOrderExpiresAt(db: DbType): Promise<string> {
  const minutes = await getOrderExpireMinutes(db);
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

export type OperationalRetentionPolicy = {
  enabled: boolean;
  rateLimitDays: number;
  idempotencyDays: number;
  requestLogDays: number;
  emailLogDays: number;
  businessLogDays: number;
  adminAuditDays: number;
};

const OPERATIONAL_RETENTION_KEYS = [
  "operational_data_retention_enabled",
  "rate_limit_retention_days",
  "idempotency_retention_days",
  "request_log_retention_days",
  "email_log_retention_days",
  "business_log_retention_days",
  "admin_audit_retention_days",
];

export function buildOperationalRetentionPolicy(config: Record<string, string>): OperationalRetentionPolicy {
  const enabledValue = config.operational_data_retention_enabled;
  return {
    enabled: enabledValue === undefined || enabledValue === "true",
    rateLimitDays: boundedInteger(config, "rate_limit_retention_days", 1),
    idempotencyDays: boundedInteger(config, "idempotency_retention_days", 30),
    requestLogDays: boundedInteger(config, "request_log_retention_days", 30),
    emailLogDays: boundedInteger(config, "email_log_retention_days", 30),
    businessLogDays: boundedInteger(config, "business_log_retention_days", 90),
    adminAuditDays: boundedInteger(config, "admin_audit_retention_days", 90),
  };
}

export async function readOperationalRetentionPolicy(db: DbType): Promise<OperationalRetentionPolicy> {
  const config = await readSystemConfigMap(db, OPERATIONAL_RETENTION_KEYS);
  return buildOperationalRetentionPolicy(config);
}

/**
 * 读取下单限流配置：时间窗口（秒）+ 窗口内最大订单数。
 * 缺失或非法值时回退到默认值 300 秒 / 3 次。
 */
export async function getOrderRateLimitConfig(db: DbType): Promise<{ windowSeconds: number; maxOrders: number }> {
  const config = await readSystemConfigMap(db, [
    "order_rate_limit_window_seconds",
    "order_rate_limit_max_orders",
  ]);
  const windowSeconds = Number(config.order_rate_limit_window_seconds);
  const maxOrders = Number(config.order_rate_limit_max_orders);
  return {
    windowSeconds: Number.isFinite(windowSeconds) && windowSeconds > 0 ? windowSeconds : 300,
    maxOrders: Number.isFinite(maxOrders) && maxOrders > 0 ? maxOrders : 3,
  };
}

export function publicSystemConfigDefinitions(): SystemConfigDefinition[] {
  return SYSTEM_CONFIG_DEFINITIONS.filter((definition) => definition.scope === "public");
}

export function adminSystemConfigDefinitions(): SystemConfigDefinition[] {
  return [...SYSTEM_CONFIG_DEFINITIONS];
}

export type TurnstileConfigCompleteness = {
  enabled: boolean;
  siteKeyConfigured: boolean;
  secretKeyConfigured: boolean;
  complete: boolean;
};

export function evaluateTurnstileConfigCompleteness(config: Record<string, string>): TurnstileConfigCompleteness {
  const enabled = config.turnstile_enabled === "true";
  const siteKeyConfigured = Boolean(config.turnstile_site_key?.trim());
  const secretKeyConfigured = Boolean(config.turnstile_secret_key?.trim());
  return {
    enabled,
    siteKeyConfigured,
    secretKeyConfigured,
    complete: !enabled || (siteKeyConfigured && secretKeyConfigured),
  };
}
