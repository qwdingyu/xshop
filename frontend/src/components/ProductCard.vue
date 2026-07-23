<template>
  <div
    class="product-card"
    :class="{ 'out-of-stock': isSoldOut, 'is-compact': displayMode === 'compact' }"
    role="button"
    :tabindex="isSoldOut ? -1 : 0"
    :aria-disabled="isSoldOut"
    @click="handleClick"
    @keydown.enter="handleClick"
    @keydown.space.prevent="handleClick"
  >
    <!-- Cover image -->
    <div v-if="displayMode === 'catalog' || product.coverUrl" class="product-cover">
      <img
        v-if="product.coverUrl && !imageFailed"
        :src="product.coverUrl"
        :alt="product.title"
        loading="lazy"
        @error="imageFailed = true"
      />
      <div v-else class="cover-placeholder">
        <span>&#x1F4E6;</span>
      </div>
      <!-- Stock badge -->
      <span v-if="isSoldOut" class="stock-badge empty">已售罄</span>
      <span v-else-if="showsLowStock" class="stock-badge low">库存紧张</span>
      <!-- Discount badge -->
      <span v-if="(product.originalPriceCents ?? 0) > product.priceCents" class="stock-badge discount">
        折扣
      </span>
    </div>

    <!-- Info -->
    <div class="product-info">
      <h3 class="product-title">{{ product.title }}</h3>
      <div v-if="product.description" class="product-desc">{{ product.description }}</div>
      <div class="product-tags">
        <span class="product-tag">{{ fulfillmentLabel }}</span>
        <span class="product-tag">{{ deliveryTimingLabel }}</span>
        <span v-if="product.category" class="product-tag product-tag-muted">{{ product.category }}</span>
      </div>
      <div class="product-footer">
        <div class="product-price-block">
          <span class="product-price">{{ displayPrice }}</span>
          <span v-if="(product.originalPriceCents ?? 0) > product.priceCents" class="product-original-price">
            {{ originalPrice }}
          </span>
        </div>
        <div class="product-status-action">
          <span v-if="isSoldOut" class="product-stock out">已售罄</span>
          <span v-else-if="showsLowStock" class="product-stock low">{{ stockLabel }}</span>
          <span v-else-if="stockLabel" class="product-stock">{{ stockLabel }}</span>
          <span v-if="purchaseLimitLabel" class="product-stock limit">{{ purchaseLimitLabel }}</span>
          <span v-if="displayMode === 'compact' && !isSoldOut" class="compact-action">
            {{ product.priceCents === 0 ? '领取' : '购买' }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Product } from '@/types'
import { productIsSoldOut, productPurchaseLimitLabel, productShowsLowStock, productStockLabel } from '@/lib/storefront-stock'
import { formatPrice } from '@/composables/useFormat'

const props = withDefaults(defineProps<{
  product: Product
  displayMode?: 'catalog' | 'compact'
}>(), {
  displayMode: 'catalog',
})

const displayMode = computed(() => props.displayMode)

const imageFailed = ref(false)
watch(() => props.product.coverUrl, () => {
  imageFailed.value = false
})

const emit = defineEmits<{
  pay: [product: Product]
}>()

const displayPrice = computed(() => props.product.priceCents === 0
  ? '免费'
  : formatPrice(props.product.priceCents, props.product.currency))
const originalPrice = computed(() => formatPrice(props.product.originalPriceCents ?? 0, props.product.currency))

const fulfillmentLabel = computed(() => {
  const mode = props.product.fulfillmentMode
  const map: Record<string, string> = {
    card: '卡密交付',
    virtual: '资料直发',
    link: '链接交付',
    code: '兑换码',
    invite: '邀请码',
  }
  return map[mode || ''] || '虚拟商品'
})

const deliveryTimingLabel = computed(() => {
  return props.product.issueMode === 'manual' ? '付款后处理' : '通常自动发货'
})

const isSoldOut = computed(() => productIsSoldOut(props.product))
const stockLabel = computed(() => productStockLabel(props.product))
const purchaseLimitLabel = computed(() => productPurchaseLimitLabel(props.product))
const showsLowStock = computed(() => productShowsLowStock(props.product))

function handleClick() {
  if (isSoldOut.value) return
  emit('pay', props.product)
}
</script>

<style scoped>
.product-card {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: var(--r-lg);
  border: 0.5px solid var(--border);
  background: var(--tg-secondary-bg);
  cursor: pointer;
  transition: transform var(--duration-fast) var(--ease-out),
              box-shadow var(--duration-fast) var(--ease-out),
              border-color var(--duration-fast) var(--ease-out);
  opacity: 0;
  animation: fadeInUp var(--duration-slow) var(--ease-out) forwards;
}

.product-card:hover:not(.out-of-stock) {
  transform: translateY(-2px);
  box-shadow: var(--shadow-md);
  border-color: var(--border-strong);
}

.product-card:active:not(.out-of-stock) {
  transform: scale(0.97);
  transition-duration: 80ms;
}

.product-card.out-of-stock {
  cursor: default;
  opacity: 0.72;
  animation: fadeInUp var(--duration-slow) var(--ease-out) forwards;
}

.product-card.is-compact {
  min-height: 92px;
  flex-direction: row;
}

.product-card.is-compact .product-cover {
  width: 112px;
  flex: 0 0 112px;
  aspect-ratio: 4 / 3;
}

.product-card.is-compact .product-info {
  min-width: 0;
  flex: 1;
  justify-content: center;
  padding: 12px 14px;
}

.product-card.is-compact .product-title {
  font-size: 15px;
  -webkit-line-clamp: 1;
}

.product-card.is-compact .product-desc {
  -webkit-line-clamp: 1;
}

.product-cover {
  position: relative;
  width: 100%;
  aspect-ratio: 4 / 3;
  overflow: hidden;
  background: var(--surface);
}

.product-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.cover-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 28px;
  color: #b8c2d1;
}

.stock-badge {
  position: absolute;
  top: 6px;
  right: 6px;
  padding: 2px 6px;
  border-radius: var(--r-full);
  font-size: 10px;
  font-weight: 600;
  backdrop-filter: blur(8px);
}

.stock-badge.empty {
  background: rgba(239, 68, 68, 0.85);
  color: #fff;
}

.stock-badge.low {
  background: rgba(245, 158, 11, 0.85);
  color: #fff;
}

.stock-badge.discount {
  background: rgba(34, 197, 94, 0.85);
  color: #fff;
}

.product-info {
  padding: 8px 10px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.product-title {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  color: var(--tg-text);
}

.product-desc {
  font-size: 12px;
  color: #aab4c3;
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.product-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.product-tag {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: var(--r-full);
  font-size: 10px;
  line-height: 1.4;
  color: #8fc5ff;
  background: rgba(96, 165, 250, 0.16);
  border: 0.5px solid rgba(147, 197, 253, 0.28);
}

.product-tag-muted {
  color: #b8c2d1;
  background: rgba(255, 255, 255, 0.07);
  border-color: rgba(255, 255, 255, 0.12);
}

.product-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.product-status-action {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  min-width: 0;
}

.compact-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 48px;
  min-height: 28px;
  padding: 5px 10px;
  border-radius: var(--r-md);
  color: var(--tg-btn-text);
  background: var(--tg-btn);
  font-size: 12px;
  font-weight: 600;
}

@media (max-width: 520px) {
  .product-card.is-compact .product-cover {
    width: 88px;
    flex-basis: 88px;
  }

  .product-card.is-compact .product-tags .product-tag-muted {
    display: none;
  }
}

.product-price-block {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.product-price {
  font-size: 16px;
  font-weight: 700;
  color: #60a5fa;
  white-space: nowrap;
  text-shadow: 0 0 12px rgba(96, 165, 250, 0.18);
}

.product-original-price {
  font-size: 11px;
  color: #9aa4b2;
  text-decoration: line-through;
}

.product-stock {
  font-size: 12px;
  color: #b8c2d1;
  font-weight: 500;
}

.product-stock.out {
  color: #ff6b6b;
  font-weight: 600;
}

.product-stock.low {
  color: #fbbf24;
  font-weight: 600;
}
</style>
