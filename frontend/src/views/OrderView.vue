<template>
  <div class="order-view">
    <div class="page-section">
      <div class="section-label">订单结果</div>
      <h1 class="section-title">订单详情</h1>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="skeleton-card">
      <div class="skeleton skeleton-line w-70" />
      <div class="skeleton skeleton-line w-40" />
    </div>

    <!-- Error -->
    <div v-else-if="error" class="result-box status-error">
      {{ error }}
    </div>

    <!-- Order result -->
    <div v-else-if="order" class="order-result">
      <div class="result-status" :class="`result-${order.status}`">
        <span class="result-icon">{{ statusIcon }}</span>
        <span class="result-title">{{ statusText }}</span>
      </div>

      <div class="order-meta-box">
        <div class="meta-row">
          <span class="meta-label">订单号</span>
          <span class="meta-value">{{ order.orderNo || order.id }}</span>
        </div>
        <div class="meta-row">
          <span class="meta-label">商品</span>
          <span class="meta-value">{{ order.productTitle || order.productName }}</span>
        </div>
        <div class="meta-row" v-if="order.buyerEmail || order.buyerContact">
          <span class="meta-label">联系人</span>
          <span class="meta-value">{{ order.buyerContact || order.buyerEmail || '-' }}</span>
        </div>
        <div class="meta-row">
          <span class="meta-label">金额</span>
          <span class="meta-value">{{ formatPrice(order.paidCents || order.amountCents, order.currency) }}</span>
        </div>
        <div v-if="order.paymentRef" class="meta-row">
          <span class="meta-label">支付流水</span>
          <span class="meta-value">{{ order.paymentRef }}</span>
        </div>
        <div v-if="order.paidAt" class="meta-row">
          <span class="meta-label">支付时间</span>
          <span class="meta-value">{{ new Date(order.paidAt).toLocaleString() }}</span>
        </div>
        <div v-if="order.issuedAt" class="meta-row">
          <span class="meta-label">发卡时间</span>
          <span class="meta-value">{{ new Date(order.issuedAt).toLocaleString() }}</span>
        </div>
        <div v-if="order.expiresAt" class="meta-row">
          <span class="meta-label">过期时间</span>
          <span class="meta-value">{{ new Date(order.expiresAt).toLocaleString() }}</span>
        </div>
      </div>

      <!-- Delivery info（复用共享组件，同时支持卡密和虚拟资料模式） -->
      <div v-if="(order.delivery && order.status === 'issued') || (order.cards && order.cards.length)" class="delivery-box">
        <h3 class="delivery-title">{{ isCardDelivery ? '卡密信息' : '交付内容' }}</h3>
        <DeliveryInfo :delivery="order.delivery" :cards="order.cards" :fulfillment-mode="deliveryFulfillmentMode" />
        <div class="delivery-actions">
          <button v-if="copyPayload" class="btn btn-ghost btn-sm" type="button" @click="copyDelivery($event)">
            复制交付内容
          </button>
          <a v-if="supportEmail" class="btn btn-ghost btn-sm" :href="`mailto:${supportEmail}?subject=${encodeURIComponent(`订单协助 ${order.orderNo || order.id}`)}`">
            联系售后
          </a>
        </div>
      </div>
      <div v-else-if="order.status === 'issued' && order.deliveryMessage" class="delivery-box">
        <h3 class="delivery-title">卡密通过邮件交付</h3>
        <p class="delivery-email-note">{{ order.deliveryMessage }}</p>
        <div class="delivery-actions">
          <a v-if="supportEmail" class="btn btn-ghost btn-sm" :href="`mailto:${supportEmail}?subject=${encodeURIComponent(`订单协助 ${order.orderNo || order.id}`)}`">
            联系售后
          </a>
        </div>
      </div>

      <div class="step-actions">
        <RouterLink to="/shop" class="btn btn-primary">返回首页</RouterLink>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onBeforeUnmount, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { getPayStatus } from '@/api'
import { formatPrice } from '@/composables/useFormat'
import DeliveryInfo from '@/components/DeliveryInfo.vue'
import { useShopConfig } from '@/composables/useShopConfig'
import { useToast } from '@/composables/useToast'
import { copyText } from '@/composables/useClipboard'
import { fieldLabel, getDeliveryEntries } from '@/composables/useDeliveryDisplay'
import type { Order } from '@/types'

const route = useRoute()
const loading = ref(true)
const error = ref('')
const order = ref<Order | null>(null)
const { supportEmail, loadShopConfig } = useShopConfig()
const { showToast } = useToast()

const statusText = computed(() => {
  if (!order.value) return ''
  const map: Record<string, string> = {
    pending: '待支付',
    paid: '已支付，正在发卡…',
    issued: '已交付',
    expired: '已过期',
    failed: '失败',
    canceled: '已取消',
    cancelled: '已取消',
    closed: '已关闭',
    refunded: '已退款',
  }
  return map[order.value.status] || order.value.status
})

const statusIcon = computed(() => {
  if (!order.value) return '⟳'
  const icons: Record<string, string> = {
    pending: '⟳',
    paid: '⏳',
    issued: '✓',
    expired: '⏰',
    failed: '✕',
    canceled: '✕',
    cancelled: '✕',
    closed: '✕',
    refunded: '↩',
  }
  return icons[order.value.status] || '⟳'
})

const deliveryFulfillmentMode = computed(() => {
  const firstItem = order.value?.items?.find(item => item.fulfillmentMode)
  return firstItem?.fulfillmentMode || order.value?.fulfillmentMode || (order.value?.cards?.length ? 'card' : '')
})
const isCardDelivery = computed(() => deliveryFulfillmentMode.value === 'card' || Boolean(order.value?.cards?.length))

const pollableStatuses = new Set(['pending', 'paid'])
const terminalStatuses = new Set(['issued', 'expired', 'failed', 'canceled', 'cancelled', 'closed', 'refunded'])

let orderPollTimer: ReturnType<typeof setInterval> | null = null
let orderPollInFlight = false
let orderPollContext: { orderId: string; token: string } | null = null

function buildOrderState(res: any): Order {
  return {
    id: res.orderId,
    orderNo: res.orderNo || '',
    productId: '',
    productTitle: res.productTitle || '',
    productName: res.productTitle || '',
    priceCents: res.amountCents || 0,
    amountCents: res.amountCents || 0,
    paidCents: res.amountCents || 0,
    currency: res.currency || 'CNY',
    status: res.status as Order['status'],
    fulfillmentMode: res.fulfillmentMode,
    delivery: res.delivery,
    cards: res.cards || [],
    items: res.items || [],
    expiresAt: res.expiresAt,
    createdAt: '',
    buyerEmail: res.buyerEmail,
    buyerContact: res.buyerContact,
    paymentRef: res.paymentRef,
    paidAt: res.paidAt,
    issuedAt: res.issuedAt,
    deliveryVisibility: res.deliveryVisibility,
    deliveryMessage: res.deliveryMessage,
  }
}

function stopOrderPolling() {
  if (orderPollTimer) {
    clearInterval(orderPollTimer)
    orderPollTimer = null
  }
  orderPollInFlight = false
  orderPollContext = null
}

async function refreshOrderStatus() {
  if (!orderPollContext || orderPollInFlight) return
  orderPollInFlight = true
  try {
    const res = await getPayStatus(orderPollContext.orderId, orderPollContext.token)
    order.value = buildOrderState(res)
    if (!pollableStatuses.has(res.status)) {
      stopOrderPolling()
    }
  } catch {
    // 查询抖动时继续轮询，让订单详情自然收敛到最终状态。
  } finally {
    orderPollInFlight = false
  }
}

function startOrderPolling(orderId: string, token: string) {
  orderPollContext = { orderId, token }
  if (orderPollTimer) return
  orderPollTimer = setInterval(() => {
    void refreshOrderStatus()
  }, 3000)
}

const copyPayload = computed(() => {
  if (!order.value) return ''
  const segments: string[] = []
  if (isCardDelivery.value) {
    if (order.value.delivery?.accountLabel) segments.push(`卡号：${order.value.delivery.accountLabel}`)
    if (order.value.delivery?.deliverySecret) segments.push(`密码：${order.value.delivery.deliverySecret}`)
    if (order.value.delivery?.deliveryNote) segments.push(`备注：${order.value.delivery.deliveryNote}`)
  } else {
    getDeliveryEntries(order.value.delivery as Record<string, unknown> | undefined | null, { includeLegacyDeliveryFields: true })
      .forEach(([key, value]) => segments.push(`${fieldLabel(key)}：${value}`))
  }
  if (order.value.cards?.length) {
    order.value.cards.forEach((card, index) => {
      segments.push(`卡密${index + 1}：${card.cardData || card.deliverySecret || ''}`)
    })
  }
  return segments.join('\n')
})



async function loadOrder() {
  stopOrderPolling()
  const orderId = route.query.orderId as string
  const token = route.query.token as string
  if (!orderId || !token) {
    error.value = '缺少订单信息'
    loading.value = false
    return
  }
  try {
    const res = await getPayStatus(orderId, token)
    order.value = buildOrderState(res)
    if (pollableStatuses.has(res.status)) {
      startOrderPolling(orderId, token)
    } else if (terminalStatuses.has(res.status)) {
      stopOrderPolling()
    }
  } catch (err: any) {
    error.value = err.message || '查询订单失败'
  } finally {
    loading.value = false
  }
}

function copyDelivery(event: Event) {
  if (!copyPayload.value) return
  try {
    copyText(copyPayload.value, event)
    showToast('已复制交付内容', 'success')
  } catch {
    showToast('复制失败，请手动复制', 'error')
  }
}

onMounted(() => {
  loadShopConfig()
  loadOrder()
})

onBeforeUnmount(() => {
  stopOrderPolling()
})
</script>

<style scoped>
.order-view {
  padding-top: 16px;
  padding-bottom: 24px;
}

.skeleton-card {
  padding: 16px;
  border-radius: var(--r-lg);
  background: var(--tg-secondary-bg);
}

.skeleton-line {
  height: 16px;
  margin-bottom: 12px;
}

.skeleton-line.w-70 { width: 70%; }
.skeleton-line.w-40 { width: 40%; }

.order-result {
  text-align: center;
}

.result-status {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 16px;
  border-radius: var(--r-lg);
  margin-bottom: 20px;
  font-size: 18px;
  font-weight: 600;
}

.result-icon {
  width: 32px;
  height: 32px;
  border-radius: var(--r-full);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
}

.result-status.result-issued {
  background: rgba(34, 197, 94, 0.12);
  color: #22c55e;
}

.result-status.result-paid {
  background: rgba(59, 130, 246, 0.12);
  color: #3b82f6;
}

.result-status.result-pending {
  background: rgba(245, 158, 11, 0.12);
  color: #f59e0b;
}

.result-status.result-expired,
.result-status.result-failed,
.result-status.result-canceled,
.result-status.result-closed,
.result-status.result-refunded {
  background: rgba(239, 68, 68, 0.12);
  color: #ef4444;
}

.order-meta-box {
  text-align: left;
  padding: 14px 16px;
  background: var(--surface);
  border-radius: var(--r-md);
  margin-bottom: 16px;
}

.meta-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 0;
  font-size: 14px;
}

.meta-label {
  color: var(--tg-hint);
}

.meta-value {
  font-weight: 500;
  font-family: var(--font-mono);
}

.delivery-box {
  text-align: left;
  padding: 14px 16px;
  background: var(--surface);
  border-radius: var(--r-md);
  margin-bottom: 16px;
}

.delivery-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.delivery-title {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 10px;
}

.delivery-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 6px 0;
  font-size: 14px;
}

.delivery-label {
  color: var(--tg-hint);
  flex-shrink: 0;
  min-width: 32px;
}

.delivery-value {
  font-family: var(--font-mono);
  font-weight: 500;
  word-break: break-all;
}

/* Copy button */
.btn-copy {
  flex-shrink: 0;
  padding: 2px 6px;
  border: none;
  border-radius: var(--r-sm);
  background: transparent;
  cursor: pointer;
  font-size: 14px;
  transition: background var(--duration-fast) var(--ease-out);
}

.btn-copy:hover {
  background: var(--surface-hover);
}

.step-actions {
  margin-top: 20px;
}
</style>
