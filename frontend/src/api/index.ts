import type { Product, ProductCategory, Storefront, SystemConfig, Order, Delivery, DeliveryVisibility, OrderItem, OrderStatus } from '@/types'

const BASE = ''

/** 自定义 API 错误，携带 HTTP 状态码和错误类型，便于调用方按场景处理 */
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** 统一请求封装：自动拼接 params，解包后端 { ok, error } 响应 */
async function request<T>(path: string, options?: RequestInit & { params?: Record<string, string> }): Promise<T> {
  const { params, ...fetchOptions } = options || {}
  if (params) {
    const sep = path.includes('?') ? '&' : '?'
    path += sep + new URLSearchParams(params).toString()
  }
  const headers = new Headers(fetchOptions.headers)
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const res = await fetch(BASE + path, { ...fetchOptions, headers })
  const data = await res.json()
  if (!res.ok) {
    const message = data.error || `Request failed: ${res.status}`
    const code = (data.code || data.details?.code) as string | undefined
    const details = data.details && typeof data.details === 'object'
      ? data.details as Record<string, unknown>
      : undefined
    switch (res.status) {
      case 401:
        throw new ApiError('登录已过期，请重新登录', 401, 'UNAUTHORIZED')
      case 403:
        throw new ApiError(message || '没有权限执行此操作', 403, code || 'FORBIDDEN', details)
      case 404:
        throw new ApiError(message || '请求的资源不存在', 404, code || 'NOT_FOUND', details)
      case 429:
        throw new ApiError(message || '请求过于频繁，请稍后再试', 429, code || 'RATE_LIMITED', details)
      case 503:
        throw new ApiError(message || '服务暂时不可用，请稍后重试', 503, code || 'SERVICE_UNAVAILABLE', details)
      default:
        throw new ApiError(message, res.status, code || 'UNKNOWN_ERROR', details)
    }
  }
  return data as T
}

// ─── Products ───

export interface FetchProductsParams {
  storefront?: string
  q?: string
  active?: string
  category?: string
  page?: number
  limit?: number
}

/** 获取商品列表 — 后端返回 { ok: true, products: [...] } */
export function fetchProducts(params?: FetchProductsParams): Promise<Product[]> {
  return fetchProductCatalog(params).then(d => d.products)
}

export interface ProductCatalog {
  storefront: Storefront
  products: Product[]
  categories: ProductCategory[]
}

/** 获取前台商品目录 — 后端返回商品和正式分类契约 */
export function fetchProductCatalog(params?: FetchProductsParams): Promise<ProductCatalog> {
  const query: Record<string, string> = {}
  if (params) {
    if (params.storefront) query.storefront = params.storefront
    if (params.q) query.q = params.q
    if (params.active) query.active = params.active
    if (params.category) query.category = params.category
    if (params.page) query.page = String(params.page)
    if (params.limit) query.limit = String(params.limit)
  }
  return request<{ storefront: Storefront; products: Product[]; categories?: ProductCategory[] }>('/api/products', {
    params: Object.keys(query).length ? query : undefined,
    cache: 'no-store',
  }).then(d => ({
    storefront: d.storefront,
    products: d.products,
    categories: d.categories || [],
  }))
}

/** 获取单个前台商品详情 — 用于打开付款弹窗前刷新实时库存 */
export function fetchProductDetail(idOrSlug: string, storefrontSlug?: string): Promise<Product> {
  return request<{ storefront: Storefront; product: Product }>(`/api/products/${encodeURIComponent(idOrSlug)}`, {
    params: storefrontSlug ? { storefront: storefrontSlug } : undefined,
    cache: 'no-store',
  }).then(d => d.product)
}

/** 邮箱验证码查询只返回该邮箱的订单摘要，不包含 Token 或交付内容。 */
export function lookupOrdersByEmail(email: string, emailAccessCode: string): Promise<Order[]> {
  return request<{ orders: Order[] }>('/api/orders/lookup', {
    method: 'POST',
    body: JSON.stringify({ email }),
    headers: emailAccessCode ? { 'X-Email-Access-Code': emailAccessCode } : undefined,
  }).then(d => d.orders.map(order => ({
    ...order,
    priceCents: order.priceCents ?? order.amountCents,
  })))
}

export function requestEmailAccessCode(
  email: string,
  turnstileToken?: string,
  options?: {
    /** 收银台发码时传入，用于发信前限购预检，避免已达上限仍滥发邮件 */
    productId?: string
    storefrontId?: string
    quantity?: number
  },
): Promise<{
  sent: boolean
  expiresInSeconds: number
  resendCooldownSeconds?: number
}> {
  return request('/api/email/access-code', {
    method: 'POST',
    body: JSON.stringify({
      email,
      turnstileToken,
      productId: options?.productId,
      storefrontId: options?.storefrontId,
      quantity: options?.quantity,
    }),
  })
}

// ─── Unified Payment ───

/** 统一下单支付：后端自动判断线上/线下，返回 mode + 支付信息 */
export function unifiedPay(payload: {
  storefrontId: string
  productId: string
  buyerEmail: string
  couponCode?: string
  campaignCode?: string
  referralCode?: string
  fulfillmentInput?: string
  turnstileToken?: string
  balancePayment?: boolean
  paymentChannel?: 'alipay' | 'wxpay' | 'qqpay'
  emailAccessCode?: string
  quantity?: number
  /** 强随机幂等键，仅通过 Idempotency-Key 请求头发送 */
  idempotencyKey: string
}): Promise<{
  mode: 'online' | 'offline' | 'balance' | 'free'
  provider?: string
  paymentChannel?: string
  paymentChannelLabel?: string
  orderId: string
  orderNo: string
  orderToken: string
  amountCents: number
  storefrontId?: string
  productId?: string
  productTitle?: string
  quantity?: number
  currency: string
  fulfillmentMode?: string
  qrImageUrl?: string
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
}> {
  const headers = { 'Idempotency-Key': payload.idempotencyKey }
  const { idempotencyKey: _idempotencyKey, ...body } = payload
  return request('/api/pay/unified', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

export interface PublicPaymentMethod {
  provider: 'easypay'
  channel: 'alipay' | 'wxpay' | 'qqpay'
  label: string
}

export function fetchPaymentMethods(): Promise<{ methods: PublicPaymentMethod[] }> {
  return request('/api/pay/methods', { cache: 'no-store' })
}

export interface BalanceRechargeResponse {
  mode: 'online'
  provider: string
  paymentChannel?: string
  paymentChannelLabel?: string
  orderId: string
  orderNo: string
  orderToken: string
  amountCents: number
  currency: 'CNY'
  status: 'pending' | 'paid' | 'expired' | 'failed'
  qrImageUrl?: string
  redirectUrl?: string
  expiresAt: string
  message?: string
}

export function createBalanceRecharge(payload: {
  buyerEmail: string
  emailAccessCode: string
  amountCents: number
  paymentChannel?: 'alipay' | 'wxpay' | 'qqpay'
  idempotencyKey: string
}): Promise<BalanceRechargeResponse> {
  const { idempotencyKey, ...body } = payload
  return request('/api/recharge/create', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(body),
  })
}

export function fetchBalanceRechargeStatus(orderId: string, orderToken: string): Promise<{
  orderId: string
  orderNo: string
  status: 'pending' | 'paid' | 'expired' | 'failed'
  amountCents: number
  currency: 'CNY'
  paidAt?: string
  expiresAt: string
}> {
  return request('/api/recharge/status', {
    method: 'POST',
    body: JSON.stringify({ orderId, orderToken }),
  })
}

/** 轮询支付状态（需 orderToken） */
export function getPayStatus(orderId: string, orderToken: string): Promise<{
  orderId: string
  orderNo: string
  status: OrderStatus
  productTitle?: string
  amountCents?: number
  quantity?: number
  currency?: string
  fulfillmentMode?: string
  buyerEmail?: string
  buyerContact?: string
  expiresAt?: string
  paymentRef?: string
  paidAt?: string
  issuedAt?: string
  fulfillmentPending?: boolean
  message?: string
  delivery?: Delivery
  deliveryVisibility?: DeliveryVisibility
  deliveryMessage?: string
  cards?: Array<{ id?: string; accountLabel?: string; deliverySecret?: string; deliveryNote?: string; cardData: string }>
  items?: OrderItem[]
}> {
  return request(`/api/pay/status/${encodeURIComponent(orderId)}?token=${encodeURIComponent(orderToken)}`, {
    cache: 'no-store',
  })
}

/** 线下支付确认：提交付款流水号后四位 */
export function confirmOfflinePay(payload: {
  orderId: string
  orderToken: string
  payRefLast4: string
}): Promise<{ confirmed: boolean }> {
  return request('/api/pay/offline/confirm', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

/** 线下支付取消：用户关闭/返回待支付页时释放订单锁定库存 */
export function cancelOfflinePay(payload: {
  orderId: string
  orderToken: string
}): Promise<{ canceled: boolean; releasedCards: number }> {
  return request('/api/pay/offline/cancel', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

// ─── Orders (New Token-based Lookup) ───

/** Token 查询返回单笔订单；页面统一包装为数组复用结果列表。 */
export function lookupOrders(token: string): Promise<Order[]> {
  return request<{ order?: Order }>('/api/orders/lookup', {
    params: { token },
  }).then(d => {
    const rows = d.order ? [d.order] : []
    return rows.map(order => {
      const normalized = {
        ...order,
        priceCents: order.priceCents ?? order.amountCents,
      } as Order
      return normalized
    })
  })
}

// ─── Coupon ───

/** 折扣码验证 — 后端 /coupons/quote（POST）返回 { valid, discountCents, payableCents, message? } */
export function verifyCoupon(code: string, productId: string, storefrontId: string, quantity = 1): Promise<{
  valid: boolean
  discountCents?: number
  payableCents?: number
  message?: string
}> {
  return request('/api/coupons/quote', {
    method: 'POST',
    body: JSON.stringify({
      productId,
      storefrontId,
      quantity,
      couponCode: code,
    }),
  })
}

// ─── Redeem ───

export function redeemCoupon(payload: {
  couponCode: string
  buyerEmail: string
  turnstileToken?: string
}): Promise<{
  ok: boolean
  orderId: string
  orderNo: string
  orderToken: string
  fulfillmentMode: 'card'
  delivery?: Delivery
  deliveryVisibility?: DeliveryVisibility
  deliveryMessage?: string
}> {
  return request('/api/redeem', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function redeemVoucher(payload: {
  code: string
  email: string
  turnstileToken?: string
}): Promise<{ success: boolean; amountCents: number; amountYuan: string; message: string }> {
  return request('/api/vouchers/redeem', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function fetchBalance(email: string, emailAccessCode: string): Promise<{
  balanceCents: number
  balanceYuan: string
}> {
  return request('/api/vouchers/balance', {
    method: 'POST',
    body: JSON.stringify({ email, emailAccessCode }),
  })
}

// ─── System ───

export function fetchConfig(): Promise<SystemConfig> {
  return request('/api/system-config', { cache: 'no-store' })
}

// ─── Health ───

export function checkHealth(): Promise<{ status: string }> {
  return request('/api/health')
}
