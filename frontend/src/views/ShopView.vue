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
        @pay="handlePay"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ProductCard from '@/components/ProductCard.vue'
import { fetchProductCatalog, fetchProductDetail } from '@/api'
import { usePayment } from '@/composables/usePayment'
import { useShopConfig } from '@/composables/useShopConfig'
import { useToast } from '@/composables/useToast'
import { productIsSoldOut } from '@/lib/storefront-stock'
import type { Product, ProductCategory } from '@/types'
import { useRecharge } from '@/composables/useRecharge'
import { useStorefrontContext } from '@/composables/useStorefrontContext'
import { usePlatform } from '@/composables/usePlatform'

const route = useRoute()
const router = useRouter()
const products = ref<Product[]>([])
const catalogCategories = ref<ProductCategory[]>([])
const loading = ref(true)
const refreshingStockId = ref('')
const error = ref('')
const searchQuery = ref('')
const activeCategory = ref<string | null>(null)
const { supportEmail, balanceRechargeEnabled, loadShopConfig } = useShopConfig()
const { isTelegram, isMobile } = usePlatform()
const { storefront, setStorefront, clearStorefront } = useStorefrontContext()
const { openRecharge } = useRecharge()
const storefrontSupportEmail = computed(() => storefront.value?.supportEmail || supportEmail.value)
const storefrontTemplate = computed(() => storefront.value?.templateKey || 'catalog')
const showInlineRecharge = computed(() => balanceRechargeEnabled.value && isTelegram.value && isMobile.value)
const requestedStorefrontSlug = computed(() => {
  const value = route.params.storefrontSlug
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
})
let catalogRequestSequence = 0

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
  loading.value = true
  error.value = ''
  clearStorefront()
  try {
    const catalog = await fetchProductCatalog(storefrontSlug ? { storefront: storefrontSlug } : undefined)
    // 路由快速切换时，只有最后一次请求可以更新页面与品牌上下文。
    if (requestSequence !== catalogRequestSequence || route.path !== requestedRoutePath) return
    if (requestedRoutePath !== catalog.storefront.homePath) {
      await router.replace({
        path: catalog.storefront.homePath,
        query: route.query,
        hash: route.hash,
      })
      return
    }
    setStorefront(catalog.storefront)
    products.value = catalog.products
    catalogCategories.value = catalog.categories
  } catch (err: any) {
    if (requestSequence !== catalogRequestSequence || route.path !== requestedRoutePath) return
    products.value = []
    catalogCategories.value = []
    error.value = err.message || '加载商品失败'
  } finally {
    if (requestSequence === catalogRequestSequence) loading.value = false
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

const { open } = usePayment()
const { showToast } = useToast()

function upsertProduct(nextProduct: Product) {
  const index = products.value.findIndex(product => product.id === nextProduct.id)
  if (index >= 0) {
    // 公开商品接口会按展示策略主动删除精确库存字段；必须整体替换响应，
    // 不能与旧对象合并，否则被后端裁剪的 stock/isLowStock 会残留在当前页面。
    products.value[index] = nextProduct
  }
}

async function refreshAfterPaymentClose() {
  await loadData()
}

async function handlePay(product: Product) {
  const activeStorefront = storefront.value
  if (refreshingStockId.value || !activeStorefront) return
  refreshingStockId.value = product.id
  let latest = product
  try {
    latest = await fetchProductDetail(product.id, activeStorefront.slug)
    if (storefront.value?.id !== activeStorefront.id) {
      refreshingStockId.value = ''
      return
    }
    upsertProduct(latest)
  } catch (err: any) {
    showToast(err.message || '刷新库存失败，请稍后重试', 'error')
    refreshingStockId.value = ''
    return
  }

  // 非精确库存模式不会返回 stock 字段，只能消费后端给出的可售状态，不能把“未公开”解释成 0。
  if (productIsSoldOut(latest)) {
    showToast('该商品已售罄', 'error')
    refreshingStockId.value = ''
    return
  }
  open({
    storefrontId: activeStorefront.id,
    storefrontSlug: activeStorefront.slug,
    id: latest.id,
    title: latest.name || latest.title,
    priceCents: latest.priceCents,
    currency: latest.currency,
    coverUrl: latest.coverUrl,
    name: latest.name,
    originalPriceCents: latest.originalPriceCents,
    stock: latest.stock,
    availableStock: latest.availableStock,
    requiresInventory: latest.requiresInventory,
    canPurchase: latest.canPurchase,
    isOutOfStock: latest.isOutOfStock,
    isLowStock: latest.isLowStock,
    description: latest.description,
    salesCopy: latest.salesCopy,
    tagsJson: latest.tagsJson,
    issueMode: latest.issueMode,
    category: latest.category,
    purchaseLimit: latest.purchaseLimit,
    sortOrder: latest.sortOrder,
    active: latest.active,
    fulfillmentMode: latest.fulfillmentMode,
    deliveryVisibility: latest.deliveryVisibility,
    stockDisplayMode: latest.stockDisplayMode,
    fulfillmentInputType: latest.fulfillmentInputType,
    fulfillmentInputLabel: latest.fulfillmentInputLabel,
    fulfillmentInputHint: latest.fulfillmentInputHint,
    fulfillmentInputRequired: latest.fulfillmentInputRequired,
  })
  refreshingStockId.value = ''
}

onMounted(() => {
  window.addEventListener('payment:closed', refreshAfterPaymentClose)
  window.addEventListener('products:refresh', refreshAfterPaymentClose)
  document.addEventListener('visibilitychange', refreshConfigWhenVisible)
})

onUnmounted(() => {
  catalogRequestSequence += 1
  window.removeEventListener('payment:closed', refreshAfterPaymentClose)
  window.removeEventListener('products:refresh', refreshAfterPaymentClose)
  document.removeEventListener('visibilitychange', refreshConfigWhenVisible)
})

watch(requestedStorefrontSlug, () => {
  searchQuery.value = ''
  activeCategory.value = null
  products.value = []
  catalogCategories.value = []
  void loadData()
}, { immediate: true })
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
