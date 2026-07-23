import { ref, computed } from 'vue'
import type { Platform } from '@/types'

const platform = ref<Platform>('h5-desktop')
const isTelegram = computed(() => platform.value.startsWith('telegram'))
const isMobile = computed(() => platform.value.includes('mobile'))
const isDesktop = computed(() => platform.value.includes('desktop'))
let sdkLoadListenerRegistered = false

export function detectPlatform(userAgent: string, telegramAvailable: boolean): Platform {
  const isMobileUA = /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(userAgent)
  if (telegramAvailable) return isMobileUA ? 'telegram-mobile' : 'telegram-desktop'
  return isMobileUA ? 'h5-mobile' : 'h5-desktop'
}

function detect() {
  const telegramInitData = (window as any).Telegram?.WebApp?.initData
  // Telegram SDK 在普通浏览器也会创建 WebApp 对象；只有宿主注入的 initData
  // 才能证明页面运行在真实 Mini App 上下文中。
  const telegramContext = typeof telegramInitData === 'string' && telegramInitData.trim().length > 0
  platform.value = detectPlatform(navigator.userAgent, telegramContext)
}

function initializePlatformDetection() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return

  // 该 composable 使用模块级单例状态，不能在模块顶层注册 onMounted；模块加载时没有
  // 活动组件实例，钩子会被 Vue 忽略，手机也会永久保留默认的 h5-desktop。
  detect()
  if (!sdkLoadListenerRegistered && document.readyState !== 'complete') {
    sdkLoadListenerRegistered = true
    // Telegram SDK 异步加载，普通浏览器先渲染；window.load 后再探测一次以识别 Mini App 环境。
    window.addEventListener('load', () => {
      sdkLoadListenerRegistered = false
      detect()
    }, { once: true })
  }
}

export function usePlatform() {
  initializePlatformDetection()
  return { platform, isTelegram, isMobile, isDesktop }
}
