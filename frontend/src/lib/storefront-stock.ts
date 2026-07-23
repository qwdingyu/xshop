import type { Product, StockDisplayMode } from '@/types'

function requiresInventory(product: Product): boolean {
  return product.requiresInventory ?? product.fulfillmentMode === 'card'
}

function displayMode(product: Product): StockDisplayMode {
  return product.stockDisplayMode || 'exact'
}

function purchaseLimit(product: Product): number | null {
  const value = Number(product.purchaseLimit || 0)
  return Number.isInteger(value) && value > 0 ? Math.min(99, value) : null
}

export function productPurchaseLimitLabel(product: Product): string {
  const limit = purchaseLimit(product)
  return product.purchaseLimitDisplay === true && limit !== null ? `限购 ${limit}` : ''
}

/** 只有 exact 模式允许前端把公开响应解释为精确库存。 */
export function exactStockOrNull(product: Product): number | null {
  if (!requiresInventory(product) || displayMode(product) !== 'exact') return null
  const raw = product.availableStock ?? product.stock
  if (raw === undefined || raw === null) return null
  const stock = Number(raw)
  return Number.isFinite(stock) ? Math.max(0, Math.trunc(stock)) : null
}

/**
 * 前端数量上限只改善交互，后端事务仍是防超卖的最终边界。
 * 非精确模式绝不从其它字段猜测库存，只应用公开的每邮箱限购规则。
 */
export function storefrontQuantityLimit(product: Product): number {
  if (product.canPurchase === false || product.isOutOfStock) return 0
  const limit = purchaseLimit(product)
  if (!requiresInventory(product)) return limit ?? 99
  const exactStock = exactStockOrNull(product)
  if (exactStock === null) return limit ?? 99
  return limit === null ? exactStock : Math.min(exactStock, limit)
}

export function productStockLabel(product: Product): string {
  if (displayMode(product) === 'hidden') return ''
  if (!requiresInventory(product)) return '不限库存'
  if (displayMode(product) === 'availability_only') return product.isLowStock ? '库存紧张' : '有货'
  const stock = exactStockOrNull(product)
  return stock === null ? '' : `库存 ${stock}`
}

/** 低库存提示也必须经过展示策略，不能直接消费可能残留在前端对象中的 isLowStock。 */
export function productShowsLowStock(product: Product): boolean {
  return product.isLowStock === true && displayMode(product) !== 'hidden'
}

export function productIsSoldOut(product: Product): boolean {
  if (typeof product.canPurchase === 'boolean') return !product.canPurchase
  if (typeof product.isOutOfStock === 'boolean') return product.isOutOfStock
  const stock = exactStockOrNull(product)
  return requiresInventory(product) && stock !== null && stock <= 0
}
