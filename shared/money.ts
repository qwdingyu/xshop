import {
  formatProviderMajorAmount as formatCoreProviderMajorAmount,
  minorToMajorString as coreMinorToMajorString,
  normalizeCurrencyCode as normalizeCoreCurrencyCode,
  parseMajorToMinor as parseCoreMajorToMinor,
  parseProviderMajorAmount as parseCoreProviderMajorAmount,
} from "@usethink/cf-core/features/payment/currency";

export const CURRENCY_CODES = ["CNY", "USD", "EUR", "HKD", "TWD", "JPY", "KRW"] as const;

export type CurrencyCode = (typeof CURRENCY_CODES)[number];

export type CurrencyMeta = Readonly<{
  code: CurrencyCode;
  exponent: 0 | 2;
  symbol: string;
  name: string;
}>;

const CURRENCY_META: Readonly<Record<CurrencyCode, CurrencyMeta>> = {
  CNY: { code: "CNY", exponent: 2, symbol: "¥", name: "人民币" },
  USD: { code: "USD", exponent: 2, symbol: "$", name: "美元" },
  EUR: { code: "EUR", exponent: 2, symbol: "€", name: "欧元" },
  HKD: { code: "HKD", exponent: 2, symbol: "HK$", name: "港币" },
  TWD: { code: "TWD", exponent: 2, symbol: "NT$", name: "新台币" },
  JPY: { code: "JPY", exponent: 0, symbol: "¥", name: "日元" },
  KRW: { code: "KRW", exponent: 0, symbol: "₩", name: "韩元" },
};

const CURRENCY_EXPONENTS: Readonly<Record<CurrencyCode, number>> = Object.fromEntries(
  CURRENCY_CODES.map((code) => [code, CURRENCY_META[code].exponent]),
) as Record<CurrencyCode, number>;

function unsupportedCurrencyMessage(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
  return normalized ? `Unsupported currency: ${normalized}` : "Unsupported currency";
}

export function normalizeCurrencyCode(value: unknown): CurrencyCode {
  let normalized = "";
  try {
    normalized = normalizeCoreCurrencyCode(value);
  } catch {
    throw new RangeError(unsupportedCurrencyMessage(value));
  }
  if ((CURRENCY_CODES as readonly string[]).includes(normalized)) {
    return normalized as CurrencyCode;
  }
  throw new RangeError(unsupportedCurrencyMessage(value));
}

/**
 * 支付回调和主动查单属于外部输入，不能把缺失或未知币种默认解释为订单币种。
 * 这些信任边界使用 null 表示“无法证明币种一致”，由调用方 fail closed。
 */
export function tryNormalizeCurrencyCode(value: unknown): CurrencyCode | null {
  try {
    return normalizeCurrencyCode(value);
  } catch {
    return null;
  }
}

export function getCurrencyMeta(currency: unknown): CurrencyMeta {
  return CURRENCY_META[normalizeCurrencyCode(currency)];
}

export function parseMajorToMinor(value: string, currency: unknown): number {
  const normalized = normalizeCurrencyCode(currency);
  return parseCoreMajorToMinor(value, normalized, CURRENCY_EXPONENTS);
}

export function minorToMajorString(value: number, currency: unknown): string {
  const normalized = normalizeCurrencyCode(currency);
  return coreMinorToMajorString(value, normalized, CURRENCY_EXPONENTS);
}

export function formatMoney(value: number, currency: unknown): string {
  const meta = getCurrencyMeta(currency);
  const major = minorToMajorString(value, meta.code);
  const negative = major.startsWith("-");
  const absolute = negative ? major.slice(1) : major;
  if (meta.code === "CNY") return `${negative ? "-" : ""}${meta.symbol}${absolute}`;
  return `${negative ? "-" : ""}${meta.code} ${absolute}`;
}

export function formatProviderMajorAmount(
  value: number,
  currency: unknown,
  supportedCurrency: CurrencyCode,
): string {
  const normalized = normalizeCurrencyCode(currency);
  if (normalized !== supportedCurrency) {
    throw new RangeError(`Payment provider only supports ${supportedCurrency}`);
  }
  return formatCoreProviderMajorAmount(value, normalized, [supportedCurrency], CURRENCY_EXPONENTS);
}

export function parseProviderMajorAmount(
  value: string,
  currency: unknown,
  supportedCurrency: CurrencyCode,
): number {
  const normalized = normalizeCurrencyCode(currency);
  if (normalized !== supportedCurrency) {
    throw new RangeError(`Payment provider only supports ${supportedCurrency}`);
  }
  return parseCoreProviderMajorAmount(value, normalized, [supportedCurrency], CURRENCY_EXPONENTS);
}
