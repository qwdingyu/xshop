<template>
  <Teleport to="body">
    <transition name="pay-fade">
      <div v-if="isVisible" class="pay-overlay" @click.self="handleOverlayClick">
        <transition name="pay-slide">
          <div class="pay-box" :class="boxClass">
            <!-- 顶栏：步骤指示 + 关闭（H5）；Telegram 用 BackButton，不渲染关闭 -->
            <div class="pay-topbar">
              <!-- 语义化步骤：填写 → 支付 → 完成（状态机仍为 form/online|offline/result，不改业务） -->
              <nav class="step-indicator" aria-label="下单进度">
                <div
                  v-for="(label, index) in checkoutStepLabels"
                  :key="label"
                  class="step-item"
                  :class="{ active: currentStepDot === index, done: currentStepDot > index }"
                  :aria-current="currentStepDot === index ? 'step' : undefined"
                >
                  <span class="step-dot" aria-hidden="true" />
                  <span class="step-caption">{{ label }}</span>
                </div>
              </nav>
              <button
                v-if="!isTelegram"
                class="pay-close"
                type="button"
                aria-label="关闭"
                @click="requestClose"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                </svg>
              </button>
            </div>

            <!-- ═══ Step 1: Order Form ═══ -->
            <div v-show="step === 'form'" class="pay-step-content">
              <div class="step-header">
                <h2 class="step-title">确认订单</h2>
                <p class="step-subtitle">填写信息后选择支付方式</p>
              </div>

              <!-- Product summary -->
              <div class="order-summary">
                <div class="summary-cover">
                  <img v-if="product.coverUrl && !productImageFailed" :src="product.coverUrl" :alt="product.title" @error="productImageFailed = true" />
                  <span v-else class="summary-icon">&#x1F4E6;</span>
                </div>
                <div class="summary-info">
                  <div class="summary-title">{{ product.title }}</div>
                  <div class="summary-price">
                    {{ productPriceLabel }}
                  </div>
                </div>
              </div>

              <!-- 订单信息：折扣码 / 数量 / 邮箱 / 履约输入（统一组间距） -->
              <div class="order-fields">
                <!-- Coupon -->
                <div v-if="!isBasePriceFreeProduct" class="field-block">
                  <div class="coupon-row">
                    <input
                      v-model="couponCode"
                      type="text"
                      placeholder="折扣码（选填）"
                      autocomplete="off"
                    />
                    <button
                      class="btn btn-secondary btn-sm"
                      type="button"
                      :disabled="verifyingCoupon || !couponCode.trim()"
                      @click="verifyCoupon"
                    >
                      {{ verifyingCoupon ? '验证中' : '验证' }}
                    </button>
                  </div>
                  <div v-if="couponMsg" class="coupon-msg" :class="couponValid ? 'valid' : 'invalid'">
                    {{ couponMsg }}
                  </div>
                </div>

                <!-- Quantity -->
                <div v-if="!isBasePriceFreeProduct" class="field-block">
                  <div class="quantity-row">
                    <span class="quantity-label">购买数量</span>
                    <div class="quantity-control">
                      <button
                        class="quantity-btn"
                        type="button"
                        :disabled="submitting || quantity <= 1"
                        @click="quantity = Math.max(1, quantity - 1)"
                      >
                        -
                      </button>
                      <input
                        v-model.number="quantity"
                        type="number"
                        inputmode="numeric"
                        min="1"
                        :max="maxQuantity"
                        @blur="normalizeQuantity"
                      />
                      <button
                        class="quantity-btn"
                        type="button"
                        :disabled="submitting || quantity >= maxQuantity"
                        @click="quantity = Math.min(maxQuantity, quantity + 1)"
                      >
                        +
                      </button>
                    </div>
                    <span v-if="quantityHint" class="quantity-hint">{{ quantityHint }}</span>
                  </div>
                </div>

                <!-- Email -->
                <div class="field-block">
                  <input
                    v-model="email"
                    type="email"
                    placeholder="邮箱（必填，用于接收卡密）"
                  />
                </div>

                <div v-if="fulfillmentInputVisible" class="field-block">
                  <label class="field-label" :for="`fulfillment-input-${product.id}`">{{ fulfillmentInputLabel }}</label>
                  <input
                    :id="`fulfillment-input-${product.id}`"
                    v-model="fulfillmentInput"
                    :type="fulfillmentInputType === 'account' || fulfillmentInputType === 'uid' || fulfillmentInputType === 'text' ? 'text' : 'tel'"
                    :inputmode="fulfillmentInputType === 'phone' || fulfillmentInputType === 'qq' ? 'numeric' : 'text'"
                    :placeholder="fulfillmentInputHint || `请输入${fulfillmentInputLabel}`"
                    :autocomplete="fulfillmentInputType === 'phone' ? 'tel' : 'off'"
                    maxlength="200"
                  />
                  <small v-if="fulfillmentInputHint" class="field-help">{{ fulfillmentInputHint }}</small>
                </div>
              </div>

              <div v-if="showOnlinePaymentSection" class="payment-method-section">
                <div class="payment-method-heading">
                  <span>支付方式</span>
                  <small v-if="onlinePaymentOptions.length > 0">{{ onlinePaymentOptions.length }} 种可用</small>
                </div>
                <div v-if="paymentMethodsLoading" class="payment-method-loading">正在读取可用支付方式…</div>
                <div v-else-if="onlinePaymentOptions.length > 0" class="payment-method-grid" :class="{ single: onlinePaymentOptions.length === 1 }" role="group" aria-label="在线支付方式">
                  <button
                    v-for="option in onlinePaymentOptions"
                    :key="option.key"
                    type="button"
                    class="payment-method-card"
                    :class="[option.kind, option.channel, { active: selectedPaymentKey === option.key }]"
                    :aria-pressed="selectedPaymentKey === option.key"
                    :disabled="submitting"
                    @click="handlePaymentMethodClick(option)"
                  >
                    <span class="payment-method-icon">{{ option.icon }}</span>
                    <span class="payment-method-copy">
                      <span class="payment-method-label">{{ option.label }}</span>
                      <span class="payment-method-desc">{{ paymentMethodDescription(option) }}</span>
                    </span>
                    <span v-if="selectedPaymentKey === option.key" class="payment-method-badge">当前</span>
                  </button>
                </div>
                <div v-else-if="paymentMethodsLoaded" class="payment-method-empty">
                  暂无在线支付方式，请联系管理员检查支付宝、微信或 QQ 配置
                </div>
              </div>

              <div v-if="balancePayAvailable" class="payment-method-section">
                <div class="payment-method-heading">
                  <span>余额支付</span>
                  <small>需要先校验邮箱余额</small>
                </div>
                <button
                  type="button"
                  class="payment-method-card balance"
                  :class="{ active: selectedPaymentMode === 'balance' }"
                  :aria-pressed="selectedPaymentMode === 'balance'"
                  :disabled="submitting"
                  @click="selectPaymentMethod({ key: 'balance', kind: 'balance', label: '余额支付', icon: '余' })"
                >
                  <span class="payment-method-icon">余</span>
                  <span class="payment-method-copy">
                    <span class="payment-method-label">余额支付</span>
                    <span class="payment-method-desc">需先完成邮箱验证和余额查询</span>
                  </span>
                  <span v-if="selectedPaymentMode === 'balance'" class="payment-method-badge">当前</span>
                </button>
                <div v-if="selectedPaymentMode === 'balance'" class="balance-auth-section">
                  <div class="email-code-row">
                    <input
                      v-model="emailAccessCode"
                      type="text"
                      inputmode="numeric"
                      autocomplete="one-time-code"
                      maxlength="6"
                      pattern="[0-9]{6}"
                      placeholder="邮箱验证码"
                    />
                    <button
                      class="btn btn-secondary btn-sm"
                      type="button"
                      :disabled="sendingEmailCode || emailCodeCoolingDown || !email.trim()"
                      @click="sendEmailCode"
                    >
                      {{ sendingEmailCode ? '发送中' : emailCodeButtonText }}
                    </button>
                  </div>
                  <div v-if="emailCodeMsg" class="email-code-msg" :class="emailCodeSent ? 'valid' : 'invalid'">
                    {{ emailCodeMsg }}
                  </div>
                  <div class="balance-row">
                    <button
                      class="btn btn-secondary btn-sm"
                      type="button"
                      :disabled="checkingBalance || !email.trim()"
                      @click="checkBalance"
                    >
                      {{ checkingBalance ? '查询中' : '查余额' }}
                    </button>
                    <span v-if="balanceMsg" class="balance-msg" :class="balanceUsable ? 'valid' : 'invalid'">
                      {{ balanceMsg }}
                    </span>
                  </div>
                  <p class="balance-auth-hint">
                    先完成邮箱验证码和余额查询，再提交余额支付
                  </p>
                </div>
              </div>

              <!-- Turnstile -->
              <Turnstile container-id="pay-turnstile" />

              <!-- Submit -->
              <div v-if="formError" class="form-error" role="alert">{{ formError }}</div>
              <div class="pay-action-row">
                <button
                  class="btn btn-primary btn-full"
                  type="button"
                  :disabled="submitting || !canSubmitCheckout"
                  @click="handleSubmit"
                >
                  {{ submitting ? '提交中…' : primaryActionLabel }}
                </button>
              </div>
            </div>

            <!-- ═══ Step 2: Online Payment ═══ -->
            <div v-show="step === 'online'" class="pay-step-content">
              <div class="step-header">
                <h2 class="step-title">{{ onlineStepTitle }}</h2>
                <p class="step-subtitle">{{ onlineStepLabel }}</p>
              </div>

              <div class="pay-amount">
                <span>应付金额</span>
                <strong>{{ formatPrice(unifiedAmountCents, product.currency) }}</strong>
              </div>

              <div class="offline-order-summary">
                <div class="offline-summary-row">
                  <span>商品</span>
                  <strong>{{ orderState?.productTitle || product.title }}</strong>
                </div>
                <div class="offline-summary-grid">
                  <div>
                    <span>订单号</span>
                    <code>{{ orderState?.orderNo || '-' }}</code>
                  </div>
                  <div>
                    <span>数量</span>
                    <strong>{{ orderState?.quantity || quantity }}</strong>
                  </div>
                  <div>
                    <span>邮箱</span>
                    <strong>{{ email }}</strong>
                  </div>
                  <div v-if="showOfflineNoteInOnlineStep">
                    <span>付款备注</span>
                    <code>{{ offlineNoteCode || '-' }}</code>
                  </div>
                </div>
              </div>

              <div v-if="showOnlinePaymentEntry" class="qr-wrapper">
                <img
                  v-if="qrUrl"
                  :src="qrUrl"
                  alt="支付二维码"
                  class="qr-image"
                />
                <a
                  v-else-if="paymentUrl"
                  :href="paymentUrl"
                  class="btn btn-primary online-payment-link"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  前往支付页
                </a>
                <div v-else class="qr-placeholder">支付入口正在确认</div>
              </div>

              <div class="payment-status-panel" :class="{ compact: !showOnlinePaymentEntry }" role="status" aria-live="polite">
                <p class="pay-hint">{{ onlineStatus }}</p>
                <span v-if="onlineTimer" class="pay-timer">{{ onlineTimer }}</span>
              </div>

              <div class="step-actions">
                <button class="btn btn-ghost" type="button" @click="goBack">返回</button>
              </div>
            </div>

            <!-- ═══ Step 3: Offline Payment ═══ -->
            <div v-show="step === 'offline'" class="pay-step-content">
              <div class="step-header">
                <h2 class="step-title offline-title">
                  <span>扫码付款</span>
                  <span v-if="offlineTimer" class="pay-timer-inline">{{ offlineTimer }}</span>
                </h2>
                <p class="step-subtitle">线下付款</p>
              </div>

              <div class="pay-amount">
                <span>应付金额</span>
                <strong>{{ formatPrice(unifiedAmountCents, product.currency) }}</strong>
              </div>

              <!-- QR codes -->
              <div class="offline-qr-row">
                <div class="qr-item" :class="{ empty: !wechatQr }">
                  <img v-if="wechatQr" :src="wechatQr" alt="微信收款码" />
                  <div v-else class="qr-empty">未配置<br />收款码</div>
                  <span class="qr-label">微信</span>
                </div>
                <div class="qr-item" :class="{ empty: !alipayQr }">
                  <img v-if="alipayQr" :src="alipayQr" alt="支付宝收款码" />
                  <div v-else class="qr-empty">未配置<br />收款码</div>
                  <span class="qr-label">支付宝</span>
                </div>
              </div>

              <p v-if="!wechatQr && !alipayQr" class="pay-warning">
                暂不可付款：管理后台尚未配置微信/支付宝收款码。请联系管理员补充收款码后再下单付款。
              </p>

              <!-- Note code -->
              <div v-if="offlineNoteCode" class="note-section">
                <div class="note-row">
                  <span>付款备注</span>
                  <code class="note-code">{{ offlineNoteCode }}</code>
                </div>
                <p class="note-hint">转账时请在「备注/附言」中完整输入上方号码</p>
              </div>

              <p class="pay-hint">{{ offlineHint }}</p>

              <!-- Confirm section -->
              <div class="confirm-section">
                <div class="confirm-divider" />
                <p class="confirm-title">确认付款</p>
                <p class="confirm-desc">付款后请输入微信/支付宝账单详情里的交易单号或商户单号后 4 位数字，便于管理员核对。</p>
                <div class="confirm-input-row">
                  <input
                    v-model="refLast4"
                    type="text"
                    inputmode="numeric"
                    maxlength="4"
                    pattern="[0-9]{4}"
                    placeholder="例：1234"
                    autocomplete="one-time-code"
                    :disabled="!hasOfflineQr"
                  />
                  <button
                    class="btn btn-primary btn-sm"
                    type="button"
                    :disabled="!hasOfflineQr || confirming || refLast4.length !== 4"
                    @click="handleConfirmOffline"
                  >
                    {{ confirming ? '核对中' : '确认' }}
                  </button>
                </div>
                <p v-if="confirmError" class="confirm-error">{{ confirmError }}</p>
                <p v-if="offlineConfirmStatus" class="pay-hint" style="margin-top:8px">{{ offlineConfirmStatus }}</p>
              </div>

              <div class="step-actions">
                <button class="btn btn-ghost" type="button" @click="goBack">返回</button>
              </div>
            </div>

            <!-- ═══ Step 4: Result ═══ -->
            <div v-show="step === 'result'" class="pay-step-content">
              <div class="step-header">
                <h2 class="step-title">支付结果</h2>
                <p class="step-subtitle">订单结果</p>
              </div>

              <div class="result-content">
                <div class="result-status" :class="`result-${resultStatus}`">
                  <span class="result-icon">{{ resultIcon }}</span>
                  <span class="result-title">{{ resultTitle }}</span>
                </div>

                <!-- Delivery info（复用共享组件，卡密显示卡号/密码，虚拟资料显示对应中文标签） -->
                <div v-if="resultDelivery || resultCards.length > 0" class="delivery-box">
                  <DeliveryInfo :delivery="resultDelivery" :cards="resultCards" :fulfillment-mode="orderState?.fulfillmentMode || product.fulfillmentMode" />
                </div>

                <p v-if="resultDesc" class="result-desc">{{ resultDesc }}</p>
              <div v-if="orderState" class="order-link-row">
                <RouterLink
                    :to="{ name: 'Order', query: { orderId: orderState?.orderId, token: orderState?.orderToken } }"
                    class="btn btn-ghost"
                    target="_blank"
                  >
                    查看订单详情 →
                  </RouterLink>
                </div>
              </div>

              <div class="step-actions">
                <button class="btn btn-primary btn-full" type="button" @click="handleClose">
                  完成
                </button>
              </div>
            </div>
          </div>
        </transition>
      </div>
    </transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue'
import Turnstile from '@/components/Turnstile.vue'
import { usePlatform } from '@/composables/usePlatform'
import { useTelegram } from '@/composables/useTelegram'
import { useTurnstile } from '@/composables/useTurnstile'
import { matchesPendingCheckoutAttempt, shouldClearCheckoutAttemptForError, usePayment } from '@/composables/usePayment'
import { useCheckoutFlow } from '@/composables/useCheckoutFlow'
import { useOfflinePayment } from '@/composables/useOfflinePayment'
import { retryAfterSecondsFromError, useEmailCodeCooldown } from '@/composables/useEmailCodeCooldown'
import { useShopConfig } from '@/composables/useShopConfig'
import { exactStockOrNull, productPurchaseLimitLabel, productStockLabel, storefrontQuantityLimit } from '@/lib/storefront-stock'
import { paymentActionLabel, shouldSubmitFromPaymentOptionClick } from '@/lib/payment-method-action'
import { isBasePriceFree, normalizeCheckoutIntent } from '@shared/checkout-policy'
import { ApiError, unifiedPay, getPayStatus, confirmOfflinePay, cancelOfflinePay, verifyCoupon as apiVerifyCoupon, fetchBalance, fetchProductDetail, requestEmailAccessCode, fetchPaymentMethods } from '@/api'
import { formatPrice } from '@/composables/useFormat'
import DeliveryInfo from '@/components/DeliveryInfo.vue'
import type { Delivery } from '@/types'
import type { PublicPaymentMethod } from '@/api'
import { normalizeFulfillmentInputConfig, resolveCheckoutFulfillmentInput } from '@shared/fulfillment-input'
import { lockBodyScroll, unlockBodyScroll } from '@/lib/body-scroll-lock'

const { isTelegram, isMobile } = usePlatform()
const { showBackButton, hideBackButton } = useTelegram()
const { getResponse, resetModalTurnstile } = useTurnstile()
const { balancePaymentEnabled, loadShopConfig } = useShopConfig()

const {
  isVisible, step, setStep, product, quantity, email, couponCode, couponValid, couponDiscount,
  fulfillmentInput, idempotencyKey, pendingAttempt,
  saveCheckoutAttempt, clearCheckoutAttempt, restartCheckoutAttempt,
  close,
} = usePayment()

const productImageFailed = ref(false)
watch(() => product.value.coverUrl, () => {
  productImageFailed.value = false
})

// ── Derived state ──

/** 用户可见的三步语义；与 form → online|offline → result 一一对应，不改状态机 */
const checkoutStepLabels = ['填写', '支付', '完成'] as const
const currentStepDot = computed(() => {
  if (step.value === 'result') return 2
  if (step.value === 'online' || step.value === 'offline') return 1
  return 0
})

const boxClass = computed(() => ({
  'box-sheet': isTelegram.value || isMobile.value,
  'box-dialog': !(isTelegram.value || isMobile.value),
}))

/** 线上支付方式显示名称 */
const PROVIDER_LABELS: Record<string, string> = {
  easypay: '易支付',
}
const providerDisplayName = computed(() => {
  if (providerName.value === 'balance') return '余额支付'
  return paymentChannelLabel.value || PROVIDER_LABELS[providerName.value] || '在线支付'
})

/** 统一支付返回的应付金额 */
const unifiedAmountCents = computed(() => orderState.value?.amountCents ?? product.value.priceCents)
const isInternalOnlineSettlement = computed(() => providerName.value === 'balance' || unifiedAmountCents.value === 0)
const showOnlinePaymentEntry = computed(() => !isInternalOnlineSettlement.value)
const onlineStepLabel = computed(() => providerName.value === 'balance' ? '余额支付' : isInternalOnlineSettlement.value ? '订单处理' : '在线支付')
const onlineStepTitle = computed(() => {
  if (unifiedAmountCents.value === 0) return '订单无需支付'
  if (providerName.value === 'balance') return '余额支付处理中'
  if (qrUrl.value) return `${providerDisplayName.value}扫码支付`
  if (paymentUrl.value) return `${providerDisplayName.value}支付`
  return `${providerDisplayName.value}状态确认`
})
const currentStock = computed(() => storefrontQuantityLimit(product.value))
const maxQuantity = computed(() => Math.max(0, currentStock.value))
const canSubmitOrder = computed(() => product.value.canPurchase !== false && maxQuantity.value > 0)
const fulfillmentInputConfig = computed(() => normalizeFulfillmentInputConfig({
  type: product.value.fulfillmentInputType,
  label: product.value.fulfillmentInputLabel,
  hint: product.value.fulfillmentInputHint,
  required: product.value.fulfillmentInputRequired,
}))
const fulfillmentInputType = computed(() => fulfillmentInputConfig.value.type)
const fulfillmentInputVisible = computed(() => fulfillmentInputType.value !== 'none')
const fulfillmentInputLabel = computed(() => fulfillmentInputConfig.value.label)
const fulfillmentInputHint = computed(() => fulfillmentInputConfig.value.hint)
/** 基础价格免费与优惠后 0 元必须分开；只有前者使用精简领取界面。 */
const isBasePriceFreeProduct = computed(() => isBasePriceFree(product.value.priceCents))
const effectiveQuantity = computed(() => isBasePriceFreeProduct.value ? 1 : quantity.value)
const productPriceLabel = computed(() => isBasePriceFreeProduct.value
  ? '免费'
  : formatPrice(product.value.priceCents, product.value.currency))
const quantityHint = computed(() => {
  const displayedLimit = productPurchaseLimitLabel(product.value)
  if (displayedLimit) return displayedLimit
  const requiresInventory = product.value.requiresInventory ?? product.value.fulfillmentMode === 'card'
  if (!requiresInventory) {
    const purchaseLimit = Number(product.value.purchaseLimit || 0)
    return purchaseLimit > 0 ? `限购 ${Math.min(99, purchaseLimit)}` : productStockLabel(product.value)
  }
  return productStockLabel(product.value)
})
const baseAmountCents = computed(() => product.value.priceCents * effectiveQuantity.value)

// ── Step 1: Form ──

const verifyingCoupon = ref(false)
const couponMsg = ref('')
const checkingBalance = ref(false)
const balanceMsg = ref('')
const balanceCents = ref(0)
const balanceChecked = ref(false)
const emailAccessCode = ref('')
const sendingEmailCode = ref(false)
const emailCodeMsg = ref('')
const emailCodeSent = ref(false)
const {
  remainingSeconds: emailCodeCooldownSeconds,
  isCoolingDown: emailCodeCoolingDown,
  buttonText: emailCodeButtonText,
  startCooldown: startEmailCodeCooldown,
  stopCooldown: stopEmailCodeCooldown,
} = useEmailCodeCooldown()
const submitting = ref(false)
const formError = ref('')
const paymentMethods = ref<PublicPaymentMethod[]>([])
const paymentMethodsLoading = ref(false)
const paymentMethodsLoaded = ref(false)
type PaymentOption = {
  key: string
  kind: 'online' | 'balance'
  label: string
  icon: string
  channel?: PublicPaymentMethod['channel']
}
const selectedPaymentMode = ref<'online' | 'balance'>('online')
const selectedPaymentChannel = ref<PublicPaymentMethod['channel']>('alipay')
const checkoutIntent = computed(() => normalizeCheckoutIntent(product.value.priceCents, {
  quantity: effectiveQuantity.value,
  couponCode: couponCode.value,
  balancePayment: selectedPaymentMode.value === 'balance',
  paymentChannel: selectedPaymentChannel.value,
  emailAccessCode: emailAccessCode.value,
}))
const payableCents = computed(() => Math.max(
  0,
  baseAmountCents.value - (!isBasePriceFreeProduct.value && couponValid.value ? couponDiscount.value : 0),
))
const balancePayAvailable = computed(() => !isBasePriceFreeProduct.value
  && balancePaymentEnabled.value
  && product.value.currency?.toUpperCase() === 'CNY')
const balanceUsable = computed(() => balanceChecked.value && balanceCents.value >= payableCents.value && payableCents.value >= 0)
const onlinePaymentOptions = computed<PaymentOption[]>(() => paymentMethods.value.map((method) => ({
    key: `online:${method.channel}`,
    kind: 'online',
    label: method.label,
    icon: paymentMethodIcon(method.channel),
    channel: method.channel,
  })))
const selectedPaymentKey = computed(() => selectedPaymentMode.value === 'balance'
  ? 'balance'
  : `online:${selectedPaymentChannel.value}`)
const showOnlinePaymentSection = computed(() => !isBasePriceFreeProduct.value
  && (paymentMethodsLoading.value || paymentMethodsLoaded.value || onlinePaymentOptions.value.length > 0))
const selectedOnlinePaymentOption = computed(() => onlinePaymentOptions.value.find((option) => option.channel === selectedPaymentChannel.value) || onlinePaymentOptions.value[0] || null)
const selectedOnlineLabel = computed(() => selectedOnlinePaymentOption.value?.label || '')
const primaryActionLabel = computed(() => paymentActionLabel({
  selectedMode: selectedPaymentMode.value,
  selectedOnlineLabel: selectedOnlineLabel.value,
  isFreeProduct: isBasePriceFreeProduct.value,
}))
const selectedOnlineAvailable = computed(() => paymentMethods.value.some((method) => method.channel === selectedPaymentChannel.value))
const isRestoringPendingAttempt = computed(() => matchesPendingCheckoutAttempt(pendingAttempt.value, {
  idempotencyKey: idempotencyKey.value,
  storefrontId: product.value.storefrontId,
  productId: product.value.id,
  buyerEmail: email.value,
  quantity: checkoutIntent.value.quantity,
  couponCode: checkoutIntent.value.couponCode,
  fulfillmentInput: fulfillmentInput.value,
  balancePayment: checkoutIntent.value.balancePayment,
  paymentChannel: checkoutIntent.value.paymentChannel,
}))
const canSubmitSelectedPayment = computed(() => {
  if (isRestoringPendingAttempt.value) return true
  if (isBasePriceFreeProduct.value) return true
  if (payableCents.value === 0) return true
  if (paymentMethodsLoading.value) return false
  if (selectedPaymentMode.value === 'balance') return balancePayAvailable.value
  return selectedOnlineAvailable.value
})
const canSubmitCheckout = computed(() => {
  if (isRestoringPendingAttempt.value) {
    return selectedPaymentMode.value !== 'balance' || balanceUsable.value
  }
  return canSubmitOrder.value && canSubmitSelectedPayment.value
})
const showOfflineNoteInOnlineStep = computed(() => Boolean(offlineNoteCode.value && providerName.value === 'offline'))

function normalizeQuantity() {
  if (isBasePriceFreeProduct.value) {
    quantity.value = 1
    return
  }
  const next = Number(quantity.value || 1)
  quantity.value = Math.min(maxQuantity.value, Math.max(1, Number.isInteger(next) ? next : 1))
}

function paymentMethodIcon(channel: PublicPaymentMethod['channel']) {
  if (channel === 'wxpay') return '微'
  if (channel === 'qqpay') return 'QQ'
  return '支'
}

function selectPaymentMethod(option: PaymentOption) {
  selectedPaymentMode.value = option.kind
  if (option.kind === 'online' && option.channel) {
    selectedPaymentChannel.value = option.channel
  }
}

function restorePendingAttemptSelection() {
  const attempt = pendingAttempt.value
  if (!attempt) {
    selectedPaymentMode.value = 'online'
    selectedPaymentChannel.value = 'alipay'
    return
  }
  selectedPaymentMode.value = attempt.balancePayment ? 'balance' : 'online'
  if (!attempt.balancePayment) {
    selectedPaymentChannel.value = attempt.paymentChannel === 'wxpay' || attempt.paymentChannel === 'qqpay'
      ? attempt.paymentChannel
      : 'alipay'
  }
}

function paymentMethodDescription(option: PaymentOption) {
  if (option.kind === 'balance') {
    return selectedPaymentMode.value === 'balance' ? '当前支付方式' : '需邮箱验证'
  }
  return selectedPaymentKey.value === option.key ? '当前支付方式' : '可用'
}

async function handlePaymentMethodClick(option: PaymentOption) {
  if (submitting.value) return
  const shouldSubmit = shouldSubmitFromPaymentOptionClick({
    clickedKind: option.kind,
    clickedChannel: option.channel,
    selectedMode: selectedPaymentMode.value,
    selectedChannel: selectedPaymentChannel.value,
    onlineOptionCount: onlinePaymentOptions.value.length,
  })
  selectPaymentMethod(option)
  if (shouldSubmit) {
    await handleSubmit()
  }
}

function reconcileSelectedPaymentOption() {
  const onlineAvailable = paymentMethods.value.length > 0
  const selectedOnlineAvailable = paymentMethods.value.some((method) => method.channel === selectedPaymentChannel.value)
  const balanceAvailable = balancePayAvailable.value

  if (selectedPaymentMode.value === 'balance') {
    if (balanceAvailable) return
    if (onlineAvailable) {
      selectedPaymentMode.value = 'online'
      selectedPaymentChannel.value = paymentMethods.value[0].channel
    }
    return
  }

  if (selectedOnlineAvailable) return
  if (onlineAvailable) {
    selectedPaymentChannel.value = paymentMethods.value[0].channel
    return
  }
  if (balanceAvailable) {
    selectedPaymentMode.value = 'balance'
  }
}

async function loadPaymentMethods(force = false) {
  if (paymentMethodsLoading.value || (paymentMethodsLoaded.value && !force)) return
  paymentMethodsLoading.value = true
  try {
    const res = await fetchPaymentMethods()
    paymentMethods.value = res.methods || []
    reconcileSelectedPaymentOption()
    paymentMethodsLoaded.value = true
  } catch (err) {
    console.warn('[pay] failed to load payment methods:', err)
    paymentMethods.value = []
    reconcileSelectedPaymentOption()
    paymentMethodsLoaded.value = true
  } finally {
    paymentMethodsLoading.value = false
  }
}

async function loadPaymentCapabilities() {
  if (isBasePriceFreeProduct.value) {
    // 免费商品不依赖系统支付开关，也不应产生 /api/pay/methods 请求。
    paymentMethods.value = []
    paymentMethodsLoading.value = false
    paymentMethodsLoaded.value = false
    selectedPaymentMode.value = 'online'
    selectedPaymentChannel.value = 'alipay'
    return
  }
  await Promise.all([
    loadShopConfig(true),
    loadPaymentMethods(true),
  ])
  reconcileSelectedPaymentOption()
}

async function refreshCurrentProductStock() {
  const latest = await fetchProductDetail(product.value.id, product.value.storefrontSlug)
  product.value = {
    ...product.value,
    ...latest,
    title: latest.name || latest.title || product.value.title,
  }
  window.dispatchEvent(new CustomEvent('products:refresh'))
  const requiresInventory = latest.requiresInventory ?? latest.fulfillmentMode === 'card'
  if (!requiresInventory) {
    const purchaseLimit = Number(latest.purchaseLimit || 0)
    return purchaseLimit > 0 ? Math.min(99, purchaseLimit) : 99
  }
  if (latest.canPurchase === false || latest.isOutOfStock) return 0
  return exactStockOrNull(latest)
}

async function verifyCoupon() {
  if (isBasePriceFreeProduct.value) return
  if (!couponCode.value.trim()) return
  verifyingCoupon.value = true
  couponMsg.value = ''
  try {
    normalizeQuantity()
    const res = await apiVerifyCoupon(
      couponCode.value.trim(),
      product.value.id,
      product.value.storefrontId,
      quantity.value,
    )
    if (res.valid) {
      couponValid.value = true
      couponDiscount.value = res.discountCents || 0
      couponMsg.value = `折扣码有效，优惠 ${formatPrice(res.discountCents || 0, product.value.currency)}`
    } else {
      couponValid.value = false
      couponDiscount.value = 0
      couponMsg.value = res.message || '折扣码无效'
    }
  } catch (err: any) {
    couponValid.value = false
    couponDiscount.value = 0
    couponMsg.value = err.message || '验证失败'
  } finally {
    verifyingCoupon.value = false
  }
}

async function checkBalance() {
  balanceMsg.value = ''
  balanceCents.value = 0
  balanceChecked.value = false
  if (!email.value.trim()) {
    balanceMsg.value = '请先输入邮箱'
    return
  }
  if (!/^\d{6}$/.test(emailAccessCode.value.trim())) {
    balanceMsg.value = '请输入邮件中的 6 位验证码'
    return
  }
  checkingBalance.value = true
  try {
    const res = await fetchBalance(email.value.trim(), emailAccessCode.value.trim())
    balanceCents.value = res.balanceCents
    balanceChecked.value = true
    balanceMsg.value = `可用余额 ¥${res.balanceYuan}`
  } catch (err: any) {
    balanceMsg.value = err.message || '余额查询失败'
  } finally {
    checkingBalance.value = false
  }
}

async function sendEmailCode() {
  emailCodeMsg.value = ''
  emailCodeSent.value = false
  if (emailCodeCoolingDown.value) {
    emailCodeMsg.value = `请 ${emailCodeCooldownSeconds.value} 秒后再发送验证码`
    return
  }
  emailAccessCode.value = ''
  balanceChecked.value = false
  balanceCents.value = 0
  balanceMsg.value = ''
  if (!email.value.trim()) {
    emailCodeMsg.value = '请先输入邮箱'
    return
  }

  sendingEmailCode.value = true
  const turnstileToken = getResponse()
  try {
    const res = await requestEmailAccessCode(email.value.trim(), turnstileToken || undefined)
    startEmailCodeCooldown(res.resendCooldownSeconds || 60)
    emailCodeSent.value = true
    emailCodeMsg.value = '验证码已发送，请检查邮箱'
  } catch (err: any) {
    const retryAfterSeconds = retryAfterSecondsFromError(err)
    if (retryAfterSeconds > 0) startEmailCodeCooldown(retryAfterSeconds)
    emailCodeMsg.value = err.message || '验证码发送失败'
  } finally {
    sendingEmailCode.value = false
    if (turnstileToken) resetModalTurnstile()
  }
}

async function handleSubmit() {
  const restoringAttempt = isRestoringPendingAttempt.value
  const displayedPriceCents = product.value.priceCents
  formError.value = ''
  if (!email.value.trim()) {
    formError.value = '请输入邮箱'
    return
  }
  const fulfillmentCheck = resolveCheckoutFulfillmentInput(fulfillmentInputConfig.value, fulfillmentInput.value, {
    restoringAttempt,
    preservedValue: pendingAttempt.value?.fulfillmentInput,
  })
  if (!fulfillmentCheck.ok) {
    formError.value = fulfillmentCheck.message
    return
  }
  const submittedFulfillmentInput = fulfillmentCheck.value
  fulfillmentInput.value = submittedFulfillmentInput
  if (!restoringAttempt && !canSubmitOrder.value) {
    formError.value = '当前商品库存不足，请返回商品列表刷新后重试'
    return
  }
  submitting.value = true
  try {
    if (!restoringAttempt) {
      const latestStock = await refreshCurrentProductStock()
      if (product.value.priceCents !== displayedPriceCents) {
        // 禁止在弹窗打开后静默按新价格扣款，免费与付费模式切换时也必须让用户重新确认。
        restartCheckoutAttempt()
        couponCode.value = ''
        couponValid.value = false
        couponDiscount.value = 0
        couponMsg.value = ''
        quantity.value = 1
        if (!isBasePriceFreeProduct.value) await loadPaymentCapabilities()
        formError.value = `商品价格已更新为 ${productPriceLabel.value}，请确认后重新提交`
        return
      }
      normalizeQuantity()
      // 前端先刷新库存降低失败率；真正的防超卖仍靠后端事务内锁库存。
      if (latestStock !== null && latestStock < effectiveQuantity.value) {
        quantity.value = Math.max(1, latestStock)
        formError.value = latestStock > 0
          ? `当前实时库存仅剩 ${latestStock} 件，已为你调整数量，请确认后重试`
          : '该商品刚刚售罄，请返回商品列表选择其它商品'
        return
      }
    }

    const intent = checkoutIntent.value
    const useBalance = intent.balancePayment
    if (!restoringAttempt && !canSubmitSelectedPayment.value) {
      formError.value = '暂无可用支付方式，请联系管理员检查支付配置'
      return
    }
    if (useBalance && !balanceUsable.value) {
      formError.value = '余额不足，请先兑换充值码或选择其它支付方式'
      return
    }
    if (useBalance && !/^\d{6}$/.test(intent.emailAccessCode)) {
      // 余额支付必须先证明邮箱归属；验证码只发给邮箱本人，避免知道邮箱即可花掉余额。
      formError.value = '请输入邮件中的 6 位验证码'
      return
    }

    const token = getResponse()
    const attemptSaved = saveCheckoutAttempt({
      idempotencyKey: idempotencyKey.value,
      storefrontId: product.value.storefrontId,
      productId: product.value.id,
      buyerEmail: email.value,
      quantity: intent.quantity,
      couponCode: intent.couponCode,
      fulfillmentInput: submittedFulfillmentInput,
      balancePayment: useBalance,
      paymentChannel: intent.paymentChannel,
    })
    if (!attemptSaved) {
      restartCheckoutAttempt()
      formError.value = '检测到上次未完成的付款参数已不适用于当前商品设置，已清理本地恢复状态，请再次点击支付'
      return
    }
    const res = await unifiedPay({
      storefrontId: product.value.storefrontId,
      productId: product.value.id,
      buyerEmail: email.value.trim(),
      quantity: intent.quantity,
      couponCode: intent.couponCode || undefined,
      fulfillmentInput: submittedFulfillmentInput || undefined,
      turnstileToken: useBalance ? undefined : token || undefined,
      balancePayment: isBasePriceFreeProduct.value ? undefined : useBalance,
      paymentChannel: intent.paymentChannel || undefined,
      emailAccessCode: intent.emailAccessCode || undefined,
      idempotencyKey: idempotencyKey.value,
    })
    clearCheckoutAttempt(idempotencyKey.value)

    setOrderState({
      orderId: res.orderId,
      orderNo: res.orderNo,
      orderToken: res.orderToken,
      amountCents: res.amountCents,
      productId: res.productId || product.value.id,
      productTitle: res.productTitle || product.value.title,
      currency: res.currency,
      quantity: res.quantity,
      fulfillmentMode: res.fulfillmentMode || product.value.fulfillmentMode,
      expiresAt: res.expiresAt,
      isFreeCheckout: isBasePriceFreeProduct.value,
    })
    if (res.mode === 'balance' || res.mode === 'free') {
      if (res.status === 'issued' || res.delivery || res.deliveryMessage || (res.cards && res.cards.length > 0)) {
        const cardCount = res.cards?.length || 0
        const desc = res.deliveryMessage || (res.amountCents === 0
          ? (cardCount > 1 ? '订单无需支付，多张卡密已发放' : '订单无需支付，交付已完成')
          : (cardCount > 1 ? '余额支付已完成，多张卡密已发放' : '余额支付已完成'))
        showResult('success', isBasePriceFreeProduct.value ? '领取成功' : '支付成功', desc, res.delivery, res.cards)
      } else {
        setOnlinePayment(res.mode, '', '', res.amountCents === 0 ? '订单无需支付，正在确认交付结果' : '')
        setStep('online')
        startOnlinePolling()
      }
    } else if (res.mode === 'online') {
      if (res.amountCents === 0) {
        setOnlinePayment('free', '', '', '订单无需支付，正在确认交付结果')
        setStep('online')
        startOnlinePolling()
        return
      }
      // 后端已把 EasyPay 的 img/qrcode 拆开：前端二维码图片只使用 qrImageUrl/qrcode，
      // 原始二维码内容 qrContent 不直接放进 <img>，避免浏览器渲染失败或误当作图片 URL。
      setOnlinePayment(res.provider || '', res.qrImageUrl || res.qrcode || '', res.redirectUrl || '', res.message || '', res.paymentChannelLabel || '')
      setStep('online')
      startOnlinePolling()
    } else {
      // 线下支付：保存收款码和备注码
      setOfflinePayment(res)
      setStep('offline')
      startOfflineCountdown(res.expiresAt)
    }
  } catch (err: any) {
    const recoverableCreationError = err instanceof ApiError
      && (err.code === 'PAYMENT_CREATION_UNCERTAIN' || err.code === 'PAYMENT_STATE_CHANGED')
    const details = recoverableCreationError ? err.details : undefined
    const recoveryOrderId = typeof details?.orderId === 'string' ? details.orderId : ''
    const recoveryOrderToken = typeof details?.orderToken === 'string' ? details.orderToken : ''
    if (recoveryOrderId && recoveryOrderToken) {
      setOrderState({
        orderId: recoveryOrderId,
        orderNo: typeof details?.orderNo === 'string' ? details.orderNo : undefined,
        orderToken: recoveryOrderToken,
        amountCents: typeof details?.amountCents === 'number' ? details.amountCents : payableCents.value,
        productId: typeof details?.productId === 'string' ? details.productId : product.value.id,
        productTitle: typeof details?.productTitle === 'string' ? details.productTitle : product.value.title,
        currency: typeof details?.currency === 'string' ? details.currency : product.value.currency,
        quantity: typeof details?.quantity === 'number' ? details.quantity : quantity.value,
        fulfillmentMode: typeof details?.fulfillmentMode === 'string' ? details.fulfillmentMode : product.value.fulfillmentMode,
        expiresAt: typeof details?.expiresAt === 'string' ? details.expiresAt : undefined,
        isFreeCheckout: isBasePriceFreeProduct.value,
      })
      clearCheckoutAttempt(idempotencyKey.value)
      setOnlinePayment(
        typeof details?.provider === 'string' ? details.provider : '',
        '',
        '',
        typeof details?.message === 'string' ? details.message : '支付渠道响应异常，正在确认订单状态',
        typeof details?.paymentChannelLabel === 'string' ? details.paymentChannelLabel : '',
      )
      formError.value = ''
      setStep('online')
      startOnlinePolling()
      return
    }
    if (err instanceof ApiError && shouldClearCheckoutAttemptForError(err.code)) {
      clearCheckoutAttempt(idempotencyKey.value)
    }
    formError.value = err.message || '下单失败，请稍后重试'
    if (err?.status === 409 || String(formError.value).includes('库存')) {
      try {
        const latestStock = await refreshCurrentProductStock()
        if (latestStock !== null && latestStock > 0) {
          quantity.value = Math.min(quantity.value, latestStock)
        }
      } catch {
        window.dispatchEvent(new CustomEvent('products:refresh'))
      }
    }
  } finally {
    submitting.value = false
  }
}

// ── Step 2/3: Payment flow ──

const {
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
} = useCheckoutFlow({ setStep, getPayStatus, showResult })

const {
  wechatQr,
  alipayQr,
  offlineNoteCode,
  offlineHint,
  confirming,
  refLast4,
  confirmError,
  offlineConfirmStatus,
  setOfflinePayment,
  confirm: confirmOfflinePayment,
  resetOfflinePayment,
} = useOfflinePayment({ confirmOfflinePay, startStatusPolling })

const hasOfflineQr = computed(() => Boolean(wechatQr.value || alipayQr.value))

async function handleConfirmOffline() {
  if (!orderState.value) return
  await confirmOfflinePayment(orderState.value.orderId, orderState.value.orderToken)
}

async function cancelPendingOfflineOrder() {
  if (step.value !== 'offline' || !orderState.value?.orderId || !orderState.value?.orderToken) return
  stopPolling()
  try {
    await cancelOfflinePay({
      orderId: orderState.value.orderId,
      orderToken: orderState.value.orderToken,
    })
  } catch (err) {
    console.warn('[pay] failed to cancel offline order:', err)
  }
}

// ── Step 4: Result ──

const resultStatus = ref('')
const resultTitle = ref('')
const resultDesc = ref('')
/** 原始的交付数据对象，直接传给 DeliveryInfo 组件动态渲染（支持卡密和虚拟资料两种模式） */
const resultDelivery = ref<Delivery | null>(null)
const resultCards = ref<Array<{ id?: string; accountLabel?: string; deliverySecret?: string; deliveryNote?: string; cardData: string }>>([])

function showResult(type: string, title: string, desc: string, deliveryData?: Delivery, cardsData: Array<{ id?: string; accountLabel?: string; deliverySecret?: string; deliveryNote?: string; cardData: string }> = []) {
  resultStatus.value = type
  resultTitle.value = title
  resultDesc.value = desc
  resultCards.value = cardsData
  resultDelivery.value = null
  if (deliveryData) {
    // 直接存储原始 Delivery，由 DeliveryInfo 组件根据字段名渲染对应标签
    resultDelivery.value = deliveryData
  }
  setStep('result')

}

const resultIcon = computed(() => {
  const icons: Record<string, string> = {
    success: '✓',
    error: '✕',
    pending: '⟳',
    warning: '⚠',
  }
  return icons[resultStatus.value] || '⟳'
})

// ── Navigation / chrome（共享滚动锁 + Esc；不改支付状态机）──

/** 本实例是否已向共享 body 锁 acquire 过（防重复 lock/unlock） */
let holdsBodyScrollLock = false

function acquireBodyScrollLock() {
  if (holdsBodyScrollLock) return
  lockBodyScroll()
  holdsBodyScrollLock = true
}

function releaseBodyScrollLock() {
  if (!holdsBodyScrollLock) return
  unlockBodyScroll()
  holdsBodyScrollLock = false
}

/**
 * 支付中关闭需确认（与遮罩点击一致）；H5 关闭钮 / Esc 共用。
 * 填写与结果步直接关闭。
 */
function requestClose() {
  if (step.value === 'online' || step.value === 'offline') {
    // Telegram 中 confirm 不可用，直接关闭
    if (isTelegram.value) {
      void handleClose()
      return
    }
    const ok = confirm(step.value === 'offline'
      ? '支付尚未完成，关闭将取消该订单并释放库存。确定关闭吗？'
      : '支付尚未完成，关闭只会停止本页轮询；订单会保留到超时，以免扫码后回调丢单。确定关闭吗？')
    if (ok) void handleClose()
    return
  }
  void handleClose()
}

async function goBack() {
  await handleClose()
}

function handleOverlayClick() {
  // 仅支付中点遮罩触发确认关闭；填写/结果不误关
  if (step.value === 'online' || step.value === 'offline') {
    requestClose()
  }
}

function onPayKeydown(event: KeyboardEvent) {
  if (!isVisible.value) return
  if (event.key !== 'Escape') return
  // Telegram 用 BackButton；H5 才 Esc 关闭
  if (isTelegram.value) return
  event.preventDefault()
  event.stopPropagation()
  requestClose()
}

async function handleClose() {
  await cancelPendingOfflineOrder()
  stopPolling()
  if (isTelegram.value) {
    hideBackButton()
  }
  close()
  window.dispatchEvent(new CustomEvent('payment:closed'))
  resetCheckoutFlow()
  resetOfflinePayment()
  formError.value = ''
  couponMsg.value = ''
  balanceMsg.value = ''
  balanceCents.value = 0
  balanceChecked.value = false
  emailAccessCode.value = ''
  emailCodeMsg.value = ''
  emailCodeSent.value = false
  resultDelivery.value = null
  resultCards.value = []
  resetModalTurnstile()
}

// Show/hide Telegram BackButton
watch([isVisible, step], ([vis, s]) => {
  if (isTelegram.value && vis && s !== 'result') {
    showBackButton(() => {
      if (s === 'form') {
        void handleClose()
      } else {
        void goBack()
      }
    })
  }
  if (!vis) {
    hideBackButton()
  }
})

watch(email, () => {
  emailAccessCode.value = ''
  emailCodeMsg.value = ''
  emailCodeSent.value = false
  stopEmailCodeCooldown()
  balanceMsg.value = ''
  balanceCents.value = 0
  balanceChecked.value = false
})

watch(emailAccessCode, () => {
  balanceMsg.value = ''
  balanceCents.value = 0
  balanceChecked.value = false
})

watch(balancePayAvailable, () => {
  if (isVisible.value) reconcileSelectedPaymentOption()
})

watch(isVisible, (vis) => {
  if (vis) {
    restorePendingAttemptSelection()
    loadPaymentCapabilities()
    // 确认层 → 收银台：ShopView 先关确认再 open；共享引用计数使 handoff 期间不断锁
    acquireBodyScrollLock()
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', onPayKeydown, true)
    }
  } else {
    selectedPaymentMode.value = 'online'
    selectedPaymentChannel.value = 'alipay'
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', onPayKeydown, true)
    }
    releaseBodyScrollLock()
  }
})

onUnmounted(() => {
  stopPolling()
  stopEmailCodeCooldown()
  if (typeof window !== 'undefined') {
    window.removeEventListener('keydown', onPayKeydown, true)
  }
  releaseBodyScrollLock()
})


</script>

<style scoped>
/* ── Overlay ── */
.pay-overlay {
  position: fixed;
  inset: 0;
  background: var(--overlay);
  z-index: 1000;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}

.box-dialog {
  align-self: center;
  width: 460px;
  max-height: 85vh;
  border-radius: var(--r-xl);
}

.box-sheet {
  width: 100%;
  max-height: 85vh;
  border-radius: var(--r-xl) var(--r-xl) 0 0;
}

.pay-box {
  background: var(--tg-bg);
  padding: 16px 16px 18px;
  padding-bottom: calc(18px + env(safe-area-inset-bottom, 0px));
  overflow-y: auto;
  position: relative;
  box-shadow: var(--shadow-lg);
}

/* ── 顶栏：步骤 + 关闭（避免绝对定位与步骤条重叠） ── */
.pay-topbar {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-bottom: 12px;
  min-height: 32px;
}

/* ── Close button ── */
.pay-close {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  margin-top: 0;
  border: none;
  border-radius: var(--r-full);
  background: var(--surface);
  color: var(--tg-hint);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background var(--duration-fast) var(--ease-out);
}

.pay-close:hover {
  background: var(--surface-hover);
  color: var(--tg-text);
}

/* ── Step indicator（填写 → 支付 → 完成） ── */
.step-indicator {
  display: flex;
  align-items: flex-start;
  justify-content: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
  margin: 0;
  /* 无关闭钮时（Telegram）仍保持视觉居中 */
  padding-inline: 4px;
}

.step-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1;
  max-width: 88px;
}

.step-dot {
  width: 100%;
  max-width: 36px;
  height: 3px;
  border-radius: 2px;
  background: var(--surface-hover);
  transition: background var(--duration-normal) var(--ease-out),
              max-width var(--duration-normal) var(--ease-out);
}

.step-item.active .step-dot {
  background: var(--tg-btn);
  max-width: 44px;
}

.step-item.done .step-dot {
  background: var(--admin-success, #22c55e);
}

.step-caption {
  font-size: 11px;
  font-weight: 500;
  line-height: 1.2;
  color: var(--tg-hint);
  white-space: nowrap;
}

.step-item.active .step-caption {
  color: var(--tg-text);
  font-weight: 600;
}

.step-item.done .step-caption {
  color: var(--tg-hint);
}

/* ── Step content ── */
.pay-step-content {
  animation: fadeInUp var(--duration-normal) var(--ease-out);
}

.step-header {
  margin-bottom: 12px;
}

/* 统一层级：主标题在上，副文案在下（各 step 一致） */
.step-title {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 0;
  line-height: 1.25;
}

.step-subtitle {
  margin: 4px 0 0;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.3;
  color: var(--tg-hint);
}

/* ── Order summary ── */
.order-summary {
  display: flex;
  gap: 10px;
  padding: 10px 12px;
  background: var(--surface);
  border-radius: var(--r-md);
  margin-bottom: 12px;
  border: 0.5px solid var(--border);
}

.summary-cover {
  width: 48px;
  height: 48px;
  border-radius: var(--r-sm);
  overflow: hidden;
  flex-shrink: 0;
  background: var(--surface-hover);
  display: flex;
  align-items: center;
  justify-content: center;
}

.summary-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.summary-icon {
  font-size: 24px;
}

.summary-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
}

.summary-title {
  font-size: 14px;
  font-weight: 600;
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.summary-price {
  font-size: 15px;
  font-weight: 700;
  color: var(--tg-btn);
  line-height: 1.25;
}

/* ── Order fields group（消除商品与表单之间的悬空白） ── */
.order-fields {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 12px;
}

.field-block {
  min-width: 0;
}

/* ── Quantity ── */
.quantity-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 40px;
}

.quantity-label {
  font-size: 13px;
  color: var(--tg-hint);
  flex-shrink: 0;
}

.quantity-control {
  display: inline-flex;
  align-items: center;
  border: 0.5px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface);
  overflow: hidden;
}

.quantity-btn {
  width: 36px;
  height: 36px;
  border: none;
  background: transparent;
  color: var(--tg-text);
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background var(--duration-fast) var(--ease-out);
  user-select: none;
}

.quantity-btn:hover:not(:disabled) {
  background: var(--surface-hover);
}

.quantity-btn:disabled {
  opacity: 0.35;
  pointer-events: none;
}

.quantity-control input {
  width: 56px;
  height: 36px;
  border: none;
  border-left: 0.5px solid var(--border);
  border-right: 0.5px solid var(--border);
  background: transparent;
  color: var(--tg-text);
  text-align: center;
  font-size: 14px;
  font-weight: 500;
  font-family: var(--font-mono);
  outline: none;
  -moz-appearance: textfield;
}

.quantity-control input::-webkit-outer-spin-button,
.quantity-control input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

.quantity-hint {
  font-size: 12px;
  color: var(--tg-hint);
  margin-left: auto;
}

/* ── Form fields ── */
.field-label,
.field-help {
  display: block;
  margin-bottom: 6px;
  color: var(--tg-hint);
  font-size: 12px;
}

.field-help {
  margin-top: 6px;
  margin-bottom: 0;
}

/* ── Coupon ── */
.coupon-row {
  display: flex;
  gap: 8px;
}

.coupon-row input {
  flex: 1;
  min-width: 0;
}

.coupon-row .btn-sm {
  flex-shrink: 0;
}

.coupon-msg {
  font-size: 12px;
  margin-top: 6px;
  line-height: 1.35;
}

.coupon-msg.valid { color: var(--admin-success, #22c55e); }
.coupon-msg.invalid { color: var(--admin-danger, #ef4444); }

.email-code-row {
  display: flex;
  gap: 8px;
  margin-bottom: 4px;
}

.email-code-row input {
  flex: 1;
  min-width: 0;
}

.email-code-row .btn-sm {
  flex-shrink: 0;
  white-space: nowrap;
}

.email-code-msg {
  font-size: 13px;
  margin-bottom: 10px;
}

.email-code-msg.valid { color: #22c55e; }
.email-code-msg.invalid { color: #ef4444; }

.balance-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 12px;
  min-height: 32px;
}

.balance-row .btn-sm {
  flex-shrink: 0;
}

.balance-msg {
  font-size: 13px;
  line-height: 1.35;
  word-break: break-word;
}

.balance-msg.valid { color: #22c55e; }
.balance-msg.invalid { color: #ef4444; }

.payment-method-section {
  margin: 0 0 10px;
}

.payment-method-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
  color: var(--tg-text);
  font-size: 13px;
  font-weight: 600;
}

.payment-method-heading small {
  color: var(--tg-hint);
  font-size: 12px;
  font-weight: 400;
}

.payment-method-loading {
  padding: 10px 12px;
  border: 0.5px solid var(--border);
  border-radius: var(--r-md);
  color: var(--tg-hint);
  background: var(--surface);
  font-size: 13px;
}

.payment-method-empty {
  padding: 10px 12px;
  border: 0.5px solid rgba(239, 68, 68, 0.36);
  border-radius: var(--r-md);
  color: #ef4444;
  background: rgba(239, 68, 68, 0.08);
  font-size: 13px;
}

.payment-method-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.payment-method-grid.single {
  grid-template-columns: 1fr;
}

.payment-method-card {
  min-height: 64px;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 10px;
  border: 0.5px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface);
  color: var(--tg-text);
  padding: 12px 14px;
  text-align: left;
  cursor: pointer;
  transition: border-color var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
}

.payment-method-section > .payment-method-card {
  width: 100%;
}

.payment-method-card:hover:not(:disabled) {
  border-color: rgba(96, 165, 250, 0.62);
  background: rgba(96, 165, 250, 0.1);
}

.payment-method-card:active:not(:disabled) {
  transform: translateY(1px);
}

.payment-method-card.active {
  border-color: var(--tg-btn);
  background: rgba(59, 130, 246, 0.16);
}

.payment-method-icon {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--r-sm);
  color: #fff;
  font-size: 14px;
  line-height: 1;
  flex-shrink: 0;
}

.payment-method-copy {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.payment-method-label {
  color: var(--tg-text);
  font-size: 15px;
  font-weight: 700;
  line-height: 1.25;
}

.payment-method-desc {
  color: var(--tg-hint);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.25;
}

.payment-method-badge {
  flex-shrink: 0;
  padding: 3px 7px;
  border-radius: var(--r-full);
  background: rgba(96, 165, 250, 0.16);
  color: var(--tg-btn);
  font-size: 11px;
  font-weight: 700;
  line-height: 1.2;
}

.payment-method-card.alipay .payment-method-icon {
  background: #00a3ee;
}

.payment-method-card.wxpay .payment-method-icon {
  background: #13b900;
}

.payment-method-card.qqpay .payment-method-icon {
  background: #12b7f5;
  font-size: 11px;
}

.payment-method-card.balance .payment-method-icon {
  background: #64748b;
}

.balance-auth-section {
  margin: -2px 0 12px;
  padding: 12px;
  border: 0.5px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface);
}

.balance-auth-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
  color: var(--tg-text);
  font-size: 14px;
  font-weight: 600;
}

.balance-auth-heading small,
.balance-auth-hint {
  color: var(--tg-hint);
  font-size: 12px;
  font-weight: 400;
}

.balance-auth-section .balance-row {
  margin-bottom: 6px;
}

.balance-auth-hint {
  margin: 0;
  line-height: 1.4;
}

.pay-action-row {
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
  margin-top: 4px;
}

.pay-action-row .btn-full {
  width: 100%;
  margin-top: 0;
}

/* ── Form error ── */
.form-error {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--admin-danger, #ef4444);
}

.btn-full {
  width: 100%;
  margin-top: 0;
}

/* ── Payment amount ── */
.pay-amount {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  background: var(--surface);
  border-radius: var(--r-md);
  margin-bottom: 20px;
  font-size: 14px;
  color: var(--tg-hint);
}

.pay-amount strong {
  font-size: 22px;
  font-weight: 700;
  color: var(--tg-text);
}

.offline-order-summary {
  margin: -8px 0 18px;
  padding: 12px 14px;
  background: rgba(255, 255, 255, 0.03);
  border: 0.5px solid var(--border);
  border-radius: var(--r-md);
}

.offline-summary-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.offline-summary-row span,
.offline-summary-grid span {
  color: var(--tg-hint);
  font-size: 12px;
}

.offline-summary-row strong,
.offline-summary-grid strong,
.offline-summary-grid code {
  color: var(--tg-text);
  font-size: 13px;
  font-weight: 600;
  word-break: break-word;
}

.offline-summary-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 12px;
}

.offline-summary-grid > div {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.offline-summary-grid code {
  font-family: var(--font-mono);
}

.offline-title {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}

.pay-timer-inline {
  font-family: var(--font-mono);
  font-size: 16px;
  font-weight: 700;
  color: var(--tg-btn);
  letter-spacing: 0.03em;
}

/* ── QR code ── */
.qr-wrapper {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  min-height: 200px;
}

.qr-image {
  max-width: 200px;
  border-radius: var(--r-md);
}

.qr-placeholder {
  width: 200px;
  height: 200px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  color: var(--tg-hint);
}

.online-payment-link {
  min-width: 180px;
  justify-content: center;
}

/* ── Offline QR ── */
.offline-qr-row {
  display: flex;
  gap: 16px;
  justify-content: center;
  margin-bottom: 16px;
}

.qr-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  min-width: 132px;
}

.qr-item img {
  max-width: 140px;
  width: 100%;
  height: auto;
  aspect-ratio: 1;
  border-radius: var(--r-md);
  object-fit: cover;
}

.qr-label {
  font-size: 13px;
  color: var(--tg-hint);
}

.qr-empty {
  width: 132px;
  height: 132px;
  border: 1px dashed var(--border);
  border-radius: var(--r-md);
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  color: var(--tg-hint);
  background: var(--surface);
  line-height: 1.5;
  font-size: 13px;
}

.pay-warning {
  margin: -4px 0 14px;
  padding: 10px 12px;
  border-radius: var(--r-md);
  background: rgba(245, 158, 11, 0.12);
  color: #fbbf24;
  font-size: 13px;
  line-height: 1.45;
}

/* ── Note code ── */
.note-section {
  margin: 16px 0;
  padding: 12px 16px;
  background: var(--surface);
  border-radius: var(--r-md);
}

.note-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 14px;
}

.note-code {
  font-family: var(--font-mono);
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: var(--tg-btn);
}

.note-hint {
  margin-top: 6px;
  font-size: 12px;
  color: var(--tg-hint);
}

/* ── Confirm section ── */
.confirm-section {
  margin-top: 16px;
}

.confirm-divider {
  height: 0.5px;
  background: var(--border);
  margin: 16px 0;
}

.confirm-title {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 4px;
}

.confirm-desc {
  font-size: 13px;
  color: var(--tg-hint);
  margin-bottom: 12px;
  line-height: 1.45;
}

.confirm-input-row {
  display: flex;
  gap: 8px;
}

.confirm-input-row input {
  flex: 1;
  text-align: center;
  letter-spacing: 0.15em;
  font-size: 18px;
  font-family: var(--font-mono);
}

.confirm-input-row .btn-sm {
  flex-shrink: 0;
}

.confirm-error {
  margin-top: 8px;
  font-size: 13px;
  color: #ef4444;
}

/* ── Pay hint / timer ── */
.payment-status-panel {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 12px;
  padding: 10px 12px;
  border: 0.5px solid var(--border);
  border-radius: var(--r-md);
  background: rgba(255, 255, 255, 0.03);
}

.payment-status-panel.compact {
  margin-top: 16px;
}

.pay-hint {
  font-size: 14px;
  color: var(--tg-hint);
  text-align: center;
  margin-top: 12px;
}

.payment-status-panel .pay-hint {
  margin: 0;
  min-width: 0;
  line-height: 1.45;
  text-align: left;
}

.pay-timer {
  flex-shrink: 0;
  margin: 0 0 0 auto;
  padding: 4px 8px;
  border-radius: var(--r-md);
  background: rgba(59, 130, 246, 0.12);
  color: var(--tg-text);
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 700;
  white-space: nowrap;
}

/* ── Step actions ── */
.step-actions {
  margin-top: 20px;
  display: flex;
  gap: 8px;
  justify-content: center;
}

/* ── Result ── */
.result-content {
  text-align: center;
}

.result-status {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 16px;
  border-radius: var(--r-lg);
  margin-bottom: 16px;
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

.result-status.result-success {
  background: rgba(34, 197, 94, 0.12);
  color: #22c55e;
}

.result-status.result-error {
  background: rgba(239, 68, 68, 0.12);
  color: #ef4444;
}

.result-status.result-pending,
.result-status.result-warning {
  background: rgba(245, 158, 11, 0.12);
  color: #f59e0b;
}

.result-desc {
  font-size: 14px;
  color: var(--tg-hint);
  margin-top: 8px;
}

/* ── Delivery box ── */
.delivery-box {
  text-align: left;
  padding: 14px 16px;
  background: var(--surface);
  border-radius: var(--r-md);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.delivery-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
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

.order-link-row {
  text-align: center;
  margin-top: 12px;
}

/* ── Transitions ── */
.pay-fade-enter-active,
.pay-fade-leave-active {
  transition: opacity var(--duration-normal) var(--ease-out);
}

.pay-fade-enter-from,
.pay-fade-leave-to {
  opacity: 0;
}

.pay-slide-enter-active {
  transition: transform var(--duration-normal) var(--ease-out);
}

.pay-slide-leave-active {
  transition: transform var(--duration-fast) var(--ease-out);
}

.pay-slide-enter-from,
.pay-slide-leave-to {
  transform: translateY(100%);
}

.box-dialog.pay-slide-enter-from {
  transform: translateY(20px);
  opacity: 0;
}

.box-dialog.pay-slide-enter-active {
  transition: transform var(--duration-normal) var(--ease-out),
              opacity var(--duration-normal) var(--ease-out);
}

@media (max-width: 640px) {
  .pay-action-row {
    position: sticky;
    bottom: 0;
    z-index: 4;
    margin: 8px -2px 0;
    padding: 8px 2px 0;
    background: var(--tg-bg);
  }
}
</style>
