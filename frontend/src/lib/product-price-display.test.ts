import { describe, expect, it } from 'vitest'
import { buildListPriceDisplay } from './product-price-display'

describe('buildListPriceDisplay', () => {
  it('shows only selling price when no compare-at price', () => {
    const d = buildListPriceDisplay(200, 'CNY', null)
    expect(d.hasDiscount).toBe(false)
    expect(d.priceLabel).toContain('2')
    expect(d.originalLabel).toBe('')
    expect(d.badgeLabel).toBe('')
    expect(d.saveLabel).toBe('')
  })

  it('highlights compare-at promo for 5 → 2 yuan style pricing', () => {
    // 5 元 = 500 分，2 元 = 200 分
    const d = buildListPriceDisplay(200, 'CNY', 500)
    expect(d.hasDiscount).toBe(true)
    expect(d.priceLabel).toContain('2')
    expect(d.originalLabel).toContain('5')
    expect(d.badgeLabel).toBe('省60%')
    expect(d.saveLabel).toMatch(/省/)
    expect(d.saveLabel).toContain('3')
  })

  it('uses 限免 badge for free product with compare-at price', () => {
    const d = buildListPriceDisplay(0, 'CNY', 500)
    expect(d.hasDiscount).toBe(true)
    expect(d.priceLabel).toBe('免费')
    expect(d.badgeLabel).toBe('限免')
  })

  it('ignores original equal or below selling price', () => {
    expect(buildListPriceDisplay(500, 'CNY', 500).hasDiscount).toBe(false)
    expect(buildListPriceDisplay(500, 'CNY', 100).hasDiscount).toBe(false)
  })
})
