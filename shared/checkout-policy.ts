/**
 * 免费商品的判定只看商品基础价格，不看优惠后的应付金额。
 * 付费商品使用 100% 优惠码后仍属于优惠结算，必须继续走优惠码核销流程。
 */
export function isBasePriceFree(basePriceMinor: number): boolean {
  return basePriceMinor === 0;
}

export const FREE_PRODUCT_QUANTITY = 1;

/** 免费领取默认每邮箱限购件数（运营侧与后端兜底一致） */
export const FREE_PRODUCT_DEFAULT_PURCHASE_LIMIT = 1;

export type CheckoutPaymentChannel = "alipay" | "wxpay" | "qqpay";

export interface CheckoutIntentInput {
  quantity: number;
  couponCode?: string;
  balancePayment?: boolean;
  paymentChannel?: CheckoutPaymentChannel | "";
  emailAccessCode?: string;
}

export interface CheckoutIntent {
  quantity: number;
  couponCode: string;
  balancePayment: boolean;
  paymentChannel: CheckoutPaymentChannel | "";
  emailAccessCode: string;
}

/**
 * 前端提交和待恢复请求共用同一套规范化规则。
 * 免费商品固定单次领取 1 件，清空支付/优惠凭据，但保留邮箱验证码（归属校验必需）。
 */
export function normalizeCheckoutIntent(basePriceMinor: number, input: CheckoutIntentInput): CheckoutIntent {
  if (isBasePriceFree(basePriceMinor)) {
    return {
      quantity: FREE_PRODUCT_QUANTITY,
      couponCode: "",
      balancePayment: false,
      paymentChannel: "",
      emailAccessCode: input.emailAccessCode?.trim() || "",
    };
  }
  return {
    quantity: input.quantity,
    couponCode: input.couponCode?.trim() || "",
    balancePayment: input.balancePayment === true,
    paymentChannel: input.balancePayment ? "" : (input.paymentChannel || ""),
    emailAccessCode: input.balancePayment ? (input.emailAccessCode?.trim() || "") : "",
  };
}

export type FreeProductCheckoutViolation =
  | "quantity"
  | "coupon"
  | "payment_method"
  | "email_verification";

/**
 * 后端使用该函数校验客户端是否绕过免费领取界面直接构造请求。
 * 返回 null 表示请求符合免费商品约束；非免费商品不受这组专用规则影响。
 *
 * 免费领取必须携带 6 位邮箱验证码；支付方式/优惠码/多数量仍禁止。
 */
export function getFreeProductCheckoutViolation(
  basePriceMinor: number,
  input: CheckoutIntentInput,
): FreeProductCheckoutViolation | null {
  if (!isBasePriceFree(basePriceMinor)) return null;
  if (input.quantity !== FREE_PRODUCT_QUANTITY) return "quantity";
  if (input.couponCode?.trim()) return "coupon";
  if (input.balancePayment || input.paymentChannel) return "payment_method";
  const code = input.emailAccessCode?.trim() || "";
  if (!/^\d{6}$/.test(code)) return "email_verification";
  return null;
}

/**
 * 免费商品限购兜底：运营未配置 purchaseLimit 时按默认 1 件计。
 * 付费商品仍尊重“空=不限购”。
 */
export function effectivePurchaseLimitForProduct(
  basePriceMinor: number,
  purchaseLimit: number | null | undefined,
): number | null {
  if (typeof purchaseLimit === "number" && purchaseLimit > 0) return purchaseLimit;
  if (isBasePriceFree(basePriceMinor)) return FREE_PRODUCT_DEFAULT_PURCHASE_LIMIT;
  return null;
}
