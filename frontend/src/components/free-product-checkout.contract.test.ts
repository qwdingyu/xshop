import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const payModalSource = readFileSync(new URL('./PayModal.vue', import.meta.url), 'utf8')
const productCardSource = readFileSync(new URL('./ProductCard.vue', import.meta.url), 'utf8')

describe('free product checkout UI contract', () => {
  it('hides coupon, quantity, online payment, and balance payment for base-free products', () => {
    // 折扣码 / 数量 各一处 v-if；文案提示嵌在折扣码块内
    expect(payModalSource.match(/v-if="!isBasePriceFreeProduct"/g)).toHaveLength(2)
    expect(payModalSource).toContain('v-if="couponMsg"')
    expect(payModalSource).toContain('class="order-fields"')
    expect(payModalSource).toContain('checkoutStepLabels')
    expect(payModalSource).toContain('const balancePayAvailable = computed(() => !isBasePriceFreeProduct.value')
    expect(payModalSource).toContain('const showOnlinePaymentSection = computed(() => !isBasePriceFreeProduct.value')
  })

  it('requires email verification UI and submits access code for free claims', () => {
    expect(payModalSource).toContain('v-if="isBasePriceFreeProduct" class="field-block free-claim-auth"')
    expect(payModalSource).toContain('placeholder="邮箱验证码（必填）"')
    expect(payModalSource).toContain('免费领取需验证邮箱归属')
    expect(payModalSource).toContain("if ((useBalance || isBasePriceFreeProduct.value) && !/^\\d{6}$/.test(intent.emailAccessCode))")
    expect(payModalSource).toContain('emailAccessCode: intent.emailAccessCode || undefined')
    expect(payModalSource).toContain('balancePayment: isBasePriceFreeProduct.value ? undefined : useBalance')
    expect(payModalSource).toContain('paymentChannel: isBasePriceFreeProduct.value ? undefined : (intent.paymentChannel || undefined)')
    expect(payModalSource).toContain("isFreeProduct: isBasePriceFreeProduct.value")
    // 免费路径复用既有发码函数，而不是另起一套
    expect(payModalSource).toContain('async function sendEmailCode()')
    expect(payModalSource).toContain('requestEmailAccessCode(email.value.trim()')
  })

  it('does not load payment capabilities for base-free products', () => {
    expect(payModalSource).toContain('if (isBasePriceFreeProduct.value) {')
    expect(payModalSource).toContain('// 免费商品不依赖系统支付开关，也不应产生 /api/pay/methods 请求。')
  })

  it('keeps free-claim auth outside the balance-payment section so it is visible without selecting balance', () => {
    const freeAuthIdx = payModalSource.indexOf('class="field-block free-claim-auth"')
    const balanceSectionIdx = payModalSource.indexOf('v-if="balancePayAvailable"')
    expect(freeAuthIdx).toBeGreaterThan(0)
    expect(balanceSectionIdx).toBeGreaterThan(0)
    expect(freeAuthIdx).toBeLessThan(balanceSectionIdx)
  })

  it('shows a semantic free price instead of a zero currency amount', () => {
    // 免费文案由 buildListPriceDisplay / 共享规则产出；收银台与卡片均走该 helper
    expect(payModalSource).toContain('buildListPriceDisplay')
    expect(productCardSource).toContain('buildListPriceDisplay')
    expect(payModalSource).toContain('listPriceDisplay')
  })
})
