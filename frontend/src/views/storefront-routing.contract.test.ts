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

  it('allows sold-out catalog cards to open the confirm sheet for view/copy', () => {
    // 售罄卡仍可点开确认层（与深链一致）；购买由确认层/checkout builder 拒绝
    expect(productCardSource).not.toMatch(/if \(isSoldOut\.value\) return/)
    expect(productCardSource).toContain("emit('pay', props.product)")
    expect(productCardSource).toContain('售罄仍可打开支付前确认层')
    expect(productCardSource).toContain("isSoldOut ? '查看'")
  })

  it('opens channel-scoped product deeplinks via confirm-first then existing PayModal', () => {
    // 渠道内 ?product=：单次详情 → 轻量确认层；购买再进现有 PayModal（禁止另起收银台/全局商品路由）。
    expect(shopSource).toContain('tryOpenProductDeeplink')
    expect(shopSource).toContain('parseProductDeeplinkQuery')
    expect(shopSource).toContain('scrubProductDeeplinkQuery')
    expect(shopSource).toContain('shouldScrubProductDeeplinkAfterAttempt')
    expect(shopSource).toContain('classifyDeeplinkFetchFailure')
    expect(shopSource).toContain('ProductConfirmSheet')
    expect(shopSource).toContain('showProductConfirm')
    expect(shopSource).toContain('buildProductConfirmFromFetchedProduct')
    expect(shopSource).toContain('buildOpenCheckoutFromFetchedProduct')
    expect(shopSource).toContain('buildUserStorefrontBuyUrl')
    expect(shopSource).toContain('productLinkKey')
    expect(shopSource).toContain('fetchProductDetail(productKey, storefrontSlug)')
    expect(shopSource).toContain('fetchProductDetail(detailKey, activeStorefront.slug)')
    expect(shopSource).toContain('showProductConfirm(latest, storefrontId)')
    expect(shopSource).toContain('void tryOpenProductDeeplink(catalog.storefront.id, catalog.storefront.slug)')
    // 重载目录关闭确认层，避免旧 SKU 错位
    expect(shopSource).toContain('closeProductConfirm()')
    // 成功路径：确认层打开；购买仅从确认层进 PayModal，不二次拉详情；
    // 先 open 再 nextTick 再关确认层，保证共享 body 锁 handoff 不断锁
    expect(shopSource).toContain('async function buyFromConfirm')
    expect(shopSource).toContain('open(result.payProduct)')
    expect(shopSource).toContain('await nextTick()')
    expect(shopSource).toContain('closeProductConfirm()')
    expect(shopSource).not.toContain('await handlePay(latest)')
    // 关收银台 / 库存刷新走静默目录拉取，禁止骨架闪底层
    expect(shopSource).toContain("loadData({ silent: true })")
    expect(shopSource).toContain('refreshCatalogSilently')
    // 卡片与深链均先确认，禁止 happy path 直开支付
    expect(shopSource).toContain('handleOpenProduct')
    expect(shopSource).toContain('@pay="handleOpenProduct"')
    // homePath 纠正必须保留推广 query
    expect(shopSource).toContain('const requestedQuery = { ...route.query }')
    expect(shopSource).toContain('query: requestedQuery')
    // scrub 必须走决策层；catch 必须 classify
    expect(shopSource).toContain('if (shouldScrub)')
    expect(shopSource).toContain("outcome = 'busy_conflict'")
    expect(shopSource).toContain("shown ? 'opened' : 'open_refused'")
    expect(shopSource).toContain('const failureKind = classifyDeeplinkFetchFailure(err)')
    expect(shopSource).toContain('outcome = failureKind')
    expect(shopSource).not.toContain("outcome = 'unsellable'")
    expect(shopSource).toContain('商品在当前渠道不可售或已下架')
    expect(shopSource).toContain('打开商品失败，请稍后重试')
    expect(shopSource).toContain('正在打开商品…')
    expect(shopSource).toContain('正在打开其他商品，请稍候再试')
    expect(shopSource).toContain('购买链接已复制')
    expect(shopSource).not.toContain('router.push({ path: \'/p/')
    expect(shopSource).not.toContain('path: `/product/')
  })
})

describe('product confirm sheet contract', () => {
  const confirmSource = readFileSync(new URL('../components/ProductConfirmSheet.vue', import.meta.url), 'utf8')

  it('never surfaces delivery-only salesCopy and only uses public description', () => {
    // salesCopy 为交付内容，店面 API 剥离；确认层正文只用 description
    expect(confirmSource).not.toMatch(/p\.salesCopy/)
    expect(confirmSource).not.toMatch(/salesCopy ===/)
    expect(confirmSource).toContain('p.description')
    expect(confirmSource).toContain('salesCopy 为交付内容')
    expect(confirmSource).toContain('展开全部')
  })

  it('surfaces list discount via shared price display (compare-at)', () => {
    expect(confirmSource).toContain("from '@/lib/product-price-display'")
    expect(confirmSource).toContain('buildListPriceDisplay')
    expect(confirmSource).toContain('confirm-save')
  })

  it('locks body scroll and traps focus while open', () => {
    // 与 PayModal 共用 body-scroll-lock（引用计数 + 滚动条补偿）
    expect(confirmSource).toContain("from '@/lib/body-scroll-lock'")
    expect(confirmSource).toContain('acquireBodyScrollLock')
    expect(confirmSource).toContain("event.key === 'Escape'")
    expect(confirmSource).toContain("event.key !== 'Tab'")
    expect(confirmSource).toContain('buyBtnEl')
  })
})

describe('pay modal checkout chrome contract', () => {
  const paySource = readFileSync(new URL('../components/PayModal.vue', import.meta.url), 'utf8')

  it('exposes semantic checkout steps without changing the payment state machine', () => {
    expect(paySource).toContain("checkoutStepLabels = ['填写', '支付', '完成']")
    expect(paySource).toContain("step === 'form'")
    expect(paySource).toContain("step === 'online'")
    expect(paySource).toContain("step === 'offline'")
    expect(paySource).toContain("step === 'result'")
    expect(paySource).toContain('class="order-fields"')
    expect(paySource).toContain('填写信息后选择支付方式')
  })

  it('keeps title-then-subtitle hierarchy, aria-current, topbar close, scroll lock and Esc', () => {
    expect(paySource).toContain('class="pay-topbar"')
    expect(paySource).toContain(":aria-current=\"currentStepDot === index ? 'step' : undefined\"")
    expect(paySource).toContain("from '@/lib/body-scroll-lock'")
    expect(paySource).toContain('acquireBodyScrollLock')
    expect(paySource).toContain("event.key !== 'Escape'")
    // 各 step-header 均为 title 在前、subtitle 在后（禁止副标题压在主标题上）
    const headers = [...paySource.matchAll(/<div class="step-header">([\s\S]*?)<\/div>/g)].map((m) => m[1])
    expect(headers.length).toBeGreaterThanOrEqual(4)
    for (const block of headers) {
      const titleAt = block.indexOf('step-title')
      const subtitleAt = block.indexOf('step-subtitle')
      expect(titleAt).toBeGreaterThanOrEqual(0)
      expect(subtitleAt).toBeGreaterThan(titleAt)
    }
  })
})
