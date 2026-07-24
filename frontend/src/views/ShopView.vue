<template>
  <div class="shop-view">
    <div class="shop-toolbar">
      <div class="shop-toolbar-main">
        <div class="shop-heading">
          <h1 class="section-title">商品</h1>
        </div>
        <div class="shop-toolbar-actions">
          <button v-if="showInlineRecharge" class="btn btn-primary btn-sm" @click="openRecharge">充值</button>
          <button class="btn btn-ghost btn-sm" @click="refresh" :disabled="loading">
            {{ loading ? '加载中…' : '刷新' }}
          </button>
        </div>
      </div>

      <div class="shop-controls">
        <div class="category-bar" aria-label="商品分类">
          <button
            class="cat-btn"
            :class="{ active: activeCategory === null }"
            @click="activeCategory = null"
          >
            全部
            <span class="cat-count">{{ products.length }}</span>
          </button>
          <button
            v-for="cat in categories"
            :key="cat.id"
            class="cat-btn"
            :class="{ active: activeCategory === cat.name }"
            @click="activeCategory = cat.name"
          >
            {{ cat.name }}
            <span class="cat-count">{{ cat.count }}</span>
          </button>
        </div>

        <div v-if="products.length > 5" class="search-row">
          <input
            v-model="searchQuery"
            type="search"
            placeholder="搜索商品名称…"
          />
        </div>
      </div>

      <div class="trust-strip">
        <span>卡密 / 链接 / 虚拟资料</span>
        <span>自动发货或付款后处理</span>
        <span>{{ storefrontSupportEmail || '下单后按订单联系售后' }}</span>
      </div>

      <div
        v-if="deeplinkOpening"
        class="deeplink-status"
        role="status"
        aria-live="polite"
      >
        正在打开商品…
      </div>
    </div>

    <!-- Skeleton loading：compact 为行骨架，catalog 为卡片骨架 -->
    <div
      v-if="loading"
      class="product-grid"
      :class="{ 'is-compact': storefrontTemplate === 'compact' }"
      aria-busy="true"
      aria-label="商品加载中"
    >
      <div
        v-for="i in skeletonCount"
        :key="i"
        class="skeleton-card"
        :class="{ 'is-compact': storefrontTemplate === 'compact' }"
      >
        <!-- compact 封面可选，加载期不假装有缩略图，只铺行骨架 -->
        <div v-if="storefrontTemplate === 'catalog'" class="skeleton skeleton-cover" />
        <div class="skeleton-body">
          <div class="skeleton skeleton-line w-70" />
          <div class="skeleton skeleton-line w-40" />
        </div>
      </div>
    </div>

    <!-- Error state -->
    <div v-else-if="error" class="empty-state" role="alert">
      <div class="empty-icon" aria-hidden="true">&#x26A0;</div>
      <p class="empty-text">{{ error }}</p>
      <button class="btn btn-primary empty-action" type="button" @click="refresh">重试</button>
    </div>

    <!-- Empty state：区分筛选无结果 vs 目录本身为空 -->
    <div v-else-if="filteredProducts.length === 0" class="empty-state">
      <div class="empty-icon" aria-hidden="true">&#x1F6D2;</div>
      <p class="empty-text">{{ emptyMessage }}</p>
      <button
        v-if="hasActiveFilters"
        class="btn btn-ghost empty-action"
        type="button"
        @click="clearFilters"
      >
        清除筛选
      </button>
    </div>

    <!-- Product grid -->
    <div
      v-else
      class="product-grid"
      :class="{ 'is-compact': storefrontTemplate === 'compact' }"
      role="list"
      :aria-label="storefrontTemplate === 'compact' ? '商品列表' : '商品目录'"
    >
      <ProductCard
        v-for="p in filteredProducts"
        :key="p.id"
        :product="p"
        :display-mode="storefrontTemplate"
        @pay="handleOpenProduct"
      />
    </div>

    <ProductConfirmSheet
      :visible="Boolean(confirmProduct)"
      :product="confirmProduct"
      :copying="copyingBuyLink"
      @close="closeProductConfirm"
      @buy="buyFromConfirm"
      @copy="copyBuyLinkFromConfirm"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ProductCard from '@/components/ProductCard.vue'
import ProductConfirmSheet from '@/components/ProductConfirmSheet.vue'
import { fetchProductCatalog, fetchProductDetail } from '@/api'
import { usePayment } from '@/composables/usePayment'
import { useShopConfig } from '@/composables/useShopConfig'
import { useToast } from '@/composables/useToast'
import { writeClipboardText } from '@/composables/useClipboard'
import {
  buildOpenCheckoutFromFetchedProduct,
  buildProductConfirmFromFetchedProduct,
  buildUserStorefrontBuyUrl,
  openCheckoutFailureMessage,
} from '@/lib/open-storefront-checkout'
import {
  classifyDeeplinkFetchFailure,
  parseProductDeeplinkQuery,
  productLinkKey,
  shouldScrubProductDeeplinkAfterAttempt,
  stripProductDeeplinkQuery,
  type DeeplinkScrubOutcome,
} from '@/lib/storefront-product-link'
import type { Product, ProductCategory } from '@/types'
import { useRecharge } from '@/composables/useRecharge'
import { useStorefrontContext } from '@/composables/useStorefrontContext'
import { usePlatform } from '@/composables/usePlatform'

const route = useRoute()
const router = useRouter()
const products = ref<Product[]>([])
const catalogCategories = ref<ProductCategory[]>([])
const loading = ref(true)
/** 卡片/深链打开互斥：同一时刻只允许一个打开意图 */
const openingProductId = ref('')
/** 深链打开进行中（目录可能已出，确认层尚未出现） */
const deeplinkOpening = ref(false)
/** 轻量商品确认层（支付前）；购买再进现有 PayModal */
const confirmProduct = ref<Product | null>(null)
const confirmHomePath = ref('')
const copyingBuyLink = ref(false)
const error = ref('')
const searchQuery = ref('')
const activeCategory = ref<string | null>(null)
const { supportEmail, balanceRechargeEnabled, loadShopConfig } = useShopConfig()
const { isTelegram, isMobile } = usePlatform()
const { storefront, setStorefront, clearStorefront } = useStorefrontContext()
const { openRecharge } = useRecharge()
const { open } = usePayment()
const { showToast } = useToast()
const storefrontSupportEmail = computed(() => storefront.value?.supportEmail || supportEmail.value)
const storefrontTemplate = computed(() => storefront.value?.templateKey || 'catalog')
const showInlineRecharge = computed(() => balanceRechargeEnabled.value && isTelegram.value && isMobile.value)
const requestedStorefrontSlug = computed(() => {
  const value = route.params.storefrontSlug
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
})
let catalogRequestSequence = 0
/** 深链打开序号：并发 loadData / query 变化时只允许最后一次打开，避免连环弹窗 */
let deeplinkRequestSequence = 0

const categories = computed(() => {
  if (catalogCategories.value.length > 0) return catalogCategories.value
  const fallbackCounts = new Map<string, number>()
  products.value.forEach(p => {
    if (p.category) {
      const existing = fallbackCounts.get(p.category)
      fallbackCounts.set(p.category, (existing || 0) + 1)
    }
  })
  return [...fallbackCounts.entries()].map(([name, count]) => ({ id: name, name, count }))
})

watch(categories, (nextCategories) => {
  if (activeCategory.value && !nextCategories.some(category => category.name === activeCategory.value)) {
    activeCategory.value = null
  }
})

const hasActiveFilters = computed(() => activeCategory.value !== null || Boolean(searchQuery.value.trim()))
const skeletonCount = computed(() => storefrontTemplate.value === 'compact' ? 5 : 6)

const filteredProducts = computed(() => {
  let result = products.value
  if (activeCategory.value !== null) {
    result = result.filter(p => p.category === activeCategory.value)
  }
  if (searchQuery.value.trim()) {
    const q = searchQuery.value.trim().toLowerCase()
    result = result.filter(p => p.title.toLowerCase().includes(q))
  }
  return result
})

const emptyMessage = computed(() => {
  if (products.value.length === 0) return '暂无商品'
  if (searchQuery.value.trim() && activeCategory.value) return '当前分类下没有匹配的商品'
  if (searchQuery.value.trim()) return '没有匹配的商品'
  if (activeCategory.value) return '该分类下暂无商品'
  return '暂无商品'
})

function clearFilters() {
  searchQuery.value = ''
  activeCategory.value = null
}

async function loadData() {
  const requestSequence = ++catalogRequestSequence
  const storefrontSlug = requestedStorefrontSlug.value
  const requestedRoutePath = route.path
  // 纠正 homePath 时必须保留推广 query（含 product），禁止丢参。
  const requestedQuery = { ...route.query }
  loading.value = true
  error.value = ''
  // 重载目录时关闭确认层，避免旧 SKU 与新渠道/目录错位
  closeProductConfirm()
  clearStorefront()
  try {
    const catalog = await fetchProductCatalog(storefrontSlug ? { storefront: storefrontSlug } : undefined)
    // 路由快速切换时，只有最后一次请求可以更新页面与品牌上下文。
    if (requestSequence !== catalogRequestSequence || route.path !== requestedRoutePath) return
    if (requestedRoutePath !== catalog.storefront.homePath) {
      await router.replace({
        path: catalog.storefront.homePath,
        query: requestedQuery,
        hash: route.hash,
      })
      return
    }
    setStorefront(catalog.storefront)
    products.value = catalog.products
    catalogCategories.value = catalog.categories
    // 目录就绪后尝试消费 ?product= 深链（失败不跳转其他渠道）。
    void tryOpenProductDeeplink(catalog.storefront.id, catalog.storefront.slug)
  } catch (err: unknown) {
    if (requestSequence !== catalogRequestSequence || route.path !== requestedRoutePath) return
    products.value = []
    catalogCategories.value = []
    error.value = err instanceof Error ? err.message : '加载商品失败'
  } finally {
    if (requestSequence === catalogRequestSequence) loading.value = false
  }
}

/** 去掉 URL 上的 product 参数，避免刷新重复自动开单；保留其余 query。 */
async function scrubProductDeeplinkQuery() {
  if (!parseProductDeeplinkQuery(route.query as Record<string, unknown>)) return
  const nextQuery = stripProductDeeplinkQuery(route.query as Record<string, unknown>)
  await router.replace({
    path: route.path,
    query: nextQuery as typeof route.query,
    hash: route.hash,
  })
}

/**
 * 渠道内单商品深链：渠道就绪后打开轻量确认层（不直开 PayModal）。
 * - 不跳转其他渠道
 * - 成功路径仅一次 fetchProductDetail → showProductConfirm
 * - 确认层打开 / 确认不可售后 scrub；忙锁、过期、瞬时失败保留 product
 */
async function tryOpenProductDeeplink(storefrontId: string, storefrontSlug: string) {
  const productKey = parseProductDeeplinkQuery(route.query as Record<string, unknown>)
  if (!productKey) return

  const requestSequence = ++deeplinkRequestSequence
  const openLockKey = `deeplink:${productKey}`
  deeplinkOpening.value = true

  let ownedAttempt = false
  let outcome: DeeplinkScrubOutcome = 'stale_or_left'

  try {
    if (openingProductId.value && openingProductId.value !== openLockKey) {
      outcome = 'busy_conflict'
      showToast('正在打开其他商品，请稍候再试', 'error')
      return
    }
    openingProductId.value = openLockKey
    ownedAttempt = true

    const latest = await fetchProductDetail(productKey, storefrontSlug)
    if (requestSequence !== deeplinkRequestSequence || storefront.value?.id !== storefrontId) {
      outcome = 'stale_or_left'
      return
    }
    upsertProduct(latest)
    const shown = showProductConfirm(latest, storefrontId)
    // 确认层打开即视为深链意图终态（可 scrub）；售罄仍可看确认层
    outcome = shown ? 'opened' : 'open_refused'
  } catch (err: unknown) {
    if (requestSequence !== deeplinkRequestSequence || storefront.value?.id !== storefrontId) {
      outcome = 'stale_or_left'
      return
    }
    const failureKind = classifyDeeplinkFetchFailure(err)
    outcome = failureKind
    const errMsg = err instanceof Error ? err.message : ''
    if (failureKind === 'unsellable') {
      showToast(errMsg || '商品在当前渠道不可售或已下架', 'error')
    } else {
      showToast(errMsg || '打开商品失败，请稍后重试', 'error')
    }
  } finally {
    if (openingProductId.value === openLockKey) {
      openingProductId.value = ''
    }
    if (requestSequence === deeplinkRequestSequence) {
      deeplinkOpening.value = false
    }
    const shouldScrub = shouldScrubProductDeeplinkAfterAttempt({
      ownedAttempt,
      isLatestSequence: requestSequence === deeplinkRequestSequence,
      stillOnExpectedStorefront: storefront.value?.id === storefrontId,
      outcome,
    })
    if (shouldScrub) {
      await scrubProductDeeplinkQuery()
    }
  }
}

async function refresh() {
  await Promise.all([loadData(), refreshShopConfig()])
}

async function refreshShopConfig() {
  try {
    await loadShopConfig(true)
  } catch {
    // The server remains the authority for payment and recharge switches.
  }
}

function refreshConfigWhenVisible() {
  if (document.visibilityState === 'visible') void refreshShopConfig()
}

function upsertProduct(nextProduct: Product) {
  const index = products.value.findIndex(product => product.id === nextProduct.id)
  if (index >= 0) {
    // 公开商品接口会按展示策略主动删除精确库存字段；必须整体替换响应，
    // 不能与旧对象合并，否则被后端裁剪的 stock/isLowStock 会残留在当前页面。
    products.value[index] = nextProduct
  } else {
    // 深链命中的 SKU 若尚未出现在当前筛选列表，仍并入目录缓存，避免弹窗与列表脱节。
    products.value = [...products.value, nextProduct]
  }
}

async function refreshAfterPaymentClose() {
  await loadData()
}

/**
 * 已拉取详情后的统一确认层入口（深链与卡片共用）。
 * 不发起网络请求；成功路径不直开 PayModal。
 */
function showProductConfirm(product: Product, expectedStorefrontId: string): boolean {
  const result = buildProductConfirmFromFetchedProduct(storefront.value, product, {
    expectedStorefrontId,
  })
  if (!result.ok) {
    showToast(openCheckoutFailureMessage(result.reason), 'error')
    return false
  }
  confirmProduct.value = result.product
  confirmHomePath.value = result.homePath
  return true
}

function closeProductConfirm() {
  confirmProduct.value = null
  confirmHomePath.value = ''
}

/** 确认层 → 现有 PayModal（不二次拉详情；售罄由 builder 拒绝） */
function buyFromConfirm() {
  const product = confirmProduct.value
  const activeStorefront = storefront.value
  if (!product || !activeStorefront) {
    showToast(openCheckoutFailureMessage('missing_storefront'), 'error')
    return
  }
  const result = buildOpenCheckoutFromFetchedProduct(activeStorefront, product, {
    expectedStorefrontId: activeStorefront.id,
  })
  if (!result.ok) {
    showToast(openCheckoutFailureMessage(result.reason), 'error')
    return
  }
  // 进入收银台后收起确认层，避免与 PayModal 双层叠态（Esc 误关底层等）
  closeProductConfirm()
  open(result.payProduct)
}

/** 确认层复制购买链：与 Admin 同契约 origin + homePath + ?product= */
async function copyBuyLinkFromConfirm() {
  const product = confirmProduct.value
  const homePath = confirmHomePath.value || storefront.value?.homePath || ''
  if (!product || !homePath) {
    showToast('当前渠道未就绪，请刷新后重试', 'error')
    return
  }
  if (copyingBuyLink.value) return
  copyingBuyLink.value = true
  try {
    const url = buildUserStorefrontBuyUrl({
      origin: window.location.origin,
      homePath,
      product: { id: product.id, slug: product.slug },
    })
    await writeClipboardText(url)
    showToast('购买链接已复制', 'success')
  } catch (err: unknown) {
    showToast(err instanceof Error ? err.message : '复制购买链接失败', 'error')
  } finally {
    copyingBuyLink.value = false
  }
}

/** 卡片点击：拉一次详情 → 确认层（不直开支付） */
async function handleOpenProduct(product: Product) {
  const activeStorefront = storefront.value
  if (!activeStorefront) {
    showToast(openCheckoutFailureMessage('missing_storefront'), 'error')
    return
  }
  if (openingProductId.value) {
    showToast('正在打开商品，请稍候', 'error')
    return
  }
  // 与深链/Admin 一致：优先 slug，回退 id
  const detailKey = productLinkKey(product) || product.id
  const openLockKey = `card:${product.id}`
  openingProductId.value = openLockKey
  try {
    const latest = await fetchProductDetail(detailKey, activeStorefront.slug)
    if (storefront.value?.id !== activeStorefront.id) {
      showToast(openCheckoutFailureMessage('channel_mismatch'), 'error')
      return
    }
    upsertProduct(latest)
    showProductConfirm(latest, activeStorefront.id)
  } catch (err: unknown) {
    showToast(err instanceof Error ? err.message : '打开商品失败，请稍后重试', 'error')
  } finally {
    if (openingProductId.value === openLockKey) {
      openingProductId.value = ''
    }
  }
}

onMounted(() => {
  window.addEventListener('payment:closed', refreshAfterPaymentClose)
  window.addEventListener('products:refresh', refreshAfterPaymentClose)
  document.addEventListener('visibilitychange', refreshConfigWhenVisible)
})

onUnmounted(() => {
  catalogRequestSequence += 1
  deeplinkRequestSequence += 1
  window.removeEventListener('payment:closed', refreshAfterPaymentClose)
  window.removeEventListener('products:refresh', refreshAfterPaymentClose)
  document.removeEventListener('visibilitychange', refreshConfigWhenVisible)
})

watch(requestedStorefrontSlug, () => {
  searchQuery.value = ''
  activeCategory.value = null
  products.value = []
  catalogCategories.value = []
  closeProductConfirm()
  void loadData()
}, { immediate: true })

// 已在渠道页时再次进入 ?product=（同会话二次点击推广链）也要打开；scrub 清空时 key 为 null 直接忽略。
watch(
  () => parseProductDeeplinkQuery(route.query as Record<string, unknown>),
  (productKey) => {
    if (!productKey || loading.value || !storefront.value) return
    void tryOpenProductDeeplink(storefront.value.id, storefront.value.slug)
  },
)
</script>

<style scoped>
.shop-view {
  width: 100%;
  max-width: 1280px;
  margin-inline: auto;
  padding-top: 6px;
  padding-bottom: 16px;
}

.shop-toolbar {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 10px;
}

.deeplink-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: var(--r-md);
  border: 0.5px solid var(--border);
  background: var(--surface);
  color: var(--tg-hint);
  font-size: 12px;
  line-height: 1.35;
}

.shop-toolbar-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.shop-heading {
  min-width: 0;
}

.shop-toolbar-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }

.shop-heading .section-title {
  color: var(--tg-text);
  font-size: var(--font-section-title);
  font-weight: 700;
  line-height: 1.2;
}

.product-grid.is-compact {
  grid-template-columns: minmax(0, 1fr);
  gap: 8px;
  max-width: 720px;
  margin-inline: auto;
}

.btn-sm {
  padding: 6px 12px;
  font-size: 13px;
}

.shop-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

/* Category filter */
.category-bar {
  display: flex;
  flex: 1 1 auto;
  gap: 6px;
  min-width: 0;
  overflow-x: auto;
  padding-bottom: 2px;
  scrollbar-width: none;
}

.category-bar::-webkit-scrollbar {
  display: none;
}

.trust-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  color: var(--tg-hint);
  font-size: 12px;
  line-height: 1.35;
}

.trust-strip span {
  display: inline-flex;
  align-items: center;
  min-width: 0;
}

.trust-strip span::before {
  content: '';
  width: 4px;
  height: 4px;
  margin-right: 6px;
  border-radius: var(--r-full);
  background: var(--tg-btn);
  opacity: 0.65;
}

.cat-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
  padding: 5px 11px;
  border: 0.5px solid var(--border);
  border-radius: var(--r-full);
  background: transparent;
  color: var(--tg-hint);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-out),
              border-color var(--duration-fast) var(--ease-out),
              background var(--duration-fast) var(--ease-out);
}

.cat-btn:hover {
  color: var(--tg-text);
  border-color: var(--border-strong);
  background: var(--surface);
}

.cat-btn:focus-visible {
  outline: 2px solid var(--tg-btn);
  outline-offset: 2px;
}

.cat-btn.active {
  background: var(--tg-btn);
  color: var(--tg-btn-text);
  border-color: var(--tg-btn);
}

.cat-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: var(--r-full);
  font-size: 11px;
  font-weight: 600;
  color: color-mix(in srgb, var(--tg-btn-text) 88%, transparent);
  background: color-mix(in srgb, var(--tg-text) 14%, transparent);
}

.cat-btn.active .cat-count {
  color: var(--tg-btn-text);
  background: color-mix(in srgb, var(--tg-btn-text) 24%, transparent);
}

/* Search */
.search-row {
  flex: 0 0 280px;
}

.search-row input {
  width: 100%;
  max-width: 100%;
}

@media (max-width: 720px) {
  .shop-controls {
    flex-direction: column;
    align-items: stretch;
  }

  .search-row {
    flex-basis: auto;
  }

  .trust-strip {
    gap: 2px 10px;
  }
}

/* Skeleton */
.skeleton-card {
  border-radius: var(--r-lg);
  overflow: hidden;
  background: var(--tg-secondary-bg);
  border: 0.5px solid var(--border);
}

.skeleton-card.is-compact {
  display: flex;
  flex-direction: row;
  align-items: center;
  min-height: 72px;
  max-width: 720px;
  margin-inline: auto;
}

.skeleton-cover {
  width: 100%;
  aspect-ratio: 4 / 3;
  border-radius: 0;
}

.skeleton-body {
  flex: 1;
  min-width: 0;
  padding: 14px 14px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 10px;
}

.skeleton-card:not(.is-compact) .skeleton-body {
  padding: 10px 12px 12px;
}

.skeleton-line {
  height: 12px;
  margin: 0;
}

.skeleton-line.w-70 { width: 70%; }
.skeleton-line.w-40 { width: 40%; }

/* Empty */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 56px 20px;
  color: var(--tg-hint);
  text-align: center;
}

.empty-icon {
  font-size: 44px;
  margin-bottom: 10px;
  opacity: 0.5;
  line-height: 1;
}

.empty-text {
  font-size: 15px;
  line-height: 1.45;
  max-width: 28em;
}

.empty-action {
  margin-top: 14px;
}
</style>
