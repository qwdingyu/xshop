/**
 * 部署后旧页面可能仍引用上一版 hash chunk。
 * 资源部署采用 immutable 缓存并不会保留旧文件，因此只能让旧页面重新获取最新入口。
 */
export const STALE_ASSET_RELOAD_PARAM = '__asset_reload'

const DYNAMIC_IMPORT_ERROR_PATTERNS = [
  'failed to fetch dynamically imported module',
  'importing a module script failed',
  'error loading dynamically imported module',
  'unable to preload',
]

export function isStaleAssetLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '')
  const normalized = message.toLowerCase()
  return DYNAMIC_IMPORT_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern))
}

/** 返回一次性刷新地址；已经刷新过则返回 null，防止缺失资源造成无限刷新。 */
export function buildStaleAssetRecoveryUrl(href: string, baseHref: string): string | null {
  const url = new URL(href, baseHref)
  if (url.searchParams.has(STALE_ASSET_RELOAD_PARAM)) return null
  url.searchParams.set(STALE_ASSET_RELOAD_PARAM, '1')
  return url.toString()
}

export function clearStaleAssetRecoveryParam(href: string): string {
  const url = new URL(href, href)
  url.searchParams.delete(STALE_ASSET_RELOAD_PARAM)
  return `${url.pathname}${url.search}${url.hash}`
}
