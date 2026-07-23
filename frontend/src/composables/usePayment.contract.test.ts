import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { matchesPendingCheckoutAttempt, shouldClearCheckoutAttemptForError, usePayment } from './usePayment'

const paymentSource = readFileSync(new URL('./usePayment.ts', import.meta.url), 'utf8')
const entrySource = readFileSync(new URL('../main.ts', import.meta.url), 'utf8')
const PENDING_ATTEMPTS_KEY = 'pending_checkout_attempts'

function installSessionStorage() {
  const store = new Map<string, string>()
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
    },
    configurable: true,
  })
}

describe('checkout recovery storage contract', () => {
  beforeEach(() => {
    installSessionStorage()
  })

  afterEach(() => {
    sessionStorage.clear()
  })

  it('keeps pending checkout recovery inside the current tab session', () => {
    expect(paymentSource).toContain("sessionStorage.getItem(PENDING_ATTEMPTS_KEY)")
    expect(paymentSource).toContain("sessionStorage.setItem(PENDING_ATTEMPTS_KEY")
    expect(paymentSource).not.toContain("localStorage.getItem(PENDING_ATTEMPTS_KEY)")
    expect(paymentSource).not.toContain("localStorage.setItem(PENDING_ATTEMPTS_KEY")
  })

  it('removes credentials persisted by older storefront builds', () => {
    expect(entrySource).toContain("localStorage.removeItem('recent_orders')")
    expect(entrySource).toContain("localStorage.removeItem('pending_checkout_attempts')")
  })

  it('treats legacy online attempts without paymentChannel as the default Alipay channel', () => {
    const payment = usePayment()
    sessionStorage.setItem(PENDING_ATTEMPTS_KEY, JSON.stringify([{
      idempotencyKey: 'legacy-alipay-attempt-000000000001',
      storefrontId: 'sf-default',
      productId: 'useai',
      buyerEmail: 'Buyer@Example.com',
      quantity: 1,
      couponCode: '',
      balancePayment: false,
      createdAt: new Date().toISOString(),
    }]))

    payment.open({ storefrontId: 'sf-default', storefrontSlug: 'shop', id: 'useai', title: 'UseAI兑换码', priceCents: 110, currency: 'CNY', coverUrl: '' })

    expect(payment.saveCheckoutAttempt({
      idempotencyKey: payment.idempotencyKey.value,
      storefrontId: 'sf-default',
      productId: 'useai',
      buyerEmail: 'buyer@example.com',
      quantity: 1,
      couponCode: '',
      balancePayment: false,
      paymentChannel: 'alipay',
    })).toBe(true)
  })

  it('can discard an incompatible local recovery attempt and continue with a fresh idempotency key', () => {
    const payment = usePayment()
    sessionStorage.setItem(PENDING_ATTEMPTS_KEY, JSON.stringify([{
      idempotencyKey: 'stale-quantity-attempt-000000000001',
      storefrontId: 'sf-default',
      productId: 'useai',
      buyerEmail: 'buyer@example.com',
      quantity: 2,
      couponCode: '',
      balancePayment: false,
      paymentChannel: 'alipay',
      createdAt: new Date().toISOString(),
    }]))

    payment.open({ storefrontId: 'sf-default', storefrontSlug: 'shop', id: 'useai', title: 'UseAI兑换码', priceCents: 110, currency: 'CNY', coverUrl: '' })
    const staleKey = payment.idempotencyKey.value

    expect(payment.saveCheckoutAttempt({
      idempotencyKey: staleKey,
      storefrontId: 'sf-default',
      productId: 'useai',
      buyerEmail: 'buyer@example.com',
      quantity: 1,
      couponCode: '',
      balancePayment: false,
      paymentChannel: 'alipay',
    })).toBe(false)

    const freshKey = payment.restartCheckoutAttempt()

    expect(freshKey).not.toBe(staleKey)
    expect(payment.saveCheckoutAttempt({
      idempotencyKey: freshKey,
      storefrontId: 'sf-default',
      productId: 'useai',
      buyerEmail: 'buyer@example.com',
      quantity: 1,
      couponCode: '',
      balancePayment: false,
      paymentChannel: 'alipay',
    })).toBe(true)
  })

  it('restores only a canonical free-product attempt without payment or coupon parameters', () => {
    const payment = usePayment()
    const freeKey = 'free-product-attempt-00000000000001'
    sessionStorage.setItem(PENDING_ATTEMPTS_KEY, JSON.stringify([{
      idempotencyKey: freeKey,
      storefrontId: 'sf-default',
      productId: 'free-guide',
      buyerEmail: 'buyer@example.com',
      quantity: 1,
      couponCode: '',
      balancePayment: false,
      paymentChannel: '',
      createdAt: new Date().toISOString(),
    }]))

    payment.open({
      storefrontId: 'sf-default',
      storefrontSlug: 'shop',
      id: 'free-guide',
      title: '免费资料',
      priceCents: 0,
      currency: 'CNY',
    })

    expect(payment.pendingAttempt.value?.idempotencyKey).toBe(freeKey)
    expect(payment.quantity.value).toBe(1)
    expect(payment.couponCode.value).toBe('')
  })

  it('discards stale paid parameters when the product has become free', () => {
    const payment = usePayment()
    const staleKey = 'paid-to-free-attempt-000000000001'
    sessionStorage.setItem(PENDING_ATTEMPTS_KEY, JSON.stringify([{
      idempotencyKey: staleKey,
      storefrontId: 'sf-default',
      productId: 'campaign-code',
      buyerEmail: 'buyer@example.com',
      quantity: 2,
      couponCode: 'SALE10',
      balancePayment: false,
      paymentChannel: 'alipay',
      createdAt: new Date().toISOString(),
    }]))

    payment.open({
      storefrontId: 'sf-default',
      storefrontSlug: 'shop',
      id: 'campaign-code',
      title: '活动兑换码',
      priceCents: 0,
      currency: 'CNY',
    })

    expect(payment.pendingAttempt.value).toBeNull()
    expect(payment.idempotencyKey.value).not.toBe(staleKey)
    expect(payment.quantity.value).toBe(1)
    expect(payment.couponCode.value).toBe('')
    expect(JSON.parse(sessionStorage.getItem(PENDING_ATTEMPTS_KEY) || '[]')).toEqual([])
  })

  it('recognizes the exact legacy request so changed product limits do not rewrite an idempotent replay', () => {
    const existing = {
      idempotencyKey: 'recover-exact-request-000000000001',
      storefrontId: 'sf-default',
      productId: 'useai',
      buyerEmail: 'Buyer@Example.com',
      quantity: 2,
      couponCode: '',
      balancePayment: false,
      paymentChannel: 'alipay',
      createdAt: new Date().toISOString(),
    } as const

    expect(matchesPendingCheckoutAttempt(existing, {
      idempotencyKey: existing.idempotencyKey,
      storefrontId: 'sf-default',
      productId: 'useai',
      buyerEmail: 'buyer@example.com',
      quantity: 2,
      couponCode: '',
      balancePayment: false,
      paymentChannel: 'alipay',
    })).toBe(true)
    expect(matchesPendingCheckoutAttempt(existing, {
      idempotencyKey: existing.idempotencyKey,
      storefrontId: 'sf-default',
      productId: 'useai',
      buyerEmail: 'buyer@example.com',
      quantity: 1,
      couponCode: '',
      balancePayment: false,
      paymentChannel: 'alipay',
    })).toBe(false)
  })

  it('binds checkout recovery to the exact fulfillment input', () => {
    const existing = {
      idempotencyKey: 'fulfillment-bound-attempt-00000001',
      storefrontId: 'sf-default',
      productId: 'account-service',
      buyerEmail: 'buyer@example.com',
      quantity: 1,
      couponCode: '',
      fulfillmentInput: 'user_123',
      balancePayment: false,
      paymentChannel: 'alipay',
      createdAt: new Date().toISOString(),
    } as const

    expect(matchesPendingCheckoutAttempt(existing, {
      idempotencyKey: existing.idempotencyKey,
      storefrontId: existing.storefrontId,
      productId: existing.productId,
      buyerEmail: existing.buyerEmail,
      quantity: 1,
      couponCode: '',
      fulfillmentInput: 'user_123',
      balancePayment: false,
      paymentChannel: 'alipay',
    })).toBe(true)
    expect(matchesPendingCheckoutAttempt(existing, {
      idempotencyKey: existing.idempotencyKey,
      storefrontId: existing.storefrontId,
      productId: existing.productId,
      buyerEmail: existing.buyerEmail,
      quantity: 1,
      couponCode: '',
      fulfillmentInput: 'user_456',
      balancePayment: false,
      paymentChannel: 'alipay',
    })).toBe(false)
  })

  it('does not restore or match the same product from another storefront', () => {
    const payment = usePayment()
    const existing = {
      idempotencyKey: 'storefront-bound-attempt-000000000001',
      storefrontId: 'sf-software',
      productId: 'shared-product',
      buyerEmail: 'buyer@example.com',
      quantity: 1,
      couponCode: '',
      balancePayment: false,
      paymentChannel: 'alipay',
      createdAt: new Date().toISOString(),
    } as const
    sessionStorage.setItem(PENDING_ATTEMPTS_KEY, JSON.stringify([existing]))

    payment.open({
      storefrontId: 'sf-accounts',
      storefrontSlug: 'accounts',
      id: 'shared-product',
      title: 'Shared product',
      priceCents: 100,
      currency: 'CNY',
    })

    expect(payment.pendingAttempt.value).toBeNull()
    expect(matchesPendingCheckoutAttempt(existing, {
      idempotencyKey: existing.idempotencyKey,
      storefrontId: 'sf-accounts',
      productId: existing.productId,
      buyerEmail: existing.buyerEmail,
      quantity: existing.quantity,
      couponCode: existing.couponCode,
      balancePayment: existing.balancePayment,
      paymentChannel: existing.paymentChannel,
    })).toBe(false)
  })

  it('keeps the local recovery record while the same idempotency key is still in flight', () => {
    expect(shouldClearCheckoutAttemptForError('IDEMPOTENCY_PENDING')).toBe(false)
    expect(shouldClearCheckoutAttemptForError('IDEMPOTENCY_REQUEST_MISMATCH')).toBe(true)
    expect(shouldClearCheckoutAttemptForError('PAYMENT_CREATION_FAILED')).toBe(true)
  })
})
