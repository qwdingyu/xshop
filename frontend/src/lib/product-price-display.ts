/**
 * 店面货架价展示：现价 + 可选对比价。
 * 规则与 @shared/product-contract 对齐；金额格式依赖 useFormat.formatPrice。
 */

import {
  hasListDiscount,
  listDiscountBadgeKind,
  listDiscountPercentOff,
  listDiscountSaveCents,
} from '@shared/product-contract'
import { formatPrice } from '@/composables/useFormat'

export type ListPriceDisplay = {
  hasDiscount: boolean
  /** 现价文案（免费商品为「免费」） */
  priceLabel: string
  /** 划线原价；无促销为空串 */
  originalLabel: string
  /** 角标：省 x% / 限免 / 空 */
  badgeLabel: string
  /** 确认层/收银台强化：「省 ¥x」 */
  saveLabel: string
}

export function buildListPriceDisplay(
  priceCents: number,
  currency: string,
  originalPriceCents?: number | null,
): ListPriceDisplay {
  const discounted = hasListDiscount(priceCents, originalPriceCents)
  const priceLabel = priceCents === 0 ? '免费' : formatPrice(priceCents, currency)
  if (!discounted) {
    return {
      hasDiscount: false,
      priceLabel,
      originalLabel: '',
      badgeLabel: '',
      saveLabel: '',
    }
  }

  const original = Math.trunc(originalPriceCents as number)
  const originalLabel = formatPrice(original, currency)
  const kind = listDiscountBadgeKind(priceCents, original)
  const pct = listDiscountPercentOff(priceCents, original)
  const save = listDiscountSaveCents(priceCents, original)

  let badgeLabel = ''
  if (kind === 'free_promo') {
    badgeLabel = '限免'
  } else if (kind === 'percent_off' && pct != null) {
    badgeLabel = `省${pct}%`
  }

  const saveLabel = save != null && save > 0 ? `省 ${formatPrice(save, currency)}` : ''

  return {
    hasDiscount: true,
    priceLabel,
    originalLabel,
    badgeLabel,
    saveLabel,
  }
}
