import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const payModalSource = readFileSync(new URL('./PayModal.vue', import.meta.url), 'utf8')
const productCardSource = readFileSync(new URL('./ProductCard.vue', import.meta.url), 'utf8')

describe('free product checkout UI contract', () => {
  it('hides coupon, quantity, online payment, and balance payment for base-free products', () => {
    expect(payModalSource.match(/v-if="!isBasePriceFreeProduct"/g)).toHaveLength(2)
    expect(payModalSource).toContain('v-if="!isBasePriceFreeProduct && couponMsg"')
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
    expect(payModalSource).toContain("? '免费'")
    expect(productCardSource).toContain("? '免费'")
  })
})
