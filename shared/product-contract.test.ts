import { describe, expect, it } from 'vitest'
import {
  DELIVERY_VISIBILITY_OPTIONS,
  FULFILLMENT_MODE_OPTIONS,
  STOCK_DISPLAY_MODE_OPTIONS,
  hasListDiscount,
  listDiscountBadgeKind,
  listDiscountPercentOff,
  listDiscountSaveCents,
  normalizeOriginalPriceCents,
  validateOriginalPriceCents,
} from './product-contract'

describe('product contract', () => {
  it('derives admin options from the canonical product-domain values', () => {
    expect(FULFILLMENT_MODE_OPTIONS).toEqual([
      { value: 'card', label: '卡密' },
      { value: 'virtual', label: '虚拟资料' },
      { value: 'link', label: '链接' },
      { value: 'code', label: '兑换码' },
      { value: 'invite', label: '邀请码' },
    ])
    expect(DELIVERY_VISIBILITY_OPTIONS).toEqual([
      { value: 'web_and_email', label: 'Web + 邮件展示' },
      { value: 'email_only', label: '仅邮件展示（活动注册码）' },
    ])
    expect(STOCK_DISPLAY_MODE_OPTIONS).toEqual([
      { value: 'exact', label: '精确库存' },
      { value: 'availability_only', label: '仅库存状态' },
      { value: 'hidden', label: '隐藏库存' },
    ])
  })
})

describe('list discount (compare-at price)', () => {
  it('treats only original strictly above selling price as a list discount', () => {
    expect(hasListDiscount(200, 500)).toBe(true)
    expect(hasListDiscount(0, 500)).toBe(true)
    expect(hasListDiscount(500, 500)).toBe(false)
    expect(hasListDiscount(600, 500)).toBe(false)
    expect(hasListDiscount(200, null)).toBe(false)
    expect(hasListDiscount(200, 0)).toBe(false)
    expect(hasListDiscount(200, undefined)).toBe(false)
  })

  it('normalizes empty and non-positive original prices to null', () => {
    expect(normalizeOriginalPriceCents(null)).toBeNull()
    expect(normalizeOriginalPriceCents('')).toBeNull()
    expect(normalizeOriginalPriceCents(0)).toBeNull()
    expect(normalizeOriginalPriceCents(-1)).toBeNull()
    expect(normalizeOriginalPriceCents(500.9)).toBe(500)
  })

  it('rejects original price that is not higher than selling price', () => {
    expect(validateOriginalPriceCents(200, 500)).toBeNull()
    expect(validateOriginalPriceCents(200, null)).toBeNull()
    expect(validateOriginalPriceCents(200, 200)).toBe('划线原价必须高于现价')
    expect(validateOriginalPriceCents(200, 100)).toBe('划线原价必须高于现价')
  })

  it('computes save cents and percent-off for promo badges', () => {
    expect(listDiscountSaveCents(200, 500)).toBe(300)
    expect(listDiscountPercentOff(200, 500)).toBe(60)
    expect(listDiscountBadgeKind(200, 500)).toBe('percent_off')
    expect(listDiscountBadgeKind(0, 500)).toBe('free_promo')
    expect(listDiscountBadgeKind(200, null)).toBe('none')
  })
})
