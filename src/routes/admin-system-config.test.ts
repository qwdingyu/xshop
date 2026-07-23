import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { adminSystemConfigRoute } from "./admin-system-config";

const getSystemConfig = vi.fn();
const upsertSystemConfig = vi.fn();
const deleteSystemConfig = vi.fn();
const clearBusinessDataPreservingConfig = vi.fn();
const writeAdminAudit = vi.fn();

vi.mock("../services/admin-service", () => ({
  getSystemConfig: (...args: unknown[]) => getSystemConfig(...args),
  upsertSystemConfig: (...args: unknown[]) => upsertSystemConfig(...args),
  deleteSystemConfig: (...args: unknown[]) => deleteSystemConfig(...args),
  clearBusinessDataPreservingConfig: (...args: unknown[]) => clearBusinessDataPreservingConfig(...args),
  CLEAR_BUSINESS_DATA_CONFIRMATIONS: {
    runtime: "清除运行态与日志",
    keep_trade: "清除账本营销保留交易",
    keep_catalog: "清除交易数据保留商品",
    full: "清除所有业务数据",
  },
}));

vi.mock("../services/audit-service", () => ({
  writeAdminAudit: (...args: unknown[]) => writeAdminAudit(...args),
}));

vi.mock("../lib/security", () => ({
  getIpHash: vi.fn().mockResolvedValue("ip-hash"),
}));

function createApp(env: Partial<AppEnv["Bindings"]> = {}) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", {} as never);
    await next();
  });
  app.route("/", adminSystemConfigRoute);
  return { app, env };
}

describe("adminSystemConfigRoute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    writeAdminAudit.mockResolvedValue(undefined);
  });

  it("returns turnstile status summary", async () => {
    getSystemConfig.mockResolvedValueOnce({
      turnstile_enabled: "true",
      turnstile_site_key: "site-key",
      turnstile_secret_key: "",
    });

    const { app, env } = createApp({ TURNSTILE_SECRET_KEY: "env-secret" });
    const res = await app.request("/", {}, env);

    expect(res.status).toBe(200);
    const body = await res.json() as {
      turnstileStatus: {
        enabled: boolean;
        siteKeyConfigured: boolean;
        secretKeyConfigured: boolean;
        complete: boolean;
      };
    };
    expect(body.turnstileStatus).toEqual({
      enabled: true,
      siteKeyConfigured: true,
      secretKeyConfigured: true,
      complete: true,
    });
  });

  it("reports sensitive configuration without returning secret values", async () => {
    getSystemConfig.mockResolvedValueOnce({
      resend_api_key: "re_db_secret",
      turnstile_secret_key: "turnstile-db-secret",
    });

    const { app, env } = createApp();
    const res = await app.request("/", {}, env);
    const body = await res.json() as {
      config: Record<string, string>;
      definitions: Array<{ key: string; sensitive?: boolean; configured?: boolean }>;
    };

    expect(res.status).toBe(200);
    expect(body.config.resend_api_key).toBe("");
    expect(body.config.turnstile_secret_key).toBe("");
    expect(body.definitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "resend_api_key", sensitive: true, configured: true }),
      expect.objectContaining({ key: "turnstile_secret_key", sensitive: true, configured: true }),
    ]));
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("re_db_secret");
    expect(serialized).not.toContain("turnstile-db-secret");
  });

  it("does not write sensitive configuration values to the audit log or response", async () => {
    getSystemConfig.mockResolvedValueOnce({
      turnstile_enabled: "false",
      turnstile_site_key: "site-key",
      turnstile_secret_key: "old-secret",
    });
    upsertSystemConfig.mockResolvedValueOnce(undefined);

    const { app, env } = createApp({ CREDENTIALS_ENCRYPTION_KEY: "a".repeat(64) });
    const res = await app.request("/", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "turnstile_secret_key", value: "new-secret" }),
    }, env);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, key: "turnstile_secret_key", value: "", configured: true });
    expect(JSON.stringify(body)).not.toContain("new-secret");
    expect(writeAdminAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "update_system_config",
      targetId: "turnstile_secret_key",
      metadata: { key: "turnstile_secret_key" },
    }));
    expect(JSON.stringify(writeAdminAudit.mock.calls)).not.toContain("new-secret");
  });

  it("rejects storing a sensitive value without a valid encryption key", async () => {
    getSystemConfig.mockResolvedValueOnce({ turnstile_enabled: "false" });
    const { app, env } = createApp();

    const res = await app.request("/", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "resend_api_key", value: "new-secret" }),
    }, env);

    expect(res.status).toBe(503);
    expect(upsertSystemConfig).not.toHaveBeenCalled();
  });

  it("keeps an environment-backed secret configured when the database override is cleared", async () => {
    getSystemConfig.mockResolvedValueOnce({
      resend_api_key: "old-db-secret",
      turnstile_enabled: "false",
    });
    upsertSystemConfig.mockResolvedValueOnce(undefined);

    const { app, env } = createApp({ RESEND_API_KEY: "env-resend-secret" });
    const res = await app.request("/", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "resend_api_key", value: "" }),
    }, env);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      key: "resend_api_key",
      value: "",
      configured: true,
      turnstileStatus: { enabled: false, complete: true },
    });
  });

  it("rejects enabling turnstile without complete keys", async () => {
    getSystemConfig.mockResolvedValueOnce({
      turnstile_enabled: "false",
      turnstile_site_key: "",
      turnstile_secret_key: "",
    });

    const { app } = createApp();
    const res = await app.request("/", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: "turnstile_enabled",
        value: "true",
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("必须先完整配置 Site Key 和 Secret Key");
    expect(upsertSystemConfig).not.toHaveBeenCalled();
  });

  it("updates a supported public system config value", async () => {
    getSystemConfig.mockResolvedValueOnce({
      turnstile_enabled: "false",
      turnstile_site_key: "",
      turnstile_secret_key: "",
    });
    upsertSystemConfig.mockResolvedValueOnce(undefined);

    const { app } = createApp();
    const res = await app.request("/", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: "shop_name",
        value: "新店铺",
      }),
    });

    expect(res.status).toBe(200);
    expect(upsertSystemConfig).toHaveBeenCalledWith(expect.anything(), "shop_name", "新店铺", undefined);
  });

  it("deletes a custom system config value", async () => {
    deleteSystemConfig.mockResolvedValueOnce(undefined);

    const { app } = createApp();
    const res = await app.request("/custom_public_banner", { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(deleteSystemConfig).toHaveBeenCalledWith(expect.anything(), "custom_public_banner");
  });

  it("clears business data only with matching profile confirmation", async () => {
    clearBusinessDataPreservingConfig.mockResolvedValue({
      deleted: 18,
      tables: { orders: 1 },
      reservedTables: ["system_config", "product_categories", "api_keys", "schema_migrations"],
      retainedAuditId: "audit-clear-business",
      profile: "full",
      cardStrategy: "clear_all",
    });

    const rejectedPhrase = await createApp().app.request("/clear-business-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profile: "full",
        confirmation: "wrong",
        preserveConfigAndSystemParams: true,
      }),
    });
    expect(rejectedPhrase.status).toBe(400);
    expect(clearBusinessDataPreservingConfig).not.toHaveBeenCalled();
    const rejectedBody = await rejectedPhrase.json() as { error?: string; message?: string };
    const rejectedText = JSON.stringify(rejectedBody);
    // 错误响应不得回显正确确认短语
    expect(rejectedText).not.toContain("清除所有业务数据");
    expect(rejectedText).toMatch(/不匹配/);

    const mismatched = await createApp().app.request("/clear-business-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profile: "keep_catalog",
        confirmation: "清除所有业务数据",
        preserveConfigAndSystemParams: true,
      }),
    });
    expect(mismatched.status).toBe(400);
    expect(clearBusinessDataPreservingConfig).not.toHaveBeenCalled();
    const mismatchedBody = await mismatched.json() as Record<string, unknown>;
    expect(JSON.stringify(mismatchedBody)).not.toContain("清除交易数据保留商品");

    const acceptedFull = await createApp().app.request("/clear-business-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        confirmation: "清除所有业务数据",
        preserveConfigAndSystemParams: true,
      }),
    });

    expect(acceptedFull.status).toBe(200);
    expect(clearBusinessDataPreservingConfig).toHaveBeenCalledWith(expect.anything(), "ip-hash", { profile: "full" });
    await expect(acceptedFull.json()).resolves.toMatchObject({
      ok: true,
      deleted: 18,
      retainedAuditId: "audit-clear-business",
    });

    clearBusinessDataPreservingConfig.mockClear();
    clearBusinessDataPreservingConfig.mockResolvedValueOnce({
      deleted: 5,
      tables: { request_logs: 1 },
      reservedTables: ["system_config", "products"],
      retainedAuditId: "audit-runtime",
      profile: "runtime",
      cardStrategy: "none",
    });

    const acceptedRuntime = await createApp().app.request("/clear-business-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profile: "runtime",
        confirmation: "清除运行态与日志",
        preserveConfigAndSystemParams: true,
      }),
    });
    expect(acceptedRuntime.status).toBe(200);
    expect(clearBusinessDataPreservingConfig).toHaveBeenCalledWith(expect.anything(), "ip-hash", { profile: "runtime" });

    clearBusinessDataPreservingConfig.mockClear();
    const missingPreserveFlag = await createApp().app.request("/clear-business-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profile: "full",
        confirmation: "清除所有业务数据",
      }),
    });
    expect(missingPreserveFlag.status).toBe(400);
    expect(clearBusinessDataPreservingConfig).not.toHaveBeenCalled();

    clearBusinessDataPreservingConfig.mockClear();
    clearBusinessDataPreservingConfig.mockResolvedValueOnce({
      deleted: 8,
      tables: { user_balances: 1 },
      reservedTables: ["system_config", "products", "orders", "cards"],
      retainedAuditId: "audit-keep-trade",
      profile: "keep_trade",
      cardStrategy: "none",
    });
    const acceptedKeepTrade = await createApp().app.request("/clear-business-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profile: "keep_trade",
        confirmation: "清除账本营销保留交易",
        preserveConfigAndSystemParams: true,
      }),
    });
    expect(acceptedKeepTrade.status).toBe(200);
    expect(clearBusinessDataPreservingConfig).toHaveBeenCalledWith(
      expect.anything(),
      "ip-hash",
      { profile: "keep_trade" },
    );
  });
});
