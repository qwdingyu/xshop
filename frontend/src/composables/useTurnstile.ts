import { ref, computed, nextTick } from 'vue'
import { useShopConfig } from './useShopConfig'

const {
  turnstileEnabled: shopTurnstileEnabled,
  turnstileSiteKey,
  loadShopConfig,
} = useShopConfig()

const widgetId = ref<number | null>(null)
const modalWidgetId = ref<number | null>(null)
const rechargeWidgetId = ref<number | null>(null)

// 配置只保留一份事实来源。强制刷新 useShopConfig 后，所有 widget 消费者立即看到新值，
// 不再因独立 module ref 快照而继续使用已撤销的 Turnstile 开关或 Site Key。
export const siteKey = computed(() => turnstileSiteKey.value)
export const turnstileEnabled = computed(() => shopTurnstileEnabled.value)

function renderTurnstile(containerId: string): number | null {
  if (!turnstileEnabled.value || !siteKey.value || !window.turnstile) return null
  const el = document.getElementById(containerId)
  if (!el) return null
  el.innerHTML = ''
  const id = window.turnstile.render(el, {
    sitekey: siteKey.value,
    'callback': () => {},
  })
  return id
}

export function useTurnstile() {
  async function ensureConfigLoaded() {
    await loadShopConfig()
  }

  function getResponse(): string | null {
    if (!turnstileEnabled.value) return null
    return window.turnstile?.getResponse() ?? null
  }

  function getRechargeResponse(): string | null {
    if (!turnstileEnabled.value || rechargeWidgetId.value == null) return null
    return window.turnstile?.getResponse(rechargeWidgetId.value) ?? null
  }

  function reset() {
    if (widgetId.value != null) window.turnstile?.reset(widgetId.value)
    if (modalWidgetId.value != null) window.turnstile?.reset(modalWidgetId.value)
    if (rechargeWidgetId.value != null) window.turnstile?.reset(rechargeWidgetId.value)
  }

  function renderPageTurnstile() {
    if (!turnstileEnabled.value) return
    const id = renderTurnstile('turnstile-container')
    if (id != null) widgetId.value = id
  }

  function renderModalTurnstile() {
    if (!turnstileEnabled.value) return
    const id = renderTurnstile('pay-turnstile')
    if (id != null) modalWidgetId.value = id
  }

  function resetModalTurnstile() {
    if (!turnstileEnabled.value) return
    if (modalWidgetId.value != null) {
      window.turnstile?.reset(modalWidgetId.value)
      modalWidgetId.value = null
    }
    // Re-render after DOM is ready
    nextTick(() => renderModalTurnstile())
  }

  function renderRechargeTurnstile() {
    if (!turnstileEnabled.value) return
    const id = renderTurnstile('recharge-turnstile')
    if (id != null) rechargeWidgetId.value = id
  }

  function resetRechargeTurnstile() {
    if (!turnstileEnabled.value) return
    if (rechargeWidgetId.value != null) {
      window.turnstile?.reset(rechargeWidgetId.value)
      rechargeWidgetId.value = null
    }
    nextTick(() => renderRechargeTurnstile())
  }

  return {
    ensureConfigLoaded,
    getResponse,
    getRechargeResponse,
    reset,
    renderPageTurnstile,
    renderModalTurnstile,
    resetModalTurnstile,
    renderRechargeTurnstile,
    resetRechargeTurnstile,
  }
}
