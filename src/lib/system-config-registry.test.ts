import { describe, expect, it } from "vitest";
import {
  PUBLIC_SYSTEM_CONFIG_KEYS,
  SYSTEM_CONFIG_KEYS,
  buildBalanceRechargeConfig,
  buildOperationalRetentionPolicy,
  buildSystemConfigMap,
  isSupportedSystemConfigKey,
  normalizeSystemConfigValue,
} from "./system-config-registry";
import definitions from "./system-config-definitions.json";

describe("system-config-registry", () => {
  it("只承认注册过的系统参数", () => {
    expect(SYSTEM_CONFIG_KEYS).toEqual(definitions.map((definition) => definition.key));
    expect(SYSTEM_CONFIG_KEYS).toContain("shop_name");
    expect(SYSTEM_CONFIG_KEYS).toContain("balance_recharge_enabled");
    expect(SYSTEM_CONFIG_KEYS).toContain("balance_recharge_min_cents");
    expect(SYSTEM_CONFIG_KEYS).toContain("balance_recharge_max_cents");
    expect(SYSTEM_CONFIG_KEYS).toContain("support_email");
    expect(SYSTEM_CONFIG_KEYS).toContain("offline_pay_hint");
    expect(SYSTEM_CONFIG_KEYS).toContain("balance_payment_enabled");
    expect(SYSTEM_CONFIG_KEYS).toContain("order_expire_minutes");
    expect(isSupportedSystemConfigKey("offline_pay_hint")).toBe(true);
    expect(isSupportedSystemConfigKey("zombie_param")).toBe(false);
  });

  it("拒绝保存未注册参数，避免僵尸配置", () => {
    const result = normalizeSystemConfigValue("zombie_param", "1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("未注册");
    }
  });

  it("校验整数和布尔参数", () => {
    expect(normalizeSystemConfigValue("order_expire_minutes", "30")).toEqual({ ok: true, value: "30" });
    expect(normalizeSystemConfigValue("order_expire_minutes", "3").ok).toBe(false);
    expect(normalizeSystemConfigValue("inventory_warning_enabled", "true")).toEqual({ ok: true, value: "true" });
    expect(normalizeSystemConfigValue("balance_payment_enabled", "true")).toEqual({ ok: true, value: "true" });
    expect(normalizeSystemConfigValue("balance_payment_enabled", "on").ok).toBe(false);
    expect(normalizeSystemConfigValue("inventory_warning_enabled", "yes").ok).toBe(false);
    expect(normalizeSystemConfigValue("operational_data_retention_enabled", "false")).toEqual({ ok: true, value: "false" });
    expect(normalizeSystemConfigValue("request_log_retention_days", "30")).toEqual({ ok: true, value: "30" });
    expect(normalizeSystemConfigValue("request_log_retention_days", "0").ok).toBe(false);
    expect(normalizeSystemConfigValue("request_log_retention_days", "366").ok).toBe(false);
  });

  it("构建有边界且可暂停的运营数据保留策略", () => {
    expect(buildOperationalRetentionPolicy({
      operational_data_retention_enabled: "false",
      rate_limit_retention_days: "7",
      idempotency_retention_days: "45",
      request_log_retention_days: "60",
      email_log_retention_days: "75",
      business_log_retention_days: "180",
      admin_audit_retention_days: "365",
    })).toEqual({
      enabled: false,
      rateLimitDays: 7,
      idempotencyDays: 45,
      requestLogDays: 60,
      emailLogDays: 75,
      businessLogDays: 180,
      adminAuditDays: 365,
    });

    expect(buildOperationalRetentionPolicy({
      operational_data_retention_enabled: "invalid",
      rate_limit_retention_days: "0",
      idempotency_retention_days: "9999",
      request_log_retention_days: "NaN",
    })).toMatchObject({
      enabled: false,
      rateLimitDays: 1,
      idempotencyDays: 30,
      requestLogDays: 30,
    });
  });

  it("充值金额配置异常时回落到已注册默认值", () => {
    expect(buildBalanceRechargeConfig({
      balance_recharge_enabled: "true",
      balance_recharge_min_cents: "NaN",
      balance_recharge_max_cents: "Infinity",
    })).toEqual({ enabled: true, minCents: 100, maxCents: 500000 });

    expect(buildBalanceRechargeConfig({
      balance_recharge_enabled: "true",
      balance_recharge_min_cents: "0",
      balance_recharge_max_cents: "10000001",
    })).toEqual({ enabled: true, minCents: 100, maxCents: 500000 });
  });

  it("充值限额定义为 unit=cents，库内仍以分为整数校验", () => {
    const minDef = definitions.find((item) => item.key === "balance_recharge_min_cents");
    const maxDef = definitions.find((item) => item.key === "balance_recharge_max_cents");
    expect(minDef).toMatchObject({ unit: "cents", type: "integer", defaultValue: "100" });
    expect(maxDef).toMatchObject({ unit: "cents", type: "integer", defaultValue: "500000" });
    expect(String(minDef?.label || "")).toContain("元");
    expect(String(maxDef?.label || "")).toContain("元");
    expect(String(minDef?.label || "")).not.toContain("（分）");
    // 管理员按元理解：5000 元 = 500000 分，normalize 仍收分整数
    expect(normalizeSystemConfigValue("balance_recharge_max_cents", "500000")).toEqual({
      ok: true,
      value: "500000",
    });
    expect(normalizeSystemConfigValue("balance_recharge_max_cents", "5000.00").ok).toBe(false);
    // 越界错误按元提示，避免把 min/max 分整数直接甩给商户
    const belowMin = normalizeSystemConfigValue("balance_recharge_min_cents", "0");
    expect(belowMin.ok).toBe(false);
    if (!belowMin.ok) {
      expect(belowMin.message).toContain("0.01 元");
      expect(belowMin.message).not.toMatch(/不能小于 1$/);
    }
    const aboveMax = normalizeSystemConfigValue("balance_recharge_max_cents", "10000001");
    expect(aboveMax.ok).toBe(false);
    if (!aboveMax.ok) {
      expect(aboveMax.message).toContain("100000.00 元");
    }
  });

  it("充值最高金额低于最低金额时以最低金额收口", () => {
    expect(buildBalanceRechargeConfig({
      balance_recharge_enabled: "true",
      balance_recharge_min_cents: "2000",
      balance_recharge_max_cents: "1000",
    })).toEqual({ enabled: true, minCents: 2000, maxCents: 2000 });
  });

  it("校验品牌公开参数", () => {
    expect(normalizeSystemConfigValue("shop_name", "我的发卡小店")).toEqual({ ok: true, value: "我的发卡小店" });
    expect(normalizeSystemConfigValue("support_email", "help@example.com")).toEqual({ ok: true, value: "help@example.com" });
    expect(normalizeSystemConfigValue("support_email", "not-email").ok).toBe(false);
    expect(normalizeSystemConfigValue("inventory_warning_email_to", "support@example.com")).toEqual({ ok: true, value: "support@example.com" });
    expect(normalizeSystemConfigValue("inventory_warning_email_to", "not-email").ok).toBe(false);
  });

  it("公开配置缺行时返回默认值", () => {
    const config = buildSystemConfigMap([{ key: "offline_pay_hint", value: "自定义提示" }], [
      "shop_name",
      "turnstile_enabled",
      "balance_payment_enabled",
      "offline_pay_hint",
      "turnstile_site_key",
    ]);
    expect(config.shop_name).toBe("Shop");
    expect(config.turnstile_enabled).toBe("false");
    expect(config.balance_payment_enabled).toBe("false");
    expect(config.offline_pay_hint).toBe("自定义提示");
    expect(config.turnstile_site_key).toBe("");
  });

  it("公开配置不包含收款码和敏感后台参数", () => {
    expect(PUBLIC_SYSTEM_CONFIG_KEYS).toEqual([
      "shop_name",
      "support_email",
      "balance_payment_enabled",
      "balance_recharge_enabled",
      "balance_recharge_min_cents",
      "balance_recharge_max_cents",
      "offline_pay_hint",
      "turnstile_enabled",
      "turnstile_site_key",
    ]);
    expect(PUBLIC_SYSTEM_CONFIG_KEYS).not.toContain("offline_pay_qr_wechat");
    expect(PUBLIC_SYSTEM_CONFIG_KEYS).not.toContain("offline_pay_qr_alipay");
    expect(PUBLIC_SYSTEM_CONFIG_KEYS).not.toContain("turnstile_secret_key");
  });
});
