<template>
  <div
    class="product-card"
    :class="{ 'out-of-stock': isSoldOut, 'is-compact': displayMode === 'compact' }"
    role="button"
    tabindex="0"
    :aria-label="isSoldOut ? `${product.title}，已售罄，查看详情` : undefined"
    @click="handleClick"
    @keydown.enter="handleClick"
    @keydown.space.prevent="handleClick"
  >
    <!-- Cover：catalog 始终占位；compact 仅在有图时显示缩略图 -->
    <div v-if="showCover" class="product-cover">
      <img
        v-if="product.coverUrl && !imageFailed"
        :src="product.coverUrl"
        :alt="product.title"
        loading="lazy"
        decoding="async"
        @error="imageFailed = true"
      />
      <div v-else class="cover-placeholder" aria-hidden="true">
        <span>&#x1F4E6;</span>
      </div>
      <!-- 角标叠放：库存/售罄优先左上，折扣右上，避免重叠 -->
      <div class="cover-badges" aria-hidden="true">
        <span v-if="isSoldOut" class="stock-badge empty">已售罄</span>
        <span v-else-if="showsLowStock" class="stock-badge low">库存紧张</span>
        <span v-if="priceDisplay.hasDiscount && priceDisplay.badgeLabel" class="stock-badge discount">
          {{ priceDisplay.badgeLabel }}
        </span>
      </div>
    </div>

    <!-- Info -->
    <div class="product-info">
      <div class="product-title-row">
        <h3 class="product-title">{{ product.title }}</h3>
        <!-- compact 无封面时封面角标不可见：标题旁补促销标 -->
        <span
          v-if="displayMode === 'compact' && !showCover && priceDisplay.hasDiscount && priceDisplay.badgeLabel"
          class="inline-discount-badge"
        >{{ priceDisplay.badgeLabel }}</span>
      </div>
      <!-- 空描述不占位；过长由 line-clamp 截断，完整说明在支付前确认层 -->
      <div v-if="cardDescription" class="product-desc">{{ cardDescription }}</div>
      <div class="product-tags">
        <span class="product-tag">{{ fulfillmentLabel }}</span>
        <span class="product-tag">{{ deliveryTimingLabel }}</span>
        <span v-if="product.category" class="product-tag product-tag-muted">{{ product.category }}</span>
      </div>
      <div class="product-footer">
        <div
          class="product-price-block"
          :class="{ 'has-promo': priceDisplay.hasDiscount }"
          :aria-label="priceDisplay.hasDiscount
            ? `现价 ${priceDisplay.priceLabel}，原价 ${priceDisplay.originalLabel}`
            : undefined"
        >
          <div class="product-price-main">
            <span
              class="product-price"
              :class="{ 'is-free': product.priceCents === 0, 'is-sale': priceDisplay.hasDiscount && product.priceCents > 0 }"
            >{{ priceDisplay.priceLabel }}</span>
            <span v-if="priceDisplay.hasDiscount" class="product-original-price">
              {{ priceDisplay.originalLabel }}
            </span>
          </div>
          <span v-if="priceDisplay.hasDiscount && priceDisplay.saveLabel" class="product-save-chip">
            {{ priceDisplay.saveLabel }}
          </span>
        </div>
        <div class="product-status-action">
          <!-- compact 行内：售罄文案即可；catalog 封面已有角标，脚部只保留库存/限购 -->
          <span v-if="isSoldOut && displayMode === 'compact'" class="product-stock out">已售罄</span>
          <span v-else-if="!isSoldOut && showsLowStock" class="product-stock low">{{ stockLabel }}</span>
          <span v-else-if="!isSoldOut && stockLabel" class="product-stock">{{ stockLabel }}</span>
          <span v-if="purchaseLimitLabel" class="product-stock limit">{{ purchaseLimitLabel }}</span>
          <span v-if="displayMode === 'compact'" class="compact-action" :class="{ muted: isSoldOut }">
            {{ isSoldOut ? '查看' : (product.priceCents === 0 ? '领取' : '购买') }}
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
import { buildListPriceDisplay } from '@/lib/product-price-display'

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

/** catalog 始终展示封面区；compact 仅有 coverUrl 时展示缩略图 */
const showCover = computed(() => displayMode.value === 'catalog' || Boolean(props.product.coverUrl))

/** 货架促销：现价 + 划线原价 + 角标（规则见 shared product-contract） */
const priceDisplay = computed(() => buildListPriceDisplay(
  props.product.priceCents,
  props.product.currency,
  props.product.originalPriceCents,
))

/** 卡片仅展示公开短描述；空白不占行高 */
const cardDescription = computed(() => {
  const raw = typeof props.product.description === 'string' ? props.product.description.trim() : ''
  return raw || ''
})

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

/** 售罄仍可打开支付前确认层（查看/复制链接）；购买由确认层与 checkout builder 拒绝 */
function handleClick() {
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
  animation: productCardEnter var(--duration-slow) var(--ease-out) both;
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

.product-card:focus-visible {
  outline: 2px solid var(--tg-btn);
  outline-offset: 2px;
}

/* 售罄：仍可点击打开确认层（查看/复制）；仅视觉降透明 */
.product-card.out-of-stock {
  cursor: pointer;
}

.product-card.out-of-stock .product-cover,
.product-card.out-of-stock .product-info {
  opacity: 0.72;
}

@keyframes productCardEnter {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .product-card {
    animation: none;
  }
}

/* compact：横排列表，宽屏限制最大阅读宽度，避免一行拉满 1280px */
.product-card.is-compact {
  min-height: 88px;
  flex-direction: row;
  width: 100%;
  max-width: 720px;
  margin-inline: auto;
}

.product-card.is-compact .product-cover {
  width: 96px;
  flex: 0 0 96px;
  aspect-ratio: 1;
  align-self: stretch;
  min-height: 88px;
}

.product-card.is-compact .product-info {
  min-width: 0;
  flex: 1;
  justify-content: center;
  padding: 10px 12px;
  gap: 4px;
}

.product-card.is-compact .product-title {
  font-size: 15px;
  -webkit-line-clamp: 1;
}

.product-card.is-compact .product-desc {
  -webkit-line-clamp: 1;
  font-size: 12px;
}

.product-card.is-compact .product-footer {
  margin-top: 2px;
}

.product-card.is-compact .product-price {
  font-size: 15px;
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
  color: var(--tg-hint);
  opacity: 0.55;
}

/* 角标容器：左右分列，避免「库存紧张 + 折扣」叠在同一角 */
.cover-badges {
  position: absolute;
  inset: 6px;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 4px;
  pointer-events: none;
}

.cover-badges .stock-badge.discount {
  margin-left: auto;
}

.stock-badge {
  padding: 2px 6px;
  border-radius: var(--r-full);
  font-size: 10px;
  font-weight: 600;
  line-height: 1.3;
  backdrop-filter: blur(8px);
  white-space: nowrap;
}

.stock-badge.empty {
  background: color-mix(in srgb, var(--tg-destructive) 88%, transparent);
  color: #fff;
}

.stock-badge.low {
  background: color-mix(in srgb, var(--admin-warning, #fbbf24) 90%, transparent);
  color: #fff;
}

/* 促销角标：暖玫红，与库存/售罄语义色分离，强化「省钱」锚点 */
.stock-badge.discount {
  padding: 3px 8px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: #fff;
  background: linear-gradient(
    135deg,
    var(--shop-sale-strong, #f43f5e) 0%,
    var(--shop-sale, #fb7185) 100%
  );
  box-shadow: 0 1px 6px color-mix(in srgb, var(--shop-sale-strong, #f43f5e) 45%, transparent);
}

.product-info {
  padding: 8px 10px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
}

.product-title-row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  min-width: 0;
}

.product-title {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  color: var(--tg-text);
}

.inline-discount-badge {
  flex-shrink: 0;
  padding: 2px 7px;
  border-radius: var(--r-full);
  font-size: 10px;
  font-weight: 700;
  line-height: 1.4;
  white-space: nowrap;
  color: #fff;
  background: linear-gradient(
    135deg,
    var(--shop-sale-strong, #f43f5e) 0%,
    var(--shop-sale, #fb7185) 100%
  );
  box-shadow: 0 1px 4px color-mix(in srgb, var(--shop-sale-strong, #f43f5e) 40%, transparent);
}

.product-desc {
  font-size: 12px;
  color: var(--tg-hint);
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.product-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.product-tag {
  display: inline-flex;
  align-items: center;
  padding: 2px 7px;
  border-radius: var(--r-full);
  font-size: 10px;
  line-height: 1.35;
  color: var(--tg-btn);
  background: color-mix(in srgb, var(--tg-btn) 16%, transparent);
  border: 0.5px solid color-mix(in srgb, var(--tg-btn) 28%, transparent);
}

.product-tag-muted {
  color: var(--tg-hint);
  background: var(--surface);
  border-color: var(--border);
}

.product-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: auto;
}

.product-status-action {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  min-width: 0;
  flex-wrap: wrap;
}

.compact-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 48px;
  height: 28px;
  padding: 0 12px;
  border-radius: var(--r-md);
  color: var(--tg-btn-text);
  background: var(--tg-btn);
  font-size: 12px;
  font-weight: 600;
  flex-shrink: 0;
}

/* 售罄：次要「查看」动作，仍可进确认层 */
.compact-action.muted {
  color: var(--tg-hint);
  background: var(--surface, rgba(255, 255, 255, 0.08));
  border: 0.5px solid var(--border);
}

.product-card.is-compact:hover .compact-action:not(.muted) {
  filter: brightness(1.08);
}

@media (max-width: 520px) {
  .product-card.is-compact .product-cover {
    width: 80px;
    flex-basis: 80px;
  }

  .product-card.is-compact .product-tags .product-tag-muted {
    display: none;
  }

  .product-card.is-compact .product-tags .product-tag:nth-child(2) {
    display: none;
  }
}

.product-price-block {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  min-width: 0;
}

.product-price-main {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
  min-width: 0;
}

.product-price {
  font-size: 17px;
  font-weight: 800;
  color: var(--tg-btn);
  white-space: nowrap;
  letter-spacing: -0.02em;
  line-height: 1.15;
}

/* 促销现价：成交色，压过默认品牌蓝 */
.product-price.is-sale {
  color: var(--shop-sale, #fb7185);
  font-size: 18px;
}

.product-price.is-free {
  color: var(--admin-success, #6ee7b7);
  text-shadow: none;
}

.product-price.is-free.is-sale {
  color: var(--shop-sale, #fb7185);
}

.product-original-price {
  font-size: 12px;
  font-weight: 500;
  color: color-mix(in srgb, var(--tg-hint) 88%, transparent);
  text-decoration: line-through;
  text-decoration-thickness: 1.5px;
  opacity: 0.92;
}

/* 「省 ¥x」微条：与角标同色系，脚部二次锚点 */
.product-save-chip {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  padding: 1px 6px;
  border-radius: var(--r-sm);
  font-size: 11px;
  font-weight: 700;
  line-height: 1.35;
  white-space: nowrap;
  color: var(--shop-sale-text, #fecdd3);
  background: var(--shop-sale-soft, rgba(244, 63, 94, 0.16));
  border: 0.5px solid var(--shop-sale-border, rgba(244, 63, 94, 0.42));
}

.product-card.is-compact .product-price.is-sale {
  font-size: 16px;
}

.product-card.is-compact .product-save-chip {
  font-size: 10px;
  padding: 0 5px;
}

.product-stock {
  font-size: 11px;
  color: var(--tg-hint);
  font-weight: 500;
  white-space: nowrap;
}

.product-stock.out {
  color: var(--admin-danger, #fca5a5);
  font-weight: 600;
}

.product-stock.low {
  color: var(--admin-warning, #fbbf24);
  font-weight: 600;
}

.product-stock.limit {
  opacity: 0.9;
}
</style>
