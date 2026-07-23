import { describe, expect, it } from 'vitest'
import {
  buildOpenCheckoutFromFetchedProduct,
  openCheckoutFailureMessage,
} from './open-storefront-checkout'
import type { Product } from '@/types'

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: 'prod-1',
    slug: 'useai',
    title: 'UseAI 兑换码',
    priceCents: 1100,
    currency: 'CNY',
    canPurchase: true,
    isOutOfStock: false,
    ...overrides,
  }
}

const storefront = { id: 'sf_default', slug: 'shop' }

describe('buildOpenCheckoutFromFetchedProduct', () => {
  it('builds a PayProduct bound to the active storefront without network I/O', () => {
    const result = buildOpenCheckoutFromFetchedProduct(storefront, product())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.payProduct.storefrontId).toBe('sf_default')
    expect(result.payProduct.storefrontSlug).toBe('shop')
    expect(result.payProduct.id).toBe('prod-1')
    expect(result.payProduct.title).toBe('UseAI 兑换码')
    expect(result.payProduct.priceCents).toBe(1100)
  })

  it('refuses sold-out products so PayModal is never opened for that intent', () => {
    const result = buildOpenCheckoutFromFetchedProduct(
      storefront,
      product({ canPurchase: false, isOutOfStock: true }),
    )
    expect(result).toEqual({ ok: false, reason: 'sold_out' })
    expect(openCheckoutFailureMessage('sold_out')).toContain('售罄')
  })

  it('refuses when the storefront context is missing', () => {
    expect(buildOpenCheckoutFromFetchedProduct(null, product())).toEqual({
      ok: false,
      reason: 'missing_storefront',
    })
  })

  it('refuses channel mismatch so a stale deeplink cannot open under another storefront', () => {
    const result = buildOpenCheckoutFromFetchedProduct(storefront, product(), {
      expectedStorefrontId: 'sf_other',
    })
    expect(result).toEqual({ ok: false, reason: 'channel_mismatch' })
  })
})
