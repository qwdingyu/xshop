import { describe, expect, it } from "vitest";
import {
  FREE_PRODUCT_DEFAULT_PURCHASE_LIMIT,
  FREE_PRODUCT_QUANTITY,
  effectivePurchaseLimitForProduct,
  getFreeProductCheckoutViolation,
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

  it("不改变付费商品的支付选择和优惠码语义", () => {
    expect(normalizeCheckoutIntent(1200, {
      quantity: 2,
      couponCode: " FREE100 ",
      balancePayment: false,
      paymentChannel: "wxpay",
    })).toEqual({
      quantity: 2,
      couponCode: "FREE100",
      balancePayment: false,
      paymentChannel: "wxpay",
      emailAccessCode: "",
    });
  });

  it.each([
    [{ quantity: 2 }, "quantity"],
    [{ quantity: 1, couponCode: "FREE100" }, "coupon"],
    [{ quantity: 1, balancePayment: true }, "payment_method"],
    [{ quantity: 1, paymentChannel: "alipay" as const }, "payment_method"],
    [{ quantity: 1 }, "email_verification"],
    [{ quantity: 1, emailAccessCode: "12" }, "email_verification"],
    [{ quantity: 1, emailAccessCode: "abcdef" }, "email_verification"],
  ] as const)("拒绝绕过免费领取约束的请求 %#", (input, violation) => {
    expect(getFreeProductCheckoutViolation(0, input)).toBe(violation);
    expect(getFreeProductCheckoutViolation(100, input)).toBeNull();
  });

  it("合法 6 位验证码的免费请求通过约束校验", () => {
    expect(getFreeProductCheckoutViolation(0, {
      quantity: 1,
      emailAccessCode: "123456",
    })).toBeNull();
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

  it("付费余额路径规范化才携带验证码；在线支付清空验证码", () => {
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
    expect(normalizeCheckoutIntent(100, {
      quantity: 1,
      balancePayment: false,
      paymentChannel: "alipay",
      emailAccessCode: "111222",
    }).emailAccessCode).toBe("");
  });
});
