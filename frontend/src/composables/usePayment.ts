import { ref } from 'vue'
import type { PayStep, PayProduct, PayOrder, Delivery } from '@/types'
import {
  isBasePriceFree,
  normalizeCheckoutIntent,
  type CheckoutPaymentChannel,
} from '@shared/checkout-policy'

const isVisible = ref(false)
const _step = ref<PayStep>('form')
const product = ref<PayProduct>({ storefrontId: '', storefrontSlug: '', id: '', title: '', priceCents: 0, currency: 'CNY', coverUrl: '' })
const quantity = ref(1)
const idempotencyKey = ref('')
const email = ref('')
const couponCode = ref('')
const fulfillmentInput = ref('')
const couponValid = ref(false)
const couponDiscount = ref(0)
const currentOrder = ref<PayOrder | null>(null)
const delivery = ref<Delivery | null>(null)
const orderStatus = ref('')
const orderError = ref('')
const pendingAttempt = ref<PendingCheckoutAttempt | null>(null)
const PENDING_ATTEMPTS_KEY = 'pending_checkout_attempts'
const PENDING_ATTEMPT_TTL_MS = 2 * 60 * 60 * 1000
const MAX_PENDING_ATTEMPTS = 5

export interface PendingCheckoutAttempt {
  idempotencyKey: string
  storefrontId: string
  productId: string
  buyerEmail: string
  quantity: number
  couponCode: string
  fulfillmentInput?: string
  balancePayment: boolean
  paymentChannel?: CheckoutPaymentChannel | ''
  createdAt: string
}

export type PendingCheckoutAttemptInput = Omit<PendingCheckoutAttempt, 'createdAt'>

function normalizeAttempt(input: PendingCheckoutAttempt): PendingCheckoutAttempt {
  return {
    ...input,
    buyerEmail: input.buyerEmail.trim().toLowerCase(),
    couponCode: input.couponCode.trim().toUpperCase(),
    fulfillmentInput: (input.fulfillmentInput || '').trim().slice(0, 200),
    // undefined 表示旧记录缺少渠道，空字符串则是免费商品的明确语义，二者不能混为一谈。
    paymentChannel: input.balancePayment ? '' : (input.paymentChannel ?? 'alipay'),
  }
}

export function matchesPendingCheckoutAttempt(
  existing: PendingCheckoutAttempt | null,
  input: PendingCheckoutAttemptInput,
): boolean {
  if (!existing) return false
  const normalizedExisting = normalizeAttempt(existing)
  const normalizedInput = normalizeAttempt({ ...input, createdAt: existing.createdAt })
  return normalizedExisting.idempotencyKey === normalizedInput.idempotencyKey
    && normalizedExisting.storefrontId === normalizedInput.storefrontId
    && normalizedExisting.productId === normalizedInput.productId
    && normalizedExisting.buyerEmail === normalizedInput.buyerEmail
    && normalizedExisting.quantity === normalizedInput.quantity
    && normalizedExisting.couponCode === normalizedInput.couponCode
    && normalizedExisting.fulfillmentInput === normalizedInput.fulfillmentInput
    && normalizedExisting.balancePayment === normalizedInput.balancePayment
    && normalizedExisting.paymentChannel === normalizedInput.paymentChannel
}

function readPendingAttempts(): PendingCheckoutAttempt[] {
  try {
    // 仅覆盖当前标签页刷新/跳转，避免买家邮箱和履约输入跨浏览器会话留存。
    const parsed: unknown = JSON.parse(sessionStorage.getItem(PENDING_ATTEMPTS_KEY) || '[]')
    if (!Array.isArray(parsed)) return []
    const cutoff = Date.now() - PENDING_ATTEMPT_TTL_MS
    const validAttempts = parsed.filter((item): item is PendingCheckoutAttempt => {
      if (!item || typeof item !== 'object') return false
      const value = item as Partial<PendingCheckoutAttempt>
      return typeof value.idempotencyKey === 'string'
        && typeof value.storefrontId === 'string'
        && typeof value.productId === 'string'
        && typeof value.buyerEmail === 'string'
        && typeof value.quantity === 'number'
        && typeof value.couponCode === 'string'
        && (value.fulfillmentInput === undefined || typeof value.fulfillmentInput === 'string')
        && typeof value.balancePayment === 'boolean'
        && (value.paymentChannel === undefined || ['', 'alipay', 'wxpay', 'qqpay'].includes(value.paymentChannel))
        && typeof value.createdAt === 'string'
        && Date.parse(value.createdAt) >= cutoff
    })
    const attempts = validAttempts.map(item => normalizeAttempt(item))
    if (attempts.length !== parsed.length || JSON.stringify(attempts) !== JSON.stringify(validAttempts)) {
      sessionStorage.setItem(PENDING_ATTEMPTS_KEY, JSON.stringify(attempts))
    }
    return attempts
  } catch {
    return []
  }
}

function saveCheckoutAttempt(input: PendingCheckoutAttemptInput): boolean {
  try {
    const attempt = normalizeAttempt({ ...input, createdAt: new Date().toISOString() })
    const attempts = readPendingAttempts()
    const existing = attempts.find(item => item.idempotencyKey === attempt.idempotencyKey)
    if (existing && !matchesPendingCheckoutAttempt(existing, input)) return false
    const next = [attempt, ...attempts.filter(item => item.idempotencyKey !== attempt.idempotencyKey)]
    sessionStorage.setItem(PENDING_ATTEMPTS_KEY, JSON.stringify(next.slice(0, MAX_PENDING_ATTEMPTS)))
    return true
  } catch {
    return true
  }
}

function clearCheckoutAttempt(key: string): void {
  try {
    const remaining = readPendingAttempts().filter(item => item.idempotencyKey !== key)
    sessionStorage.setItem(PENDING_ATTEMPTS_KEY, JSON.stringify(remaining))
  } catch {
    // sessionStorage unavailable
  }
  if (pendingAttempt.value?.idempotencyKey === key) {
    pendingAttempt.value = null
  }
}

function restartCheckoutAttempt(): string {
  clearCheckoutAttempt(idempotencyKey.value)
  idempotencyKey.value = createIdempotencyKey()
  return idempotencyKey.value
}

export function shouldClearCheckoutAttemptForError(code?: string): boolean {
  // 同键请求仍在服务端执行时必须保留恢复记录；换新键可能创建第二笔订单。
  return code !== 'IDEMPOTENCY_PENDING'
}

function createIdempotencyKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

function open(p: PayProduct) {
  product.value = p
  // 同一全局商品可以出现在多个渠道，恢复键必须同时绑定渠道和商品。
  let savedAttempt = readPendingAttempts().find(item => (
    item.storefrontId === p.storefrontId && item.productId === p.id
  )) || null
  if (savedAttempt && isBasePriceFree(p.priceCents)) {
    const normalized = normalizeCheckoutIntent(p.priceCents, savedAttempt)
    const isCanonicalFreeAttempt = savedAttempt.quantity === normalized.quantity
      && savedAttempt.couponCode === normalized.couponCode
      && savedAttempt.balancePayment === normalized.balancePayment
      && savedAttempt.paymentChannel === normalized.paymentChannel
    // 商品价格可能在待支付期间改为 0；旧的付费参数不能继续绑定原幂等键。
    if (!isCanonicalFreeAttempt) {
      clearCheckoutAttempt(savedAttempt.idempotencyKey)
      savedAttempt = null
    }
  }
  pendingAttempt.value = savedAttempt
  quantity.value = isBasePriceFree(p.priceCents) ? 1 : (savedAttempt?.quantity || 1)
  idempotencyKey.value = savedAttempt?.idempotencyKey || createIdempotencyKey()
  email.value = savedAttempt?.buyerEmail || ''
  fulfillmentInput.value = savedAttempt?.fulfillmentInput || ''
  couponCode.value = isBasePriceFree(p.priceCents) ? '' : (savedAttempt?.couponCode || '')
  couponValid.value = false
  couponDiscount.value = 0
  currentOrder.value = null
  delivery.value = null
  orderStatus.value = ''
  orderError.value = ''
  _step.value = 'form'
  isVisible.value = true
}

function close() {
  isVisible.value = false
  _step.value = 'form'
  currentOrder.value = null
  pendingAttempt.value = null
}

function setStep(s: PayStep) {
  _step.value = s
}

export function usePayment() {
  return {
    isVisible,
    /** 只读 step — 通过 setStep 修改 */
    step: _step,
    setStep,
    product,
    quantity,
    idempotencyKey,
    email,
    couponCode,
    fulfillmentInput,
    couponValid,
    couponDiscount,
    currentOrder,
    delivery,
    orderStatus,
    orderError,
    pendingAttempt,
    saveCheckoutAttempt,
    clearCheckoutAttempt,
    restartCheckoutAttempt,
    open,
    close,
  }
}
