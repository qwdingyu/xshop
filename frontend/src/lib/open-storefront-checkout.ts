/**
 * 渠道内「商品确认 → 收银台」纯决策层。
 * - 确认层：渠道就绪即可展示（售罄仍可看、可复制链接，主按钮禁用）
 * - 收银台：确认层点购买时再校验可售，输出 PayProduct
 * I/O（fetch / toast / open）留在视图层；深链与卡片共用，避免双次详情。
 */
import {
  buildStorefrontProductBuyUrl,
  productLinkKey,
} from '@/lib/storefront-product-link'
import { productIsSoldOut } from '@/lib/storefront-stock'
import type { PayProduct, Product, Storefront } from '@/types'

export type OpenCheckoutFailureReason =
  | 'missing_storefront'
  | 'channel_mismatch'
  | 'sold_out'

export type OpenCheckoutResult =
  | { ok: true; payProduct: PayProduct }
  | { ok: false; reason: OpenCheckoutFailureReason }

/** homePath 仅确认层/复制链接需要；收银台构建只依赖 id+slug */
export type ActiveStorefrontRef = Pick<Storefront, 'id' | 'slug'> & { homePath?: string }

export type ShowConfirmFailureReason = 'missing_storefront' | 'channel_mismatch'

export type ShowConfirmResult =
  | { ok: true; product: Product; storefrontId: string; homePath: string }
  | { ok: false; reason: ShowConfirmFailureReason }

/**
 * 详情已拉取：是否可进入轻量确认层（不校验售罄——售罄仍可看与复制链接）。
 */
export function buildProductConfirmFromFetchedProduct(
  storefront: ActiveStorefrontRef | null | undefined,
  product: Product,
  options?: { expectedStorefrontId?: string },
): ShowConfirmResult {
  if (!storefront?.id || !storefront.slug) {
    return { ok: false, reason: 'missing_storefront' }
  }
  if (options?.expectedStorefrontId && storefront.id !== options.expectedStorefrontId) {
    return { ok: false, reason: 'channel_mismatch' }
  }
  const rawHome = String(storefront.homePath || '').trim()
  const homePath = rawHome
    ? (rawHome.startsWith('/') ? rawHome : `/${rawHome}`)
    : (storefront.slug === 'shop' ? '/shop' : `/s/${storefront.slug}`)
  return {
    ok: true,
    product,
    storefrontId: storefront.id,
    homePath,
  }
}

/**
 * 用已就绪的渠道上下文 + 已拉取的商品详情构建支付弹窗入参。
 * 调用方必须保证 product 来自该渠道的详情接口（含映射校验）。
 * 售罄在此拒绝，确认层主按钮应禁用。
 */
export function buildOpenCheckoutFromFetchedProduct(
  storefront: ActiveStorefrontRef | null | undefined,
  product: Product,
  options?: {
    /** 打开时仍要求与某次意图的 storefrontId 一致（防竞态） */
    expectedStorefrontId?: string
  },
): OpenCheckoutResult {
  if (!storefront?.id || !storefront.slug) {
    return { ok: false, reason: 'missing_storefront' }
  }
  if (options?.expectedStorefrontId && storefront.id !== options.expectedStorefrontId) {
    return { ok: false, reason: 'channel_mismatch' }
  }
  if (productIsSoldOut(product)) {
    return { ok: false, reason: 'sold_out' }
  }

  const payProduct: PayProduct = {
    storefrontId: storefront.id,
    storefrontSlug: storefront.slug,
    id: product.id,
    title: product.name || product.title,
    priceCents: product.priceCents,
    currency: product.currency,
    coverUrl: product.coverUrl,
    name: product.name,
    originalPriceCents: product.originalPriceCents,
    stock: product.stock,
    availableStock: product.availableStock,
    requiresInventory: product.requiresInventory,
    canPurchase: product.canPurchase,
    isOutOfStock: product.isOutOfStock,
    isLowStock: product.isLowStock,
    description: product.description,
    // 店面公开响应会剥离 salesCopy（交付私密）；不从确认层回填
    tagsJson: product.tagsJson,
    issueMode: product.issueMode,
    category: product.category,
    purchaseLimit: product.purchaseLimit,
    sortOrder: product.sortOrder,
    active: product.active,
    fulfillmentMode: product.fulfillmentMode,
    deliveryVisibility: product.deliveryVisibility,
    stockDisplayMode: product.stockDisplayMode,
    fulfillmentInputType: product.fulfillmentInputType,
    fulfillmentInputLabel: product.fulfillmentInputLabel,
    fulfillmentInputHint: product.fulfillmentInputHint,
    fulfillmentInputRequired: product.fulfillmentInputRequired,
  }

  return { ok: true, payProduct }
}

/** 用户可见的打开失败文案（视图层 toast 统一消费） */
export function openCheckoutFailureMessage(reason: OpenCheckoutFailureReason | ShowConfirmFailureReason): string {
  switch (reason) {
    case 'sold_out':
      return '该商品已售罄'
    case 'channel_mismatch':
      return '渠道已切换，请重试'
    case 'missing_storefront':
    default:
      return '当前渠道未就绪，请刷新后重试'
  }
}

/**
 * 用户侧复制购买链（与 Admin 同一 URL 契约：origin + homePath + ?product=）。
 * 禁止拼全局 /product/ 路径。
 */
export function buildUserStorefrontBuyUrl(input: {
  origin: string
  homePath: string
  product: { id: string; slug?: string | null }
}): string {
  const key = productLinkKey(input.product)
  if (!key) {
    throw new Error('product key is required')
  }
  return buildStorefrontProductBuyUrl(input.origin, input.homePath, key)
}
