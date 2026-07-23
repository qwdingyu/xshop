/**
 * 渠道内单商品购买深链（用户侧推广）。
 *
 * 契约（不可破坏）：
 * - 渠道只在 path：`/shop` 或 `/s/:slug`（与 storefront.homePath 一致）
 * - 商品只在 query：`?product=`（slug 优先，兼容 id）
 * - 禁止无渠道全局商品链；失败时禁止跳到其他渠道
 */

export const PRODUCT_DEEPLINK_QUERY = 'product' as const

export type ProductLinkIdentity = {
  id: string
  slug?: string | null
}

/** 生成链接用的商品键：优先 slug，回退稳定 id */
export function productLinkKey(product: ProductLinkIdentity): string {
  const slug = typeof product.slug === 'string' ? product.slug.trim() : ''
  if (slug) return slug
  return String(product.id || '').trim()
}

/**
 * 渠道内购买路径（含 query，不含 origin）。
 * homePath 必须是后端给出的规范路径，例如 `/shop` 或 `/s/software`。
 */
export function buildStorefrontProductBuyPath(homePath: string, productKey: string): string {
  const path = String(homePath || '').trim() || '/shop'
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  const key = String(productKey || '').trim()
  if (!key) {
    throw new Error('productKey is required')
  }
  const params = new URLSearchParams()
  params.set(PRODUCT_DEEPLINK_QUERY, key)
  return `${normalizedPath}?${params.toString()}`
}

/** 完整用户侧购买 URL */
export function buildStorefrontProductBuyUrl(origin: string, homePath: string, productKey: string): string {
  const base = String(origin || '').trim() || 'http://localhost'
  return new URL(buildStorefrontProductBuyPath(homePath, productKey), base).toString()
}

/** 从 Vue Router query 读取单商品深链键；非法或空则 null */
export function parseProductDeeplinkQuery(query: Record<string, unknown> | { [key: string]: unknown }): string | null {
  const raw = query[PRODUCT_DEEPLINK_QUERY]
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

/** 去掉 product 查询参数，保留其余 query（用于打开后 scrub，避免刷新连环弹窗） */
export function stripProductDeeplinkQuery<T extends Record<string, unknown>>(query: T): Omit<T, typeof PRODUCT_DEEPLINK_QUERY> {
  const next = { ...query }
  delete next[PRODUCT_DEEPLINK_QUERY]
  return next
}

/** 单次消费键：同一渠道 + 同一 product 查询只自动打开一次 */
export function productDeeplinkConsumeKey(storefrontId: string, productKey: string): string {
  return `${storefrontId}::${productKey}`
}
