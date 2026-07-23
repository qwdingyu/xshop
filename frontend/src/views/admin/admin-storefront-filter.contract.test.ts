import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const ordersSource = readFileSync(new URL('./AdminOrdersView.vue', import.meta.url), 'utf8')
const productsSource = readFileSync(new URL('./AdminProductsView.vue', import.meta.url), 'utf8')

describe('admin storefront filter contract', () => {
  it('keeps order attribution filters in the URL and both export requests', () => {
    expect(ordersSource).toContain("if (filter.orderSource) query.orderSource = filter.orderSource")
    expect(ordersSource).toContain("if (filter.storefrontId) query.storefrontId = filter.storefrontId")
    expect(ordersSource).toContain("void router.replace({ path: route.path, query })")
    expect(ordersSource.match(/orderSource: filter\.orderSource/g)).toHaveLength(2)
    expect(ordersSource.match(/storefrontId: filter\.storefrontId/g)).toHaveLength(2)
  })

  it('keeps the product storefront filter visible and restorable', () => {
    expect(productsSource).toContain("filter.storefrontId = String(route.query.storefrontId || '')")
    expect(productsSource).toContain("if (filter.storefrontId) query.storefrontId = filter.storefrontId")
    expect(productsSource).toContain("void router.replace({ path: route.path, query })")
  })
})
