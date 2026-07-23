/**
 * 渠道内打开收银台的纯决策层：输入「已校验渠道 + 已拉取的商品详情」，
 * 输出 PayProduct 或明确拒绝原因。I/O（fetch / toast / open）留在视图层。
 *
 * 深链与卡片点击必须共用此路径，避免双实现漂移与双次详情请求。
 */
import { productIsSoldOut } from '@/lib/storefront-stock'
import type { PayProduct, Product, Storefront } from '@/types'

export type OpenCheckoutFailureReason =
  | 'missing_storefront'
  | 'channel_mismatch'
  | 'sold_out'

export type OpenCheckoutResult =
  | { ok: true; payProduct: PayProduct }
  | { ok: false; reason: OpenCheckoutFailureReason }

export type ActiveStorefrontRef = Pick<Storefront, 'id' | 'slug'>

/**
 * 用已就绪的渠道上下文 + 已拉取的商品详情构建支付弹窗入参。
 * 调用方必须保证 product 来自该渠道的详情接口（含映射校验）。
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
    salesCopy: product.salesCopy,
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
export function openCheckoutFailureMessage(reason: OpenCheckoutFailureReason): string {
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
