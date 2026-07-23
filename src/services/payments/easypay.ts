/**
 * 易支付兼容 Provider — cf-shop
 *
 * 对接所有兼容易支付协议的聚合平台，包括 ZPay 等。
 * 后台只需要配置一个接口基础地址，运行时按官方协议派生：
 * - API 下单：{apiBase}/mapi.php
 * - 页面跳转：{apiBase}/submit.php（当前未启用 hosted 模式）
 * - 内部查单：{apiBase}/api.php
 *
 * 核心规则：
 * - MD5 签名校验（手工拼接 a=b&c=d，排序后追加 key）
 * - trade_status = TRADE_SUCCESS 确认支付
 * - 金额核对由路由层按订单金额再次执行
 * - 迟到回调通过 api.php 查单补偿实际付款时间
 * - 返回 "success" 避免网关重试
 */

import type {
  CreatePaymentInput,
  CreatePaymentResult,
  CallbackResult,
  QueryStatusResult,
  PaymentProvider,
  ProviderFactory,
} from "@usethink/cf-core/features/payment";
import { md5Hex } from "../../lib/md5";
import { isSecurePaymentUrl, normalizeSecurePaymentUrl } from "../../lib/payment-url";
import {
  formatProviderMajorAmount,
  parseProviderMajorAmount,
} from "../../../shared/money";

// 允许运营粘贴服务商文档里的任一端点；入库和运行时都先剥离成协议根地址。
// 注意：这里不是兼容旧 provider，只是把同一易支付协议的端点输入规整为一个配置值。
const EASYPAY_ENDPOINT_SUFFIXES = ["/submit.php", "/mapi.php", "/api.php"];

export type EasyPayProviderErrorKind = "deterministic" | "ambiguous";

export class EasyPayProviderError extends Error {
  readonly kind: EasyPayProviderErrorKind;
  readonly httpStatus?: number;
  readonly providerMessage?: string;

  constructor(
    kind: EasyPayProviderErrorKind,
    message: string,
    details: { httpStatus?: number; providerMessage?: string; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "EasyPayProviderError";
    this.kind = kind;
    this.httpStatus = details.httpStatus;
    this.providerMessage = details.providerMessage;
    if (details.cause) {
      (this as Error & { cause?: unknown }).cause = details.cause;
    }
  }
}

export function isAmbiguousEasyPayProviderError(error: unknown): boolean {
  return error instanceof EasyPayProviderError && error.kind === "ambiguous";
}

// ── 内联 fetchWithRetry（避免额外文件依赖）──
const RETRY_DELAYS = [500, 1500];

async function fetchWithRetry(
  url: string,
  options: RequestInit & { retries?: number; timeoutMs?: number } = {},
): Promise<Response> {
  const maxRetries = options.retries ?? 2;
  const timeoutMs = options.timeoutMs ?? 10_000;
  let lastError = "";

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    try {
      const controller = new AbortController();
      timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      const resp = await fetch(url, { ...options, signal: controller.signal });
      // 4xx 通常是参数、签名或商户配置错误，重试不会修复；429 可能是短时限流，保留重试。
      if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) return resp;
      if (!resp.ok && attempt <= maxRetries) {
        lastError = `HTTP ${resp.status}`;
        await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt - 1] ?? 1000));
        continue;
      }
      return resp;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt <= maxRetries) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt - 1] ?? 1000));
        continue;
      }
      throw new EasyPayProviderError(
        "ambiguous",
        `EasyPay 网络请求中断或超时：${lastError}`,
        { cause: err },
      );
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }
  throw new EasyPayProviderError("ambiguous", `EasyPay 网络请求结果不确定：${lastError}`);
}

// ── 工具函数 ──

/** 构建签名字符串（导出供测试使用）。
 * 易支付 MD5 签名要求：过滤 sign/sign_type/空值，按参数名升序拼接，末尾追加商户密钥。
 * 这里刻意不做 URL 编码；编码只发生在真正提交表单时，否则签名会和上游计算结果不一致。
 */
export function buildSignString(params: Record<string, string | undefined>): string {
  return Object.entries(params)
    .filter(([k, v]) => k !== "sign" && k !== "sign_type" && v !== "" && v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

/** 验证易支付回调签名（导出供测试使用） */
export async function verifyEasyPaySign(
  params: Record<string, string>,
  key: string,
): Promise<boolean> {
  const received = (params.sign || "").toLowerCase();
  if (!received) return false;
  const signStr = buildSignString(params);
  const calculated = md5Hex(signStr + key);
  return calculated === received;
}

/**
 * 归一化易支付接口基础地址。
 *
 * 运营经常会从服务商文档里复制根地址、submit.php、mapi.php 或 api.php。
 * 为避免把页面跳转端点误当成 API 下单端点，这里只保存协议根地址，
 * 运行时再按用途派生 mapi.php / api.php。
 */
export function normalizeEasyPayApiBaseUrl(value: string | undefined): string {
  const secureUrl = normalizeSecurePaymentUrl(value);
  if (!secureUrl) return "";

  try {
    const parsed = new URL(secureUrl);
    // 查询串和 hash 只属于文档链接或调试参数，不能进入基础地址，否则会污染 mapi/api 派生结果。
    parsed.search = "";
    parsed.hash = "";
    const rawPath = parsed.pathname.replace(/\/+$/, "");
    const lowerPath = rawPath.toLowerCase();
    const endpointSuffix = EASYPAY_ENDPOINT_SUFFIXES.find((suffix) => lowerPath.endsWith(suffix));
    const basePath = endpointSuffix
      ? rawPath.slice(0, rawPath.length - endpointSuffix.length).replace(/\/+$/, "")
      : rawPath;
    return `${parsed.origin}${basePath === "/" ? "" : basePath}`.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

export function buildEasyPayPaymentApiUrl(value: string | undefined): string {
  const baseUrl = normalizeEasyPayApiBaseUrl(value);
  return baseUrl ? `${baseUrl}/mapi.php` : "";
}

export function buildEasyPayQueryApiUrl(value: string | undefined): string {
  const baseUrl = normalizeEasyPayApiBaseUrl(value);
  return baseUrl ? `${baseUrl}/api.php` : "";
}

// ── Provider ──

export interface EasyPayConfig {
  /** 商户唯一标识（易支付服务商后台获取） */
  pid: string;
  /** 商户密钥（易支付服务商后台获取） */
  key: string;
  /** 易支付接口基础地址；不要在业务代码里直接拼用户输入的 submit.php/mapi.php/api.php */
  apiBase: string;
  /** 异步通知 URL（由路由层按当前域名生成） */
  notifyUrl: string;
  /** 支付完成跳转 URL */
  returnUrl?: string;
  /** 默认易支付 type 参数：alipay / wxpay / qqpay */
  payType?: string;
  /** 后台明确启用的易支付 type 列表；留空时兼容旧配置，仅启用默认收款方式 */
  enabledPayTypes?: string | string[];
}

export type EasyPayPayType = "alipay" | "wxpay" | "qqpay";
const EASY_PAY_PAY_TYPES: EasyPayPayType[] = ["alipay", "wxpay", "qqpay"];

export type EasyPayQueryStatusResult = QueryStatusResult;

export function normalizeEasyPayPayType(value: unknown): EasyPayPayType {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "wxpay" || normalized === "qqpay" ? normalized : "alipay";
}

export function normalizeEasyPayEnabledPayTypes(value: unknown, fallback: unknown = "alipay"): EasyPayPayType[] {
  const fallbackPayType = normalizeEasyPayPayType(fallback);
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const enabled: EasyPayPayType[] = [];
  for (const raw of rawValues) {
    if (typeof raw !== "string") continue;
    const normalized = raw.trim().toLowerCase();
    if (!EASY_PAY_PAY_TYPES.includes(normalized as EasyPayPayType)) continue;
    if (!enabled.includes(normalized as EasyPayPayType)) enabled.push(normalized as EasyPayPayType);
  }
  return enabled.length > 0 ? enabled : [fallbackPayType];
}

export function easyPayPayTypeLabel(value: unknown): string {
  const payType = normalizeEasyPayPayType(value);
  if (payType === "wxpay") return "微信支付";
  if (payType === "qqpay") return "QQ 支付";
  return "支付宝";
}

function responseCodeIsSuccess(value: unknown): boolean {
  if (value === 1) return true;
  if (typeof value === "string") return value.trim() === "1";
  return false;
}

function statusIsPaid(value: unknown): boolean {
  // 不同易支付服务商查单返回略有差异：有的返回数字 1，有的返回 TRADE_SUCCESS/SUCCESS。
  // 只把明确成功值视为 paid，未知状态一律 fail closed。
  if (value === 1) return true;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toUpperCase();
  return normalized === "1" || normalized === "TRADE_SUCCESS" || normalized === "SUCCESS";
}

function moneyToCents(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  try {
    return parseProviderMajorAmount(String(value), "CNY", "CNY");
  } catch {
    return undefined;
  }
}

export const EASYPAY_SUPPORTED_CURRENCIES = ["CNY"] as const;

export class EasyPayProvider implements PaymentProvider {
  readonly name = "easypay";
  readonly displayName = "易支付";
  readonly supportedCurrencies = [...EASYPAY_SUPPORTED_CURRENCIES];
  readonly defaultPayType: EasyPayPayType;
  readonly enabledPayTypes: EasyPayPayType[];

  constructor(private config: EasyPayConfig) {
    this.defaultPayType = normalizeEasyPayPayType(config.payType);
    this.enabledPayTypes = normalizeEasyPayEnabledPayTypes(config.enabledPayTypes, this.defaultPayType);
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const { pid, key, apiBase } = this.config;
    const amount = formatProviderMajorAmount(input.amountCents, input.currency, "CNY");

    // 从 metadata.payType 读取支付方式，兼容 TG Bot 按钮选择；Web 未显式选择时使用商户配置。
    // 默认支付宝，因为聚合易支付商户常见开通顺序是先开 alipay，不能擅自把订单打到微信通道。
    const requestedPayType = input.metadata?.payType
      ? normalizeEasyPayPayType(input.metadata.payType)
      : this.defaultPayType;
    if (!this.enabledPayTypes.includes(requestedPayType)) {
      throw new EasyPayProviderError(
        "deterministic",
        `EasyPay: ${easyPayPayTypeLabel(requestedPayType)}未在后台启用`,
        { providerMessage: "pay_type_disabled" },
      );
    }
    const payType = requestedPayType;

    // notifyUrl 优先使用调用方传入的（如 TG Bot 回调路径），降级到配置中的全局 notifyUrl
    const effectiveNotifyUrl = input.notifyUrl || this.config.notifyUrl || "";
    // returnUrl 优先使用调用方传入的（如 TG Bot 支付结果页），降级到配置中的全局 returnUrl
    const effectiveReturnUrl = input.returnUrl || this.config.returnUrl || "";

    // 易支付 mapi.php 请求参数。签名时不做 URL 编码，提交时再由 URLSearchParams 编码。
    const params: Record<string, string> = {
      pid,
      type: payType,
      out_trade_no: input.orderNo,
      notify_url: effectiveNotifyUrl,
      return_url: effectiveReturnUrl,
      name: input.metadata?.subject || "商品购买",
      money: amount,
      // 设备类型：alipay → alipay，wxpay → wechat，其他 → pc（对标 TGPays bot.php 的 device 映射）
      device: payType === "alipay" ? "alipay" : payType === "wxpay" ? "wechat" : "pc",
      // 客户端 IP（可选，部分易支付平台需要）
      clientip: input.metadata?.clientIp || "",
      param: input.orderNo,
      sign_type: "MD5",
    };

    // 下单签名在提交前完成，签名原文使用未编码参数；body 再由 URLSearchParams 做表单编码。
    params.sign = md5Hex(buildSignString(params) + key);

    const resp = await fetchWithRetry(buildEasyPayPaymentApiUrl(apiBase), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
      timeoutMs: 8_000,
      retries: 2,
    });

    if (!resp.ok) {
      const ambiguous = resp.status >= 500 || resp.status === 429;
      throw new EasyPayProviderError(
        ambiguous ? "ambiguous" : "deterministic",
        `EasyPay HTTP ${resp.status}`,
        { httpStatus: resp.status },
      );
    }

    type EasyPayCreateResponse = {
      code?: number | string; msg?: string;
      payurl?: string; qrcode?: string; img?: string; urlscheme?: string; trade_no?: string;
    };
    let data: EasyPayCreateResponse;
    try {
      data = await resp.json() as EasyPayCreateResponse;
    } catch (error) {
      // 已收到 HTTP 200 但响应体不是 EasyPay JSON，属于确定的协议/网关配置错误；
      // 不能伪装成“可能已建单”，否则前台只能无意义轮询。
      throw new EasyPayProviderError("deterministic", "EasyPay 响应不是有效 JSON", { cause: error });
    }

    // code=1 才代表上游明确创建成功；其他响应不能降级成线下支付，避免同一订单重复收款。
    if (!responseCodeIsSuccess(data.code)) {
      throw new EasyPayProviderError(
        "deterministic",
        `EasyPay: ${data.msg || "unknown"}`,
        { providerMessage: data.msg || "unknown" },
      );
    }

    const qrcode = typeof data.qrcode === "string" ? data.qrcode.trim() : "";
    const img = typeof data.img === "string" ? data.img.trim() : "";

    return {
      // 创建响应未返回平台流水号时保持缺失；商户订单号 out_trade_no 不是 trade_no。
      providerTradeNo: data.trade_no || undefined,
      // EasyPay 官方字段语义：qrcode 是二维码内容/链接，img 才是二维码图片地址。
      // cf-core 的公共类型暂时只有 qrCode，所以这里保持向后兼容，精确语义放入 raw 供路由层拆分。
      qrCode: img || qrcode,
      redirectUrl: data.payurl || data.urlscheme || "",
      raw: {
        ...data,
        payType,
        payTypeLabel: easyPayPayTypeLabel(payType),
        qrcode,
        img,
        qrContent: qrcode,
        qrImageUrl: img,
      },
    };
  }

  async verifyCallback(params: Record<string, string>): Promise<CallbackResult> {
    const key = this.config.key;

    if (!(await verifyEasyPaySign(params, key))) {
      throw new Error("EasyPay signature invalid");
    }

    const tradeStatus = params.trade_status || params.status || "";
    if (tradeStatus !== "TRADE_SUCCESS" && tradeStatus !== "SUCCESS") {
      throw new Error(`Unexpected trade_status: ${tradeStatus}`);
    }

    // Provider 只把回调解析成标准结果；金额是否等于订单金额由路由层统一校验。
    const moneyStr = params.money || params.total_fee || "0";
    const amountCents = parseProviderMajorAmount(moneyStr, "CNY", "CNY");
    const orderNo = params.out_trade_no || "";
    const providerTradeNo = params.trade_no?.trim() || "";
    if (!providerTradeNo) throw new Error("EasyPay callback missing trade_no");

    return {
      orderNo,
      providerTradeNo,
      amountCents,
      currency: "CNY",
      paidAt: params.time || new Date().toISOString(),
      raw: params,
    };
  }

  async queryStatus(outTradeNo: string): Promise<EasyPayQueryStatusResult> {
    const { pid, key, apiBase } = this.config;
    // 易支付查单接口使用 key 明文鉴权。apiBase 在工厂和后台保存时已要求 HTTPS/本地回环，
    // 这里仍只从归一化后的 apiBase 派生 api.php，避免把运营输入直接拼成任意请求地址。
    const queryUrl = `${buildEasyPayQueryApiUrl(apiBase)}?act=order&pid=${encodeURIComponent(pid)}&key=${encodeURIComponent(key)}&out_trade_no=${encodeURIComponent(outTradeNo)}`;

    const resp = await fetchWithRetry(queryUrl, { method: "GET", timeoutMs: 3_000, retries: 0 });
    if (!resp.ok) return { paid: false };

    const data = await resp.json() as {
      code?: number | string;
      status?: number | string;
      trade_status?: string;
      trade_no?: string;
      money?: string;
      addtime?: string;
      endtime?: string;
      data?: {
        status?: number | string;
        trade_status?: string;
        trade_no?: string;
        money?: string;
        addtime?: string;
        endtime?: string;
      };
    };
    const nested = data.data || {};
    // 部分实现把订单字段放在 data 内，部分放在顶层；两层都读取，但 code/status 必须明确成功。
    const paidByStatus = statusIsPaid(data.trade_status)
      || statusIsPaid(data.status)
      || statusIsPaid(nested.trade_status)
      || statusIsPaid(nested.status);
    return {
      paid: responseCodeIsSuccess(data.code) && paidByStatus,
      // out_trade_no 是本系统商户订单号，绝不能伪装成支付平台 trade_no。
      // 上游未返回独立流水号时保持缺失，让对账层拒绝自动入账。
      providerTradeNo: data.trade_no || nested.trade_no || undefined,
      providerCreatedAt: data.addtime || nested.addtime || undefined,
      paidAt: data.endtime || nested.endtime || undefined,
      // 易支付协议固定以人民币金额字段 money 表示；主动对账必须带回金额，路由层才能做二次核验。
      amountCents: moneyToCents(data.money || nested.money),
      currency: "CNY",
    };
  }
}

// ── 工厂 ──

export const easyPayFactory: ProviderFactory = {
  name: "easypay",
  priority: 40,
  isAvailable(env) {
    const apiBase = normalizeEasyPayApiBaseUrl(String(env.EASYPAY_API_BASE || ""));
    // 可用性检查必须同时满足商户凭据、可派生的基础地址和安全 URL，缺一则不注册 provider。
    return !!(
      env.EASYPAY_PID
      && env.EASYPAY_KEY
      && apiBase
      && isSecurePaymentUrl(apiBase)
    );
  },
  create(env) {
    const apiBase = normalizeEasyPayApiBaseUrl(String(env.EASYPAY_API_BASE || ""));
    return new EasyPayProvider({
      pid: String(env.EASYPAY_PID),
      key: String(env.EASYPAY_KEY),
      apiBase,
      notifyUrl: "",
      returnUrl: normalizeSecurePaymentUrl(String(env.EASYPAY_RETURN_URL || "")),
      payType: normalizeEasyPayPayType(env.EASYPAY_PAY_TYPE),
      enabledPayTypes: normalizeEasyPayEnabledPayTypes(env.EASYPAY_ENABLED_PAY_TYPES, env.EASYPAY_PAY_TYPE),
    });
  },
};
