import { describe, expect, it } from 'vitest'
import { paymentActionLabel, shouldSubmitFromPaymentOptionClick } from './payment-method-action'

describe('payment method action behavior', () => {
  it('submits immediately when the only online method card is clicked', () => {
    expect(shouldSubmitFromPaymentOptionClick({
      clickedKind: 'online',
      clickedChannel: 'alipay',
      selectedMode: 'online',
      selectedChannel: 'alipay',
      onlineOptionCount: 1,
    })).toBe(true)
  })

  it('submits when the already selected online method is clicked again', () => {
    expect(shouldSubmitFromPaymentOptionClick({
      clickedKind: 'online',
      clickedChannel: 'wxpay',
      selectedMode: 'online',
      selectedChannel: 'wxpay',
      onlineOptionCount: 2,
    })).toBe(true)
  })

  it('does not submit while switching between multiple online methods', () => {
    expect(shouldSubmitFromPaymentOptionClick({
      clickedKind: 'online',
      clickedChannel: 'wxpay',
      selectedMode: 'online',
      selectedChannel: 'alipay',
      onlineOptionCount: 2,
    })).toBe(false)
  })

  it('does not submit from the balance method card', () => {
    expect(shouldSubmitFromPaymentOptionClick({
      clickedKind: 'balance',
      selectedMode: 'balance',
      selectedChannel: 'alipay',
      onlineOptionCount: 1,
    })).toBe(false)
  })

  it('names the selected online channel in the primary action', () => {
    expect(paymentActionLabel({ selectedMode: 'online', selectedOnlineLabel: '支付宝' })).toBe('去支付宝支付')
    expect(paymentActionLabel({ selectedMode: 'balance', selectedOnlineLabel: '支付宝' })).toBe('余额支付')
  })

  it('uses a领取 action for base-free products regardless of selected payment state', () => {
    expect(paymentActionLabel({
      selectedMode: 'balance',
      selectedOnlineLabel: '支付宝',
      isFreeProduct: true,
    })).toBe('免费领取')
  })
})
