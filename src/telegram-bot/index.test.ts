/**
 * Telegram Bot 核心业务逻辑测试
 *
 * 测试覆盖 TG Bot 支付流程的关键路径：
 * - processAmount：订单创建、重复订单拦截、金额校验
 * - /tg/callback：支付回调验签、金额校验、幂等、状态更新、TG 通知
 * - close_order / cancel_order：订单关闭
 * - /status：订单查询
 *
 * 注意：不测试 Telegram API 调用（tgRequest/tgSendText 等），
 * 这些是外部依赖，通过 mock 验证调用参数。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Vitest 测试环境提供 global，但 TypeScript 默认不认识；此处补全类型，避免 type-check 报错。
declare const global: typeof globalThis;

// ── Mock 外部依赖（使用 vi.hoisted 确保在 vi.mock 提升前定义）──
const { mockDb, mockProvider, mockRegistry } = vi.hoisted(() => {
  const db = { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), run: vi.fn() };
  const provider = { name: "easypay", createPayment: vi.fn(), verifyCallback: vi.fn() };
  const registry = {
    selectOnline: vi.fn<() => typeof provider | null>(() => provider),
    get: vi.fn<() => typeof provider | null>(() => provider),
  };
  return { mockDb: db, mockProvider: provider, mockRegistry: registry };
});

vi.mock("../db/database", () => ({
  initDatabase: vi.fn(() => ({ db: mockDb })),
}));

vi.mock("../services/payments", () => ({
  createDbProviderRegistry: vi.fn(() => Promise.resolve(mockRegistry)),
  createDbProviderRegistryForCallback: vi.fn(() => Promise.resolve(mockRegistry)),
}));

vi.mock("../lib/token", () => ({
  hashOrderToken: vi.fn(() => Promise.resolve("mocked-hash")),
}));

vi.mock("../services/audit-service", () => ({
  writeOrderEvent: vi.fn(() => Promise.resolve()),
}));

vi.mock("@usethink/cf-core/auth/jwt", () => ({
  signJwt: vi.fn(() => Promise.resolve("mocked-jwt-token")),
}));

// ── 导入被测试模块 ──
// 注意：tgBot 是 Hono 路由，我们通过 app.request() 测试
import { normalizeTelegramPaymentUrl, tgBot } from "./index";
import { createDbProviderRegistryForCallback } from "../services/payments";

function createMockEnv(overrides: Record<string, string> = {}) {
  return {
    TURSO_URL: "libsql://test.turso.io",
    TURSO_TOKEN: "test-token",
    TG_BOT_TOKEN: "123456:ABC-DEF",
    JWT_SECRET: "jwt-secret",
    TG_OWNER_ID: "12345",
    ADMIN_TOKEN: "admin-secret",
    APP_ORIGIN: "https://shop.example.com",
    EASYPAY_PID: "1001",
    EASYPAY_KEY: "test-key",
    EASYPAY_API_BASE: "https://pay.example.com",
    ...overrides,
  };
}

async function telegramWebhookSecret(botToken: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(botToken));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function webhookRequest(body: Record<string, unknown>, env = createMockEnv(), headers: Record<string, string> = {}) {
  return tgBot.request("/webhook", {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": await telegramWebhookSecret(env.TG_BOT_TOKEN),
      ...headers,
    },
  }, env);
}

describe("TG Bot 支付回调 (/tg/callback)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn(() => Promise.resolve(Response.json({ ok: true }))) as any;
  });

  it("返回 500 当 easypay 未配置", async () => {
    // 让 selectOnline 返回 null（无可用支付渠道）
    mockRegistry.selectOnline.mockReturnValueOnce(null);
    mockRegistry.get.mockReturnValueOnce(null);

    const res = await tgBot.request("/callback", {
      method: "POST",
      body: new URLSearchParams({ out_trade_no: "TG-001" }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }, createMockEnv());

    expect(res.status).toBe(500);
    expect(await res.text()).toBe("easypay not configured");
  });

  it("uses the callback provider registry so admin disable does not break existing payment verification", async () => {
    mockRegistry.get.mockReturnValueOnce(null);
    const env = createMockEnv({ CREDENTIALS_ENCRYPTION_KEY: "a".repeat(64) });

    const res = await tgBot.request("/callback", {
      method: "POST",
      body: new URLSearchParams({ out_trade_no: "TG-001" }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }, env);

    expect(res.status).toBe(500);
    expect(createDbProviderRegistryForCallback).toHaveBeenCalledWith(env, mockDb, "a".repeat(64));
  });

  it("返回 400 当签名验证失败", async () => {
    mockProvider.verifyCallback.mockRejectedValueOnce(new Error("EasyPay signature invalid"));

    const res = await tgBot.request("/callback", {
      method: "POST",
      body: new URLSearchParams({ out_trade_no: "TG-001", sign: "invalid" }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }, createMockEnv());

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("fail");
  });

  it("订单不存在时返回 404 以保留支付平台重试", async () => {
    mockProvider.verifyCallback.mockResolvedValueOnce({
      orderNo: "TG-NOT-EXIST",
      providerTradeNo: "EP001",
      amountCents: 8866,
      currency: "CNY",
      paidAt: "2026-06-22T10:00:00Z",
    });
    mockDb.select.mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([])),
        })),
      })),
    });

    const res = await tgBot.request("/callback", {
      method: "POST",
      body: new URLSearchParams({ out_trade_no: "TG-NOT-EXIST", sign: "valid" }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }, createMockEnv());

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("order not found");
  });

  it("拒绝金额不匹配的回调并记录事件", async () => {
    mockProvider.verifyCallback.mockResolvedValueOnce({
      orderNo: "TG-001",
      providerTradeNo: "EP001",
      amountCents: 5000, // 回调金额 50 元
      currency: "CNY",
      paidAt: "2026-06-22T10:00:00Z",
    });
    mockDb.select.mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([{ id: "order-1", amountCents: 8866, currency: "CNY", status: "pending", productId: "tg_custom", paymentMethod: "tg_easypay", paymentProvider: "easypay", buyerContact: "tg:12345" }])),
        })),
      })),
    });

    const res = await tgBot.request("/callback", {
      method: "POST",
      body: new URLSearchParams({ out_trade_no: "TG-001", sign: "valid" }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }, createMockEnv());

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("fail");
    const { writeOrderEvent } = await import("../services/audit-service");
    expect(writeOrderEvent).toHaveBeenCalledWith(
      expect.anything(),
      "order-1",
      "payment_rejected",
      "Telegram 支付回调金额不匹配",
      expect.objectContaining({ callbackAmountCents: 5000, orderAmountCents: 8866 }),
    );
  });

  it("拒绝缺少币种的 Telegram 支付回调", async () => {
    mockProvider.verifyCallback.mockResolvedValueOnce({
      orderNo: "TG-MISSING-CURRENCY",
      providerTradeNo: "EP-MISSING-CURRENCY",
      amountCents: 8866,
      paidAt: "2026-06-22T10:00:00Z",
    });
    mockDb.select.mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([{
            id: "order-missing-currency",
            amountCents: 8866,
            currency: "CNY",
            status: "pending",
            productId: "tg_custom",
            paymentMethod: "tg_easypay",
            paymentProvider: "easypay",
          }])),
        })),
      })),
    });

    const res = await tgBot.request("/callback", {
      method: "POST",
      body: new URLSearchParams({ out_trade_no: "TG-MISSING-CURRENCY", sign: "valid" }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }, createMockEnv());

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("fail");
    expect(mockDb.update).not.toHaveBeenCalled();
    const { writeOrderEvent } = await import("../services/audit-service");
    expect(writeOrderEvent).toHaveBeenCalledWith(
      expect.anything(),
      "order-missing-currency",
      "payment_rejected",
      "Telegram 支付回调币种不匹配",
      expect.objectContaining({ expected: "CNY", received: "" }),
    );
  });

  it("返回 success 当订单已支付（幂等）", async () => {
    mockProvider.verifyCallback.mockResolvedValueOnce({
      orderNo: "TG-001",
      providerTradeNo: "EP001",
      amountCents: 8866,
      currency: "CNY",
      paidAt: "2026-06-22T10:00:00Z",
    });
    mockDb.select.mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([{ id: "order-1", amountCents: 8866, currency: "CNY", status: "paid", productId: "tg_custom", paymentMethod: "tg_easypay", paymentProvider: "easypay", paymentRef: "EP001" }])),
        })),
      })),
    });

    const res = await tgBot.request("/callback", {
      method: "POST",
      body: new URLSearchParams({ out_trade_no: "TG-001", sign: "valid" }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }, createMockEnv());

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("success");
    // 幂等：不应调用 update
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("成功处理支付回调：更新订单状态 + 写事件 + 返回 success", async () => {
    mockProvider.verifyCallback.mockResolvedValueOnce({
      orderNo: "TG-001",
      providerTradeNo: "EP20250001",
      amountCents: 8866,
      currency: "CNY",
      paidAt: "2026-06-22T10:00:00Z",
    });

    // 查订单
    mockDb.select.mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([{ id: "order-1", amountCents: 8866, currency: "CNY", status: "pending", productId: "tg_custom", paymentMethod: "tg_easypay", paymentProvider: "easypay", buyerContact: "tg:12345" }])),
        })),
      })),
    });

    // update 返回成功
    mockDb.update.mockReturnValueOnce({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([{ id: "order-1" }])),
        })),
      })),
    });

    const res = await tgBot.request("/callback", {
      method: "POST",
      body: new URLSearchParams({
        out_trade_no: "TG-001",
        trade_no: "EP20250001",
        money: "88.66",
        trade_status: "TRADE_SUCCESS",
        sign: "valid",
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }, createMockEnv());

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("success");

    // 验证订单状态更新
    expect(mockDb.update).toHaveBeenCalled();
    // 验证事件记录
    const { writeOrderEvent } = await import("../services/audit-service");
    expect(writeOrderEvent).toHaveBeenCalledWith(
      expect.anything(),
      "order-1",
      "paid",
      "Telegram 支付成功",
      expect.objectContaining({ provider: "easypay", trade_no: "EP20250001" }),
    );
  });

  it("支持 EasyPay 官方 GET 回调参数", async () => {
    mockProvider.verifyCallback.mockResolvedValueOnce({
      orderNo: "TG-GET-001",
      providerTradeNo: "EPGET001",
      amountCents: 8866,
      currency: "CNY",
      paidAt: "2026-06-22T10:00:00Z",
    });
    mockDb.select.mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([{
            id: "order-get-1",
            amountCents: 8866,
            currency: "CNY",
            status: "pending",
            productId: "tg_custom",
            paymentMethod: "tg_easypay",
            paymentProvider: "easypay",
            buyerContact: "tg:12345",
          }])),
        })),
      })),
    });
    mockDb.update.mockReturnValueOnce({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([{ id: "order-get-1" }])),
        })),
      })),
    });

    const res = await tgBot.request(
      "/callback?out_trade_no=TG-GET-001&trade_no=EPGET001&money=88.66&trade_status=TRADE_SUCCESS&sign=valid",
      { method: "GET" },
      createMockEnv(),
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("success");
    expect(mockProvider.verifyCallback).toHaveBeenCalledWith(expect.objectContaining({
      out_trade_no: "TG-GET-001",
      trade_no: "EPGET001",
      money: "88.66",
      trade_status: "TRADE_SUCCESS",
      sign: "valid",
    }));
  });

  it("拒绝 payment provider 快照为空的 Telegram 待支付订单", async () => {
    mockProvider.verifyCallback.mockResolvedValueOnce({
      orderNo: "TG-LEGACY",
      providerTradeNo: "EP-LEGACY",
      amountCents: 8866,
      currency: "CNY",
      paidAt: "2026-06-22T10:00:00Z",
    });
    mockDb.select.mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([{
            id: "order-legacy",
            amountCents: 8866,
            currency: "CNY",
            status: "pending",
            productId: "tg_custom",
            paymentMethod: "tg_easypay",
            paymentProvider: "",
            buyerContact: "tg:12345",
          }])),
        })),
      })),
    });
    const res = await tgBot.request("/callback", {
      method: "POST",
      body: new URLSearchParams({ out_trade_no: "TG-LEGACY", sign: "valid" }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }, createMockEnv());

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("fail");
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("拒绝 provider 非空且不是 easypay 的 Telegram 回调", async () => {
    mockProvider.verifyCallback.mockResolvedValueOnce({
      orderNo: "TG-WRONG-PROVIDER",
      providerTradeNo: "EP-WRONG",
      amountCents: 8866,
      currency: "CNY",
      paidAt: "2026-06-22T10:00:00Z",
    });
    mockDb.select.mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([{
            id: "order-wrong-provider",
            amountCents: 8866,
            currency: "CNY",
            status: "pending",
            productId: "tg_custom",
            paymentMethod: "tg_easypay",
            paymentProvider: "stripe",
            buyerContact: "tg:12345",
          }])),
        })),
      })),
    });

    const res = await tgBot.request("/callback", {
      method: "POST",
      body: new URLSearchParams({ out_trade_no: "TG-WRONG-PROVIDER", sign: "valid" }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }, createMockEnv());

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("fail");
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("支付落库后 Telegram 通知失败仍确认回调并记录失败事件", async () => {
    mockProvider.verifyCallback.mockResolvedValueOnce({
      orderNo: "TG-NOTIFY-FAIL",
      providerTradeNo: "EP-NOTIFY-FAIL",
      amountCents: 8866,
      currency: "CNY",
      paidAt: "2026-06-22T10:00:00Z",
    });
    mockDb.select.mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([{
            id: "order-notify-fail",
            amountCents: 8866,
            currency: "CNY",
            status: "pending",
            productId: "tg_custom",
            paymentMethod: "tg_easypay",
            paymentProvider: "easypay",
            buyerContact: "tg:12345",
          }])),
        })),
      })),
    });
    mockDb.update.mockReturnValueOnce({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([{ id: "order-notify-fail" }])),
        })),
      })),
    });
    global.fetch = vi.fn(() => Promise.resolve(Response.json({ ok: false, description: "telegram unavailable" }))) as any;

    const res = await tgBot.request("/callback", {
      method: "POST",
      body: new URLSearchParams({ out_trade_no: "TG-NOTIFY-FAIL", sign: "valid" }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }, createMockEnv());

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("success");
    expect(global.fetch).toHaveBeenCalledTimes(2);
    const { writeOrderEvent } = await import("../services/audit-service");
    expect(writeOrderEvent).toHaveBeenCalledWith(
      expect.anything(),
      "order-notify-fail",
      "notification_failed",
      "Telegram 支付成功通知发送失败",
      expect.objectContaining({ channel: "telegram", description: "telegram unavailable" }),
    );
  });

  it("支付状态落库后审计事件失败不触发支付平台重试", async () => {
    mockProvider.verifyCallback.mockResolvedValueOnce({
      orderNo: "TG-AUDIT-FAIL",
      providerTradeNo: "EP-AUDIT-FAIL",
      amountCents: 8866,
      currency: "CNY",
      paidAt: "2026-06-22T10:00:00Z",
    });
    mockDb.select.mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([{
            id: "order-audit-fail",
            amountCents: 8866,
            currency: "CNY",
            status: "pending",
            productId: "tg_custom",
            paymentMethod: "tg_easypay",
            paymentProvider: "easypay",
            buyerContact: "tg:12345",
          }])),
        })),
      })),
    });
    mockDb.update.mockReturnValueOnce({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([{ id: "order-audit-fail" }])),
        })),
      })),
    });
    const { writeOrderEvent } = await import("../services/audit-service");
    vi.mocked(writeOrderEvent).mockRejectedValueOnce(new Error("audit unavailable"));

    const res = await tgBot.request("/callback", {
      method: "POST",
      body: new URLSearchParams({ out_trade_no: "TG-AUDIT-FAIL", sign: "valid" }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }, createMockEnv());

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("success");
  });

  it("records a verified payment even when the user closed the Telegram order first", async () => {
    mockProvider.verifyCallback.mockResolvedValueOnce({
      orderNo: "TG-CLOSED",
      providerTradeNo: "EP-CLOSED",
      amountCents: 8866,
      currency: "CNY",
      paidAt: "2026-06-22T10:00:00Z",
    });
    mockDb.select.mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([{
            id: "order-closed",
            amountCents: 8866,
            currency: "CNY",
            status: "closed",
            productId: "tg_custom",
            paymentMethod: "tg_easypay",
            paymentProvider: "easypay",
            buyerContact: "tg:12345",
          }])),
        })),
      })),
    });
    mockDb.update.mockReturnValueOnce({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([{ id: "order-closed" }])),
        })),
      })),
    });

    const res = await tgBot.request("/callback", {
      method: "POST",
      body: new URLSearchParams({ out_trade_no: "TG-CLOSED", sign: "valid" }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }, createMockEnv());

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("success");
    expect(mockDb.update).toHaveBeenCalled();
  });

  it("records a verified Telegram payment even when its notification arrives after expiry", async () => {
    mockProvider.verifyCallback.mockResolvedValueOnce({
      orderNo: "TG-STALE",
      providerTradeNo: "EP-STALE",
      amountCents: 8866,
      currency: "CNY",
      paidAt: new Date().toISOString(),
    });
    mockDb.select.mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([{
            id: "order-stale",
            amountCents: 8866,
            currency: "CNY",
            status: "pending",
            expiresAt: new Date(Date.now() - 60_000).toISOString(),
            productId: "tg_custom",
            paymentMethod: "tg_easypay",
            paymentProvider: "easypay",
            buyerContact: "tg:12345",
          }])),
        })),
      })),
    });
    mockDb.update.mockReturnValueOnce({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([{ id: "order-stale" }])),
        })),
      })),
    });

    const res = await tgBot.request("/callback", {
      method: "POST",
      body: new URLSearchParams({ out_trade_no: "TG-STALE", sign: "valid" }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }, createMockEnv());

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("success");
    expect(mockDb.update).toHaveBeenCalled();
    const { writeOrderEvent } = await import("../services/audit-service");
    expect(writeOrderEvent).toHaveBeenCalledWith(
      expect.anything(),
      "order-stale",
      "paid",
      "Telegram 支付成功",
      expect.objectContaining({ trade_no: "EP-STALE" }),
    );
  });

  it("接受过期前已付款但通知延迟到达的 Telegram 回调", async () => {
    const paidAt = new Date(Date.now() - 120_000).toISOString();
    const expiresAt = new Date(Date.now() - 60_000).toISOString();
    mockProvider.verifyCallback.mockResolvedValueOnce({
      orderNo: "TG-PAID-BEFORE-EXPIRY",
      providerTradeNo: "EP-BEFORE-EXPIRY",
      amountCents: 8866,
      currency: "CNY",
      paidAt,
    });
    mockDb.select.mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([{
            id: "order-paid-before-expiry",
            amountCents: 8866,
            currency: "CNY",
            status: "pending",
            expiresAt,
            productId: "tg_custom",
            paymentMethod: "tg_easypay",
            paymentProvider: "easypay",
            buyerContact: "tg:12345",
          }])),
        })),
      })),
    });
    const set = vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([{ id: "order-paid-before-expiry" }])),
      })),
    }));
    mockDb.update.mockReturnValueOnce({ set });

    const res = await tgBot.request("/callback", {
      method: "POST",
      body: new URLSearchParams({ out_trade_no: "TG-PAID-BEFORE-EXPIRY", sign: "valid" }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }, createMockEnv());

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("success");
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      status: "paid",
      paymentProvider: "easypay",
      paymentRef: "EP-BEFORE-EXPIRY",
      paidAt,
    }));
    const { writeOrderEvent } = await import("../services/audit-service");
    expect(writeOrderEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      "order-paid-before-expiry",
      "expired",
      expect.any(String),
    );
  });

  it("拒绝与已支付订单记录不一致的支付流水", async () => {
    mockProvider.verifyCallback.mockResolvedValueOnce({
      orderNo: "TG-PAID-REF-CONFLICT",
      providerTradeNo: "EP-NEW",
      amountCents: 8866,
      currency: "CNY",
      paidAt: "2026-06-22T10:00:00Z",
    });
    mockDb.select.mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([{
            id: "order-paid-ref-conflict",
            amountCents: 8866,
            currency: "CNY",
            status: "paid",
            productId: "tg_custom",
            paymentMethod: "tg_easypay",
            paymentProvider: "easypay",
            paymentRef: "EP-RECORDED",
            buyerContact: "tg:12345",
          }])),
        })),
      })),
    });

    const res = await tgBot.request("/callback", {
      method: "POST",
      body: new URLSearchParams({ out_trade_no: "TG-PAID-REF-CONFLICT", sign: "valid" }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }, createMockEnv());

    expect(res.status).toBe(409);
    expect(await res.text()).toBe("fail");
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("recovers a verified payment when close wins the first callback CAS", async () => {
    mockDb.select.mockReset();
    mockDb.update.mockReset();
    mockProvider.verifyCallback.mockResolvedValueOnce({
      orderNo: "TG-CLOSE-RACE",
      providerTradeNo: "EP-CLOSE-RACE",
      amountCents: 8866,
      currency: "CNY",
      paidAt: new Date().toISOString(),
    });
    mockDb.select.mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve([{
              id: "order-close-race",
              amountCents: 8866,
              currency: "CNY",
              status: "pending",
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              productId: "tg_custom",
              paymentMethod: "tg_easypay",
              paymentProvider: "easypay",
              paymentRef: "",
              buyerContact: "tg:12345",
            }])),
          })),
        })),
      }).mockReturnValue({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve([{
              status: "closed",
              paymentProvider: "easypay",
              paymentRef: "",
            }])),
          })),
        })),
      });
    mockDb.update
      .mockReturnValueOnce({
        set: vi.fn(() => ({
          where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([])) })),
        })),
      })
      .mockReturnValueOnce({
        set: vi.fn(() => ({
          where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: "order-close-race" }])) })),
        })),
      });

    const res = await tgBot.request("/callback", {
      method: "POST",
      body: new URLSearchParams({ out_trade_no: "TG-CLOSE-RACE", sign: "valid" }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }, createMockEnv());

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("success");
    expect(mockDb.select).toHaveBeenCalledTimes(2);
  });

  it("CAS 失败后恢复并记录过期前已付款的 Telegram 订单", async () => {
    mockDb.select.mockReset();
    mockDb.update.mockReset();
    const paidAt = new Date(Date.now() - 120_000).toISOString();
    const expiresAt = new Date(Date.now() - 60_000).toISOString();
    mockProvider.verifyCallback.mockResolvedValueOnce({
      orderNo: "TG-EXPIRY-RACE-RECOVERY",
      providerTradeNo: "EP-EXPIRY-RACE",
      amountCents: 8866,
      currency: "CNY",
      paidAt,
    });
    mockDb.select.mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve([{
              id: "order-expiry-race-recovery",
              orderNo: "TG-EXPIRY-RACE-RECOVERY",
              amountCents: 8866,
              currency: "CNY",
              status: "pending",
              expiresAt,
              productId: "tg_custom",
              paymentMethod: "tg_easypay",
              paymentProvider: "easypay",
              paymentRef: "",
              buyerContact: "tg:12345",
            }])),
          })),
        })),
      }).mockReturnValue({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve([{
              status: "expired",
              paymentProvider: "easypay",
              paymentRef: "",
            }])),
          })),
        })),
      });
    mockDb.update.mockReturnValueOnce({
        set: vi.fn(() => ({
          where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([])) })),
        })),
      }).mockReturnValue({
        set: vi.fn(() => ({
          where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: "order-expiry-race-recovery" }])) })),
        })),
      });

    const res = await tgBot.request("/callback", {
      method: "POST",
      body: new URLSearchParams({ out_trade_no: "TG-EXPIRY-RACE-RECOVERY", sign: "valid" }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }, createMockEnv());

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("success");
    expect(mockDb.update).toHaveBeenCalledTimes(2);
    const { writeOrderEvent } = await import("../services/audit-service");
    expect(writeOrderEvent).toHaveBeenCalledWith(
      expect.anything(),
      "order-expiry-race-recovery",
      "paid",
      "Telegram 支付成功",
      expect.objectContaining({ trade_no: "EP-EXPIRY-RACE" }),
    );
  });
});

describe("TG Bot 订单关闭 (close_order / cancel_order)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Telegram Bot API 的成功响应是 JSON；保持 mock 与生产 tgRequest 的 res.json() 契约一致。
    global.fetch = vi.fn(() => Promise.resolve(Response.json({ ok: true }))) as any;
  });

  it("拒绝缺少 Telegram webhook secret 的请求", async () => {
    const res = await tgBot.request("/webhook", {
      method: "POST",
      body: JSON.stringify({ message: { chat: { id: 12345 }, text: "/start" } }),
      headers: { "Content-Type": "application/json" },
    }, createMockEnv());

    expect(res.status).toBe(401);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("拒绝群组成员操作共享支付按钮", async () => {
    const res = await webhookRequest({
      callback_query: {
        id: "cq-group",
        message: { chat: { id: -100123, type: "supergroup" }, message_id: 99 },
        from: { id: 54321 },
        data: "close_order:TG-GROUP",
      },
    });

    expect(res.status).toBe(200);
    expect(mockDb.select).not.toHaveBeenCalled();
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("close_order 更新数据库状态为 closed", async () => {
    // 查订单
    mockDb.select.mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([{ id: "order-1", status: "pending", productId: "tg_custom", paymentMethod: "tg_easypay", paymentProvider: "easypay", buyerContact: "tg:12345" }])),
        })),
      })),
    });

    // update 返回成功
    mockDb.update.mockReturnValueOnce({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve({ rowsAffected: 1 })),
      })),
    });

    // 使用 Telegram Bot API 的真实 callback_query.message.chat.id 结构。
    const res = await webhookRequest({
      callback_query: {
        id: "cq-1",
        message: { chat: { id: 12345 }, message_id: 100 },
        from: { id: 12345 },
        data: "close_order:TG-001",
      },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");

    // 验证数据库更新
    expect(mockDb.select).toHaveBeenCalled();
    expect(mockDb.update).toHaveBeenCalled();
    const { writeOrderEvent } = await import("../services/audit-service");
    expect(writeOrderEvent).toHaveBeenCalledWith(expect.anything(), "order-1", "closed", "用户通过 TG Bot 关闭订单");
  });

  it("cancel_order 更新数据库状态为 closed", async () => {
    // 查订单
    mockDb.select.mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([{ id: "order-2", status: "pending", productId: "tg_custom", paymentMethod: "tg_easypay", paymentProvider: "easypay", buyerContact: "tg:12345" }])),
        })),
      })),
    });

    // update 返回成功
    mockDb.update.mockReturnValueOnce({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve({ rowsAffected: 1 })),
      })),
    });

    const res = await webhookRequest({
      callback_query: {
        id: "cq-2",
        message: { chat_id: 12345, message_id: 101 },
        from: { id: 12345 },
        data: "cancel_order:TG-002",
      },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(mockDb.update).toHaveBeenCalled();
  });

  it("支付回调抢先完成时关闭订单不能覆盖 paid 状态", async () => {
    mockDb.select.mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([{
            id: "order-race",
            status: "pending",
            productId: "tg_custom",
            paymentMethod: "tg_easypay",
            paymentProvider: "easypay",
            buyerContact: "tg:12345",
          }])),
        })),
      })),
    });
    mockDb.update.mockReturnValueOnce({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve({ rowsAffected: 0 })),
      })),
    });

    const res = await webhookRequest({
      callback_query: {
        id: "cq-race",
        message: { chat_id: 12345, message_id: 102 },
        from: { id: 12345 },
        data: "close_order:TG-RACE",
      },
    });

    expect(res.status).toBe(200);
    const { writeOrderEvent } = await import("../services/audit-service");
    expect(writeOrderEvent).not.toHaveBeenCalled();
  });

  it("不允许其他 Telegram chat 关闭订单", async () => {
    mockDb.select.mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([{ id: "order-owned", status: "pending", productId: "tg_custom", paymentMethod: "tg_easypay", paymentProvider: "easypay", buyerContact: "tg:12345" }])),
        })),
      })),
    });

    const res = await webhookRequest({
      callback_query: {
        id: "cq-cross-chat",
        message: { chat_id: 99999, message_id: 102 },
        from: { id: 99999 },
        data: "close_order:TG-OWNED",
      },
    });

    expect(res.status).toBe(200);
    expect(mockDb.update).not.toHaveBeenCalled();
  });
});

describe("TG Bot 支付过期检测", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn(() => Promise.resolve(Response.json({ ok: true }))) as any;
  });

  it("pay_wxpay 创建 EasyPay 订单时传入 Worker 可见来源 IP", async () => {
    mockDb.select.mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([{
            id: "order-pay-ip",
            orderNo: "TG-IP",
            amountCents: 8866,
            currency: "CNY",
            status: "pending",
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
            productId: "tg_custom",
            paymentMethod: "tg_easypay",
            paymentProvider: "easypay",
            buyerContact: "tg:12345",
          }])),
        })),
      })),
    });
    mockProvider.createPayment.mockResolvedValueOnce({
      redirectUrl: "https://pay.example.com/pay/TG-IP",
      raw: {
        qrcode: "https://pay.example.com/pay/TG-IP",
        qrContent: "https://pay.example.com/pay/TG-IP",
      },
    });

    const res = await webhookRequest({
      callback_query: {
        id: "cq-pay-ip",
        message: { chat_id: 12345, message_id: 202 },
        from: { id: 12345 },
        data: "pay_wxpay:TG-IP",
      },
    }, createMockEnv(), {
      "cf-connecting-ip": "203.0.113.55",
    });

    expect(res.status).toBe(200);
    expect(mockProvider.createPayment).toHaveBeenCalledWith(expect.objectContaining({
      orderNo: "TG-IP",
      metadata: expect.objectContaining({
        payType: "wxpay",
        clientIp: "203.0.113.55",
      }),
    }));
  });

  it("pay_alipay 检测到过期订单并标记 expired", async () => {
    // 查订单 — 已过期
    const pastDate = new Date(Date.now() - 600000).toISOString(); // 10分钟前过期
    mockDb.select.mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([{
            id: "order-expired",
            orderNo: "TG-EXP",
            amountCents: 8866,
            currency: "CNY",
            status: "pending",
            expiresAt: pastDate,
            productId: "tg_custom",
            paymentMethod: "tg_easypay",
            paymentProvider: "easypay",
            buyerContact: "tg:12345",
          }])),
        })),
      })),
    });

    // update 标记 expired
    mockDb.update.mockReturnValueOnce({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([{ id: "order-expired" }])),
        })),
      })),
    });

    const res = await webhookRequest({
      callback_query: {
        id: "cq-exp",
        message: { chat_id: 12345, message_id: 200 },
        from: { id: 12345 },
        data: "pay_alipay:TG-EXP",
      },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    // 验证 expired 更新被调用
    expect(mockDb.update).toHaveBeenCalled();
  });

  it("支付回调抢先改变状态时不误记 expired 事件", async () => {
    mockDb.select.mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([{
            id: "order-expire-race",
            orderNo: "TG-EXP-RACE",
            amountCents: 8866,
            currency: "CNY",
            status: "pending",
            expiresAt: new Date(Date.now() - 600_000).toISOString(),
            productId: "tg_custom",
            paymentMethod: "tg_easypay",
            paymentProvider: "easypay",
            buyerContact: "tg:12345",
          }])),
        })),
      })),
    });
    mockDb.update.mockReturnValueOnce({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([])),
        })),
      })),
    });

    const res = await webhookRequest({
      callback_query: {
        id: "cq-exp-race",
        message: { chat_id: 12345, message_id: 201 },
        from: { id: 12345 },
        data: "pay_alipay:TG-EXP-RACE",
      },
    });

    expect(res.status).toBe(200);
    const { writeOrderEvent } = await import("../services/audit-service");
    expect(writeOrderEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      "order-expire-race",
      "expired",
      expect.any(String),
    );
  });
});

describe("TG Bot webhook setup", () => {
  it("rejects unauthenticated setup requests before calling Telegram", async () => {
    const env = createMockEnv();
    global.fetch = vi.fn(() => Promise.resolve(Response.json({ ok: true }))) as any;

    const res = await tgBot.request("/set-webhook", { method: "POST" }, env);

    expect(res.status).toBe(401);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("registers the derived Telegram webhook secret", async () => {
    const env = createMockEnv();
    global.fetch = vi.fn(() => Promise.resolve(Response.json({ ok: true }))) as any;

    const res = await tgBot.request("/set-webhook", {
      method: "POST",
      headers: { Authorization: "Bearer admin-secret" },
    }, env);

    expect(res.status).toBe(200);
    const firstUrl = new URL(String(vi.mocked(global.fetch).mock.calls[0][0]));
    expect(firstUrl.searchParams.get("secret_token")).toBe(await telegramWebhookSecret(env.TG_BOT_TOKEN));
  });
});

describe("TG Bot 结果页 (/tg/result)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 结果页当前不会主动请求 Telegram，但仍使用真实 API 形状，避免后续调用产生误导性解析异常。
    global.fetch = vi.fn(() => Promise.resolve(Response.json({ ok: true }))) as any;
  });

  it("返回 HTML 页面（成功状态）", async () => {
    mockDb.select.mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([{
            status: "paid",
            amountCents: 8866,
            currency: "CNY",
            paymentProvider: "easypay",
          }])),
        })),
      })),
    });

    const res = await tgBot.request("/result?orderNo=TG-001&status=TRADE_SUCCESS", {}, createMockEnv());

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("支付成功");
    expect(html).toContain("TG-001");
    expect(html).toContain("88.66");
  });

  it("返回 HTML 页面（失败状态）", async () => {
    const res = await tgBot.request("/result?orderNo=TG-001&status=failed", {}, createMockEnv());

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("支付未完成");
  });

  it("does not trust a success query parameter when the order does not exist", async () => {
    mockDb.select.mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([])),
        })),
      })),
    });

    const res = await tgBot.request("/result?orderNo=FORGED&status=TRADE_SUCCESS", {}, createMockEnv());
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("支付未完成");
    expect(html).not.toContain("支付成功");
  });

  it("does not trust a success query parameter when database access is unavailable", async () => {
    const res = await tgBot.request(
      "/result?orderNo=FORGED&status=TRADE_SUCCESS",
      {},
      createMockEnv({ TURSO_URL: "", TURSO_TOKEN: "" }),
    );
    const html = await res.text();

    expect(html).toContain("支付未完成");
    expect(html).not.toContain("支付成功");
  });

  it("转义订单号并禁止结果页执行脚本", async () => {
    const injectedOrderNo = `<script>localStorage.getItem("admin_token")</script>`;
    const res = await tgBot.request(`/result?orderNo=${encodeURIComponent(injectedOrderNo)}&status=failed`, {}, createMockEnv());

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toContain("script-src 'none'");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const html = await res.text();
    expect(html).not.toContain(injectedOrderNo);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
});

describe("normalizeTelegramPaymentUrl", () => {
  it("accepts only absolute HTTP(S) payment URLs", () => {
    expect(normalizeTelegramPaymentUrl("https://pay.example.com/checkout")).toBe("https://pay.example.com/checkout");
    expect(normalizeTelegramPaymentUrl("http://127.0.0.1:8787/pay")).toBe("http://127.0.0.1:8787/pay");
    expect(normalizeTelegramPaymentUrl("http://pay.example.com/checkout")).toBe("");
    expect(normalizeTelegramPaymentUrl("javascript:alert(1)")).toBe("");
    expect(normalizeTelegramPaymentUrl("data:text/html,pay")).toBe("");
    expect(normalizeTelegramPaymentUrl("not-a-url")).toBe("");
  });
});
