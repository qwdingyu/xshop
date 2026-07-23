import { computed, ref } from 'vue'
import { fetchConfig } from '@/api'

const DEFAULT_SHOP_NAME = 'Shop'

const loaded = ref(false)
const loading = ref(false)
const shopName = ref(DEFAULT_SHOP_NAME)
const supportEmail = ref('')
const turnstileEnabled = ref(false)
const turnstileSiteKey = ref('')
const balancePaymentEnabled = ref(false)
const balanceRechargeEnabled = ref(false)
const balanceRechargeMinCents = ref(100)
const balanceRechargeMaxCents = ref(500000)
let inFlightLoad: Promise<void> | null = null
let queuedForcedLoad: Promise<void> | null = null

function normalizeShopName(value?: string): string {
  const name = value?.trim()
  return name || DEFAULT_SHOP_NAME
}

function normalizeSupportEmail(value?: string): string {
  return value?.trim() || ''
}

function normalizeTurnstileEnabled(value?: string): boolean {
  return value === 'true'
}

function normalizeTurnstileSiteKey(value?: string): string {
  return value?.trim() || ''
}

function normalizeBoolean(value?: string): boolean {
  return value === 'true'
}

function normalizeBoundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function runShopConfigLoad(): Promise<void> {
  loading.value = true
  const request = (async () => {
    const data = await fetchConfig()
    shopName.value = normalizeShopName(data.config?.shop_name)
    supportEmail.value = normalizeSupportEmail(data.config?.support_email)
    turnstileEnabled.value = normalizeTurnstileEnabled(data.config?.turnstile_enabled)
    turnstileSiteKey.value = normalizeTurnstileSiteKey(data.config?.turnstile_site_key)
    balancePaymentEnabled.value = normalizeBoolean(data.config?.balance_payment_enabled)
    balanceRechargeEnabled.value = normalizeBoolean(data.config?.balance_recharge_enabled)
    balanceRechargeMinCents.value = normalizeBoundedInteger(
      data.config?.balance_recharge_min_cents,
      100,
      1,
      1_000_000,
    )
    const configuredMaxCents = normalizeBoundedInteger(
      data.config?.balance_recharge_max_cents,
      500_000,
      1,
      10_000_000,
    )
    balanceRechargeMaxCents.value = Math.max(balanceRechargeMinCents.value, configuredMaxCents)
    loaded.value = true
  })()
  inFlightLoad = request
  return request.finally(() => {
    if (inFlightLoad === request) {
      inFlightLoad = null
      loading.value = false
    }
  })
}

async function loadShopConfig(force = false): Promise<void> {
  if (inFlightLoad) {
    if (!force) return inFlightLoad
    if (!queuedForcedLoad) {
      queuedForcedLoad = inFlightLoad
        .catch(() => undefined)
        .then(() => runShopConfigLoad())
        .finally(() => { queuedForcedLoad = null })
    }
    return queuedForcedLoad
  }
  if (loaded.value && !force) return
  return runShopConfigLoad()
}

export function useShopConfig() {
  return {
    loaded,
    loading,
    shopName: computed(() => shopName.value),
    supportEmail: computed(() => supportEmail.value),
    turnstileEnabled: computed(() => turnstileEnabled.value),
    turnstileSiteKey: computed(() => turnstileSiteKey.value),
    balancePaymentEnabled: computed(() => balancePaymentEnabled.value),
    balanceRechargeEnabled: computed(() => balanceRechargeEnabled.value),
    balanceRechargeMinCents: computed(() => balanceRechargeMinCents.value),
    balanceRechargeMaxCents: computed(() => balanceRechargeMaxCents.value),
    loadShopConfig,
  }
}
