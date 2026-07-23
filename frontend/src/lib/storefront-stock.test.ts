import { describe, expect, it } from 'vitest'
import type { Product } from '@/types'
import { exactStockOrNull, productIsSoldOut, productPurchaseLimitLabel, productShowsLowStock, productStockLabel, storefrontQuantityLimit } from './storefront-stock'

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: 'product-1',
    title: 'Product',
    priceCents: 100,
    currency: 'CNY',
    fulfillmentMode: 'card',
    requiresInventory: true,
    canPurchase: true,
    stockDisplayMode: 'exact',
    stock: 5,
    availableStock: 5,
    ...overrides,
  }
}

describe('storefront stock policy', () => {
  it('uses the real stock only when exact visibility is enabled', () => {
    expect(exactStockOrNull(product())).toBe(5)
    expect(storefrontQuantityLimit(product())).toBe(5)
    expect(productStockLabel(product())).toBe('库存 5')
  })

  it('uses availability and purchase limit without reconstructing hidden stock', () => {
    const availabilityOnly = product({
      stockDisplayMode: 'availability_only',
      stock: undefined,
      availableStock: undefined,
      purchaseLimit: 3,
      isLowStock: true,
    })

    expect(exactStockOrNull(availabilityOnly)).toBeNull()
    expect(storefrontQuantityLimit(availabilityOnly)).toBe(3)
    expect(productStockLabel(availabilityOnly)).toBe('库存紧张')
  })

  it('separates purchase-limit display from the enforced quantity limit', () => {
    const hiddenLimit = product({ purchaseLimit: 2, purchaseLimitDisplay: false })
    const displayedLimit = product({ purchaseLimit: 2, purchaseLimitDisplay: true })

    expect(storefrontQuantityLimit(hiddenLimit)).toBe(2)
    expect(productPurchaseLimitLabel(hiddenLimit)).toBe('')
    expect(storefrontQuantityLimit(displayedLimit)).toBe(2)
    expect(productPurchaseLimitLabel(displayedLimit)).toBe('限购 2')
  })

  it('shows no inventory label in hidden mode while still blocking sold-out products', () => {
    const hidden = product({ stockDisplayMode: 'hidden', stock: undefined, availableStock: undefined })
    const soldOut = product({
      stockDisplayMode: 'hidden',
      stock: undefined,
      availableStock: undefined,
      canPurchase: false,
      isOutOfStock: true,
    })

    expect(productStockLabel(hidden)).toBe('')
    expect(productShowsLowStock({ ...hidden, isLowStock: true })).toBe(false)
    expect(productIsSoldOut(hidden)).toBe(false)
    expect(storefrontQuantityLimit(hidden)).toBe(99)
    expect(productIsSoldOut(soldOut)).toBe(true)
    expect(storefrontQuantityLimit(soldOut)).toBe(0)
  })

  it('shows the low-stock badge only when the public display policy allows it', () => {
    expect(productShowsLowStock(product({ stockDisplayMode: 'availability_only', isLowStock: true }))).toBe(true)
    expect(productShowsLowStock(product({ stockDisplayMode: 'availability_only', isLowStock: false }))).toBe(false)
    expect(productShowsLowStock(product({ stockDisplayMode: 'exact', stock: 2, availableStock: 2, isLowStock: true }))).toBe(true)
  })

  it('hides the unlimited-stock label for hidden non-inventory products', () => {
    const hiddenVirtual = product({
      fulfillmentMode: 'virtual',
      requiresInventory: false,
      stockDisplayMode: 'hidden',
      stock: 0,
      availableStock: 0,
    })

    expect(productStockLabel(hiddenVirtual)).toBe('')
    expect(productIsSoldOut(hiddenVirtual)).toBe(false)
  })
})
