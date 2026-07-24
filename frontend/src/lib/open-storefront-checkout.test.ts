import { describe, expect, it } from 'vitest'
import {
  buildOpenCheckoutFromFetchedProduct,
  buildProductConfirmFromFetchedProduct,
  buildUserStorefrontBuyUrl,
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

const storefront = { id: 'sf_default', slug: 'shop', homePath: '/shop' }
const software = { id: 'sf_software', slug: 'software', homePath: '/s/software' }

describe('buildProductConfirmFromFetchedProduct', () => {
  it('opens confirm for sellable products bound to the active storefront', () => {
    const result = buildProductConfirmFromFetchedProduct(storefront, product())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.storefrontId).toBe('sf_default')
    expect(result.homePath).toBe('/shop')
    expect(result.product.id).toBe('prod-1')
  })

  it('still opens confirm for sold-out products so users can view and copy the link', () => {
    const result = buildProductConfirmFromFetchedProduct(
      storefront,
      product({ canPurchase: false, isOutOfStock: true }),
    )
    expect(result.ok).toBe(true)
  })

  it('refuses missing storefront or channel mismatch', () => {
    expect(buildProductConfirmFromFetchedProduct(null, product())).toEqual({
      ok: false,
      reason: 'missing_storefront',
    })
    expect(buildProductConfirmFromFetchedProduct(storefront, product(), {
      expectedStorefrontId: 'sf_other',
    })).toEqual({ ok: false, reason: 'channel_mismatch' })
  })

  it('falls back to /s/:slug when homePath is empty', () => {
    const result = buildProductConfirmFromFetchedProduct(
      { id: 'sf_software', slug: 'software' },
      product(),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.homePath).toBe('/s/software')
  })
})

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

describe('buildUserStorefrontBuyUrl', () => {
  it('builds the frozen channel-scoped buy URL (same contract as Admin copy)', () => {
    expect(buildUserStorefrontBuyUrl({
      origin: 'https://shop.example',
      homePath: '/shop',
      product: { id: 'prod-1', slug: 'useai' },
    })).toBe('https://shop.example/shop?product=useai')

    expect(buildUserStorefrontBuyUrl({
      origin: 'https://shop.example',
      homePath: software.homePath,
      product: { id: 'prod-1', slug: 'useai' },
    })).toBe('https://shop.example/s/software?product=useai')
  })

  it('falls back to product id when slug is empty and never uses /product/', () => {
    const url = buildUserStorefrontBuyUrl({
      origin: 'https://shop.example',
      homePath: '/shop',
      product: { id: 'prod-raw', slug: '  ' },
    })
    expect(url).toBe('https://shop.example/shop?product=prod-raw')
    expect(url).not.toContain('/product/')
  })
})
