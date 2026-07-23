export type Platform = 'telegram-mobile' | 'telegram-desktop' | 'h5-mobile' | 'h5-desktop'
export type { DeliveryVisibility, StockDisplayMode } from '@shared/product-contract'
export type { FulfillmentInputType } from '@shared/fulfillment-input'
import type { DeliveryVisibility, StockDisplayMode } from '@shared/product-contract'
import type { FulfillmentInputType } from '@shared/fulfillment-input'
import type { OrderStatus } from '@shared/order-status'
export type { OrderStatus }
export type StorefrontTemplate = 'catalog' | 'compact'
// 订单状态规范拼写见 @shared/order-status（canceled 一 d；读路径兼容 cancelled）

// ─── Storefront ───

/**
 * 公开展示渠道。slug 只用于目录 URL，交易请求必须使用稳定的 id。
 * homePath 由后端根据当前默认渠道计算，是渠道内品牌和商品入口的唯一链接目标。
 */
export interface Storefront {
  id: string
  slug: string
  name: string
  logoUrl: string
  supportEmail: string
  templateKey: StorefrontTemplate
  isDefault: boolean
  homePath: string
}

// ─── Product ───

export interface Product {
  id: string
  /** 公开展示用键；购买深链优先使用 slug，兼容 id */
  slug?: string
  title: string
  name?: string
  priceCents: number
  originalPriceCents?: number
  currency: string
  coverUrl?: string
  stock?: number
  availableStock?: number
  requiresInventory?: boolean
  canPurchase?: boolean
  isOutOfStock?: boolean
  isLowStock?: boolean
  description?: string
  salesCopy?: string
  tagsJson?: string
  issueMode?: string
  category?: string
  sortOrder?: number
  active?: boolean
  fulfillmentMode?: string
  purchaseLimit?: number | null
  purchaseLimitDisplay?: boolean
  deliveryVisibility?: DeliveryVisibility
  stockDisplayMode?: StockDisplayMode
  fulfillmentInputType?: FulfillmentInputType
  fulfillmentInputLabel?: string
  fulfillmentInputHint?: string
  fulfillmentInputRequired?: boolean
}

export interface ProductCategory {
  id: string
  name: string
  count: number
}

// ─── Order ───

export interface Order {
  id: string
  orderNo: string
  productId: string
  productTitle?: string
  productName?: string
  priceCents: number
  amountCents: number
  quantity?: number
  paidCents?: number
  discountCents?: number
  currency: string
  status: OrderStatus
  fulfillmentMode?: string
  delivery?: Delivery
  cards?: Array<{ id?: string; accountLabel?: string; deliverySecret?: string; deliveryNote?: string; cardData: string }>
  items?: OrderItem[]
  createdAt: string
  expiresAt?: string
  buyerEmail?: string
  buyerContact?: string
  paymentRef?: string
  paidAt?: string
  issuedAt?: string
  orderToken?: string
  deliveryVisibility?: DeliveryVisibility
  deliveryMessage?: string
}

export interface OrderItem {
  id: string
  productId: string
  productTitle: string
  fulfillmentMode: string
  quantity: number
  unitPriceCents: number
  discountCents: number
  amountCents: number
  deliveryJson?: string
}

export interface Delivery {
  type?: 'card' | 'email' | 'direct'
  /** 卡号（前端展示用） */
  cardNo?: string
  /** 密码（前端展示用） */
  password?: string
  email?: string
  content?: string
  url?: string
  code?: string
  text?: string
  inviteCode?: string
  /** 后端 pay/status 返回的字段 */
  accountLabel?: string
  deliverySecret?: string
  deliveryNote?: string
  [key: string]: any
}

// ─── Payment ───

export interface PayProduct {
  storefrontId: string
  storefrontSlug: string
  id: string
  title: string
  name?: string
  priceCents: number
  originalPriceCents?: number
  currency: string
  coverUrl?: string
  availableStock?: number
  stock?: number
  requiresInventory?: boolean
  canPurchase?: boolean
  isOutOfStock?: boolean
  isLowStock?: boolean
  description?: string
  salesCopy?: string
  tagsJson?: string
  issueMode?: string
  category?: string
  sortOrder?: number
  active?: boolean
  fulfillmentMode?: string
  purchaseLimit?: number | null
  purchaseLimitDisplay?: boolean
  deliveryVisibility?: DeliveryVisibility
  stockDisplayMode?: StockDisplayMode
  fulfillmentInputType?: FulfillmentInputType
  fulfillmentInputLabel?: string
  fulfillmentInputHint?: string
  fulfillmentInputRequired?: boolean
  quantity?: number
}

export type PayStep = 'form' | 'online' | 'offline' | 'result'

export interface PayOrder {
  orderId: string
  product: PayProduct
  couponCode?: string
  couponDiscount?: number
  finalPriceCents: number
  currency: string
  email: string
  mode: 'online' | 'offline' | 'balance' | 'free'
}

// ─── API Responses ───

export interface ApiResponse<T> {
  ok?: boolean
  error?: string
  data?: T
}

export interface SystemConfig {
  config?: {
    shop_name?: string
    support_email?: string
    offline_pay_qr_wechat?: string
    offline_pay_qr_alipay?: string
    offline_pay_hint?: string
    balance_payment_enabled?: string
    balance_recharge_enabled?: string
    balance_recharge_min_cents?: string
    balance_recharge_max_cents?: string
    turnstile_enabled?: string
    turnstile_site_key?: string
    order_expire_minutes?: string
    inventory_warning_enabled?: string
    inventory_warning_threshold?: string
    [key: string]: any
  }
}

// ─── Unified Pay Response ───

export interface UnifiedPayData {
  orderId: string
  mode: 'online' | 'offline' | 'balance' | 'free'
  provider?: string
  paymentChannel?: string
  paymentChannelLabel?: string
  orderNo: string
  orderToken: string
  amountCents: number
  storefrontId?: string
  productId?: string
  productTitle?: string
  quantity?: number
  currency: string
  fulfillmentMode?: string
  /** 支付二维码图片地址或安全 data 位图；不要混入二维码原始内容。 */
  qrImageUrl?: string
  /** 支付网关返回的二维码原始内容/链接，仅作调试或跳转兜底，不直接放入 img。 */
  qrContent?: string
  qrcode?: string
  redirectUrl?: string
  offlineNoteCode?: string
  wechatQr?: string
  alipayQr?: string
  offlineHint?: string
  expiresAt?: string
  expireMinutes?: number
  delivery?: Delivery
  deliveryVisibility?: DeliveryVisibility
  deliveryMessage?: string
  cards?: Array<{ id?: string; accountLabel?: string; deliverySecret?: string; deliveryNote?: string; cardData: string }>
  items?: OrderItem[]
  status?: OrderStatus
  message?: string
}
