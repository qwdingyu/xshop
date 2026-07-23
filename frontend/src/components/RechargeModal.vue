<template>
  <Teleport to="body">
    <div v-if="visible" class="recharge-overlay" role="presentation" @click.self="close">
      <section class="recharge-dialog" role="dialog" aria-modal="true" aria-labelledby="recharge-title">
        <header class="recharge-header">
          <div><span class="recharge-eyebrow">人民币余额</span><h2 id="recharge-title">{{ title }}</h2></div>
          <button class="recharge-close" type="button" aria-label="关闭充值窗口" :disabled="submitting" @click="close">×</button>
        </header>

        <form v-if="step === 'form'" class="recharge-body" @submit.prevent="submit">
          <div class="amount-presets" role="group" aria-label="充值金额">
            <button v-for="value in presetAmounts" :key="value" type="button" :class="{ active: amountCents === value }" @click="setAmount(value)">
              {{ formatMoney(value, 'CNY') }}
            </button>
          </div>
          <label class="recharge-field"><span>自定义金额（元）</span><input v-model="amountYuan" inputmode="decimal" placeholder="1.00 - 5000.00" @input="syncCustomAmount" /></label>
          <label class="recharge-field"><span>到账邮箱</span><input v-model="email" type="email" autocomplete="email" placeholder="余额将绑定到该邮箱" /></label>
          <div class="code-row">
            <label class="recharge-field"><span>邮箱验证码</span><input v-model="emailCode" inputmode="numeric" maxlength="6" autocomplete="one-time-code" enterkeyhint="go" placeholder="6 位验证码" /></label>
            <button type="button" class="btn btn-ghost" :disabled="sendingCode || isCoolingDown || methodsLoading || methods.length === 0" @click="sendCode">{{ sendingCode ? '发送中…' : buttonText }}</button>
          </div>
          <Turnstile container-id="recharge-turnstile" />
          <div v-if="methods.length > 0" class="recharge-methods" role="group" aria-label="充值支付方式">
            <button v-for="method in methods" :key="method.channel" type="button" :class="{ active: selectedChannel === method.channel }" @click="selectedChannel = method.channel">
              {{ method.label }}
            </button>
          </div>
          <p v-if="paymentAvailabilityError" class="recharge-error" role="alert">{{ paymentAvailabilityError }}</p>
          <p v-if="error" class="recharge-error" role="alert">{{ error }}</p>
          <button class="btn btn-primary recharge-primary" type="submit" :disabled="submitting || methodsLoading || methods.length === 0">
            {{ submitting ? '验证并创建充值订单…' : `验证并充值 ${formatMoney(amountCents, 'CNY')}` }}
          </button>
        </form>

        <div v-else class="recharge-body recharge-payment">
          <div class="recharge-summary"><span>充值金额</span><strong>{{ formatMoney(amountCents, 'CNY') }}</strong><small>{{ orderNo }}</small></div>
          <img v-if="qrImageUrl" class="recharge-qr" :src="qrImageUrl" alt="充值付款二维码" />
          <a v-if="redirectUrl" class="btn btn-primary recharge-primary" :href="redirectUrl" target="_blank" rel="noopener noreferrer">打开{{ paymentLabel }}付款</a>
          <div class="recharge-state" :class="status">
            <strong>{{ statusTitle }}</strong>
            <span>{{ statusMessage }}</span>
          </div>
          <p v-if="error" class="recharge-error" role="alert">{{ error }}</p>
          <button v-if="status === 'paid'" class="btn btn-primary recharge-primary" type="button" @click="close">完成</button>
          <button v-else-if="status === 'expired' || status === 'failed'" class="btn btn-ghost recharge-primary" type="button" @click="restart">重新充值</button>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { ApiError, createBalanceRecharge, fetchBalanceRechargeStatus, fetchPaymentMethods, requestEmailAccessCode, type PublicPaymentMethod } from '@/api'
import { useRecharge } from '@/composables/useRecharge'
import { useShopConfig } from '@/composables/useShopConfig'
import { retryAfterSecondsFromError, useEmailCodeCooldown } from '@/composables/useEmailCodeCooldown'
import { useTurnstile } from '@/composables/useTurnstile'
import Turnstile from '@/components/Turnstile.vue'
import { parseYuanToCents } from '@/utils/currency'
import { formatMoney, minorToMajorString } from '@shared/money'

type RechargeStatus = 'pending' | 'paid' | 'expired' | 'failed'
type StoredRecharge = { idempotencyKey: string; email: string; amountCents: number; channel: PublicPaymentMethod['channel']; createdAt: string; orderId?: string; orderNo?: string; orderToken?: string; expiresAt?: string; qrImageUrl?: string; redirectUrl?: string; paymentLabel?: string }

const STORAGE_KEY = 'pending_balance_recharge'
const PENDING_RECHARGE_TTL_MS = 2 * 60 * 60 * 1000
const { visible, closeRecharge } = useRecharge()
const { balanceRechargeMinCents, balanceRechargeMaxCents, loadShopConfig } = useShopConfig()
const { getRechargeResponse, resetRechargeTurnstile } = useTurnstile()
const { isCoolingDown, buttonText, startCooldown } = useEmailCodeCooldown()
const step = ref<'form' | 'payment'>('form')
const email = ref('')
const emailCode = ref('')
const amountYuan = ref('50.00')
const amountCents = ref(5000)
const methods = ref<PublicPaymentMethod[]>([])
const selectedChannel = ref<PublicPaymentMethod['channel']>('alipay')
const sendingCode = ref(false)
const submitting = ref(false)
const methodsLoading = ref(false)
const methodsLoadError = ref('')
const error = ref('')
const orderId = ref('')
const orderNo = ref('')
const orderToken = ref('')
const qrImageUrl = ref('')
const redirectUrl = ref('')
const paymentLabel = ref('支付宝')
const status = ref<RechargeStatus>('pending')
let idempotencyKey = createKey()
let pollTimer: ReturnType<typeof setInterval> | undefined

const presetAmounts = computed(() => [1000, 2000, 5000, 10000, 20000, 50000].filter((value) => value >= balanceRechargeMinCents.value && value <= balanceRechargeMaxCents.value))
const paymentAvailabilityError = computed(() => {
  if (methodsLoading.value) return ''
  if (methodsLoadError.value) return methodsLoadError.value
  return methods.value.length === 0 ? '暂无可用在线支付渠道，请联系管理员启用支付配置后重试' : ''
})
const title = computed(() => step.value === 'form' ? '在线充值' : status.value === 'paid' ? '充值成功' : '等待付款')
const statusTitle = computed(() => ({ pending: '等待支付确认', paid: '余额已到账', expired: '充值订单已过期', failed: '充值订单创建失败' })[status.value])
const statusMessage = computed(() => status.value === 'pending' ? '付款完成后页面会自动确认，请勿重复创建订单。' : status.value === 'paid' ? `${formatMoney(amountCents.value, 'CNY')} 已充入 ${email.value}` : '该订单不会再入账，可以重新发起充值。')

function setAmount(value: number) { amountCents.value = value; amountYuan.value = minorToMajorString(value, 'CNY') }
function syncCustomAmount() { amountCents.value = parseYuanToCents(amountYuan.value) ?? 0 }
function createKey() { return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) => value.toString(16).padStart(2, '0')).join('') }
function savePending(extra: Partial<StoredRecharge> = {}) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ idempotencyKey, email: email.value.trim().toLowerCase(), amountCents: amountCents.value, channel: selectedChannel.value, createdAt: new Date().toISOString(), orderId: orderId.value || undefined, orderNo: orderNo.value || undefined, orderToken: orderToken.value || undefined, qrImageUrl: qrImageUrl.value || undefined, redirectUrl: redirectUrl.value || undefined, paymentLabel: paymentLabel.value, ...extra }))
  } catch {
    // Payment remains usable when browser privacy settings disable session storage.
  }
}
function clearPending() {
  try { sessionStorage.removeItem(STORAGE_KEY) } catch { /* no persisted session to clear */ }
}

function resetFormState() {
  step.value = 'form'
  status.value = 'pending'
  emailCode.value = ''
  orderId.value = ''
  orderNo.value = ''
  orderToken.value = ''
  qrImageUrl.value = ''
  redirectUrl.value = ''
  paymentLabel.value = '支付宝'
  error.value = ''
  idempotencyKey = createKey()
}

async function loadMethods() {
  methodsLoading.value = true
  methodsLoadError.value = ''
  try {
    const res = await fetchPaymentMethods()
    methods.value = res.methods
    if (!methods.value.some((item) => item.channel === selectedChannel.value)) selectedChannel.value = methods.value[0]?.channel || 'alipay'
  } catch (err: any) {
    methods.value = []
    methodsLoadError.value = err.message || '读取支付方式失败'
  } finally {
    methodsLoading.value = false
  }
}

async function sendCode() {
  if (sendingCode.value || isCoolingDown.value) return
  if (methodsLoading.value) { error.value = '正在读取支付方式，请稍后重试'; return }
  if (methods.value.length === 0) return
  if (!/^\S+@\S+\.\S+$/.test(email.value.trim())) { error.value = '请先填写有效邮箱'; return }
  sendingCode.value = true; error.value = ''
  try { const res = await requestEmailAccessCode(email.value.trim(), getRechargeResponse() || undefined); startCooldown(res.resendCooldownSeconds || 60); resetRechargeTurnstile() }
  catch (err: any) { const retry = retryAfterSecondsFromError(err); if (retry) startCooldown(retry); error.value = err.message || '验证码发送失败'; resetRechargeTurnstile() }
  finally { sendingCode.value = false }
}

function applyOrder(data: Record<string, any>) {
  orderId.value = String(data.orderId || '')
  orderNo.value = String(data.orderNo || '')
  orderToken.value = String(data.orderToken || '')
  qrImageUrl.value = String(data.qrImageUrl || '')
  redirectUrl.value = String(data.redirectUrl || '')
  paymentLabel.value = String(data.paymentChannelLabel || paymentLabel.value)
  status.value = (data.status || 'pending') as RechargeStatus
  step.value = 'payment'
  savePending()
  startPolling()
}

async function submit() {
  if (submitting.value) return
  if (!/^\S+@\S+\.\S+$/.test(email.value.trim())) { error.value = '请先填写有效邮箱'; return }
  if (!/^\d{6}$/.test(emailCode.value.trim())) { error.value = '请输入邮件中的 6 位验证码'; return }
  if (amountCents.value < balanceRechargeMinCents.value || amountCents.value > balanceRechargeMaxCents.value) {
    error.value = `充值金额必须在 ${formatMoney(balanceRechargeMinCents.value, 'CNY')} 到 ${formatMoney(balanceRechargeMaxCents.value, 'CNY')} 之间`
    return
  }
  if (methodsLoading.value) { error.value = '正在读取支付方式，请稍后重试'; return }
  if (methods.value.length === 0) return
  submitting.value = true; error.value = ''; savePending()
  try { applyOrder(await createBalanceRecharge({ buyerEmail: email.value.trim(), emailAccessCode: emailCode.value.trim(), amountCents: amountCents.value, paymentChannel: selectedChannel.value, idempotencyKey })) }
  catch (err: any) {
    const details = err instanceof ApiError ? err.details : undefined
    if ((err.code === 'PAYMENT_CREATION_UNCERTAIN' || err.code === 'IDEMPOTENCY_PENDING') && details?.orderId && details?.orderToken) applyOrder(details)
    else { error.value = err.message || '创建充值订单失败'; if (err.code !== 'IDEMPOTENCY_PENDING') { clearPending(); idempotencyKey = createKey() } }
  } finally { submitting.value = false }
}

async function poll() {
  if (!orderId.value || !orderToken.value || status.value !== 'pending') return
  try {
    const res = await fetchBalanceRechargeStatus(orderId.value, orderToken.value)
    status.value = res.status
    if (res.status !== 'pending') { stopPolling(); clearPending() }
  } catch (err: any) { if (err.status === 404) { status.value = 'failed'; stopPolling(); clearPending() } }
}
function startPolling() { stopPolling(); pollTimer = setInterval(poll, 2500); poll() }
function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = undefined }
function close() { if (submitting.value) return; stopPolling(); closeRecharge(); resetFormState() }
function restart() { stopPolling(); clearPending(); resetFormState() }

function restore() {
  try {
    const stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null') as StoredRecharge | null
    const createdAt = stored && typeof stored.createdAt === 'string' ? Date.parse(stored.createdAt) : NaN
    if (!stored || !Number.isFinite(createdAt) || createdAt < Date.now() - PENDING_RECHARGE_TTL_MS || typeof stored.idempotencyKey !== 'string' || typeof stored.email !== 'string' || !Number.isInteger(stored.amountCents) || !['alipay', 'wxpay', 'qqpay'].includes(stored.channel)) {
      clearPending()
      resetFormState()
      return false
    }
    idempotencyKey = stored.idempotencyKey; email.value = stored.email; setAmount(stored.amountCents); selectedChannel.value = stored.channel
    if (stored.orderId && stored.orderToken) { orderId.value = stored.orderId; orderNo.value = stored.orderNo || ''; orderToken.value = stored.orderToken; qrImageUrl.value = stored.qrImageUrl || ''; redirectUrl.value = stored.redirectUrl || ''; paymentLabel.value = stored.paymentLabel || '在线'; step.value = 'payment'; startPolling() }
    return true
  } catch { clearPending(); resetFormState(); return false }
}

watch(visible, async (next) => {
  if (!next) { stopPolling(); return }
  error.value = ''
  // 先同步恢复旧订单，不能让网络刷新窗口短暂展示一个可再次提交的新表单。
  restore()
  await Promise.all([
    loadShopConfig(true).catch(() => undefined),
    loadMethods(),
  ])
})
onMounted(() => { if (restore()) visible.value = true })
onUnmounted(stopPolling)
</script>

<style scoped>
.recharge-overlay { position: fixed; inset: 0; z-index: 1100; display: flex; align-items: center; justify-content: center; padding: 16px; background: var(--overlay, rgba(0,0,0,.48)); }
.recharge-dialog { width: min(440px, 100%); max-height: calc(100vh - 32px); overflow: auto; border-radius: var(--r-lg, 8px); background: var(--tg-bg, #fff); color: var(--tg-text, #111827); box-shadow: var(--shadow-lg, 0 20px 50px rgba(0,0,0,.2)); }
.recharge-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px; border-bottom: .5px solid var(--border, #e5e7eb); }
.recharge-header h2 { margin: 2px 0 0; font-size: 18px; }
.recharge-eyebrow { color: var(--tg-hint, #6b7280); font-size: 11px; font-weight: 600; }
.recharge-close { width: 32px; height: 32px; border: 0; background: transparent; color: var(--tg-hint, #6b7280); font-size: 24px; cursor: pointer; }
.recharge-body { display: flex; flex-direction: column; gap: 12px; padding: 16px; }
.amount-presets, .recharge-methods { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.amount-presets button, .recharge-methods button { min-height: 42px; border: .5px solid var(--border, #e5e7eb); border-radius: var(--r-md, 8px); background: var(--tg-bg, #fff); color: var(--tg-text, #111827); cursor: pointer; }
.amount-presets button.active, .recharge-methods button.active { border-color: var(--tg-btn); background: color-mix(in srgb, var(--tg-btn) 10%, transparent); color: var(--tg-btn); font-weight: 700; }
.recharge-field { display: flex; flex: 1; flex-direction: column; gap: 5px; min-width: 0; font-size: 12px; }
.recharge-field input { width: 100%; min-height: 42px; padding: 9px 10px; border: .5px solid var(--border, #e5e7eb); border-radius: var(--r-md, 8px); background: var(--tg-bg, #fff); color: var(--tg-text, #111827); font-size: 14px; }
.code-row { display: flex; align-items: flex-end; gap: 8px; }
.code-row .btn { min-height: 42px; flex-shrink: 0; }
.recharge-primary { width: 100%; min-height: 44px; }
.recharge-error { margin: 0; color: #dc2626; font-size: 13px; }
.recharge-summary { display: flex; flex-direction: column; align-items: center; gap: 4px; }
.recharge-summary span, .recharge-summary small { color: var(--tg-hint, #6b7280); font-size: 12px; }
.recharge-summary strong { font-size: 28px; }
.recharge-qr { width: min(240px, 80vw); aspect-ratio: 1; object-fit: contain; align-self: center; }
.recharge-state { display: flex; flex-direction: column; gap: 4px; padding: 12px; border: .5px solid var(--border, #e5e7eb); border-radius: var(--r-md, 8px); }
.recharge-state span { color: var(--tg-hint, #6b7280); font-size: 13px; line-height: 1.5; }
.recharge-state.paid { border-color: rgba(22,163,74,.35); background: rgba(22,163,74,.06); }
@media (max-width: 640px) { .recharge-overlay { align-items: flex-end; padding: 0; } .recharge-dialog { width: 100%; max-height: 92vh; border-radius: 8px 8px 0 0; } }
</style>
