import { describe, expect, it } from "vitest";
import {
  FREE_PRODUCT_DEFAULT_PURCHASE_LIMIT,
  FREE_PRODUCT_QUANTITY,
  effectivePurchaseLimitForProduct,
  getFreeProductCheckoutViolation,
  hasValidEmailAccessCode,
  isBasePriceFree,
  normalizeCheckoutIntent,
} from "./checkout-policy";

describe("checkout policy", () => {
  it("只把基础价格为 0 的商品识别为免费商品", () => {
    expect(isBasePriceFree(0)).toBe(true);
    expect(isBasePriceFree(1)).toBe(false);
    expect(isBasePriceFree(1200)).toBe(false);
  });

  it("将免费商品规范化为单件、清空优惠/支付，但保留邮箱验证码", () => {
    expect(normalizeCheckoutIntent(0, {
      quantity: 9,
      couponCode: " FREE100 ",
      balancePayment: true,
      paymentChannel: "alipay",
      emailAccessCode: "123456",
    })).toEqual({
      quantity: FREE_PRODUCT_QUANTITY,
      couponCode: "",
      balancePayment: false,
      paymentChannel: "",
      emailAccessCode: "123456",
    });
  });

  it("免费商品规范化时 trim 验证码，空码保持空串", () => {
    expect(normalizeCheckoutIntent(0, {
      quantity: 1,
      emailAccessCode: " 654321 ",
    }).emailAccessCode).toBe("654321");
    expect(normalizeCheckoutIntent(0, {
      quantity: 1,
    }).emailAccessCode).toBe("");
  });

  it("付费商品在线支付也保留邮箱验证码", () => {
    expect(normalizeCheckoutIntent(1200, {
      quantity: 2,
      couponCode: " FREE100 ",
      balancePayment: false,
      paymentChannel: "wxpay",
      emailAccessCode: " 111222 ",
    })).toEqual({
      quantity: 2,
      couponCode: "FREE100",
      balancePayment: false,
      paymentChannel: "wxpay",
      emailAccessCode: "111222",
    });
  });

  it.each([
    [{ quantity: 2 }, "quantity"],
    [{ quantity: 1, couponCode: "FREE100" }, "coupon"],
    [{ quantity: 1, balancePayment: true }, "payment_method"],
    [{ quantity: 1, paymentChannel: "alipay" as const }, "payment_method"],
  ] as const)("拒绝绕过免费领取约束的请求 %#", (input, violation) => {
    expect(getFreeProductCheckoutViolation(0, input)).toBe(violation);
    expect(getFreeProductCheckoutViolation(100, input)).toBeNull();
  });

  it("免费商品专用约束不再重复校验验证码格式", () => {
    expect(getFreeProductCheckoutViolation(0, {
      quantity: 1,
    })).toBeNull();
    expect(getFreeProductCheckoutViolation(0, {
      quantity: 1,
      emailAccessCode: "123456",
    })).toBeNull();
  });

  it("hasValidEmailAccessCode 只接受 6 位数字", () => {
    expect(hasValidEmailAccessCode("123456")).toBe(true);
    expect(hasValidEmailAccessCode(" 654321 ")).toBe(true);
    expect(hasValidEmailAccessCode("12")).toBe(false);
    expect(hasValidEmailAccessCode("abcdef")).toBe(false);
    expect(hasValidEmailAccessCode("")).toBe(false);
    expect(hasValidEmailAccessCode(undefined)).toBe(false);
  });

  it("免费商品未配置限购时默认 1 件；付费商品空限购仍不限", () => {
    expect(effectivePurchaseLimitForProduct(0, null)).toBe(FREE_PRODUCT_DEFAULT_PURCHASE_LIMIT);
    expect(effectivePurchaseLimitForProduct(0, undefined)).toBe(FREE_PRODUCT_DEFAULT_PURCHASE_LIMIT);
    expect(effectivePurchaseLimitForProduct(0, 0)).toBe(FREE_PRODUCT_DEFAULT_PURCHASE_LIMIT);
    expect(effectivePurchaseLimitForProduct(0, 3)).toBe(3);
    expect(effectivePurchaseLimitForProduct(1200, null)).toBeNull();
    expect(effectivePurchaseLimitForProduct(1200, 0)).toBeNull();
    expect(effectivePurchaseLimitForProduct(1200, 2)).toBe(2);
  });

  it("免费请求允许带验证码且禁止同时带支付渠道", () => {
    expect(getFreeProductCheckoutViolation(0, {
      quantity: 1,
      emailAccessCode: "000000",
      paymentChannel: "wxpay",
    })).toBe("payment_method");
    expect(getFreeProductCheckoutViolation(0, {
      quantity: 1,
      emailAccessCode: "000000",
      balancePayment: true,
    })).toBe("payment_method");
  });

  it("付费余额路径规范化携带验证码且清空支付渠道", () => {
    expect(normalizeCheckoutIntent(100, {
      quantity: 1,
      balancePayment: true,
      emailAccessCode: " 111222 ",
      paymentChannel: "alipay",
    })).toEqual({
      quantity: 1,
      couponCode: "",
      balancePayment: true,
      paymentChannel: "",
      emailAccessCode: "111222",
    });
  });
});
