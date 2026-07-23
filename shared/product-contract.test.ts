import { describe, expect, it } from 'vitest'
import {
  DELIVERY_VISIBILITY_OPTIONS,
  FULFILLMENT_MODE_OPTIONS,
  STOCK_DISPLAY_MODE_OPTIONS,
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
