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

  it('does not load payment capabilities or submit payment fields for base-free products', () => {
    expect(payModalSource).toContain('if (isBasePriceFreeProduct.value) {')
    expect(payModalSource).toContain('balancePayment: isBasePriceFreeProduct.value ? undefined : useBalance')
    expect(payModalSource).toContain('paymentChannel: intent.paymentChannel || undefined')
    expect(payModalSource).toContain("isFreeProduct: isBasePriceFreeProduct.value")
  })

  it('shows a semantic free price instead of a zero currency amount', () => {
    // 免费文案由 buildListPriceDisplay / 共享规则产出；收银台与卡片均走该 helper
    expect(payModalSource).toContain('buildListPriceDisplay')
    expect(productCardSource).toContain('buildListPriceDisplay')
    expect(payModalSource).toContain('listPriceDisplay')
  })
})
