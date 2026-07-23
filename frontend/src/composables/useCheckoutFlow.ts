import { ref, shallowRef } from 'vue'
import type { Delivery, DeliveryVisibility, OrderStatus } from '@/types'

export interface CheckoutOrderState {
  orderId: string
  orderNo?: string
  orderToken: string
  amountCents: number
  productId?: string
  productTitle?: string
  currency: string
  quantity?: number
  fulfillmentMode?: string
  expiresAt?: string
  /** 仅表示商品基础价格为 0；优惠后 0 元仍按普通购买结果展示。 */
  isFreeCheckout?: boolean
}

interface PaymentStatusResponse {
  status: OrderStatus
  fulfillmentMode?: string
  delivery?: Delivery
  deliveryVisibility?: DeliveryVisibility
  deliveryMessage?: string
  cards?: Array<{ id?: string; accountLabel?: string; deliverySecret?: string; deliveryNote?: string; cardData: string }>
  fulfillmentPending?: boolean
  message?: string
}

interface CheckoutFlowOptions {
  setStep: (step: 'form' | 'online' | 'offline' | 'result') => void
  getPayStatus: (orderId: string, orderToken: string) => Promise<PaymentStatusResponse>
  showResult: (type: string, title: string, desc: string, delivery?: Delivery, cards?: PaymentStatusResponse['cards']) => void
}

// 缺少 expiresAt 的旧响应才使用前端兜底等待时间；订单真实状态始终以后端为准。
const ONLINE_TIMEOUT_MS = 5 * 60 * 1000
const OFFLINE_TIMEOUT_MS = 30 * 60 * 1000

function formatCountdown(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export function useCheckoutFlow(options: CheckoutFlowOptions) {
  const orderState = shallowRef<CheckoutOrderState | null>(null)
  const providerName = ref('')
  const paymentChannelLabel = ref('')
  const qrUrl = ref('')
  const paymentUrl = ref('')
  const onlineStatus = ref('请扫码支付，支付完成后自动跳转')
  const onlineTimer = ref('')
  const offlineTimer = ref('')

  let pollTimer: ReturnType<typeof setInterval> | null = null
  let onlineTickTimer: ReturnType<typeof setInterval> | null = null
  let offlineTickTimer: ReturnType<typeof setInterval> | null = null
  let onlinePollStartTime: number | null = null
  let offlinePollStartTime: number | null = null

  function setOrderState(state: CheckoutOrderState) {
    orderState.value = state
  }

  function setOnlinePayment(provider: string, qrcode: string, redirectUrl = '', statusMessage = '', channelLabel = '') {
    providerName.value = provider
    paymentChannelLabel.value = channelLabel.trim()
    qrUrl.value = qrcode
    paymentUrl.value = redirectUrl
    onlineStatus.value = statusMessage.trim() || (provider === 'free'
      ? '正在确认领取和交付结果'
      : provider === 'balance'
      ? '余额支付处理中，请稍候'
      : qrcode
      ? paymentChannelLabel.value
        ? `请使用${paymentChannelLabel.value}扫码支付，支付完成后自动跳转`
        : '请扫码支付，支付完成后自动跳转'
      : redirectUrl
      ? paymentChannelLabel.value
        ? `请使用${paymentChannelLabel.value}前往支付页完成付款，本页会自动更新结果`
        : '请前往支付页完成付款，本页会自动更新结果'
      : '支付渠道响应异常，正在确认订单状态')
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    if (onlineTickTimer) {
      clearInterval(onlineTickTimer)
      onlineTickTimer = null
    }
    if (offlineTickTimer) {
      clearInterval(offlineTickTimer)
      offlineTickTimer = null
    }
    onlineTimer.value = ''
    offlineTimer.value = ''
  }

  function startStatusPolling() {
    if (!orderState.value || pollTimer) return
    pollTimer = setInterval(async () => {
      const state = orderState.value
      if (!state) return
      try {
        const res = await options.getPayStatus(state.orderId, state.orderToken)
        // 履约模式可能来自订单明细快照，支付期间商品配置变更时以前端最新轮询结果为准。
        if (res.fulfillmentMode && res.fulfillmentMode !== state.fulfillmentMode) {
          orderState.value = { ...state, fulfillmentMode: res.fulfillmentMode }
        }
        // issued 是交付完成终态；email_only 订单可能没有 delivery/cards，但会有 deliveryMessage。
        if (res.status === 'issued' && (res.delivery || res.deliveryMessage || (res.cards && res.cards.length > 0))) {
          stopPolling()
          options.showResult(
            'success',
            state.isFreeCheckout ? '领取成功' : '支付成功',
            res.deliveryMessage || ((res.cards?.length || 0) > 1 ? '多张卡密已发放' : '卡密已发放'),
            res.delivery,
            res.cards,
          )
        } else if (res.status === 'paid') {
          // paid 只代表收款成功，仍需等待后端发卡/虚拟资料交付，不应提前显示成功交付。
          onlineStatus.value = res.fulfillmentPending && res.message
            ? res.message
            : '支付已确认，正在发卡…'
        } else if (res.status === 'canceled' || res.status === 'closed') {
          stopPolling()
          options.showResult('error', '订单已取消', '订单已取消，未完成支付')
        } else if (res.status === 'expired' || res.status === 'failed' || res.status === 'refunded') {
          // 这些都是不会再自动进入成功交付的终态，必须停轮询并给用户明确结果。
          stopPolling()
          options.showResult(
            'error',
            state.isFreeCheckout ? '领取失败' : '支付失败',
            res.status === 'expired' ? '订单已过期' : res.status === 'refunded' ? '订单已退款' : '支付处理失败',
          )
        }
      } catch {
        // 网络抖动时继续轮询，避免用户已支付但前端提前失败。
      }
    }, 3000)
  }

  function startOnlinePolling() {
    if (!orderState.value) return
    onlinePollStartTime = Date.now()
    const expiresAtMs = Date.parse(orderState.value.expiresAt || '')
    const deadline = Number.isFinite(expiresAtMs)
      ? expiresAtMs
      : onlinePollStartTime + ONLINE_TIMEOUT_MS
    startStatusPolling()
    onlineTickTimer = setInterval(() => {
      if (!onlinePollStartTime) return
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        stopPolling()
        options.showResult(
          'warning',
          orderState.value?.isFreeCheckout ? '领取状态待确认' : '支付状态待确认',
          orderState.value?.isFreeCheckout
            ? '领取处理时间较长，请查看订单详情确认最终状态，避免重复领取'
            : '支付窗口已结束，请查看订单详情确认最终状态，避免重复付款',
        )
      } else {
        onlineTimer.value = `剩余 ${formatCountdown(remaining)}`
      }
    }, 1000)
  }

  function startOfflineCountdown(expiresAt?: string) {
    offlinePollStartTime = Date.now()
    offlineTickTimer = setInterval(() => {
      const remaining = expiresAt
        ? new Date(expiresAt).getTime() - Date.now()
        : OFFLINE_TIMEOUT_MS - (Date.now() - (offlinePollStartTime || Date.now()))
      if (remaining <= 0) {
        stopPolling()
        options.showResult('error', '支付超时', '订单已过期，请重新下单')
      } else {
        offlineTimer.value = `剩余 ${formatCountdown(remaining)}`
      }
    }, 1000)
  }

  function resetCheckoutFlow() {
    stopPolling()
    orderState.value = null
    providerName.value = ''
    paymentChannelLabel.value = ''
    qrUrl.value = ''
    paymentUrl.value = ''
    onlineStatus.value = '请扫码支付，支付完成后自动跳转'
    onlineTimer.value = ''
    offlineTimer.value = ''
    onlinePollStartTime = null
    offlinePollStartTime = null
  }

  return {
    orderState,
    providerName,
    paymentChannelLabel,
    qrUrl,
    paymentUrl,
    onlineStatus,
    onlineTimer,
    offlineTimer,
    setOrderState,
    setOnlinePayment,
    startOnlinePolling,
    startStatusPolling,
    startOfflineCountdown,
    stopPolling,
    resetCheckoutFlow,
  }
}
