import { computed, ref } from 'vue'

export const EMAIL_CODE_RESEND_COOLDOWN_SECONDS = 60

/**
 * 邮箱验证码重发倒计时。
 *
 * 这里只负责前端交互防连点；真正的 60 秒强制限制必须由后端执行，
 * 否则刷新页面或直接请求接口仍可绕过按钮禁用状态。
 */
export function useEmailCodeCooldown(defaultSeconds = EMAIL_CODE_RESEND_COOLDOWN_SECONDS) {
  const remainingSeconds = ref(0)
  let deadlineMs = 0
  let timer: ReturnType<typeof setInterval> | undefined

  function clearTimer() {
    if (!timer) return
    clearInterval(timer)
    timer = undefined
  }

  function syncRemaining() {
    const next = Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000))
    remainingSeconds.value = next
    if (next <= 0) {
      clearTimer()
    }
  }

  function startCooldown(seconds = defaultSeconds) {
    const normalizedSeconds = Math.max(0, Math.ceil(seconds))
    clearTimer()
    if (normalizedSeconds <= 0) {
      remainingSeconds.value = 0
      return
    }

    deadlineMs = Date.now() + normalizedSeconds * 1000
    remainingSeconds.value = normalizedSeconds
    timer = setInterval(syncRemaining, 1000)
  }

  function stopCooldown() {
    clearTimer()
    remainingSeconds.value = 0
  }

  const isCoolingDown = computed(() => remainingSeconds.value > 0)
  const buttonText = computed(() => isCoolingDown.value ? `${remainingSeconds.value}s后重发` : '发送验证码')

  return {
    remainingSeconds,
    isCoolingDown,
    buttonText,
    startCooldown,
    stopCooldown,
  }
}

export function retryAfterSecondsFromError(error: unknown) {
  const details = (error as { details?: Record<string, unknown> } | undefined)?.details
  const retryAfterSeconds = Number(details?.retryAfterSeconds)
  return Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
    ? Math.ceil(retryAfterSeconds)
    : 0
}
