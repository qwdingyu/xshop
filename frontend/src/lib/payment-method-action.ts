export type PaymentMode = 'online' | 'balance'
export type OnlinePaymentChannel = 'alipay' | 'wxpay' | 'qqpay'
export type PaymentOptionKind = PaymentMode

export function shouldSubmitFromPaymentOptionClick(input: {
  clickedKind: PaymentOptionKind
  clickedChannel?: OnlinePaymentChannel
  selectedMode: PaymentMode
  selectedChannel: OnlinePaymentChannel
  onlineOptionCount: number
}): boolean {
  if (input.clickedKind !== 'online') return false
  if (input.onlineOptionCount === 1) return true
  return input.selectedMode === 'online' && input.clickedChannel === input.selectedChannel
}

export function paymentActionLabel(input: {
  selectedMode: PaymentMode
  selectedOnlineLabel?: string
  isFreeProduct?: boolean
}): string {
  if (input.isFreeProduct) return '免费领取'
  if (input.selectedMode === 'balance') return '余额支付'
  const label = input.selectedOnlineLabel?.trim()
  return label ? `去${label}支付` : '去支付'
}
