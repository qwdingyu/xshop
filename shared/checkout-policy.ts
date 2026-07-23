/**
 * 免费商品的判定只看商品基础价格，不看优惠后的应付金额。
 * 付费商品使用 100% 优惠码后仍属于优惠结算，必须继续走优惠码核销流程。
 */
export function isBasePriceFree(basePriceMinor: number): boolean {
  return basePriceMinor === 0;
}

export const FREE_PRODUCT_QUANTITY = 1;

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
 * 免费商品固定单次领取 1 件，且不携带任何支付或优惠凭据，避免本地恢复状态污染订单语义。
 */
export function normalizeCheckoutIntent(basePriceMinor: number, input: CheckoutIntentInput): CheckoutIntent {
  if (isBasePriceFree(basePriceMinor)) {
    return {
      quantity: FREE_PRODUCT_QUANTITY,
      couponCode: "",
      balancePayment: false,
      paymentChannel: "",
      emailAccessCode: "",
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

export type FreeProductCheckoutViolation = "quantity" | "coupon" | "payment_method";

/**
 * 后端使用该函数校验客户端是否绕过免费领取界面直接构造请求。
 * 返回 null 表示请求符合免费商品约束；非免费商品不受这组专用规则影响。
 */
export function getFreeProductCheckoutViolation(
  basePriceMinor: number,
  input: CheckoutIntentInput,
): FreeProductCheckoutViolation | null {
  if (!isBasePriceFree(basePriceMinor)) return null;
  if (input.quantity !== FREE_PRODUCT_QUANTITY) return "quantity";
  if (input.couponCode?.trim()) return "coupon";
  if (input.balancePayment || input.paymentChannel || input.emailAccessCode?.trim()) return "payment_method";
  return null;
}
