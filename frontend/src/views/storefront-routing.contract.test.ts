import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const routerSource = readFileSync(new URL('../router/index.ts', import.meta.url), 'utf8')
const shopSource = readFileSync(new URL('./ShopView.vue', import.meta.url), 'utf8')
const appSource = readFileSync(new URL('../App.vue', import.meta.url), 'utf8')
const headerSource = readFileSync(new URL('../components/HeaderBar.vue', import.meta.url), 'utf8')
const productCardSource = readFileSync(new URL('../components/ProductCard.vue', import.meta.url), 'utf8')
const adminStorefrontSource = readFileSync(new URL('./admin/AdminStorefrontsView.vue', import.meta.url), 'utf8')

describe('storefront routing contract', () => {
  it('reuses ShopView for named storefront URLs', () => {
    expect(routerSource).toContain("path: '/s/:storefrontSlug'")
    expect(routerSource.match(/import\('@\/views\/ShopView\.vue'\)/g)).toHaveLength(2)
  })

  it('guards route changes and redirects to the backend canonical homePath', () => {
    expect(shopSource).toContain('const requestSequence = ++catalogRequestSequence')
    expect(shopSource).toContain('requestSequence !== catalogRequestSequence || route.path !== requestedRoutePath')
    expect(shopSource).toContain('path: catalog.storefront.homePath')
    expect(shopSource).toContain("fetchProductCatalog(storefrontSlug ? { storefront: storefrontSlug } : undefined)")
  })

  it('keeps branding and product navigation inside the active storefront', () => {
    expect(headerSource.match(/:to="homePath"/g)?.length).toBeGreaterThanOrEqual(4)
    expect(appSource).toContain('if (!active) clearStorefront()')
    expect(appSource).toContain('document.title = active ? brandName : shopName.value')
    expect(headerSource).toContain("'is-telegram': isTelegram.value")
    expect(headerSource).toContain("'is-mobile': isMobile.value")
  })

  it('renders a controlled channel template without repeating the brand as the page heading', () => {
    expect(shopSource).not.toContain('<h1 class="section-title">{{ storefrontName }}</h1>')
    expect(shopSource).toContain('<h1 class="section-title">商品</h1>')
    expect(shopSource).toContain(':display-mode="storefrontTemplate"')
    expect(productCardSource).toContain("displayMode?: 'catalog' | 'compact'")
    expect(adminStorefrontSource).toContain('v-model="form.templateKey"')
  })

  it('keeps recharge as a separated global action and refresh as a shop-local action', () => {
    expect(headerSource).toContain('showHeaderRecharge')
    expect(headerSource).toContain('class="btn btn-primary header-recharge"')
    expect(shopSource).toContain('showInlineRecharge')
    expect(shopSource).toContain('{{ loading ? \'加载中…\' : \'刷新\' }}')
  })
})
