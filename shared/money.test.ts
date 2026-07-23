import { describe, expect, it } from "vitest";
import {
  CURRENCY_CODES,
  formatMoney,
  formatProviderMajorAmount,
  getCurrencyMeta,
  minorToMajorString,
  normalizeCurrencyCode,
  parseMajorToMinor,
  parseProviderMajorAmount,
  tryNormalizeCurrencyCode,
} from "./money";

describe("currency metadata", () => {
  it("defines the deliberately supported currency set and exponents", () => {
    expect(CURRENCY_CODES).toEqual(["CNY", "USD", "EUR", "HKD", "TWD", "JPY", "KRW"]);
    expect(getCurrencyMeta("cny").exponent).toBe(2);
    expect(getCurrencyMeta("JPY").exponent).toBe(0);
    expect(getCurrencyMeta("krw").exponent).toBe(0);
  });

  it("normalizes known ISO codes and rejects unknown values", () => {
    expect(normalizeCurrencyCode(" cny ")).toBe("CNY");
    expect(() => normalizeCurrencyCode("GBP")).toThrow("Unsupported currency: GBP");
    expect(() => normalizeCurrencyCode(undefined)).toThrow("Unsupported currency");
  });

  it("外部币种无法规范化时返回 null，禁止隐式采用订单币种", () => {
    expect(tryNormalizeCurrencyCode(" cny ")).toBe("CNY");
    expect(tryNormalizeCurrencyCode("")).toBeNull();
    expect(tryNormalizeCurrencyCode("GBP")).toBeNull();
    expect(tryNormalizeCurrencyCode(undefined)).toBeNull();
  });
});

describe("exact major/minor unit conversion", () => {
  it.each(["CNY", "USD", "EUR", "HKD", "TWD"] as const)(
    "parses and formats two-decimal %s values without floating-point arithmetic",
    (currency) => {
      expect(parseMajorToMinor("0.01", currency)).toBe(1);
      expect(parseMajorToMinor("50", currency)).toBe(5000);
      expect(parseMajorToMinor(" 50.5 ", currency)).toBe(5050);
      expect(minorToMajorString(5050, currency)).toBe("50.50");
    },
  );

  it.each(["JPY", "KRW"] as const)("uses zero decimal places for %s", (currency) => {
    expect(parseMajorToMinor("500", currency)).toBe(500);
    expect(minorToMajorString(500, currency)).toBe("500");
    expect(() => parseMajorToMinor("500.0", currency)).toThrow("does not allow decimal places");
  });

  it("rejects ambiguous, negative, over-precise and unsafe input", () => {
    for (const value of ["", ".5", "1.", "1.001", "1e2", "1,000", "+1", "-1"]) {
      expect(() => parseMajorToMinor(value, "CNY"), value).toThrow();
    }
    expect(parseMajorToMinor("90071992547409.91", "CNY")).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => parseMajorToMinor("90071992547409.92", "CNY")).toThrow("safe integer");
    expect(() => minorToMajorString(Number.MAX_SAFE_INTEGER + 1, "CNY")).toThrow("safe integer");
  });

  it("formats negative minor-unit values exactly for ledger displays", () => {
    expect(minorToMajorString(-123, "CNY")).toBe("-1.23");
    expect(formatMoney(-123, "CNY")).toBe("-¥1.23");
  });

  it("keeps non-CNY displays unambiguous", () => {
    expect(formatMoney(110, "CNY")).toBe("¥1.10");
    expect(formatMoney(110, "USD")).toBe("USD 1.10");
    expect(formatMoney(500, "JPY")).toBe("JPY 500");
  });
});

describe("provider amount boundary", () => {
  it("formats and parses EasyPay CNY amounts exactly", () => {
    expect(formatProviderMajorAmount(110, "CNY", "CNY")).toBe("1.10");
    expect(parseProviderMajorAmount("1.10", "CNY", "CNY")).toBe(110);
  });

  it("fails closed for unsupported provider currencies or malformed values", () => {
    expect(() => formatProviderMajorAmount(110, "USD", "CNY")).toThrow("only supports CNY");
    expect(() => parseProviderMajorAmount("1e2", "CNY", "CNY")).toThrow();
    expect(() => parseProviderMajorAmount("1.001", "CNY", "CNY")).toThrow();
    expect(() => parseProviderMajorAmount("0.00", "CNY", "CNY")).toThrow("greater than zero");
  });
});
