/**
 * Admin「复制用户购买链接」闸门（纯函数）。
 * 禁止：下架商品、不可见映射、停用渠道、多渠道未指定、静默改道默认店。
 */
import {
  buildStorefrontProductBuyUrl,
  productLinkKey,
  type ProductLinkIdentity,
} from '@/lib/storefront-product-link'

export type AdminBuyLinkStorefront = {
  id: string
  name: string
  homePath: string
  active: boolean
}

export type AdminBuyLinkProductMapping = {
  id: string
  name?: string
  visible?: boolean
  active?: boolean
}

export type ResolveAdminBuyLinkInput = {
  product: ProductLinkIdentity & {
    active?: boolean
    storefronts?: AdminBuyLinkProductMapping[]
    storefrontIds?: string[]
  }
  /** 当前列表筛选的渠道；空表示未筛选 */
  filterStorefrontId?: string
  storefronts: AdminBuyLinkStorefront[]
  origin: string
}

export type AdminBuyLinkFailureReason =
  | 'product_inactive'
  | 'no_visible_mapping'
  | 'filter_not_visible'
  | 'multi_channel_ambiguous'
  | 'storefront_missing'
  | 'storefront_inactive'
  | 'empty_product_key'

export type ResolveAdminBuyLinkResult =
  | { ok: true; url: string; storefront: AdminBuyLinkStorefront; productKey: string }
  | { ok: false; reason: AdminBuyLinkFailureReason }

function visibleMappings(product: ResolveAdminBuyLinkInput['product']): AdminBuyLinkProductMapping[] {
  if (product.storefronts?.length) {
    return product.storefronts.filter(entry => entry.visible !== false)
  }
  return (product.storefrontIds || []).map(id => ({ id, visible: true }))
}

/**
 * 解析并生成用户侧购买 URL；任何不确定情况 fail closed。
 */
export function resolveAdminBuyLink(input: ResolveAdminBuyLinkInput): ResolveAdminBuyLinkResult {
  if (input.product.active === false) {
    return { ok: false, reason: 'product_inactive' }
  }

  const visible = visibleMappings(input.product)
  if (visible.length === 0) {
    return { ok: false, reason: 'no_visible_mapping' }
  }

  const filterId = String(input.filterStorefrontId || '').trim()
  let targetId: string | null = null

  if (filterId) {
    if (!visible.some(entry => entry.id === filterId)) {
      return { ok: false, reason: 'filter_not_visible' }
    }
    targetId = filterId
  } else if (visible.length === 1) {
    targetId = visible[0].id
  } else {
    return { ok: false, reason: 'multi_channel_ambiguous' }
  }

  const storefront = input.storefronts.find(entry => entry.id === targetId)
  if (!storefront) {
    return { ok: false, reason: 'storefront_missing' }
  }
  if (!storefront.active) {
    return { ok: false, reason: 'storefront_inactive' }
  }

  const productKey = productLinkKey(input.product)
  if (!productKey) {
    return { ok: false, reason: 'empty_product_key' }
  }

  const url = buildStorefrontProductBuyUrl(input.origin, storefront.homePath, productKey)
  return { ok: true, url, storefront, productKey }
}

export function adminBuyLinkFailureMessage(reason: AdminBuyLinkFailureReason): string {
  switch (reason) {
    case 'product_inactive':
      return '商品已下架，无法生成用户购买链接'
    case 'no_visible_mapping':
      return '该商品未挂到任何可见渠道，请先在「展示渠道」中配置'
    case 'filter_not_visible':
      return '当前筛选渠道下该商品不可见，请更换渠道或调整映射后再复制'
    case 'multi_channel_ambiguous':
      return '该商品挂在多个渠道，请先在上方筛选目标渠道再复制购买链接'
    case 'storefront_missing':
      return '目标渠道不存在，请刷新后重试'
    case 'storefront_inactive':
      return '该渠道已停用，无法生成用户购买链接'
    case 'empty_product_key':
      return '商品标识无效，无法生成购买链接'
    default:
      return '无法生成购买链接'
  }
}

/**
 * 渠道商品映射面板：是否允许复制购买链接。
 * 只认已落库的「已选 + 可见」；草稿改动未保存时禁止，避免复制出 404 死链。
 */
export type MappingBuyLinkGateFailure =
  | 'not_persisted'
  | 'draft_dirty'
  | 'not_visible'
  | 'product_inactive'
  | 'storefront_inactive'

export type MappingBuyLinkPersisted = {
  selected: boolean
  visible: boolean
}

export function canCopyPersistedStorefrontBuyLink(input: {
  channelActive: boolean
  productActive: boolean
  /** 面板当前草稿 */
  draft: { selected: boolean; visible: boolean }
  /** 打开面板/上次加载时的服务端快照；null = 服务端无此映射 */
  persisted: MappingBuyLinkPersisted | null
}): { ok: true } | { ok: false; reason: MappingBuyLinkGateFailure } {
  if (!input.channelActive) return { ok: false, reason: 'storefront_inactive' }
  if (!input.productActive) return { ok: false, reason: 'product_inactive' }
  if (!input.persisted?.selected) return { ok: false, reason: 'not_persisted' }
  if (!input.persisted.visible) return { ok: false, reason: 'not_visible' }
  // 草稿相对落库的 selected/visible 有变更 → 必须先保存
  if (
    input.draft.selected !== input.persisted.selected
    || input.draft.visible !== input.persisted.visible
  ) {
    return { ok: false, reason: 'draft_dirty' }
  }
  if (!input.draft.selected || !input.draft.visible) {
    return { ok: false, reason: 'not_visible' }
  }
  return { ok: true }
}

export function mappingBuyLinkGateMessage(reason: MappingBuyLinkGateFailure): string {
  switch (reason) {
    case 'not_persisted':
      return '请先保存商品映射后再复制购买链接'
    case 'draft_dirty':
      return '映射尚未保存，请先点击「保存商品映射」再复制'
    case 'not_visible':
      return '仅可为已落库且可见的商品复制购买链接'
    case 'product_inactive':
      return '商品已下架，无法生成用户购买链接'
    case 'storefront_inactive':
      return '该渠道已停用，无法生成用户购买链接'
    default:
      return '无法生成购买链接'
  }
}
