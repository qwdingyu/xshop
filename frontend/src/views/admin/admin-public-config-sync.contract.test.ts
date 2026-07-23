import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const paymentSource = readFileSync(new URL('./AdminPaymentView.vue', import.meta.url), 'utf8')
const systemConfigSource = readFileSync(new URL('./AdminSystemConfigView.vue', import.meta.url), 'utf8')
const shopSource = readFileSync(new URL('../ShopView.vue', import.meta.url), 'utf8')

describe('public configuration synchronization contract', () => {
  it('refreshes shared storefront configuration from every admin mutation surface', () => {
    expect(paymentSource).toContain("import { useShopConfig } from '@/composables/useShopConfig'")
    expect(paymentSource).toContain('loadShopConfig(true)')
    expect(systemConfigSource).toContain('loadShopConfig(true)')
  })

  it('refreshes storefront configuration when an existing shop tab becomes visible again', () => {
    expect(shopSource).toContain("document.addEventListener('visibilitychange'")
    expect(shopSource).toContain('loadShopConfig(true)')
  })
})
