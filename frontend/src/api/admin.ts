import type {
  AdminSummary,
  DailyIncome,
  AdminProduct,
  AdminProductCategory,
  AdminProductCategoryBody,
  AdminProductFilter,
  AdminProductListResult,
  AdminCardFilter,
  AdminCardListResult,
  AdminImportCardsPayload,
  AdminImportCardsResult,
  AdminOrder,
  AdminOrderFilter,
  AdminOrderListResult,
  AdminOrderExportParams,
  AdminOrderExportResult,
  AdminCouponFilter,
  AdminCouponListResult,
  AdminCreateCouponBody,
  AdminGenerateCouponBody,
  AdminUpdateCouponBody,
  AdminBalanceTransactionFilter,
  AdminBalanceTransactionListResult,
  AdminUserBalanceFilter,
  AdminUserBalanceListResult,
  AdminAdjustUserBalanceBody,
  AdminAdjustUserBalanceResult,
  AdminVoucherFilter,
  AdminVoucherListResult,
  AdminVoucherStats,
  AdminGenerateVoucherBody,
  AdminRechargeOrderFilter,
  AdminRechargeOrderListResult,
  AdminSystemConfigResult,
  AdminUpdateSystemConfigBody,
  AdminPaymentProviderResult,
  AdminPaymentHealthResult,
  AdminPaymentConfigsResult,
  AdminBatchListResult,
  AdminLowStockProduct,
  AdminTestEmailBody,
  AdminEmailLogListResult,
  AdminEmailLogFilter,
  AdminAuditLogListResult,
  AdminAuditLogFilter,
  AdminCampaign,
  AdminCreateCampaignBody,
  AdminUpdateCampaignBody,
  AdminReferralCode,
  AdminCreateReferralCodeBody,
  AdminUpdateReferralCodeBody,
  AdminCleanupResult,
  AdminStorefront,
  AdminStorefrontDetail,
  AdminCreateStorefrontBody,
  AdminUpdateStorefrontBody,
  AdminStorefrontProductBody,
  AdminMediaImageUploadResult,
} from '@/types/admin'
import type { FulfillmentProgressStage } from '@shared/fulfillment-progress'

const BASE = ''

type AdminRequestOptions = RequestInit & {
  params?: Record<string, string | number | Array<string | number>>
  redirectOnUnauthorized?: boolean
}

function handleUnauthorized() {
  try {
    localStorage.removeItem('admin_token')
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`
    const target = `/admin/login?redirect=${encodeURIComponent(current || '/admin')}`
    if (!window.location.pathname.startsWith('/admin/login')) {
      window.location.assign(target)
    }
  } catch {
    // Ignore storage/navigation failures; caller still receives AdminApiError.
  }
}

/** 管理端 API 错误 */
export class AdminApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message)
    this.name = 'AdminApiError'
  }
}

/** 带 Admin Bearer Token 的统一请求封装 */
async function adminRequest<T>(
  token: string,
  path: string,
  options?: AdminRequestOptions,
): Promise<T> {
  const { params, redirectOnUnauthorized = true, ...fetchOptions } = options || {}
  let url = BASE + path
  if (params) {
    const sep = url.includes('?') ? '&' : '?'
    const query = new URLSearchParams()
    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined || value === '') return
      query.set(key, Array.isArray(value) ? value.join(',') : String(value))
    })
    const queryString = query.toString()
    if (queryString) url += sep + queryString
  }

  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(fetchOptions.headers || {}),
    },
    ...fetchOptions,
  })

  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const message = data.error || `Admin request failed: ${res.status}`
    const code = data.code as string | undefined
    if (res.status === 401) {
      // 登录阶段校验的是候选令牌，不能套用已登录会话失效的清理和跳转逻辑。
      // 其他管理 API 仍维持统一退出，避免失效令牌让页面停留在半登录状态。
      if (!redirectOnUnauthorized) {
        throw new AdminApiError('管理令牌无效', 401, 'INVALID_ADMIN_TOKEN')
      }
      handleUnauthorized()
      throw new AdminApiError('登录已过期，请重新登录', 401, 'UNAUTHORIZED')
    }
    throw new AdminApiError(message, res.status, code || 'ADMIN_ERROR')
  }
  return data as T
}

/** 用于文件下载等非 JSON 响应的原始请求封装 */
async function adminRequestRaw(token: string, path: string): Promise<Response> {
  const url = BASE + path
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    const message = data.error || `Admin request failed: ${res.status}`
    const code = data.code as string | undefined
    if (res.status === 401) {
      handleUnauthorized()
      throw new AdminApiError('登录已过期，请重新登录', 401, 'UNAUTHORIZED')
    }
    throw new AdminApiError(message, res.status, code || 'ADMIN_ERROR')
  }
  return res
}

// ─── Auth ───

/** 使用无数据库依赖的受保护端点验证手工输入的 ADMIN_TOKEN。 */
export function verifyAdminToken(token: string): Promise<{ ok: true }> {
  return adminRequest(token, '/api/admin/session', {
    redirectOnUnauthorized: false,
  })
}

/** 通过 JWT 换取 ADMIN_TOKEN（用于 TG Bot 登录链接） */
export function adminVerifyJwt(token: string, jwt: string): Promise<{ adminToken: string }> {
  return adminRequest(token, '/api/admin/verify-jwt', {
    method: 'POST',
    body: JSON.stringify({ jwt }),
  })
}

// ─── Summary ───

export function fetchAdminSummary(token: string): Promise<{ summary: AdminSummary; dailyIncome: DailyIncome[] }> {
  return adminRequest(token, '/api/admin/summary')
}

export function batchDeleteAdminOrders(token: string, ids: string[]): Promise<{ deleted: number; blocked: number }> {
  return adminRequest(token, '/api/admin/orders/batch-delete', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  })
}

// ─── Products ───

export function fetchAdminProducts(token: string, params?: AdminProductFilter): Promise<AdminProductListResult> {
  return adminRequest(token, '/api/admin/products', { params: params as Record<string, string | number | Array<string | number>> | undefined })
}

export function fetchAdminProductCategories(token: string): Promise<{ categories: AdminProductCategory[] }> {
  return adminRequest(token, '/api/admin/product-categories')
}

export function createAdminProductCategory(token: string, body: AdminProductCategoryBody): Promise<{ id: string }> {
  return adminRequest(token, '/api/admin/product-categories', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function updateAdminProductCategory(token: string, id: string, body: Partial<AdminProductCategoryBody>): Promise<{ id: string }> {
  return adminRequest(token, `/api/admin/product-categories/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export function deleteAdminProductCategory(token: string, id: string): Promise<{ deleted: string }> {
  return adminRequest(token, `/api/admin/product-categories/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

export function createAdminProduct(token: string, body: Partial<AdminProduct> & Pick<AdminProduct, 'title' | 'priceCents'>): Promise<{ productId: string }> {
  return adminRequest(token, '/api/admin/products', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function updateAdminProduct(token: string, id: string, body: Partial<AdminProduct>): Promise<{ productId: string }> {
  return adminRequest(token, `/api/admin/products/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export function duplicateAdminProduct(token: string, id: string): Promise<{ productId: string }> {
  return adminRequest(token, `/api/admin/products/${encodeURIComponent(id)}/duplicate`, {
    method: 'POST',
  })
}

export function deleteAdminProduct(token: string, id: string): Promise<{ deleted: string }> {
  return adminRequest(token, `/api/admin/products/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

/**
 * 上传公开商品图片或渠道 Logo。FormData 必须由浏览器设置 boundary，不能复用 JSON 请求头。
 * 文件大小在客户端提前拦截以节省流量，后端仍会执行同样的权威校验。
 */
export async function uploadAdminMediaImage(token: string, file: File): Promise<AdminMediaImageUploadResult> {
  if (file.size <= 0) throw new AdminApiError('请选择非空图片文件', 400, 'INVALID_MEDIA_IMAGE')
  if (file.size > 5 * 1024 * 1024) throw new AdminApiError('图片不能超过 5MiB', 400, 'MEDIA_IMAGE_TOO_LARGE')

  const form = new FormData()
  form.append('file', file)
  const res = await fetch('/api/admin/media/images', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (res.status === 401) {
      handleUnauthorized()
      throw new AdminApiError('登录已过期，请重新登录', 401, 'UNAUTHORIZED')
    }
    const code = data.code || data.details?.code || 'MEDIA_UPLOAD_FAILED'
    throw new AdminApiError(data.error || `图片上传失败：${res.status}`, res.status, code)
  }
  return data as AdminMediaImageUploadResult
}

// ─── Storefront display channels ───

export function fetchAdminStorefronts(token: string): Promise<{ storefronts: AdminStorefront[] }> {
  return adminRequest(token, '/api/admin/storefronts')
}

export function fetchAdminStorefront(token: string, id: string): Promise<AdminStorefrontDetail> {
  return adminRequest(token, `/api/admin/storefronts/${encodeURIComponent(id)}`)
}

export function createAdminStorefront(token: string, body: AdminCreateStorefrontBody): Promise<{ id: string }> {
  return adminRequest(token, '/api/admin/storefronts', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function updateAdminStorefront(token: string, id: string, body: AdminUpdateStorefrontBody): Promise<{ id: string }> {
  return adminRequest(token, `/api/admin/storefronts/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export function replaceAdminStorefrontProducts(
  token: string,
  id: string,
  products: AdminStorefrontProductBody[],
  options?: { allowEmptyDefault?: boolean },
): Promise<{ id: string; count: number }> {
  return adminRequest(token, `/api/admin/storefronts/${encodeURIComponent(id)}/products`, {
    method: 'PUT',
    body: JSON.stringify({ items: products, allowEmptyDefault: options?.allowEmptyDefault === true }),
  })
}

export function updateAdminStorefrontProduct(
  token: string,
  id: string,
  productId: string,
  body: Partial<Pick<AdminStorefrontProductBody, 'visible' | 'sortOrder'>>,
): Promise<{ id: string; productId: string }> {
  return adminRequest(token, `/api/admin/storefronts/${encodeURIComponent(id)}/products/${encodeURIComponent(productId)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export function setAdminDefaultStorefront(token: string, id: string): Promise<{ id: string }> {
  return adminRequest(token, `/api/admin/storefronts/${encodeURIComponent(id)}/set-default`, {
    method: 'POST',
  })
}

export function deleteAdminStorefront(token: string, id: string): Promise<{ deleted: string }> {
  return adminRequest(token, `/api/admin/storefronts/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

// ─── Cards ───

export function fetchAdminCards(token: string, params?: AdminCardFilter): Promise<AdminCardListResult> {
  return adminRequest(token, '/api/admin/cards', { params: params as Record<string, string | number | Array<string | number>> | undefined })
}

export function importAdminCards(token: string, body: AdminImportCardsPayload): Promise<AdminImportCardsResult & { ok: boolean }> {
  return adminRequest(token, '/api/admin/cards/import', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function downloadCardImportTemplate(token: string): Promise<Blob> {
  return adminRequestRaw(token, '/api/admin/cards/import-template').then((res) => res.blob())
}

export function updateAdminCard(token: string, id: string, body: { status: 'available' | 'disabled' }): Promise<{ id: string; status: string }> {
  return adminRequest(token, `/api/admin/cards/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export interface AdminBatchDisablePayload {
  ids: string[]
  status: 'available' | 'disabled'
}

export function batchDisableAdminCards(token: string, body: AdminBatchDisablePayload): Promise<{ updated: number }> {
  return adminRequest(token, '/api/admin/cards/batch-disable', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function batchDeleteAdminCards(token: string, ids: string[]): Promise<{ deleted: number; blocked: number }> {
  return adminRequest(token, '/api/admin/cards/batch-delete', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  })
}

export interface AdminGenerateGenericCardsPayload {
  productId: string
  count: number
  genericCode: string
  batchName: string
  expiresAt?: string
}

export interface AdminGenerateGenericCardsResult {
  batchId: string
  generated: number
  message: string
}

export function generateAdminGenericCards(
  token: string,
  body: AdminGenerateGenericCardsPayload,
): Promise<AdminGenerateGenericCardsResult & { ok: boolean }> {
  return adminRequest(token, '/api/admin/cards/generate-generic', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

// ─── Orders ───

export function fetchAdminOrders(token: string, params?: AdminOrderFilter): Promise<AdminOrderListResult> {
  return adminRequest(token, '/api/admin/orders', { params: params as Record<string, string | number | Array<string | number>> | undefined })
}

export function exportAdminOrders(token: string, params?: AdminOrderExportParams): Promise<AdminOrderExportResult> {
  return adminRequest(token, '/api/admin/orders/export', { params: params as Record<string, string | number | Array<string | number>> | undefined })
}

export function downloadAdminOrdersExport(token: string, params?: AdminOrderExportParams): Promise<Blob> {
  const { format, ...rest } = params || {}
  const query = new URLSearchParams()
  if (format) query.set('format', format)
  Object.entries(rest).forEach(([k, v]) => {
    if (v === undefined || v === '') return
    query.set(k, Array.isArray(v) ? v.join(',') : String(v))
  })
  const url = `/api/admin/orders/export${query ? `?${query.toString()}` : ''}`
  return adminRequestRaw(token, url).then((res) => res.blob())
}

export interface AdminFinanceExportParams {
  status?: string | string[]
  productId?: string
  q?: string
  paymentMethod?: string
  orderSource?: string
  storefrontId?: string
  format?: 'csv' | 'json'
  cursor?: string
  limit?: number
}

export interface AdminFinanceExportResult {
  orders?: Record<string, unknown>[]
  balanceTransactions?: Record<string, unknown>[]
  summary?: {
    totalIncomeCents: number
    totalCardIssuedCents: number
    totalBalanceSpentCents: number
    totalRefundCents: number
  }
  nextCursor?: string
  hasMore?: boolean
}

export function fetchAdminFinanceExport(token: string, params?: AdminFinanceExportParams): Promise<AdminFinanceExportResult> {
  return adminRequest(token, '/api/admin/finance/export', { params: params as Record<string, string | number | Array<string | number>> | undefined })
}

export function downloadAdminFinanceExport(token: string, params?: AdminFinanceExportParams): Promise<Blob> {
  const { format, ...rest } = params || {}
  const query = new URLSearchParams()
  if (format) query.set('format', format)
  Object.entries(rest).forEach(([k, v]) => {
    if (v === undefined || v === '') return
    query.set(k, Array.isArray(v) ? v.join(',') : String(v))
  })
  const url = `/api/admin/finance/export${query ? `?${query.toString()}` : ''}`
  return adminRequestRaw(token, url).then((res) => res.blob())
}

export function fetchAdminOrder(token: string, id: string): Promise<{ order: AdminOrder }> {
  return adminRequest(token, `/api/admin/orders/${encodeURIComponent(id)}`)
}

export function markAdminOrderPaid(token: string, id: string): Promise<{ message: string }> {
  return adminRequest(token, `/api/admin/orders/${encodeURIComponent(id)}/mark-paid`, {
    method: 'POST',
  })
}

export function retryAdminOrderFulfillment(token: string, id: string): Promise<{ message: string }> {
  return adminRequest(token, `/api/admin/orders/${encodeURIComponent(id)}/retry-fulfillment`, {
    method: 'POST',
  })
}

export interface AdminFulfillmentProgressPayload {
  stage: FulfillmentProgressStage
  supplierOrderRef?: string
  note?: string
}

export function updateAdminOrderFulfillmentProgress(
  token: string,
  id: string,
  body: AdminFulfillmentProgressPayload,
): Promise<{ message: string }> {
  return adminRequest(token, `/api/admin/orders/${encodeURIComponent(id)}/fulfillment-progress`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function cancelAdminOrder(token: string, id: string): Promise<{ message: string; releasedCardId?: string }> {
  return adminRequest(token, `/api/admin/orders/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
  })
}

// ─── Coupons ───

export function fetchAdminCoupons(token: string, params?: AdminCouponFilter): Promise<AdminCouponListResult> {
  return adminRequest(token, '/api/admin/coupons', { params: params as Record<string, string | number | Array<string | number>> | undefined })
}

export function createAdminCoupon(token: string, body: AdminCreateCouponBody): Promise<{ code: string; warning?: string }> {
  return adminRequest(token, '/api/admin/coupons', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function generateAdminCoupons(token: string, body: AdminGenerateCouponBody): Promise<{ codes: string[]; productId: string }> {
  return adminRequest(token, '/api/admin/coupons/generate', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function updateAdminCoupon(token: string, code: string, body: AdminUpdateCouponBody): Promise<{ code: string }> {
  return adminRequest(token, `/api/admin/coupons/${encodeURIComponent(code)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export function deleteAdminCoupon(token: string, code: string): Promise<{ deleted: string }> {
  return adminRequest(token, `/api/admin/coupons/${encodeURIComponent(code)}`, {
    method: 'DELETE',
  })
}

// ─── Balance Transactions ───

export function fetchAdminBalanceTransactions(
  token: string,
  params?: AdminBalanceTransactionFilter,
): Promise<AdminBalanceTransactionListResult> {
  return adminRequest(token, '/api/admin/balance-transactions', { params: params as Record<string, string | number | Array<string | number>> | undefined })
}

// ─── User Balances ───

export function fetchAdminUserBalances(
  token: string,
  params?: AdminUserBalanceFilter,
): Promise<AdminUserBalanceListResult> {
  return adminRequest(token, '/api/admin/user-balances', {
    params: params as Record<string, string | number | Array<string | number>> | undefined,
  })
}

export function adjustAdminUserBalance(
  token: string,
  body: AdminAdjustUserBalanceBody,
): Promise<AdminAdjustUserBalanceResult> {
  return adminRequest(token, '/api/admin/user-balances/adjust', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

// ─── Recharge Vouchers ───

export function fetchAdminVouchers(token: string, params?: AdminVoucherFilter): Promise<AdminVoucherListResult> {
  return adminRequest(token, '/api/admin/vouchers/list', {
    params: params as Record<string, string | number | Array<string | number>> | undefined,
  })
}

export function fetchAdminVoucherStats(token: string): Promise<AdminVoucherStats> {
  return adminRequest(token, '/api/admin/vouchers/stats')
}

export function generateAdminVouchers(
  token: string,
  body: AdminGenerateVoucherBody,
): Promise<{ count: number; batchId: string; codes: string[]; message: string }> {
  return adminRequest(token, '/api/admin/vouchers/generate', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function revokeAdminVouchers(token: string, codes: string[]): Promise<{ count: number; message: string }> {
  return adminRequest(token, '/api/admin/vouchers/revoke', {
    method: 'POST',
    body: JSON.stringify({ codes }),
  })
}

export function fetchAdminRechargeOrders(token: string, params?: AdminRechargeOrderFilter): Promise<AdminRechargeOrderListResult> {
  return adminRequest(token, '/api/admin/recharge-orders', {
    params: params as Record<string, string | number | Array<string | number>> | undefined,
  })
}

// ─── System Config ───

export function fetchAdminSystemConfig(token: string): Promise<AdminSystemConfigResult> {
  return adminRequest(token, '/api/admin/system-config')
}

export function updateAdminSystemConfig(token: string, body: AdminUpdateSystemConfigBody): Promise<{
  key: string
  value: string
  configured?: boolean
  turnstileStatus?: AdminSystemConfigResult['turnstileStatus']
}> {
  return adminRequest(token, '/api/admin/system-config', {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

export function deleteAdminSystemConfig(token: string, key: string): Promise<{ deleted: string }> {
  return adminRequest(token, `/api/admin/system-config/${encodeURIComponent(key)}`, {
    method: 'DELETE',
  })
}

// ─── Payment ───

export function fetchAdminPaymentProviders(token: string): Promise<AdminPaymentProviderResult> {
  return adminRequest(token, '/api/admin/payment/providers')
}

export function fetchAdminPaymentHealth(token: string): Promise<AdminPaymentHealthResult> {
  return adminRequest(token, '/api/admin/payment/health')
}

export function fetchAdminPaymentConfigs(token: string): Promise<AdminPaymentConfigsResult> {
  return adminRequest(token, '/api/admin/payment/configs')
}

export function updateAdminPaymentConfig(token: string, name: string, body: Record<string, string>): Promise<{ provider: string; enabled: boolean; message: string }> {
  return adminRequest(token, `/api/admin/payment/configs/${encodeURIComponent(name)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

export function setAdminPaymentProviderEnabled(
  token: string,
  name: string,
  enabled: boolean,
): Promise<{ provider: string; enabled: boolean; message: string }> {
  return adminRequest(token, `/api/admin/payment/configs/${encodeURIComponent(name)}/enabled`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled }),
  })
}

export function deleteAdminPaymentConfig(token: string, name: string): Promise<{ provider: string; message: string }> {
  return adminRequest(token, `/api/admin/payment/configs/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  })
}

// ─── Batches ───

export function fetchAdminBatches(token: string, productId?: string): Promise<AdminBatchListResult> {
  return adminRequest(token, '/api/admin/batches', {
    params: productId ? { productId } : undefined,
  })
}

// ─── Low Stock Products ───

export function fetchAdminLowStockProducts(token: string, threshold?: number): Promise<{ products: AdminLowStockProduct[] }> {
  return adminRequest(token, '/api/admin/low-stock-products', {
    params: threshold !== undefined ? { threshold: String(threshold) } : undefined,
  })
}

export interface AdminNotifyLowStockPayload {
  threshold?: number
}

export interface AdminNotifyLowStockResult {
  ok: boolean
  message: string
  sent: boolean
  count: number
}

export function notifyAdminLowStock(token: string, payload: AdminNotifyLowStockPayload): Promise<AdminNotifyLowStockResult> {
  return adminRequest(token, '/api/admin/low-stock-products/notify', {
    method: 'POST',
    params: payload.threshold !== undefined ? { threshold: String(payload.threshold) } : undefined,
  })
}

// ─── Email ───

export function testAdminEmail(token: string, body: AdminTestEmailBody): Promise<{ ok: boolean; message: string; resendId?: string }> {
  return adminRequest(token, '/api/admin/test-email', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function fetchAdminEmailLogs(token: string, params?: AdminEmailLogFilter): Promise<AdminEmailLogListResult> {
  return adminRequest(token, '/api/admin/email-logs', { params: params as Record<string, string | number | Array<string | number>> | undefined })
}

export function batchDeleteAdminEmailLogs(token: string, ids: string[]): Promise<{ deleted: number }> {
  return adminRequest(token, '/api/admin/email-logs/batch-delete', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  })
}

// ─── Logs ───

export function fetchAdminLogs(token: string, params?: AdminAuditLogFilter): Promise<AdminAuditLogListResult> {
  return adminRequest(token, '/api/admin/logs', { params: params as Record<string, string | number | Array<string | number>> | undefined })
}

export function batchDeleteAdminLogs(
  token: string,
  logs: Array<{ type: 'request' | 'admin'; id: string }>,
): Promise<{ deleted: number; request: number; admin: number }> {
  return adminRequest(token, '/api/admin/logs/batch-delete', {
    method: 'POST',
    body: JSON.stringify({ logs }),
  })
}

export function clearAllAdminLogs(token: string): Promise<{
  deleted: number
  request: number
  admin: number
  retainedAuditId: string
}> {
  return adminRequest(token, '/api/admin/logs/clear', {
    method: 'POST',
    body: JSON.stringify({ confirmation: 'CLEAR_ALL_LOGS' }),
  })
}

export type AdminClearBusinessDataProfile = 'runtime' | 'keep_catalog' | 'full'

export interface AdminClearBusinessDataResult {
  deleted: number
  tables: Record<string, number>
  reservedTables: string[]
  retainedAuditId: string
  profile: AdminClearBusinessDataProfile
  cardStrategy: 'none' | 'clear_all'
}

export function clearAdminBusinessData(
  token: string,
  confirmation: string,
  profile: AdminClearBusinessDataProfile = 'full',
): Promise<AdminClearBusinessDataResult> {
  return adminRequest(token, '/api/admin/system-config/clear-business-data', {
    method: 'POST',
    body: JSON.stringify({
      profile,
      confirmation,
      preserveConfigAndSystemParams: true,
    }),
  })
}

// ─── Campaigns ───

export function fetchAdminCampaigns(token: string): Promise<{ campaigns: AdminCampaign[] }> {
  return adminRequest(token, '/api/admin/campaigns')
}

export function createAdminCampaign(token: string, body: AdminCreateCampaignBody): Promise<{ code: string }> {
  return adminRequest(token, '/api/admin/campaigns', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function updateAdminCampaign(token: string, code: string, body: AdminUpdateCampaignBody): Promise<{ code: string }> {
  return adminRequest(token, `/api/admin/campaigns/${encodeURIComponent(code)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export function deleteAdminCampaign(token: string, code: string): Promise<{ deleted: string }> {
  return adminRequest(token, `/api/admin/campaigns/${encodeURIComponent(code)}`, {
    method: 'DELETE',
  })
}

// ─── Referral Codes ───

export function fetchAdminReferralCodes(token: string): Promise<{ codes: AdminReferralCode[] }> {
  return adminRequest(token, '/api/admin/referral-codes')
}

export function createAdminReferralCode(token: string, body: AdminCreateReferralCodeBody): Promise<{ code: string }> {
  return adminRequest(token, '/api/admin/referral-codes', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function updateAdminReferralCode(token: string, code: string, body: AdminUpdateReferralCodeBody): Promise<{ code: string }> {
  return adminRequest(token, `/api/admin/referral-codes/${encodeURIComponent(code)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export function deleteAdminReferralCode(token: string, code: string): Promise<{ deleted: string }> {
  return adminRequest(token, `/api/admin/referral-codes/${encodeURIComponent(code)}`, {
    method: 'DELETE',
  })
}

// ─── Cleanup ───

export function runAdminCleanup(token: string): Promise<AdminCleanupResult> {
  return adminRequest(token, '/api/admin/cleanup', {
    method: 'POST',
  })
}

// ─── Phase 3: 运营效率工具 ──────────────────────────────

export interface AdminPendingTasks {
  pendingOfflinePayments: Record<string, unknown>[]
  paidButNotIssued: Record<string, unknown>[]
  lowStockProducts: AdminLowStockProduct[]
}

export function fetchAdminPendingTasks(token: string): Promise<AdminPendingTasks> {
  return adminRequest(token, '/api/admin/pending-tasks')
}

export interface AdminUpdateCardBatchPayload {
  name?: string
  source?: string
  costPriceCents?: number | null
  note?: string | null
}

export function updateAdminCardBatch(token: string, id: string, body: AdminUpdateCardBatchPayload): Promise<{ id: string }> {
  return adminRequest(token, `/api/admin/batches/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export interface AdminResendEmailResult {
  ok: boolean
  message: string
}

export function resendAdminOrderEmail(token: string, id: string): Promise<AdminResendEmailResult> {
  return adminRequest(token, `/api/admin/orders/${encodeURIComponent(id)}/resend-email`, {
    method: 'POST',
  })
}

export interface AdminCompensationNotePayload {
  note: string
}

export interface AdminCompensationNoteResult {
  ok: boolean
  message: string
}

export function addAdminOrderCompensationNote(token: string, id: string, body: AdminCompensationNotePayload): Promise<AdminCompensationNoteResult> {
  return adminRequest(token, `/api/admin/orders/${encodeURIComponent(id)}/compensation-note`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}
