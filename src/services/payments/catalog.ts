import type { ProviderFactory } from "@usethink/cf-core/features/payment";
import { EASYPAY_SUPPORTED_CURRENCIES, easyPayFactory } from "./easypay";

export type ProviderFieldMeta = {
  key: string;
  label: string;
  type?: "text" | "password" | "url";
  required: boolean;
  sensitive: boolean;
  placeholder?: string;
  hint?: string;
};

export type PaymentProviderCatalogItem = {
  name: string;
  displayName: string;
  description: string;
  supportedCurrencies: readonly string[];
  factory: ProviderFactory;
  fields: ProviderFieldMeta[];
};

export const PAYMENT_PROVIDER_CATALOG = [
  {
    name: "easypay",
    displayName: "易支付",
    description: "对接所有兼容易支付协议的聚合网关，包括 ZPay；支持支付宝、微信和 QQ 支付",
    supportedCurrencies: EASYPAY_SUPPORTED_CURRENCIES,
    factory: easyPayFactory,
    fields: [
      { key: "EASYPAY_PID", label: "商户PID", required: true, sensitive: false },
      { key: "EASYPAY_KEY", label: "商户密钥", type: "password", required: true, sensitive: true },
      {
        key: "EASYPAY_API_BASE",
        label: "易支付接口地址",
        type: "url",
        required: true,
        sensitive: false,
        placeholder: "https://zpayz.cn",
        hint: "填写服务商提供的根地址即可；粘贴 submit.php、mapi.php 或 api.php 时，系统会自动归一化并内部派生下单与查单端点。",
      },
      {
        key: "EASYPAY_RETURN_URL",
        label: "支付后跳转URL（可选）",
        type: "url",
        required: false,
        sensitive: false,
        placeholder: "留空由调用方自动生成",
        hint: "异步通知地址由系统按当前域名自动生成：/api/pay/callback/easypay；这里只控制用户支付完成后的页面跳转。",
      },
      {
        key: "EASYPAY_PAY_TYPE",
        label: "默认收款方式",
        required: false,
        sensitive: false,
        placeholder: "alipay",
        hint: "选择默认提交给易支付的 type。ZPay 若只开通支付宝，请保持支付宝。",
      },
      {
        key: "EASYPAY_ENABLED_PAY_TYPES",
        label: "启用收款方式",
        required: false,
        sensitive: false,
        placeholder: "alipay",
        hint: "逗号分隔：alipay、wxpay、qqpay。前台只展示这里启用的方式；留空时只启用默认收款方式。",
      },
    ],
  },
] satisfies PaymentProviderCatalogItem[];

export const PAYMENT_PROVIDER_FACTORIES = PAYMENT_PROVIDER_CATALOG.map((item) => item.factory);
export const VALID_PROVIDER_NAMES = PAYMENT_PROVIDER_CATALOG.map((item) => item.name) as Array<ValidProviderName>;

export type ValidProviderName = typeof PAYMENT_PROVIDER_CATALOG[number]["name"];

export function getProviderMeta(name: string): PaymentProviderCatalogItem | undefined {
  return PAYMENT_PROVIDER_CATALOG.find((item) => item.name === name);
}

export function isValidProviderName(name: string): name is ValidProviderName {
  return PAYMENT_PROVIDER_CATALOG.some((item) => item.name === name);
}
