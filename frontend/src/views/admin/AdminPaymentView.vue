<template>
  <div class="admin-page">
    <div class="toolbar">
      <h2 class="page-title">支付配置</h2>
      <div class="toolbar-actions">
        <button class="btn btn-primary btn-sm" :disabled="loading || isOperating" @click="loadData">刷新</button>
      </div>
    </div>

    <div v-if="paymentHealth" class="health-card" :class="paymentHealthClass">
      <strong>{{ paymentHealthTitle }}</strong>
      <p>{{ paymentHealthMessage }}</p>
    </div>

    <div v-if="balancePaymentLoaded" class="balance-card" :class="balancePaymentEnabled ? 'balance-card-success' : 'balance-card-muted'">
      <div class="balance-card-head">
        <div>
          <strong>站内余额支付</strong>
          <p>控制前台是否显示余额支付入口。关闭后只保留在线支付；0 元订单不受影响。</p>
        </div>
        <span class="tag" :class="balancePaymentEnabled ? 'tag-success' : 'tag-muted'">
          {{ balancePaymentEnabled ? '已启用' : '已关闭' }}
        </span>
      </div>
      <div class="balance-card-actions">
        <button
          class="btn btn-primary btn-sm"
          :disabled="loading || isOperating || balanceSaving"
          type="button"
          @click="toggleBalancePayment"
        >
          {{ balanceSaving ? '处理中…' : (balancePaymentEnabled ? '关闭余额支付' : '启用余额支付') }}
        </button>
        <span class="balance-card-hint">同一配置键为 <code>balance_payment_enabled</code>，系统配置页也会同步显示。</span>
      </div>
    </div>

    <div v-if="balancePaymentLoaded" class="balance-card" :class="balanceRechargeEnabled ? 'balance-card-success' : 'balance-card-muted'">
      <div class="balance-card-head">
        <div>
          <strong>在线充值余额</strong>
          <p>控制商品页右上角充值入口。用户验证邮箱后通过在线渠道付款，成功后直接进入该邮箱余额。</p>
        </div>
        <span class="tag" :class="balanceRechargeEnabled ? 'tag-success' : 'tag-muted'">{{ balanceRechargeEnabled ? '已启用' : '已关闭' }}</span>
      </div>
      <div class="balance-card-actions">
        <button class="btn btn-primary btn-sm" :disabled="loading || isOperating || rechargeSaving" type="button" @click="toggleBalanceRecharge">
          {{ rechargeSaving ? '处理中…' : (balanceRechargeEnabled ? '关闭在线充值' : '启用在线充值') }}
        </button>
        <span class="balance-card-hint">默认关闭；启用前应完成真实小额充值、回调和重复回调测试。</span>
      </div>
    </div>

    <div v-if="loading" class="skeleton-list">
      <div v-for="i in 4" :key="i" class="skeleton-line w-60" />
    </div>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" :disabled="loading || isOperating" @click="loadData">重新加载</button>
    </div>

    <div
      v-if="!loading && !loadError"
      class="provider-list"
      role="region"
      aria-label="支付渠道列表"
      tabindex="0"
    >
      <div v-for="item in providers" :key="item.name" class="provider-card">
        <div class="provider-header">
          <div class="provider-title-row">
            <div>
              <h3 class="provider-name">{{ item.displayName }}</h3>
              <p class="provider-desc">{{ item.description }}</p>
            </div>
          </div>
          <div class="provider-status">
            <span class="tag" :class="item.enabled ? 'tag-success' : 'tag-muted'">
              {{ item.enabled ? '已启用' : '未启用' }}
            </span>
            <span class="tag" :class="item.configured ? 'tag-success' : 'tag-muted'">
              {{ item.configured ? '已配置' : '未配置' }}
            </span>
          </div>
          <dl class="provider-facts">
            <div>
              <dt>支持币种</dt>
              <dd>{{ item.supportedCurrencies.join(' / ') }}</dd>
            </div>
            <div>
              <dt>默认收款</dt>
              <dd>{{ paymentTypeLabel(providerConfigValue(item, 'EASYPAY_PAY_TYPE')) }}</dd>
            </div>
            <div>
              <dt>启用方式</dt>
              <dd>{{ enabledPaymentTypesLabel(providerConfigValue(item, 'EASYPAY_ENABLED_PAY_TYPES'), providerConfigValue(item, 'EASYPAY_PAY_TYPE')) }}</dd>
            </div>
            <div>
              <dt>网关地址</dt>
              <dd>{{ providerConfigValue(item, 'EASYPAY_API_BASE') || '未配置' }}</dd>
            </div>
            <div>
              <dt>回调地址</dt>
              <dd class="callback-value"><span>{{ callbackUrl(item) }}</span><button class="btn btn-ghost btn-xs" @click="copyCallbackUrl(item)">复制</button></dd>
            </div>
            <div>
              <dt>充值回调</dt>
              <dd class="callback-value"><span>{{ rechargeCallbackUrl(item) }}</span><button class="btn btn-ghost btn-xs" @click="copyRechargeCallbackUrl(item)">复制</button></dd>
            </div>
          </dl>
        </div>
        <div class="provider-actions">
          <button class="btn btn-primary btn-sm" :disabled="isOperating || deletingProvider === item.name" @click="openConfig(item)">配置</button>
          <button class="btn btn-ghost btn-sm" :disabled="isOperating || !item.configured || deletingProvider === item.name" @click="toggleEnabled(item)">
            {{ togglingProvider === item.name ? '处理中…' : (item.enabled ? '禁用' : '启用') }}
          </button>
          <button class="btn btn-danger btn-sm" :disabled="isOperating" @click="removeConfig(item)">
            {{ deletingProvider === item.name ? '删除中…' : '删除' }}
          </button>
        </div>
      </div>
    </div>

    <AdminModal v-model="configVisible" :title="editingProvider ? '编辑服务商' : '支付配置'" max-width="720px" hide-actions>
      <form class="modal-form" @submit.prevent="saveConfig">
        <template v-if="editingProvider?.name === 'easypay'">
          <div class="config-grid two-cols">
            <label>
              <span>服务商名称</span>
              <input :value="editingProvider.displayName" disabled />
            </label>
            <label>
              <span>服务商类型</span>
              <input value="易支付" disabled />
            </label>
          </div>

          <div class="quick-setting">
            <div class="quick-copy">
              <span class="quick-label">启用收款方式</span>
              <small>前台只展示已开通并启用的方式</small>
            </div>
            <div class="segmented" role="group" aria-label="启用收款方式">
              <button
                v-for="option in paymentTypeOptions"
                :key="option.value"
                type="button"
                class="segment-btn"
                :class="{ active: enabledPayTypes.includes(option.value) }"
                @click="togglePayType(option.value)"
              >
                {{ option.label }}
              </button>
            </div>
          </div>

          <div class="quick-setting">
            <div class="quick-copy">
              <span class="quick-label">默认收款方式</span>
              <small>旧客户端或未选择时使用</small>
            </div>
            <div class="segmented" role="group" aria-label="默认收款方式">
              <button
                v-for="option in paymentTypeOptions"
                :key="option.value"
                type="button"
                class="segment-btn"
                :class="{ active: selectedPayType === option.value }"
                @click="setPayType(option.value)"
              >
                {{ option.label }}
              </button>
            </div>
          </div>

          <label>
            <span>商户 PID</span>
            <input v-model="configForm.EASYPAY_PID" placeholder="2026062310564339" autocomplete="off" required />
          </label>
          <label>
            <span>商户密钥</span>
            <input v-model="configForm.EASYPAY_KEY" type="password" placeholder="留空以保持当前密钥" autocomplete="new-password" required />
            <small class="field-hint">已配置时会显示为脱敏占位符，直接保存会保留原密钥。</small>
          </label>
          <label>
            <span>API 基础地址</span>
            <input v-model="configForm.EASYPAY_API_BASE" placeholder="https://zpayz.cn" required />
            <small class="field-hint">可粘贴根地址、submit.php、mapi.php 或 api.php，系统会自动归一化。</small>
          </label>
          <label>
            <span>支付后跳转 URL（可选）</span>
            <input v-model="configForm.EASYPAY_RETURN_URL" placeholder="留空由系统自动返回查单页" />
          </label>
          <div class="callback-box">
            <span>异步回调地址</span>
            <code>{{ editingProvider ? callbackUrl(editingProvider) : '' }}</code>
            <button v-if="editingProvider" type="button" class="btn btn-ghost btn-xs" @click="copyCallbackUrl(editingProvider)">复制</button>
          </div>
        </template>
        <template v-else>
          <label v-for="field in editingProvider?.fields" :key="field.key">
            <span>{{ field.label }}</span>
            <input v-model="configForm[field.key]" :type="field.type === 'password' ? 'password' : 'text'" :placeholder="field.placeholder || ''" />
            <small v-if="field.hint" class="field-hint">{{ field.hint }}</small>
          </label>
        </template>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" :disabled="Boolean(savingProvider)" @click="configVisible = false">取消</button>
          <button type="submit" class="btn btn-primary" :disabled="Boolean(savingProvider)">
            {{ savingProvider ? '保存中…' : '保存' }}
          </button>
        </div>
      </form>
    </AdminModal>

    <ConfirmDialog v-model="confirmVisible" :message="confirmMessage" danger @confirm="onConfirm" />
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, computed } from 'vue'
import { fetchAdminPaymentProviders, fetchAdminPaymentConfigs, fetchAdminPaymentHealth, fetchAdminSystemConfig, updateAdminPaymentConfig, updateAdminSystemConfig, setAdminPaymentProviderEnabled, deleteAdminPaymentConfig } from '@/api/admin'
import type { AdminPaymentProvider, AdminPaymentConfigItem, AdminPaymentHealthResult, AdminSystemConfigResult } from '@/types/admin'
import { useToast } from '@/composables/useToast'
import { useAdminAuth } from '@/composables/useAdminAuth'
import AdminModal from '@/components/AdminModal.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import { writeClipboardText } from '@/composables/useClipboard'
import { useShopConfig } from '@/composables/useShopConfig'

const { showToast } = useToast()
const { token } = useAdminAuth()
const { loadShopConfig } = useShopConfig()

async function refreshPublicShopConfig(): Promise<boolean> {
  try {
    await loadShopConfig(true)
    return true
  } catch {
    return false
  }
}

function showConfigMutationResult(message: string, publicConfigSynced: boolean) {
  showToast(
    publicConfigSynced ? message : `${message}，但当前页面未能刷新前台配置；重新加载页面后可同步`,
    publicConfigSynced ? 'success' : 'info',
    publicConfigSynced ? 3000 : 5000,
  )
}

async function copyCallbackUrl(provider: AdminPaymentProvider) {
  try {
    await writeClipboardText(callbackUrl(provider))
    showToast('回调地址已复制', 'success')
  } catch {
    showToast('复制失败，请手动选择地址', 'error')
  }
}

const loading = ref(false)
const loadError = ref('')
const providers = ref<AdminPaymentProvider[]>([])
const configs = ref<AdminPaymentConfigItem[]>([])
const paymentHealth = ref<AdminPaymentHealthResult | null>(null)
const balancePaymentEnabled = ref(false)
const balancePaymentLoaded = ref(false)
const balanceSaving = ref(false)
const balanceRechargeEnabled = ref(false)
const rechargeSaving = ref(false)

const configVisible = ref(false)
const editingProvider = ref<AdminPaymentProvider | null>(null)
const configForm = reactive<Record<string, string>>({})
const savingProvider = ref('')
const togglingProvider = ref('')
const deletingProvider = ref('')
const isOperating = computed(() => Boolean(savingProvider.value || togglingProvider.value || deletingProvider.value))
const paymentTypeOptions = [
  { value: 'alipay' as const, label: '支付宝' },
  { value: 'wxpay' as const, label: '微信支付' },
  { value: 'qqpay' as const, label: 'QQ 支付' },
]
const selectedPayType = computed(() => normalizePayType(configForm.EASYPAY_PAY_TYPE))
const enabledPayTypes = computed(() => normalizeEnabledPayTypes(configForm.EASYPAY_ENABLED_PAY_TYPES, selectedPayType.value))

const { confirmVisible, confirmMessage, askConfirm, onConfirm } = useConfirmDialog()
let loadSequence = 0

const paymentHealthClass = computed(() => {
  const key = paymentHealth.value?.credentialsEncryptionKey
  return key?.configured && key.valid ? 'health-card-success' : 'health-card-error'
})

const paymentHealthTitle = computed(() => {
  const key = paymentHealth.value?.credentialsEncryptionKey
  if (!key?.configured) return '支付密钥未配置'
  return key.valid ? '支付密钥正常' : '支付密钥格式错误'
})

const paymentHealthMessage = computed(() => {
  const key = paymentHealth.value?.credentialsEncryptionKey
  if (!key?.configured) return '请先配置 CREDENTIALS_ENCRYPTION_KEY，否则无法安全保存线上支付渠道密钥。'
  if (!key.valid) return 'CREDENTIALS_ENCRYPTION_KEY 必须是 64 位 hex 字符串，请修正 Worker secret 后再保存支付渠道。'
  return '线上支付渠道密钥可安全加密存储。上线前仍需完成真实小额支付和回调验收。'
})

async function loadData() {
  const sequence = ++loadSequence
  loading.value = true
  loadError.value = ''
  try {
    const [providersRes, configsRes, healthRes] = await Promise.all([
      fetchAdminPaymentProviders(token.value),
      fetchAdminPaymentConfigs(token.value),
      fetchAdminPaymentHealth(token.value),
    ])
    if (sequence !== loadSequence) return
    providers.value = providersRes.providers
    configs.value = configsRes.configs
    paymentHealth.value = healthRes
    const systemRes: AdminSystemConfigResult = await fetchAdminSystemConfig(token.value)
    if (sequence !== loadSequence) return
    balancePaymentEnabled.value = systemRes.config.balance_payment_enabled === 'true'
    balanceRechargeEnabled.value = systemRes.config.balance_recharge_enabled === 'true'
    balancePaymentLoaded.value = true
  } catch (err: any) {
    if (sequence !== loadSequence) return
    providers.value = []
    configs.value = []
    balancePaymentLoaded.value = false
    loadError.value = err.message || '加载支付配置失败'
    showToast(err.message || '加载支付配置失败', 'error')
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}

async function toggleBalanceRecharge() {
  if (loading.value || isOperating.value || rechargeSaving.value) return
  const next = !balanceRechargeEnabled.value
  const confirmed = await askConfirm(next
    ? '确认启用在线充值？启用前应确认支付渠道、充值回调、邮箱验证码和重复回调均已通过真实小额测试。'
    : '确认关闭在线充值？关闭后不再创建新充值订单，已有订单仍可接收回调并完成入账。')
  if (!confirmed) return
  rechargeSaving.value = true
  try {
    const res = await updateAdminSystemConfig(token.value, { key: 'balance_recharge_enabled', value: next ? 'true' : 'false' })
    balanceRechargeEnabled.value = res.value === 'true'
    const publicConfigSynced = await refreshPublicShopConfig()
    showConfigMutationResult(balanceRechargeEnabled.value ? '在线充值已启用' : '在线充值已关闭', publicConfigSynced)
    await loadData()
  } catch (err: any) {
    showToast(err.message || '保存失败', 'error')
  } finally {
    rechargeSaving.value = false
  }
}

async function toggleBalancePayment() {
  if (loading.value || isOperating.value || balanceSaving.value) return
  const next = !balancePaymentEnabled.value
  const confirmed = await askConfirm(
    next
      ? '确认启用余额支付？启用后前台会显示余额支付入口，仅适用于 CNY 商品。'
      : '确认关闭余额支付？关闭后前台将隐藏余额支付入口，但已创建的余额订单不受影响。',
  )
  if (!confirmed) return

  balanceSaving.value = true
  try {
    const res = await updateAdminSystemConfig(token.value, {
      key: 'balance_payment_enabled',
      value: next ? 'true' : 'false',
    })
    balancePaymentEnabled.value = res.value === 'true'
    const publicConfigSynced = await refreshPublicShopConfig()
    showConfigMutationResult(balancePaymentEnabled.value ? '余额支付已启用' : '余额支付已关闭', publicConfigSynced)
    await loadData()
  } catch (err: any) {
    showToast(err.message || '保存失败', 'error')
  } finally {
    balanceSaving.value = false
  }
}

function openConfig(provider: AdminPaymentProvider) {
  editingProvider.value = provider
  const existing = configs.value.find((c) => c.name === provider.name)
  const form: Record<string, string> = {}
  Object.keys(configForm).forEach((key) => {
    delete configForm[key]
  })
  provider.fields.forEach((field) => {
    form[field.key] = existing?.configured
      ? (field.sensitive ? '••••••••' : existing.values?.[field.key] || '')
      : ''
  })
  if (provider.name === 'easypay') {
    form.EASYPAY_PAY_TYPE = normalizePayType(form.EASYPAY_PAY_TYPE)
    form.EASYPAY_ENABLED_PAY_TYPES = normalizeEnabledPayTypes(form.EASYPAY_ENABLED_PAY_TYPES, form.EASYPAY_PAY_TYPE).join(',')
  }
  Object.assign(configForm, form)
  configVisible.value = true
}

async function saveConfig() {
  if (!editingProvider.value) return
  if (savingProvider.value) return
  try {
    if (editingProvider.value.name === 'easypay') {
      configForm.EASYPAY_PAY_TYPE = normalizePayType(configForm.EASYPAY_PAY_TYPE)
      configForm.EASYPAY_ENABLED_PAY_TYPES = normalizeEnabledPayTypes(configForm.EASYPAY_ENABLED_PAY_TYPES, configForm.EASYPAY_PAY_TYPE).join(',')
    }
    savingProvider.value = editingProvider.value.name
    const result = await updateAdminPaymentConfig(token.value, editingProvider.value.name, configForm)
    showToast(result.message, 'success')
    configVisible.value = false
    loadData()
  } catch (err: any) {
    showToast(err.message || '保存失败', 'error')
  } finally {
    savingProvider.value = ''
  }
}

async function toggleEnabled(provider: AdminPaymentProvider) {
  if (isOperating.value) return
  if (!provider.configured) {
    showToast('请先保存完整支付配置', 'error')
    return
  }
  const next = !provider.enabled
  if (next && !(await askConfirm(`确认已验证 ${provider.displayName} 的商户号、密钥、网关地址和回调地址，并启用线上收款？`))) return
  if (togglingProvider.value) return
  togglingProvider.value = provider.name
  try {
    await setAdminPaymentProviderEnabled(token.value, provider.name, next)
    showToast(next ? '已启用' : '已禁用', 'success')
    loadData()
  } catch (err: any) {
    showToast(err.message || '操作失败', 'error')
  } finally {
    togglingProvider.value = ''
  }
}

async function removeConfig(provider: AdminPaymentProvider) {
  if (isOperating.value) return
  if (!(await askConfirm(`确认删除 ${provider.displayName} 的支付配置？存在待支付、已支付或近期过期订单时，后端会拒绝删除以保留回调验签能力。`))) return
  deletingProvider.value = provider.name
  try {
    await deleteAdminPaymentConfig(token.value, provider.name)
    showToast('已删除', 'success')
    loadData()
  } catch (err: any) {
    showToast(err.message || '删除失败', 'error')
  } finally {
    deletingProvider.value = ''
  }
}

function providerConfigValue(provider: AdminPaymentProvider, key: string) {
  const existing = configs.value.find((item) => item.name === provider.name)
  return existing?.values?.[key] || ''
}

function normalizePayType(value: string | undefined) {
  const normalized = String(value || '').trim().toLowerCase()
  return ['alipay', 'wxpay', 'qqpay'].includes(normalized) ? normalized : 'alipay'
}

function normalizeEnabledPayTypes(value: string | undefined, fallback: string) {
  const enabled: Array<typeof paymentTypeOptions[number]['value']> = []
  String(value || '')
    .split(',')
    .map((item) => normalizePayType(item))
    .forEach((item) => {
      if (!enabled.includes(item as typeof paymentTypeOptions[number]['value'])) {
        enabled.push(item as typeof paymentTypeOptions[number]['value'])
      }
    })
  const defaultType = normalizePayType(fallback) as typeof paymentTypeOptions[number]['value']
  if (enabled.length === 0) enabled.push(defaultType)
  if (!enabled.includes(defaultType)) enabled.unshift(defaultType)
  return enabled
}

function paymentTypeLabel(value: string | undefined) {
  const normalized = normalizePayType(value)
  return paymentTypeOptions.find((option) => option.value === normalized)?.label || '支付宝'
}

function enabledPaymentTypesLabel(value: string | undefined, fallback: string | undefined) {
  return normalizeEnabledPayTypes(value, normalizePayType(fallback)).map(paymentTypeLabel).join('、')
}

function setPayType(value: string) {
  const next = normalizePayType(value)
  configForm.EASYPAY_PAY_TYPE = next
  configForm.EASYPAY_ENABLED_PAY_TYPES = normalizeEnabledPayTypes(configForm.EASYPAY_ENABLED_PAY_TYPES, next).join(',')
}

function togglePayType(value: string) {
  const next = normalizePayType(value) as typeof paymentTypeOptions[number]['value']
  const enabled = enabledPayTypes.value.filter((item) => item !== next)
  if (enabledPayTypes.value.includes(next)) {
    if (next === selectedPayType.value) {
      showToast('默认收款方式必须保持启用', 'error')
      return
    }
    if (enabled.length === 0) {
      showToast('至少启用一种收款方式', 'error')
      return
    }
    configForm.EASYPAY_ENABLED_PAY_TYPES = enabled.join(',')
    return
  }
  configForm.EASYPAY_ENABLED_PAY_TYPES = [...enabledPayTypes.value, next].join(',')
}

function callbackUrl(provider: AdminPaymentProvider) {
  const origin = typeof window === 'undefined' ? '' : window.location.origin
  return `${origin}/api/pay/callback/${provider.name}`
}

function rechargeCallbackUrl(provider: AdminPaymentProvider) {
  const origin = typeof window === 'undefined' ? '' : window.location.origin
  return `${origin}/api/recharge/callback/${provider.name}`
}

async function copyRechargeCallbackUrl(provider: AdminPaymentProvider) {
  try {
    await writeClipboardText(rechargeCallbackUrl(provider))
    showToast('充值回调地址已复制', 'success')
  } catch {
    showToast('复制失败，请手动选择地址', 'error')
  }
}

onMounted(loadData)
</script>

<style>
@import '@/assets/admin.css';
</style>

<style scoped>
.page-title {
  margin: 0;
  font-size: 16px;
}

.skeleton-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.skeleton-line {
  height: 12px;
  border-radius: 6px;
  background: var(--tg-secondary-bg, #f5f7fa);
}

.skeleton-line.w-60 {
  width: 60%;
}

.health-card {
  margin-bottom: 12px;
  padding: 10px 12px;
  border-radius: var(--r-lg, 12px);
  border: 0.5px solid var(--border, #e5e7eb);
  font-size: 13px;
  line-height: 1.5;
}

.health-card strong {
  display: block;
  margin-bottom: 4px;
}

.health-card p {
  margin: 0;
}

.health-card-success {
  background: rgba(34, 197, 94, 0.08);
  color: #15803d;
  border-color: rgba(34, 197, 94, 0.22);
}

.health-card-error {
  background: rgba(239, 68, 68, 0.08);
  color: #b91c1c;
  border-color: rgba(239, 68, 68, 0.22);
}

.balance-card {
  margin-bottom: 12px;
  padding: 10px 12px;
  border-radius: var(--r-lg, 12px);
  border: 0.5px solid var(--border, #e5e7eb);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.balance-card-success {
  background: rgba(34, 197, 94, 0.08);
  color: #15803d;
  border-color: rgba(34, 197, 94, 0.22);
}

.balance-card-muted {
  background: rgba(59, 130, 246, 0.06);
  color: #1d4ed8;
  border-color: rgba(59, 130, 246, 0.18);
}

.balance-card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.balance-card-head strong {
  display: block;
  margin-bottom: 4px;
  font-size: 13px;
}

.balance-card-head p,
.balance-card-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: inherit;
}

.balance-card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.balance-card-hint code {
  font-size: 12px;
}

.provider-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  padding: 1px 2px 2px 1px;
}

.provider-list:focus-visible {
  outline: 2px solid var(--tg-btn, #3b82f6);
  outline-offset: 2px;
}

.provider-card {
  background: var(--tg-bg, #fff);
  border-radius: var(--r-lg, 12px);
  padding: 12px;
  border: 0.5px solid var(--border, #e5e7eb);
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex: 0 0 auto;
  transition: border-color 0.12s ease, background-color 0.12s ease;
}

.provider-header {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  flex: 1 1 auto;
}

.provider-title-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.provider-name {
  margin: 0;
  font-size: 14px;
}

.provider-desc {
  margin: 0;
  font-size: 12px;
  color: var(--tg-hint, #999);
}

.provider-status {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.provider-actions {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  flex: 0 0 auto;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}

.field-hint {
  color: var(--tg-hint, #6b7280);
  font-size: 12px;
  line-height: 1.5;
}

.provider-facts {
  display: grid;
  grid-template-columns: repeat(4, minmax(120px, 1fr));
  gap: 8px;
  margin: 0;
}

.provider-facts div {
  min-width: 0;
  padding: 8px 10px;
  border-radius: var(--r-md, 8px);
  background: var(--tg-secondary-bg, #f5f7fa);
}

.provider-facts dt {
  margin: 0 0 3px;
  color: var(--tg-hint, #6b7280);
  font-size: 12px;
}

.provider-facts dd {
  margin: 0;
  color: var(--tg-text, #111827);
  font-size: 13px;
  line-height: 1.35;
  overflow-wrap: anywhere;
}

.config-grid {
  display: grid;
  gap: 10px;
}

.config-grid.two-cols {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.config-grid input:disabled,
.modal-form input:disabled {
  color: var(--tg-hint, #6b7280);
  background: var(--tg-secondary-bg, #f5f7fa);
}

.quick-setting {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px;
  border: 0.5px solid var(--border, #e5e7eb);
  border-radius: var(--r-md, 8px);
  background: var(--tg-bg, #fff);
}

.quick-label {
  color: var(--tg-text, #111827);
  font-size: 14px;
  font-weight: 600;
}

.quick-copy {
  display: grid;
  gap: 2px;
}

.quick-copy small {
  color: var(--tg-hint, #6b7280);
  font-size: 12px;
  line-height: 1.4;
}

.segmented {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: flex-end;
}

.segment-btn {
  min-height: 34px;
  padding: 0 12px;
  white-space: nowrap;
  border: 0.5px solid var(--border, #d1d5db);
  border-radius: var(--r-sm, 6px);
  background: var(--tg-secondary-bg, #f5f7fa);
  color: var(--tg-text, #111827);
  font-size: 13px;
  cursor: pointer;
}

.segment-btn.active {
  border-color: var(--tg-btn, #2563eb);
  background: var(--tg-btn, #2563eb);
  color: var(--tg-btn-text, #fff);
}

.callback-box {
  display: grid;
  gap: 6px;
  padding: 10px;
  border: 0.5px dashed var(--border, #d1d5db);
  border-radius: var(--r-md, 8px);
  background: var(--tg-secondary-bg, #f5f7fa);
}

.callback-box span {
  color: var(--tg-hint, #6b7280);
  font-size: 12px;
}

.callback-box code {
  color: var(--tg-text, #111827);
  font-size: 12px;
  overflow-wrap: anywhere;
  white-space: normal;
}

.btn-sm {
  padding: 6px 10px;
  font-size: 12px;
  border-radius: var(--r-sm, 6px);
}

@media (max-width: 640px) {
  .provider-card {
    flex-direction: column;
  }

  .provider-actions {
    justify-content: flex-start;
    width: 100%;
  }

  .provider-facts,
  .config-grid.two-cols {
    grid-template-columns: 1fr;
  }

  .quick-setting {
    align-items: flex-start;
    flex-direction: column;
  }

  .segmented {
    justify-content: flex-start;
  }
}
</style>
