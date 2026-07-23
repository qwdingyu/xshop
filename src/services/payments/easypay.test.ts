/**
 * 易支付 Provider 单元测试
 *
 * 测试覆盖：
 * - 签名构建（buildSignString）
 * - MD5 签名验证（verifyEasyPaySign）
 * - createPayment 参数构建（mock fetch）
 * - verifyCallback 验签 + 金额解析
 * - queryStatus
 * - 工厂 isAvailable / create
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { md5Hex } from "../../lib/md5";
import {
  EasyPayProviderError,
  EasyPayProvider,
  easyPayFactory,
  buildEasyPayPaymentApiUrl,
  buildEasyPayQueryApiUrl,
  buildSignString,
  isAmbiguousEasyPayProviderError,
  normalizeEasyPayEnabledPayTypes,
  normalizeEasyPayPayType,
  normalizeEasyPayApiBaseUrl,
  verifyEasyPaySign,
} from "./easypay";

// ── 测试用配置 ──
const TEST_CONFIG = {
  pid: "1001",
  key: "test_key_abc123",
  apiBase: "https://pay.example.com",
  notifyUrl: "https://shop.example.com/tg/callback",
  returnUrl: "https://shop.example.com/tg/result",
};

// ── 工具函数测试 ──

describe("buildSignString", () => {
  it("sorts params by key and joins with &", () => {
    const result = buildSignString({ b: "2", a: "1", c: "3" });
    expect(result).toBe("a=1&b=2&c=3");
  });

  it("excludes sign and sign_type keys", () => {
    const result = buildSignString({ a: "1", sign: "xxx", sign_type: "MD5" });
    expect(result).toBe("a=1");
  });

  it("excludes empty and undefined values", () => {
    const result = buildSignString({ a: "1", b: "", c: undefined });
    expect(result).toBe("a=1");
  });
});

describe("verifyEasyPaySign", () => {
  it("returns true for valid signature", async () => {
    const params: Record<string, string> = {
      pid: "1001",
      out_trade_no: "TG-001",
      money: "88.66",
      sign_type: "MD5",
    };
    // 手动计算预期签名：buildSignString(params) + key 的 MD5
    const signStr = buildSignString(params);
    const expected = md5Hex(signStr + TEST_CONFIG.key);

    const result = await verifyEasyPaySign({ ...params, sign: expected }, TEST_CONFIG.key);
    expect(result).toBe(true);
  });

  it("returns false for invalid signature", async () => {
    const result = await verifyEasyPaySign({ a: "1", sign: "invalid" }, TEST_CONFIG.key);
    expect(result).toBe(false);
  });

  it("returns false when sign is empty", async () => {
    const result = await verifyEasyPaySign({ a: "1", sign: "" }, TEST_CONFIG.key);
    expect(result).toBe(false);
  });
});

describe("EasyPay endpoint normalization", () => {
  it("accepts root, submit.php, mapi.php, and api.php input as the same API base", () => {
    for (const value of [
      "https://zpayz.cn",
      "https://zpayz.cn/",
      "https://zpayz.cn/submit.php",
      "https://zpayz.cn/mapi.php",
      "https://zpayz.cn/api.php",
      "https://zpayz.cn/api.php?act=order#docs",
    ]) {
      expect(normalizeEasyPayApiBaseUrl(value)).toBe("https://zpayz.cn");
      expect(buildEasyPayPaymentApiUrl(value)).toBe("https://zpayz.cn/mapi.php");
      expect(buildEasyPayQueryApiUrl(value)).toBe("https://zpayz.cn/api.php");
    }
  });

  it("keeps gateway subpaths while stripping only known endpoint suffixes", () => {
    expect(normalizeEasyPayApiBaseUrl("https://pay.example.com/epay/mapi.php")).toBe("https://pay.example.com/epay");
    expect(buildEasyPayPaymentApiUrl("https://pay.example.com/epay/api.php")).toBe("https://pay.example.com/epay/mapi.php");
  });

  it("rejects non-local HTTP endpoints", () => {
    expect(normalizeEasyPayApiBaseUrl("http://pay.example.com/mapi.php")).toBe("");
    expect(normalizeEasyPayApiBaseUrl("http://localhost:8787/mapi.php")).toBe("http://localhost:8787");
  });
});

describe("EasyPay pay type normalization", () => {
  it("defaults unknown or empty values to alipay", () => {
    expect(normalizeEasyPayPayType(undefined)).toBe("alipay");
    expect(normalizeEasyPayPayType("")).toBe("alipay");
    expect(normalizeEasyPayPayType("wechat")).toBe("alipay");
  });

  it("accepts supported EasyPay type values", () => {
    expect(normalizeEasyPayPayType("alipay")).toBe("alipay");
    expect(normalizeEasyPayPayType("WXPAY")).toBe("wxpay");
    expect(normalizeEasyPayPayType(" qqpay ")).toBe("qqpay");
  });

  it("normalizes enabled pay types without trusting unknown channels", () => {
    expect(normalizeEasyPayEnabledPayTypes(" wxpay,alipay,wxpay,bank ", "qqpay")).toEqual(["wxpay", "alipay"]);
    expect(normalizeEasyPayEnabledPayTypes("", "wxpay")).toEqual(["wxpay"]);
    expect(normalizeEasyPayEnabledPayTypes(["qqpay", "wechat", "alipay"], "wxpay")).toEqual(["qqpay", "alipay"]);
  });
});

// ── Provider 测试 ──

describe("EasyPayProvider", () => {
  let provider: EasyPayProvider;

  beforeEach(() => {
    provider = new EasyPayProvider(TEST_CONFIG);
    vi.restoreAllMocks();
  });

  describe("createPayment", () => {
    it("fails before network access when the order currency is not CNY", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      await expect(provider.createPayment({
        orderNo: "TG-USD",
        amountCents: 8866,
        currency: "USD",
        notifyUrl: "https://shop.example.com/api/pay/callback/easypay",
      })).rejects.toThrow("only supports CNY");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("classifies gateway 4xx responses as deterministic failures", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad request", { status: 400 }));
      await expect(provider.createPayment({
        orderNo: "TG-001",
        amountCents: 8866,
        currency: "CNY",
        notifyUrl: "https://shop.example.com/api/pay/callback/easypay",
      })).rejects.toMatchObject({
        name: "EasyPayProviderError",
        kind: "deterministic",
        httpStatus: 400,
      });
    });

    it("classifies gateway 5xx responses as ambiguous failures", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 500 }));
      await expect(provider.createPayment({
        orderNo: "TG-001",
        amountCents: 8866,
        currency: "CNY",
        notifyUrl: "https://shop.example.com/api/pay/callback/easypay",
      })).rejects.toMatchObject({
        name: "EasyPayProviderError",
        kind: "ambiguous",
        httpStatus: 500,
      });
    });

    it("throws when gateway returns error code", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ code: 0, msg: "参数错误" }), { status: 200 }),
      );
      await expect(provider.createPayment({
        orderNo: "TG-001",
        amountCents: 8866,
        currency: "CNY",
        notifyUrl: "https://shop.example.com/api/pay/callback/easypay",
      })).rejects.toMatchObject({
        name: "EasyPayProviderError",
        kind: "deterministic",
        providerMessage: "参数错误",
      });
    });

    it("returns payment result with separated qrcode content and img URL", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({
          code: 1,
          payurl: "https://pay.example.com/qr/abc",
          qrcode: "https://pay.example.com/native-content",
          img: "https://pay.example.com/qr-image.png",
          trade_no: "EP20250001",
        }), { status: 200 }),
      );

      const result = await provider.createPayment({
        orderNo: "TG-001",
        amountCents: 8866,
        currency: "CNY",
        notifyUrl: "https://shop.example.com/api/pay/callback/easypay",
        metadata: { payType: "alipay", subject: "测试商品" },
      });

      expect(result.providerTradeNo).toBe("EP20250001");
      expect(result.qrCode).toBe("https://pay.example.com/qr-image.png");
      expect(result.redirectUrl).toBe("https://pay.example.com/qr/abc");
      expect(result.raw).toMatchObject({
        payType: "alipay",
        payTypeLabel: "支付宝",
        qrcode: "https://pay.example.com/native-content",
        img: "https://pay.example.com/qr-image.png",
        qrContent: "https://pay.example.com/native-content",
        qrImageUrl: "https://pay.example.com/qr-image.png",
      });
    });

    it("falls back to qrcode when img is absent", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({
          code: "1",
          qrcode: "https://pay.example.com/qrcode-link",
          trade_no: "EP20250002",
        }), { status: 200 }),
      );

      const result = await provider.createPayment({
        orderNo: "TG-002",
        amountCents: 1200,
        currency: "CNY",
        notifyUrl: "https://shop.example.com/api/pay/callback/easypay",
      });

      expect(result.providerTradeNo).toBe("EP20250002");
      expect(result.qrCode).toBe("https://pay.example.com/qrcode-link");
      expect(result.raw).toMatchObject({
        qrContent: "https://pay.example.com/qrcode-link",
        qrImageUrl: "",
      });
    });

    it("does not present the merchant order number as a provider trade number", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ code: 1, payurl: "https://pay.example.com/order" }), { status: 200 }),
      );

      const result = await provider.createPayment({
        orderNo: "MERCHANT-ORDER-001",
        amountCents: 1200,
        currency: "CNY",
        notifyUrl: "https://shop.example.com/api/pay/callback/easypay",
      });

      expect(result.providerTradeNo).toBeUndefined();
    });

    it("posts API payments to mapi.php even when the configured base came from submit.php", async () => {
      provider = new EasyPayProvider({ ...TEST_CONFIG, apiBase: normalizeEasyPayApiBaseUrl("https://zpayz.cn/submit.php") });
      let requestUrl = "";
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
        requestUrl = String(url);
        return new Response(JSON.stringify({ code: 1, payurl: "https://zpayz.cn/pay", trade_no: "EP20250001" }), { status: 200 });
      });

      await provider.createPayment({
        orderNo: "TG-001",
        amountCents: 8866,
        currency: "CNY",
        notifyUrl: "https://shop.example.com/api/pay/callback/easypay",
      });

      expect(requestUrl).toBe("https://zpayz.cn/mapi.php");
    });

    it("uses alipay as default payType when not specified", async () => {
      let requestBody = "";
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, opts) => {
        requestBody = (opts?.body as URLSearchParams)?.toString() || "";
        return new Response(JSON.stringify({ code: 1, payurl: "https://pay.example.com/qr/abc" }), { status: 200 });
      });

      await provider.createPayment({
        orderNo: "TG-001",
        amountCents: 8866,
        currency: "CNY",
        notifyUrl: "https://shop.example.com/api/pay/callback/easypay",
      });

      expect(requestBody).toContain("type=alipay");
      expect(requestBody).toContain("device=alipay");
    });

    it("uses configured default payType when metadata does not specify one", async () => {
      provider = new EasyPayProvider({ ...TEST_CONFIG, payType: "wxpay" });
      let requestBody = "";
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, opts) => {
        requestBody = (opts?.body as URLSearchParams)?.toString() || "";
        return new Response(JSON.stringify({ code: 1, payurl: "https://pay.example.com/qr/abc" }), { status: 200 });
      });

      const result = await provider.createPayment({
        orderNo: "TG-001",
        amountCents: 8866,
        currency: "CNY",
        notifyUrl: "https://shop.example.com/api/pay/callback/easypay",
      });

      expect(requestBody).toContain("type=wxpay");
      expect(requestBody).toContain("device=wechat");
      expect(result.raw).toMatchObject({
        payType: "wxpay",
        payTypeLabel: "微信支付",
      });
    });

    it("passes payType from metadata", async () => {
      let requestBody = "";
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, opts) => {
        requestBody = (opts?.body as URLSearchParams)?.toString() || "";
        return new Response(JSON.stringify({ code: 1, payurl: "https://pay.example.com/qr/abc" }), { status: 200 });
      });

      await provider.createPayment({
        orderNo: "TG-001",
        amountCents: 8866,
        currency: "CNY",
        notifyUrl: "https://shop.example.com/api/pay/callback/easypay",
        metadata: { payType: "alipay" },
      });

      expect(requestBody).toContain("type=alipay");
      expect(requestBody).toContain("device=alipay");
    });

    it("rejects metadata payType that is not enabled by admin config", async () => {
      provider = new EasyPayProvider({ ...TEST_CONFIG, payType: "alipay", enabledPayTypes: "alipay" });
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      await expect(provider.createPayment({
        orderNo: "TG-001",
        amountCents: 8866,
        currency: "CNY",
        notifyUrl: "https://shop.example.com/api/pay/callback/easypay",
        metadata: { payType: "wxpay" },
      })).rejects.toMatchObject({
        name: "EasyPayProviderError",
        kind: "deterministic",
        providerMessage: "pay_type_disabled",
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("prefers input notifyUrl over config", async () => {
      let requestBody = "";
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, opts) => {
        requestBody = (opts?.body as URLSearchParams)?.toString() || "";
        return new Response(JSON.stringify({ code: 1, payurl: "https://pay.example.com/qr/abc" }), { status: 200 });
      });

      await provider.createPayment({
        orderNo: "TG-001",
        amountCents: 8866,
        currency: "CNY",
        notifyUrl: "https://custom.example.com/callback",
      });

      expect(requestBody).toContain(encodeURIComponent("https://custom.example.com/callback"));
    });

    it("submits the caller-provided client IP to EasyPay", async () => {
      let requestBody = "";
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, opts) => {
        requestBody = String(opts?.body || "");
        return new Response(JSON.stringify({ code: 1, payurl: "https://pay.example.com/qr/abc" }), { status: 200 });
      });

      await provider.createPayment({
        orderNo: "TG-001",
        amountCents: 8866,
        currency: "CNY",
        notifyUrl: "https://shop.example.com/api/pay/callback/easypay",
        metadata: { clientIp: "203.0.113.9" },
      });

      expect(requestBody).toContain("clientip=203.0.113.9");
    });

    it("marks typed ambiguous errors for caller-side recovery decisions", () => {
      const error = new EasyPayProviderError("ambiguous", "timeout");
      expect(isAmbiguousEasyPayProviderError(error)).toBe(true);
      expect(isAmbiguousEasyPayProviderError(new EasyPayProviderError("deterministic", "bad config"))).toBe(false);
      expect(isAmbiguousEasyPayProviderError(new Error("timeout"))).toBe(false);
    });
  });

  describe("verifyCallback", () => {
    it("throws on invalid signature", async () => {
      await expect(provider.verifyCallback({ sign: "invalid" })).rejects.toThrow("EasyPay signature invalid");
    });

    it("throws on unexpected trade_status", async () => {
      const params: Record<string, string> = { trade_status: "WAIT_BUYER_PAY", money: "88.66", out_trade_no: "TG-001", sign_type: "MD5" };
      const signStr = buildSignString(params);
      const sign = md5Hex(signStr + TEST_CONFIG.key);
      await expect(provider.verifyCallback({ ...params, sign })).rejects.toThrow("Unexpected trade_status");
    });

    it("rejects a signed success callback without a provider trade number", async () => {
      const params: Record<string, string> = {
        trade_status: "TRADE_SUCCESS",
        money: "88.66",
        out_trade_no: "TG-001",
        sign_type: "MD5",
      };
      const sign = md5Hex(buildSignString(params) + TEST_CONFIG.key);

      await expect(provider.verifyCallback({ ...params, sign })).rejects.toThrow("trade_no");
    });

    it("returns CallbackResult on TRADE_SUCCESS", async () => {
      const params: Record<string, string> = {
        trade_status: "TRADE_SUCCESS",
        money: "88.66",
        out_trade_no: "TG-001",
        trade_no: "EP20250001",
        time: "2026-06-22T10:00:00Z",
        sign_type: "MD5",
      };
      const signStr = buildSignString(params);
      const sign = md5Hex(signStr + TEST_CONFIG.key);

      const result = await provider.verifyCallback({ ...params, sign });
      expect(result.orderNo).toBe("TG-001");
      expect(result.providerTradeNo).toBe("EP20250001");
      expect(result.amountCents).toBe(8866);
      expect(result.currency).toBe("CNY");
    });

    it("supports SUCCESS status alias", async () => {
      const params: Record<string, string> = {
        status: "SUCCESS",
        total_fee: "50.00",
        out_trade_no: "TG-002",
        trade_no: "EP20250002",
        sign_type: "MD5",
      };
      const signStr = buildSignString(params);
      const sign = md5Hex(signStr + TEST_CONFIG.key);

      const result = await provider.verifyCallback({ ...params, sign });
      expect(result.orderNo).toBe("TG-002");
      expect(result.amountCents).toBe(5000);
    });

    it.each(["1e2", "1.001", "-1", "NaN"])("rejects a signed callback with malformed money %s", async (money) => {
      const params: Record<string, string> = {
        trade_status: "TRADE_SUCCESS",
        money,
        out_trade_no: "TG-BAD-MONEY",
        trade_no: "EP-BAD-MONEY",
        sign_type: "MD5",
      };
      const sign = md5Hex(buildSignString(params) + TEST_CONFIG.key);
      await expect(provider.verifyCallback({ ...params, sign })).rejects.toThrow("Invalid CNY major-unit amount");
    });
  });

  describe("queryStatus", () => {
    it("returns paid=false on non-200", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 500 }));
      const result = await provider.queryStatus("EP20250001");
      expect(result.paid).toBe(false);
    });

    it("returns paid=true when code=1 and status=TRADE_SUCCESS", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ code: 1, status: "TRADE_SUCCESS" }), { status: 200 }),
      );
      const result = await provider.queryStatus("EP20250001");
      expect(result.paid).toBe(true);
      expect(result.providerTradeNo).toBeUndefined();
    });

    it("queries api.php with out_trade_no and returns provider timing fields", async () => {
      let requestUrl = "";
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
        requestUrl = String(url);
        return new Response(JSON.stringify({
          code: 1,
          status: 1,
          trade_no: "EP20250001",
          money: "88.66",
          addtime: "2026-07-15 10:00:00",
          endtime: "2026-07-15 10:29:00",
        }), { status: 200 });
      });

      const result = await provider.queryStatus("TG-001");

      expect(requestUrl).toContain("https://pay.example.com/api.php?act=order");
      expect(requestUrl).toContain("pid=1001");
      expect(requestUrl).toContain("out_trade_no=TG-001");
      expect(result).toMatchObject({
        paid: true,
        providerTradeNo: "EP20250001",
        providerCreatedAt: "2026-07-15 10:00:00",
        paidAt: "2026-07-15 10:29:00",
        amountCents: 8866,
        currency: "CNY",
      });
    });
  });
});

// ── 工厂测试 ──

describe("easyPayFactory", () => {
  it("isAvailable returns true when all env vars present", () => {
    const result = easyPayFactory.isAvailable({
      EASYPAY_PID: "1001",
      EASYPAY_KEY: "key",
      EASYPAY_API_BASE: "https://pay.example.com",
    });
    expect(result).toBe(true);
  });

  it("isAvailable returns false when missing env vars", () => {
    expect(easyPayFactory.isAvailable({})).toBe(false);
    expect(easyPayFactory.isAvailable({ EASYPAY_PID: "1001" })).toBe(false);
  });

  it("rejects non-local HTTP gateways but permits loopback development", () => {
    expect(easyPayFactory.isAvailable({
      EASYPAY_PID: "1001",
      EASYPAY_KEY: "key",
      EASYPAY_API_BASE: "http://pay.example.com/mapi.php",
    })).toBe(false);
    expect(easyPayFactory.isAvailable({
      EASYPAY_PID: "1001",
      EASYPAY_KEY: "key",
      EASYPAY_API_BASE: "http://localhost:8787/mapi.php",
    })).toBe(true);
  });

  it("create returns EasyPayProvider instance", () => {
    const provider = easyPayFactory.create({
      EASYPAY_PID: "1001",
      EASYPAY_KEY: "key",
      EASYPAY_API_BASE: "https://pay.example.com/mapi.php",
      EASYPAY_RETURN_URL: "https://shop.example.com/tg/result",
    });
    expect(provider.name).toBe("easypay");
    expect(provider.displayName).toBe("易支付");
  });

  it("create reads the configured default pay type from env", async () => {
    const provider = easyPayFactory.create({
      EASYPAY_PID: "1001",
      EASYPAY_KEY: "key",
      EASYPAY_API_BASE: "https://pay.example.com/mapi.php",
      EASYPAY_PAY_TYPE: "wxpay",
    });
    let requestBody = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, opts) => {
      requestBody = (opts?.body as URLSearchParams)?.toString() || "";
      return new Response(JSON.stringify({ code: 1, payurl: "https://pay.example.com/qr/abc" }), { status: 200 });
    });

    await provider.createPayment({
      orderNo: "TG-001",
      amountCents: 8866,
      currency: "CNY",
      notifyUrl: "https://shop.example.com/api/pay/callback/easypay",
    });

    expect(requestBody).toContain("type=wxpay");
  });
});
