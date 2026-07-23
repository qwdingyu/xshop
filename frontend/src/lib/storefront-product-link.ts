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

/**
 * 深链意图终态后是否应 scrub `?product=`。
 *
 * 仅在「本意图已拥有打开锁，且到达可判定的售卖结论」时清除：
 * - opened：已打开收银台
 * - unsellable：当前渠道确认不可售（404 / PRODUCT_NOT_IN_STOREFRONT 等）
 * - open_refused：详情已取回但 builder 拒绝（售罄、渠道竞态等）
 *
 * 忙锁冲突、过期序号、中途离开渠道、瞬时失败（503/429/网络）：保留 query，避免推广链被误吞。
 */
export type DeeplinkScrubOutcome =
  | 'busy_conflict'
  | 'stale_or_left'
  | 'opened'
  | 'unsellable'
  | 'open_refused'
  | 'transient'

/** 详情拉取失败：确认不可售 vs 瞬时故障（决定是否 scrub） */
export type DeeplinkFetchFailureKind = 'unsellable' | 'transient'

/**
 * 从 fetchProductDetail 抛出的错误判定售卖终态。
 * 仅 404 / PRODUCT_NOT_IN_STOREFRONT（及同义渠道不可见）视为 unsellable 可 scrub；
 * 503/429/5xx/网络断开等一律 transient，保留 ?product= 供重试。
 */
export function classifyDeeplinkFetchFailure(err: unknown): DeeplinkFetchFailureKind {
  const status = readErrorStatus(err)
  const code = readErrorCode(err)

  if (code === 'PRODUCT_NOT_IN_STOREFRONT' || code === 'STOREFRONT_NOT_FOUND') {
    return 'unsellable'
  }
  if (status === 404) return 'unsellable'

  return 'transient'
}

function readErrorStatus(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null
  const status = (err as { status?: unknown }).status
  return typeof status === 'number' && Number.isFinite(status) ? status : null
}

function readErrorCode(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' && code.trim() ? code.trim() : null
}

export function shouldScrubProductDeeplinkAfterAttempt(input: {
  /** 本意图是否成功占有打开锁并开始执行（忙锁冲突为 false） */
  ownedAttempt: boolean
  /** 是否仍是最新一次深链序号 */
  isLatestSequence: boolean
  /** 是否仍在启动时的渠道上下文 */
  stillOnExpectedStorefront: boolean
  outcome: DeeplinkScrubOutcome
}): boolean {
  if (!input.ownedAttempt) return false
  if (!input.isLatestSequence) return false
  if (!input.stillOnExpectedStorefront) return false
  if (
    input.outcome === 'busy_conflict'
    || input.outcome === 'stale_or_left'
    || input.outcome === 'transient'
  ) {
    return false
  }
  return input.outcome === 'opened'
    || input.outcome === 'unsellable'
    || input.outcome === 'open_refused'
}
