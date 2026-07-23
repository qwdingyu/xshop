import { describe, expect, it } from 'vitest'
import {
  PRODUCT_DEEPLINK_QUERY,
  buildStorefrontProductBuyPath,
  buildStorefrontProductBuyUrl,
  parseProductDeeplinkQuery,
  productDeeplinkConsumeKey,
  productLinkKey,
  stripProductDeeplinkQuery,
} from './storefront-product-link'

describe('storefront product buy link', () => {
  it('builds channel-scoped buy paths with product query only', () => {
    expect(buildStorefrontProductBuyPath('/shop', 'useai')).toBe('/shop?product=useai')
    expect(buildStorefrontProductBuyPath('/s/software', 'useai')).toBe('/s/software?product=useai')
    expect(buildStorefrontProductBuyPath('s/software', 'prod-1')).toBe('/s/software?product=prod-1')
  })

  it('rejects empty product keys and encodes full URLs from origin + homePath', () => {
    expect(() => buildStorefrontProductBuyPath('/shop', '  ')).toThrow(/productKey/)
    expect(buildStorefrontProductBuyUrl('https://shop.example', '/s/codes', 'vip-month'))
      .toBe('https://shop.example/s/codes?product=vip-month')
  })

  it('prefers slug over id for the public product key', () => {
    expect(productLinkKey({ id: 'prod-1', slug: 'useai' })).toBe('useai')
    expect(productLinkKey({ id: 'prod-1', slug: '  ' })).toBe('prod-1')
    expect(productLinkKey({ id: 'prod-1' })).toBe('prod-1')
  })

  it('parses and strips the product deeplink query without jumping channels', () => {
    expect(parseProductDeeplinkQuery({ product: 'useai' })).toBe('useai')
    expect(parseProductDeeplinkQuery({ product: ['useai', 'other'] })).toBe('useai')
    expect(parseProductDeeplinkQuery({ product: '  ' })).toBeNull()
    expect(parseProductDeeplinkQuery({ q: 'x' })).toBeNull()

    const stripped = stripProductDeeplinkQuery({
      [PRODUCT_DEEPLINK_QUERY]: 'useai',
      utm: 'ad',
    })
    expect(stripped).toEqual({ utm: 'ad' })
    expect(PRODUCT_DEEPLINK_QUERY in stripped).toBe(false)
  })

  it('scopes one-shot consumption to storefront + product key', () => {
    expect(productDeeplinkConsumeKey('sf_a', 'useai')).toBe('sf_a::useai')
    expect(productDeeplinkConsumeKey('sf_a', 'useai')).not.toBe(productDeeplinkConsumeKey('sf_b', 'useai'))
  })
})
