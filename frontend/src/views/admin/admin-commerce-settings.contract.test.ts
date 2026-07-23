import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const paymentSource = readFileSync(new URL('./AdminPaymentView.vue', import.meta.url), 'utf8')
const productsSource = readFileSync(new URL('./AdminProductsView.vue', import.meta.url), 'utf8')
const storefrontsSource = readFileSync(new URL('./AdminStorefrontsView.vue', import.meta.url), 'utf8')
const productCardSource = readFileSync(new URL('../../components/ProductCard.vue', import.meta.url), 'utf8')
const mainSource = readFileSync(new URL('../../main.ts', import.meta.url), 'utf8')

describe('admin commerce settings contract', () => {
  it('shows the enabled state returned by payment config saves instead of a stale fixed message', () => {
    expect(paymentSource).toContain('const result = await updateAdminPaymentConfig')
    expect(paymentSource).toContain("showToast(result.message, 'success')")
    expect(paymentSource).not.toContain('已保存，验证无误后请手动启用')
  })

  it('keeps product cover URL editing, preview, persistence, and storefront fallback connected', () => {
    expect(productsSource).toContain('v-model.trim="form.coverUrl"')
    expect(productsSource).toContain('coverUrl: form.coverUrl')
    expect(productsSource).toContain('@error="coverPreviewFailed = true"')
    expect(productCardSource).toContain("@error=\"imageFailed = true\"")
    expect(productsSource).toContain('await uploadAdminMediaImage(token.value, file)')
    expect(productsSource).toContain('form.coverUrl = result.url')
    expect(storefrontsSource).toContain('await uploadAdminMediaImage(token.value, file)')
    expect(storefrontsSource).toContain('form.logoUrl = result.url')
  })

  it('exposes product selection for every storefront and guards an empty default shop', () => {
    expect(storefrontsSource).toContain('选择商品（{{ item.productCount }}）')
    expect(storefrontsSource).toContain('currentStorefront.value.isDefault && visibleProducts.length === 0')
    expect(storefrontsSource).toContain('默认 /shop 将没有可见商品')
  })

  it('shows the stable template key beside its operator-facing label', () => {
    expect(storefrontsSource).toContain('catalog · 图片卡片模板')
    expect(storefrontsSource).toContain('compact · 紧凑列表模板')
  })

  it('copies user-facing buy links only for a visible channel mapping', () => {
    expect(productsSource).toContain('copyProductBuyLink')
    expect(productsSource).toContain('resolveAdminBuyLink')
    expect(productsSource).toContain('adminBuyLinkFailureMessage')
    expect(storefrontsSource).toContain('copyProductBuyLink')
    expect(storefrontsSource).toContain('resolveAdminBuyLink')
    expect(storefrontsSource).toContain('仅可为已选且可见的商品复制购买链接')
    // 禁止静默拼到无渠道 path
    expect(productsSource).not.toContain("'/product/'")
    expect(storefrontsSource).not.toContain("'/product/'")
  })

  it('recovers once when a deployed lazy chunk is missing from an already-open page', () => {
    expect(mainSource).toContain("window.addEventListener('vite:preloadError'")
    expect(mainSource).toContain('router.onError')
    expect(mainSource).toContain('window.location.replace(recoveryUrl)')
  })
})
