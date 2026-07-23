import { describe, expect, it } from "vitest";
import {
  FREE_PRODUCT_QUANTITY,
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

  it("将免费商品规范化为单件且不携带优惠和支付参数", () => {
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
      emailAccessCode: "",
    });
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
    [{ quantity: 1, emailAccessCode: "123456" }, "payment_method"],
  ] as const)("拒绝绕过免费领取界面的请求 %#", (input, violation) => {
    expect(getFreeProductCheckoutViolation(0, input)).toBe(violation);
    expect(getFreeProductCheckoutViolation(100, input)).toBeNull();
  });
});
