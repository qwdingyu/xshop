import { ref, computed } from 'vue'
import type { TelegramWebApp, TgUser, TgThemeParams } from '@/types/telegram'

const tg = ref<TelegramWebApp | null>(null)
const user = ref<TgUser | null>(null)
const themeParams = ref<Record<string, string>>({})
const colorScheme = ref<'light' | 'dark'>('dark')

function applyTheme(params: TgThemeParams) {
  const root = document.documentElement
  const map: Record<string, string> = {
    bg_color: '--tg-bg',
    text_color: '--tg-text',
    hint_color: '--tg-hint',
    link_color: '--tg-link',
    button_color: '--tg-btn',
    button_text_color: '--tg-btn-text',
    secondary_bg_color: '--tg-secondary-bg',
    header_bg_color: '--tg-header-bg',
    bottom_bar_bg_color: '--tg-bottom-bar-bg',
    top_bar_bg_color: '--tg-top-bar-bg',
    destructive_text_color: '--tg-destructive',
    section_bg_color: '--tg-section-bg',
  }
  for (const [tgKey, cssVar] of Object.entries(map)) {
    const value = (params as any)[tgKey]
    if (value) {
      root.style.setProperty(cssVar, value)
    }
  }
}

function init() {
  const webApp = (window as any).Telegram?.WebApp
  if (!webApp) return

  tg.value = webApp
  webApp.ready()
  webApp.expand()

  user.value = webApp.initDataUnsafe?.user ?? null
  themeParams.value = { ...webApp.themeParams }
  colorScheme.value = webApp.colorScheme ?? 'dark'

  applyTheme(webApp.themeParams)

  webApp.onEvent('themeChanged', () => {
    if (!tg.value) return
    themeParams.value = Object.fromEntries(Object.entries(webApp.themeParams).filter(([_, v]) => v)) as Record<string, string>
    colorScheme.value = tg.value.colorScheme
    applyTheme(tg.value.themeParams)
  })
}

init()

export function useTelegram() {
  const mainButton = computed(() => tg.value?.MainButton ?? null)
  const backButton = computed(() => tg.value?.BackButton ?? null)

  function showMainButton(text: string, onClick: () => void) {
    const mb = tg.value?.MainButton
    if (!mb) return
    mb.setText(text)
    mb.show()
    mb.onClick(onClick)
  }

  function hideMainButton() {
    tg.value?.MainButton?.offClick()
    tg.value?.MainButton?.hide()
  }

  function showBackButton(onClick: () => void) {
    const bb = tg.value?.BackButton
    if (!bb) return
    bb.show()
    bb.onClick(onClick)
  }

  function hideBackButton() {
    tg.value?.BackButton?.offClick()
    tg.value?.BackButton?.hide()
  }

  return {
    tg,
    user,
    themeParams,
    colorScheme,
    mainButton,
    backButton,
    showMainButton,
    hideMainButton,
    showBackButton,
    hideBackButton,
  }
}
