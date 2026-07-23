import { describe, expect, it } from 'vitest'
import {
  PRODUCT_DEEPLINK_QUERY,
  buildStorefrontProductBuyPath,
  buildStorefrontProductBuyUrl,
  classifyDeeplinkFetchFailure,
  parseProductDeeplinkQuery,
  productDeeplinkConsumeKey,
  productLinkKey,
  shouldScrubProductDeeplinkAfterAttempt,
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

  it('scrubs product only after a owned attempt reaches a sellable terminal outcome', () => {
    const base = {
      ownedAttempt: true,
      isLatestSequence: true,
      stillOnExpectedStorefront: true,
    }
    expect(shouldScrubProductDeeplinkAfterAttempt({ ...base, outcome: 'opened' })).toBe(true)
    expect(shouldScrubProductDeeplinkAfterAttempt({ ...base, outcome: 'unsellable' })).toBe(true)
    expect(shouldScrubProductDeeplinkAfterAttempt({ ...base, outcome: 'open_refused' })).toBe(true)

    // 忙锁：推广链必须保留，允许用户稍后再试
    expect(shouldScrubProductDeeplinkAfterAttempt({
      ownedAttempt: false,
      isLatestSequence: true,
      stillOnExpectedStorefront: true,
      outcome: 'busy_conflict',
    })).toBe(false)

    // 瞬时 503/网络：不清，用户刷新或再次进入可重试
    expect(shouldScrubProductDeeplinkAfterAttempt({
      ...base,
      outcome: 'transient',
    })).toBe(false)

    // 过期序号 / 离开渠道：不清，避免误吞仍有效的 query
    expect(shouldScrubProductDeeplinkAfterAttempt({
      ownedAttempt: true,
      isLatestSequence: false,
      stillOnExpectedStorefront: true,
      outcome: 'opened',
    })).toBe(false)
    expect(shouldScrubProductDeeplinkAfterAttempt({
      ownedAttempt: true,
      isLatestSequence: true,
      stillOnExpectedStorefront: false,
      outcome: 'unsellable',
    })).toBe(false)
    expect(shouldScrubProductDeeplinkAfterAttempt({
      ownedAttempt: true,
      isLatestSequence: true,
      stillOnExpectedStorefront: true,
      outcome: 'stale_or_left',
    })).toBe(false)
  })

  it('classifies detail fetch failures: 404/PRODUCT_NOT_IN_STOREFRONT scrub, 503/network keep', () => {
    expect(classifyDeeplinkFetchFailure({
      status: 404,
      code: 'PRODUCT_NOT_IN_STOREFRONT',
      message: '商品不属于当前展示渠道或已下架',
    })).toBe('unsellable')

    expect(classifyDeeplinkFetchFailure({
      status: 404,
      code: 'NOT_FOUND',
      message: '请求的资源不存在',
    })).toBe('unsellable')

    expect(classifyDeeplinkFetchFailure({
      status: 404,
      code: 'STOREFRONT_NOT_FOUND',
      message: '展示渠道不存在或已停用',
    })).toBe('unsellable')

    // 瞬时：503 / 429 / 5xx / 无 status 的网络错误 — 不得 scrub
    expect(classifyDeeplinkFetchFailure({
      status: 503,
      code: 'SERVICE_UNAVAILABLE',
      message: '服务暂时不可用，请稍后重试',
    })).toBe('transient')

    expect(classifyDeeplinkFetchFailure({
      status: 429,
      code: 'RATE_LIMITED',
      message: '请求过于频繁，请稍后再试',
    })).toBe('transient')

    expect(classifyDeeplinkFetchFailure({
      status: 500,
      code: 'UNKNOWN_ERROR',
      message: '服务器错误',
    })).toBe('transient')

    expect(classifyDeeplinkFetchFailure(new TypeError('Failed to fetch'))).toBe('transient')
    expect(classifyDeeplinkFetchFailure(new Error('Network offline'))).toBe('transient')
    expect(classifyDeeplinkFetchFailure(null)).toBe('transient')

    // 组合：classify → shouldScrub（模拟 ShopView catch 接线）
    const owned = {
      ownedAttempt: true,
      isLatestSequence: true,
      stillOnExpectedStorefront: true,
    }
    expect(shouldScrubProductDeeplinkAfterAttempt({
      ...owned,
      outcome: classifyDeeplinkFetchFailure({ status: 404, code: 'PRODUCT_NOT_IN_STOREFRONT' }),
    })).toBe(true)
    expect(shouldScrubProductDeeplinkAfterAttempt({
      ...owned,
      outcome: classifyDeeplinkFetchFailure({ status: 503, code: 'SERVICE_UNAVAILABLE' }),
    })).toBe(false)
  })
})
