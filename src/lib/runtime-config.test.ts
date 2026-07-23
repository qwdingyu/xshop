/**
 * 运行时配置工具单元测试
 *
 * 测试覆盖：
 * - mergeRuntimeConfig：DB 配置优先于环境变量的优先级策略
 * - readRuntimeConfig：通过 mock readSystemConfigMap 验证配置读取
 */
import { describe, it, expect, vi } from "vitest";
import type { DbType } from "../db/client";
import { mergeRuntimeConfig } from "./runtime-config";
import type { RuntimeConfig } from "./runtime-config";

// ── mergeRuntimeConfig 纯函数测试 ──────────────────────────────────────
// 优先级规则：dbConfig > env > 空字符串兜底

describe("mergeRuntimeConfig", () => {
  // 基础默认 DB 配置
  const baseDb: RuntimeConfig = {
    resendApiKey: "",
    emailFrom: "",
    turnstileEnabled: false,
    turnstileSecretKey: "",
    allowTurnstileBypassForSmoke: false,
    inventoryWarningEmailTo: "",
  };

  // 基础默认环境变量
  const baseEnv = {
    RESEND_API_KEY: "",
    EMAIL_FROM: "",
    TURNSTILE_SECRET_KEY: "",
    ALLOW_TURNSTILE_BYPASS_FOR_SMOKE: "",
    INVENTORY_WARNING_EMAIL_TO: "",
  };

  it("当 dbConfig 和 env 都为空时返回空字符串", () => {
    const result = mergeRuntimeConfig(baseDb, baseEnv);
    expect(result.resendApiKey).toBe("");
    expect(result.emailFrom).toBe("");
    expect(result.turnstileEnabled).toBe(false);
    expect(result.turnstileSecretKey).toBe("");
    expect(result.allowTurnstileBypassForSmoke).toBe(false);
    expect(result.inventoryWarningEmailTo).toBe("");
  });

  it("优先使用 dbConfig（DB 配置 > env 变量）", () => {
    const dbConfig: RuntimeConfig = {
      ...baseDb,
      resendApiKey: "re_db_key",
      emailFrom: "db@example.com",
    };
    const env = {
      ...baseEnv,
      RESEND_API_KEY: "re_env_key",
      EMAIL_FROM: "env@example.com",
    };
    const result = mergeRuntimeConfig(dbConfig, env);
    expect(result.resendApiKey).toBe("re_db_key");
    expect(result.emailFrom).toBe("db@example.com");
  });

  it("dbConfig 为空时回退到 env 变量", () => {
    const dbConfig: RuntimeConfig = { ...baseDb };
    const env = {
      ...baseEnv,
      RESEND_API_KEY: "re_env_key",
      TURNSTILE_SECRET_KEY: "0x_env_secret",
      INVENTORY_WARNING_EMAIL_TO: "admin@example.com",
    };
    const result = mergeRuntimeConfig(dbConfig, env);
    expect(result.resendApiKey).toBe("re_env_key");
    expect(result.turnstileEnabled).toBe(false);
    expect(result.turnstileSecretKey).toBe("0x_env_secret");
    expect(result.inventoryWarningEmailTo).toBe("admin@example.com");
  });

  it("dbConfig 和 env 都为空时返回空串兜底", () => {
    const result = mergeRuntimeConfig(
      { ...baseDb, resendApiKey: "", emailFrom: "" },
      { ...baseEnv, RESEND_API_KEY: "", EMAIL_FROM: "" }
    );
    expect(result.resendApiKey).toBe("");
    expect(result.emailFrom).toBe("");
  });

  it("turnstileEnabled 仅由 dbConfig 控制", () => {
    const result = mergeRuntimeConfig(
      { ...baseDb, turnstileEnabled: true },
      baseEnv
    );
    expect(result.turnstileEnabled).toBe(true);
  });

  it("allowTurnstileBypassForSmoke boolean 类型：dbConfig 为 true 时返回 true", () => {
    const dbConfig: RuntimeConfig = { ...baseDb, allowTurnstileBypassForSmoke: true };
    const result = mergeRuntimeConfig(dbConfig, baseEnv);
    expect(result.allowTurnstileBypassForSmoke).toBe(true);
  });

  it("allowTurnstileBypassForSmoke：dbConfig false 但 env 为 'true' 时返回 true", () => {
    const result = mergeRuntimeConfig(
      { ...baseDb, allowTurnstileBypassForSmoke: false },
      { ...baseEnv, ALLOW_TURNSTILE_BYPASS_FOR_SMOKE: "true" }
    );
    expect(result.allowTurnstileBypassForSmoke).toBe(true);
  });

  it("allowTurnstileBypassForSmoke：两者都 false 时返回 false", () => {
    const result = mergeRuntimeConfig(
      { ...baseDb, allowTurnstileBypassForSmoke: false },
      { ...baseEnv, ALLOW_TURNSTILE_BYPASS_FOR_SMOKE: "false" }
    );
    expect(result.allowTurnstileBypassForSmoke).toBe(false);
  });

  it("混合场景：部分从 dbConfig、部分从 env、部分为空", () => {
    const dbConfig: RuntimeConfig = {
      ...baseDb,
      resendApiKey: "re_db",
      emailFrom: "",        // db 为空，期待从 env 获取
      turnstileEnabled: false,
      turnstileSecretKey: "0x_db",
      allowTurnstileBypassForSmoke: false,
      inventoryWarningEmailTo: "",  // db 为空，env 也为空，期待空串
    };
    const env = {
      ...baseEnv,
      RESEND_API_KEY: "re_env",   // 有值但 db 优先级更高
      EMAIL_FROM: "env@example.com",
      TURNSTILE_SECRET_KEY: "0x_env",
      INVENTORY_WARNING_EMAIL_TO: "",  // 两个都为空
    };
    const result = mergeRuntimeConfig(dbConfig, env);
    expect(result.resendApiKey).toBe("re_db");       // db > env
    expect(result.emailFrom).toBe("env@example.com"); // db 空 → env
    expect(result.turnstileEnabled).toBe(false);      // 仅由 db 控制
    expect(result.turnstileSecretKey).toBe("0x_db");  // db > env
    expect(result.allowTurnstileBypassForSmoke).toBe(false);
    expect(result.inventoryWarningEmailTo).toBe("");  // 都空 → 空串
  });

  it("读取 dbConfig 的字段精确匹配 env 的字段映射", () => {
    // resendApiKey → RESEND_API_KEY
    // emailFrom → EMAIL_FROM
    // turnstileSecretKey → TURNSTILE_SECRET_KEY
    // allowTurnstileBypassForSmoke → ALLOW_TURNSTILE_BYPASS_FOR_SMOKE
    // inventoryWarningEmailTo → INVENTORY_WARNING_EMAIL_TO
    const dbConfig: RuntimeConfig = { ...baseDb };
    const env = {
      RESEND_API_KEY: "re_env_only",
      EMAIL_FROM: "env_only@example.com",
      TURNSTILE_SECRET_KEY: "0x_env_only",
      ALLOW_TURNSTILE_BYPASS_FOR_SMOKE: "true",
      INVENTORY_WARNING_EMAIL_TO: "inventory@example.com",
    };
    const result = mergeRuntimeConfig(dbConfig, env);
    expect(result).toEqual({
      resendApiKey: "re_env_only",
      emailFrom: "env_only@example.com",
      turnstileEnabled: false,
      turnstileSecretKey: "0x_env_only",
      allowTurnstileBypassForSmoke: true,
      inventoryWarningEmailTo: "inventory@example.com",
    });
  });
});

// ── readRuntimeConfig 测试（使用 vi.hoisted 定义顶层 mock） ──────────

const mockReadConfigMap = vi.hoisted(() => vi.fn());

vi.mock("../lib/system-config-registry", () => ({
  readSystemConfigMap: (...args: unknown[]) => mockReadConfigMap(...args),
}));

describe("readRuntimeConfig", () => {
  it("从 DB 读取配置并映射到 RuntimeConfig 结构", async () => {
    mockReadConfigMap.mockResolvedValue({
      resend_api_key: "re_db_value",
      email_from: "db@shop.com",
      turnstile_enabled: "true",
      turnstile_secret_key: "0x_secret",
      allow_turnstile_bypass_for_smoke: "true",
      inventory_warning_email_to: "admin@shop.com",
    });

    const { readRuntimeConfig } = await import("./runtime-config");
    const db = {} as DbType;

    const result = await readRuntimeConfig(db);

    expect(mockReadConfigMap).toHaveBeenCalledWith(db, [
      "resend_api_key",
      "email_from",
      "turnstile_enabled",
      "turnstile_secret_key",
      "allow_turnstile_bypass_for_smoke",
      "inventory_warning_email_to",
    ]);
    expect(result.resendApiKey).toBe("re_db_value");
    expect(result.emailFrom).toBe("db@shop.com");
    expect(result.turnstileEnabled).toBe(true);
    expect(result.turnstileSecretKey).toBe("0x_secret");
    expect(result.allowTurnstileBypassForSmoke).toBe(true);
    expect(result.inventoryWarningEmailTo).toBe("admin@shop.com");
  });

  it("DB 返回空值时映射为空字符串", async () => {
    mockReadConfigMap.mockResolvedValue({
      resend_api_key: "",
      email_from: "",
      turnstile_enabled: "",
      turnstile_secret_key: undefined,
      allow_turnstile_bypass_for_smoke: "",
      inventory_warning_email_to: null,
    });

    const { readRuntimeConfig } = await import("./runtime-config");
    const db = {} as DbType;

    const result = await readRuntimeConfig(db);

    expect(result.resendApiKey).toBe("");
    expect(result.emailFrom).toBe("");
    expect(result.turnstileEnabled).toBe(false);
    expect(result.turnstileSecretKey).toBe("");
    expect(result.allowTurnstileBypassForSmoke).toBe(false);
    expect(result.inventoryWarningEmailTo).toBe("");
  });

  it("decrypts sensitive DB values with the configured credentials key", async () => {
    const encryptionKey = "a".repeat(64);
    const { encryptSecretConfigValue } = await import("./secret-config");
    mockReadConfigMap.mockResolvedValue({
      resend_api_key: await encryptSecretConfigValue("re_encrypted", encryptionKey),
      turnstile_secret_key: await encryptSecretConfigValue("turnstile-encrypted", encryptionKey),
    });

    const { readRuntimeConfig } = await import("./runtime-config");
    const result = await readRuntimeConfig({} as DbType, encryptionKey);

    expect(result.resendApiKey).toBe("re_encrypted");
    expect(result.turnstileSecretKey).toBe("turnstile-encrypted");
  });
});
