import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../bindings";
import { adminPaymentRoute } from "./admin-payment";

const getPaymentProviderConfigs = vi.fn();
const countProviderOrdersRequiringCredentials = vi.fn();
const upsertPaymentProviderConfig = vi.fn();
const deletePaymentProviderConfig = vi.fn();
const setPaymentProviderEnabled = vi.fn();

vi.mock("../services/admin-service", () => ({
  getPaymentProviderConfigs: (...args: unknown[]) => getPaymentProviderConfigs(...args),
  countProviderOrdersRequiringCredentials: (...args: unknown[]) => countProviderOrdersRequiringCredentials(...args),
  upsertPaymentProviderConfig: (...args: unknown[]) => upsertPaymentProviderConfig(...args),
  deletePaymentProviderConfig: (...args: unknown[]) => deletePaymentProviderConfig(...args),
  setPaymentProviderEnabled: (...args: unknown[]) => setPaymentProviderEnabled(...args),
}));

vi.mock("../services/audit-service", () => ({
  writeAdminAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/security", () => ({
  getIpHash: vi.fn().mockResolvedValue("ip-hash"),
}));

function createApp() {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", {} as never);
    await next();
  });
  app.route("/api/admin/payment", adminPaymentRoute);
  return app;
}

beforeEach(() => {
  getPaymentProviderConfigs.mockReset();
  getPaymentProviderConfigs.mockResolvedValue({});
  countProviderOrdersRequiringCredentials.mockReset();
  countProviderOrdersRequiringCredentials.mockResolvedValue(0);
  upsertPaymentProviderConfig.mockReset();
  upsertPaymentProviderConfig.mockResolvedValue(false);
  deletePaymentProviderConfig.mockReset();
  deletePaymentProviderConfig.mockResolvedValue(undefined);
  setPaymentProviderEnabled.mockReset();
  setPaymentProviderEnabled.mockResolvedValue(true);
});

describe("adminPaymentRoute", () => {
  it("exposes supported currencies in provider metadata", async () => {
    const res = await createApp().request("/api/admin/payment/providers", {}, {});

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      providers: [
        expect.objectContaining({
          name: "easypay",
          supportedCurrencies: ["CNY"],
        }),
      ],
    });
  });

  it("reports payment encryption key health without exposing the key", async () => {
    const res = await createApp().request("/api/admin/payment/health", {}, {
      CREDENTIALS_ENCRYPTION_KEY: "a".repeat(64),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      credentialsEncryptionKey: { configured: true, valid: true },
    });
    expect(JSON.stringify(body)).not.toContain("a".repeat(64));
  });

  it("reports invalid payment encryption key format", async () => {
    const res = await createApp().request("/api/admin/payment/health", {}, {
      CREDENTIALS_ENCRYPTION_KEY: "not-hex",
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      credentialsEncryptionKey: { configured: true, valid: false },
    });
  });

  it("rejects a 64-character non-hex key on payment config writes", async () => {
    const res = await createApp().request("/api/admin/payment/configs/easypay", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        EASYPAY_PID: "1001",
        EASYPAY_KEY: "secret",
        EASYPAY_API_BASE: "https://pay.example.com",
        EASYPAY_RETURN_URL: "https://shop.example.com/return",
      }),
    }, {
      CREDENTIALS_ENCRYPTION_KEY: "z".repeat(64),
    });

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("64 字符 hex"),
    });
  });

  it("rejects non-local HTTP payment endpoints", async () => {
    const res = await createApp().request("/api/admin/payment/configs/easypay", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        EASYPAY_PID: "1001",
        EASYPAY_KEY: "secret",
        EASYPAY_API_BASE: "http://pay.example.com/mapi.php",
        EASYPAY_RETURN_URL: "https://shop.example.com/return",
      }),
    }, {
      CREDENTIALS_ENCRYPTION_KEY: "a".repeat(64),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      error: "请求参数无效",
    });
  });

  it("allows optional EasyPay return URLs to be omitted", async () => {
    const res = await createApp().request("/api/admin/payment/configs/easypay", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        EASYPAY_PID: "20220715225121",
        EASYPAY_KEY: "secret",
        EASYPAY_API_BASE: "https://zpayz.cn",
      }),
    }, {
      CREDENTIALS_ENCRYPTION_KEY: "a".repeat(64),
    });

    expect(res.status).toBe(200);
    expect(upsertPaymentProviderConfig).toHaveBeenCalledWith(
      {},
      "easypay",
      expect.objectContaining({
        EASYPAY_PID: "20220715225121",
        EASYPAY_API_BASE: "https://zpayz.cn",
        EASYPAY_RETURN_URL: "",
      }),
      "a".repeat(64),
    );
  });

  it("normalizes EasyPay endpoint fields before encrypted storage", async () => {
    const res = await createApp().request("/api/admin/payment/configs/easypay", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        EASYPAY_PID: "20220715225121",
        EASYPAY_KEY: "secret",
        EASYPAY_API_BASE: "https://zpayz.cn/submit.php?x=1",
      }),
    }, {
      CREDENTIALS_ENCRYPTION_KEY: "a".repeat(64),
    });

    expect(res.status).toBe(200);
    expect(upsertPaymentProviderConfig).toHaveBeenCalledWith(
      {},
      "easypay",
      expect.objectContaining({
        EASYPAY_API_BASE: "https://zpayz.cn",
        EASYPAY_RETURN_URL: "",
      }),
      "a".repeat(64),
    );
  });

  it("normalizes EasyPay enabled payment types and keeps the default enabled", async () => {
    const res = await createApp().request("/api/admin/payment/configs/easypay", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        EASYPAY_PID: "20220715225121",
        EASYPAY_KEY: "secret",
        EASYPAY_API_BASE: "https://zpayz.cn",
        EASYPAY_PAY_TYPE: "wxpay",
        EASYPAY_ENABLED_PAY_TYPES: "alipay,wxpay,alipay",
      }),
    }, {
      CREDENTIALS_ENCRYPTION_KEY: "a".repeat(64),
    });

    expect(res.status).toBe(200);
    expect(upsertPaymentProviderConfig).toHaveBeenCalledWith(
      {},
      "easypay",
      expect.objectContaining({
        EASYPAY_PAY_TYPE: "wxpay",
        EASYPAY_ENABLED_PAY_TYPES: "alipay,wxpay",
      }),
      "a".repeat(64),
    );
  });

  it("preserves an existing sensitive key when updating non-sensitive EasyPay fields", async () => {
    getPaymentProviderConfigs.mockResolvedValue({
      easypay: {
        enabled: true,
        configured: true,
        config: {
          EASYPAY_PID: "20220715225121",
          EASYPAY_KEY: "stored-secret",
          EASYPAY_API_BASE: "https://zpayz.cn",
          EASYPAY_RETURN_URL: "",
          EASYPAY_PAY_TYPE: "wxpay",
        },
      },
    });
    upsertPaymentProviderConfig.mockResolvedValueOnce(true);

    const res = await createApp().request("/api/admin/payment/configs/easypay", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        EASYPAY_PID: "20220715225121",
        EASYPAY_KEY: "••••••••",
        EASYPAY_API_BASE: "https://zpayz.cn/submit.php",
        EASYPAY_RETURN_URL: "",
        EASYPAY_PAY_TYPE: "alipay",
      }),
    }, {
      CREDENTIALS_ENCRYPTION_KEY: "a".repeat(64),
    });

    expect(res.status).toBe(200);
    expect(upsertPaymentProviderConfig).toHaveBeenCalledWith(
      {},
      "easypay",
      expect.objectContaining({
        EASYPAY_KEY: "stored-secret",
        EASYPAY_API_BASE: "https://zpayz.cn",
        EASYPAY_PAY_TYPE: "alipay",
      }),
      "a".repeat(64),
    );
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      enabled: true,
      message: "支付配置已保存，当前仍保持启用",
    });
  });

  it("rejects sensitive placeholders when no existing EasyPay key can be preserved", async () => {
    getPaymentProviderConfigs.mockResolvedValue({});

    const res = await createApp().request("/api/admin/payment/configs/easypay", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        EASYPAY_PID: "20220715225121",
        EASYPAY_KEY: "••••••••",
        EASYPAY_API_BASE: "https://zpayz.cn",
      }),
    }, {
      CREDENTIALS_ENCRYPTION_KEY: "a".repeat(64),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      error: "商户密钥 不能为空",
    });
    expect(upsertPaymentProviderConfig).not.toHaveBeenCalled();
  });

  it("rejects unsupported EasyPay default payment types", async () => {
    const res = await createApp().request("/api/admin/payment/configs/easypay", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        EASYPAY_PID: "20220715225121",
        EASYPAY_KEY: "secret",
        EASYPAY_API_BASE: "https://zpayz.cn",
        EASYPAY_PAY_TYPE: "wechat",
      }),
    }, {
      CREDENTIALS_ENCRYPTION_KEY: "a".repeat(64),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      error: "请求参数无效",
    });
  });

  it("rejects removed standalone ZPay provider configs", async () => {
    const res = await createApp().request("/api/admin/payment/configs/zpay", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pid: "20220715225121",
      }),
    }, {
      CREDENTIALS_ENCRYPTION_KEY: "a".repeat(64),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      error: "不支持的支付渠道: zpay",
    });
  });

  it("returns only non-sensitive payment config values", async () => {
    getPaymentProviderConfigs.mockResolvedValue({
      easypay: {
        enabled: true,
        configured: true,
        config: {
          EASYPAY_PID: "1001",
          EASYPAY_KEY: "secret",
          EASYPAY_API_BASE: "https://pay.example.com",
          EASYPAY_RETURN_URL: "https://shop.example.com/return",
        },
      },
    });

    const res = await createApp().request("/api/admin/payment/configs", {}, {
      CREDENTIALS_ENCRYPTION_KEY: "a".repeat(64),
    });

    expect(res.status).toBe(200);
    expect(getPaymentProviderConfigs).toHaveBeenCalledWith({}, "a".repeat(64));
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      configs: [
        {
          name: "easypay",
          enabled: true,
          configured: true,
          values: {
            EASYPAY_PID: "1001",
            EASYPAY_API_BASE: "https://pay.example.com",
            EASYPAY_RETURN_URL: "https://shop.example.com/return",
          },
        },
      ],
    });
    const bodyRes = await createApp().request("/api/admin/payment/configs", {}, {
      CREDENTIALS_ENCRYPTION_KEY: "a".repeat(64),
    });
    const body = await bodyRes.text();
    expect(body).not.toContain("secret");
    expect(body).not.toContain("EASYPAY_KEY");
  });

  it("blocks callback credential rotation while orders still depend on the current key", async () => {
    getPaymentProviderConfigs.mockResolvedValue({
      easypay: {
        enabled: false,
        configured: true,
        config: {
          EASYPAY_PID: "1001",
          EASYPAY_KEY: "old-secret",
          EASYPAY_API_BASE: "https://old-pay.example.com",
        },
      },
    });
    countProviderOrdersRequiringCredentials.mockResolvedValue(2);

    const res = await createApp().request("/api/admin/payment/configs/easypay", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        EASYPAY_PID: "1001",
        EASYPAY_KEY: "new-secret",
        EASYPAY_API_BASE: "https://new-pay.example.com",
      }),
    }, {
      CREDENTIALS_ENCRYPTION_KEY: "a".repeat(64),
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      details: { code: "PAYMENT_PROVIDER_HAS_DEPENDENT_ORDERS", dependentOrders: 2 },
    });
    expect(upsertPaymentProviderConfig).not.toHaveBeenCalled();
  });

  it("blocks payment config deletion while callback credentials are still required", async () => {
    countProviderOrdersRequiringCredentials.mockResolvedValue(1);

    const res = await createApp().request("/api/admin/payment/configs/easypay", {
      method: "DELETE",
    }, {
      CREDENTIALS_ENCRYPTION_KEY: "a".repeat(64),
    });

    expect(res.status).toBe(409);
    expect(deletePaymentProviderConfig).not.toHaveBeenCalled();
  });
});
