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
    expect(headerSource).toContain('homePath: storefrontHomePath')
  })

  it('renders a controlled channel template without repeating the brand as the page heading', () => {
    expect(shopSource).not.toContain('<h1 class="section-title">{{ storefrontName }}</h1>')
    expect(shopSource).toContain('<h1 class="section-title">商品</h1>')
    expect(shopSource).toContain(':display-mode="storefrontTemplate"')
    expect(productCardSource).toContain("displayMode?: 'catalog' | 'compact'")
    expect(productCardSource).toContain("displayMode.value === 'catalog' || Boolean(props.product.coverUrl)")
    expect(productCardSource).toContain('cover-badges')
    expect(shopSource).toContain("class=\"product-grid\"")
    expect(shopSource).toContain("'is-compact': storefrontTemplate === 'compact'")
    expect(shopSource).toContain('clearFilters')
    expect(adminStorefrontSource).toContain('v-model="form.templateKey"')
  })

  it('keeps recharge as a separated global action and refresh as a shop-local action', () => {
    expect(headerSource).toContain('showHeaderRecharge')
    expect(headerSource).toContain('class="btn btn-primary header-recharge"')
    expect(shopSource).toContain('showInlineRecharge')
    expect(shopSource).toContain('{{ loading ? \'加载中…\' : \'刷新\' }}')
  })

  it('opens channel-scoped product deeplinks via the existing PayModal path only', () => {
    // 渠道内 ?product= 深链：单次详情 + openPayFromFetchedProduct，禁止另起收银台或跳转其他渠道。
    expect(shopSource).toContain('tryOpenProductDeeplink')
    expect(shopSource).toContain('parseProductDeeplinkQuery')
    expect(shopSource).toContain('scrubProductDeeplinkQuery')
    expect(shopSource).toContain('shouldScrubProductDeeplinkAfterAttempt')
    expect(shopSource).toContain('openPayFromFetchedProduct')
    expect(shopSource).toContain('buildOpenCheckoutFromFetchedProduct')
    expect(shopSource).toContain('fetchProductDetail(productKey, storefrontSlug)')
    expect(shopSource).toContain('openPayFromFetchedProduct(latest, storefrontId)')
    expect(shopSource).toContain('void tryOpenProductDeeplink(catalog.storefront.id, catalog.storefront.slug)')
    // 成功深链不得再委托 handlePay（否则二次详情请求）
    expect(shopSource).not.toContain('await handlePay(latest)')
    // homePath 纠正必须保留推广 query
    expect(shopSource).toContain('const requestedQuery = { ...route.query }')
    expect(shopSource).toContain('query: requestedQuery')
    // scrub 必须走决策层，禁止 finally 无条件 scrub（忙锁会吞推广链）
    expect(shopSource).toContain('if (shouldScrub)')
    expect(shopSource).toContain("outcome = 'busy_conflict'")
    expect(shopSource).toContain("opened ? 'opened' : 'open_refused'")
    expect(shopSource).toContain("outcome = 'unsellable'")
    // 失败文案：当前渠道不可售，不暗示改道
    expect(shopSource).toContain('商品在当前渠道不可售或已下架')
    expect(shopSource).toContain('正在打开商品…')
    expect(shopSource).toContain('正在打开其他商品，请稍候再试')
    expect(shopSource).not.toContain('router.push({ path: \'/p/')
    expect(shopSource).not.toContain('path: `/product/')
  })
})
