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

  it('defaults free-product purchase limit guidance to one claim per mailbox', () => {
    expect(productsSource).toContain("isFreeProductPrice ? '免费商品默认 1，可改大'")
    expect(productsSource).toContain('免费商品未填写时保存与后端均按每邮箱 1 次限购')
    expect(productsSource).toContain("if (parseMajorToMinor(form.priceMajor, form.currency) === 0) return 1")
    // 新建表单不得写死 purchaseLimit: '1'，否则改成付费价也会误带每人限 1
    expect(productsSource).toMatch(/purchaseLimit:\s*''/)
    expect(productsSource).toContain('付费商品留空表示不限购')
  })

  it('uses an on-row shelf switch instead of a sort jump in product ops', () => {
    expect(productsSource).toContain('toggleProductActive')
    expect(productsSource).toContain('status-switch')
    expect(productsSource).toContain("updateAdminProduct(token.value, item.id, { active: nextActive })")
    expect(productsSource).not.toContain('goStorefrontSort')
    expect(productsSource).not.toContain('>排序</button>')
    // 渠道排序仍保留在展示渠道列的行内编辑，不从操作列跳转
    expect(productsSource).toContain('saveCurrentStorefrontSort')
    expect(productsSource).toContain('当前渠道排序')
  })

  it('copies user-facing buy links only for a visible channel mapping', () => {
    expect(productsSource).toContain('copyProductBuyLink')
    expect(productsSource).toContain('resolveAdminBuyLink')
    expect(productsSource).toContain('adminBuyLinkFailureMessage')
    // 下架商品在商品列表直接禁用复制，避免无效点击
    expect(productsSource).toContain('item.active === false')
    expect(storefrontsSource).toContain('copyProductBuyLink')
    expect(storefrontsSource).toContain('resolveAdminBuyLink')
    // 渠道映射：只允许已落库且未 dirty 的可见映射，禁止草稿死链
    expect(storefrontsSource).toContain('canCopyPersistedStorefrontBuyLink')
    expect(storefrontsSource).toContain('mappingBuyLinkGateMessage')
    expect(storefrontsSource).toContain('canCopyBuyLink')
    expect(storefrontsSource).toContain('persisted:')
    expect(storefrontsSource).toContain('mappingBuyLinkGateMessage(gate.reason)')
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
