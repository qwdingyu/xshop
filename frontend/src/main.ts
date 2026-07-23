import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import './assets/base.css'
import './assets/telegram.css'
import './assets/desktop.css'
import './assets/admin.css'
import { buildStaleAssetRecoveryUrl, clearStaleAssetRecoveryParam, isStaleAssetLoadError } from '@/lib/stale-asset-recovery'

// 部署期间已经打开的旧页面可能引用上一版不存在的 hash chunk。
// 只允许刷新一次：刷新后若新版本仍缺少资源，保留错误现场，避免无限刷新掩盖真正的部署问题。
let staleAssetReloadStarted = false
function recoverFromStaleAsset(error: unknown, href: string): boolean {
  if (staleAssetReloadStarted || !isStaleAssetLoadError(error)) return false
  const recoveryUrl = buildStaleAssetRecoveryUrl(href, window.location.href)
  if (!recoveryUrl) return false
  staleAssetReloadStarted = true
  window.location.replace(recoveryUrl)
  return true
}

window.addEventListener('vite:preloadError', (event) => {
  if (!isStaleAssetLoadError(event.payload)) return
  // Vite 会在动态 import 失败时派发可取消事件；取消默认抛错后交给一次性刷新恢复。
  event.preventDefault()
  window.setTimeout(() => { recoverFromStaleAsset(event.payload, window.location.href) }, 100)
})

router.onError((error, to) => {
  const targetUrl = router.resolve(to).href
  recoverFromStaleAsset(error, targetUrl)
})

router.afterEach((_to, _from, failure) => {
  if (failure) return
  const cleanUrl = clearStaleAssetRecoveryParam(window.location.href)
  if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== cleanUrl) {
    window.history.replaceState(window.history.state, '', cleanUrl)
  }
})

// 清除旧版本跨会话保存的订单 Token 和支付恢复参数，避免共享浏览器继续暴露上一位买家的记录或邮箱。
try {
  localStorage.removeItem('recent_orders')
  localStorage.removeItem('pending_checkout_attempts')
} catch {
  // 禁用存储或隐私模式下无需处理。
}

const app = createApp(App)
app.use(router)
app.mount('#app')
