/**
 * 运行时配置读取工具。
 *
 * 优先从 systemConfig 数据库表读取，缺失时回退到 c.env。
 * 用于将可后台配置的 key 从环境变量迁移到数据库。
 */

import type { DbType } from "../db/client";
import { readSystemConfigMap } from "./system-config-registry";
import { decryptSecretConfigValue } from "./secret-config";

export type RuntimeConfig = {
  resendApiKey: string;
  emailFrom: string;
  turnstileEnabled: boolean;
  turnstileSecretKey: string;
  allowTurnstileBypassForSmoke: boolean;
  inventoryWarningEmailTo: string;
};

export async function readRuntimeConfig(db: DbType, encryptionKey?: string): Promise<RuntimeConfig> {
  const map = await readSystemConfigMap(db, [
    "resend_api_key",
    "email_from",
    "turnstile_enabled",
    "turnstile_secret_key",
    "allow_turnstile_bypass_for_smoke",
    "inventory_warning_email_to",
  ]);

  const [resendApiKey, turnstileSecretKey] = await Promise.all([
    decryptSecretConfigValue(map.resend_api_key || "", encryptionKey),
    decryptSecretConfigValue(map.turnstile_secret_key || "", encryptionKey),
  ]);

  return {
    resendApiKey,
    emailFrom: map.email_from || "",
    turnstileEnabled: map.turnstile_enabled === "true",
    turnstileSecretKey,
    allowTurnstileBypassForSmoke: map.allow_turnstile_bypass_for_smoke === "true",
    inventoryWarningEmailTo: map.inventory_warning_email_to || "",
  };
}

export function mergeRuntimeConfig(
  dbConfig: RuntimeConfig,
  env: {
    RESEND_API_KEY?: string;
    EMAIL_FROM?: string;
    TURNSTILE_SECRET_KEY?: string;
    ALLOW_TURNSTILE_BYPASS_FOR_SMOKE?: string;
    INVENTORY_WARNING_EMAIL_TO?: string;
  },
): RuntimeConfig {
  return {
    resendApiKey: dbConfig.resendApiKey || env.RESEND_API_KEY || "",
    emailFrom: dbConfig.emailFrom || env.EMAIL_FROM || "",
    turnstileEnabled: dbConfig.turnstileEnabled,
    turnstileSecretKey: dbConfig.turnstileSecretKey || env.TURNSTILE_SECRET_KEY || "",
    allowTurnstileBypassForSmoke:
      dbConfig.allowTurnstileBypassForSmoke || env.ALLOW_TURNSTILE_BYPASS_FOR_SMOKE === "true",
    inventoryWarningEmailTo: dbConfig.inventoryWarningEmailTo || env.INVENTORY_WARNING_EMAIL_TO || "",
  };
}
