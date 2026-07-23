import { ref } from 'vue'

export const DEFAULT_OFFLINE_HINT = '请扫码付款，转账备注填写付款备注码；付款完成后，请在微信/支付宝账单详情中找到交易单号或商户单号，并提交后 4 位数字供管理员核对。'

interface OfflinePaymentOptions {
  confirmOfflinePay: (payload: {
    orderId: string
    orderToken: string
    payRefLast4: string
  }) => Promise<{ confirmed: boolean }>
  startStatusPolling: () => void
}

export function useOfflinePayment(options: OfflinePaymentOptions) {
  const wechatQr = ref('')
  const alipayQr = ref('')
  const offlineNoteCode = ref('')
  const offlineHint = ref(DEFAULT_OFFLINE_HINT)
  const offlineExpiresAt = ref('')
  const confirming = ref(false)
  const refLast4 = ref('')
  const confirmError = ref('')
  const offlineConfirmStatus = ref('')

  function setOfflinePayment(data: {
    wechatQr?: string
    alipayQr?: string
    offlineNoteCode?: string
    offlineHint?: string
    expiresAt?: string
  }) {
    wechatQr.value = data.wechatQr || ''
    alipayQr.value = data.alipayQr || ''
    offlineNoteCode.value = data.offlineNoteCode || ''
    offlineHint.value = data.offlineHint || DEFAULT_OFFLINE_HINT
    offlineExpiresAt.value = data.expiresAt || ''
    refLast4.value = ''
    confirmError.value = ''
    offlineConfirmStatus.value = ''
  }

  async function confirm(orderId: string, orderToken: string) {
    if (refLast4.value.length !== 4) return
    confirming.value = true
    confirmError.value = ''
    try {
      await options.confirmOfflinePay({
        orderId,
        orderToken,
        payRefLast4: refLast4.value,
      })
      offlineConfirmStatus.value = '已提交确认，等待管理员核对…'
      options.startStatusPolling()
    } catch (err: unknown) {
      confirmError.value = err instanceof Error ? err.message : '确认失败'
    } finally {
      confirming.value = false
    }
  }

  function resetOfflinePayment() {
    wechatQr.value = ''
    alipayQr.value = ''
    offlineNoteCode.value = ''
    offlineHint.value = DEFAULT_OFFLINE_HINT
    offlineExpiresAt.value = ''
    confirming.value = false
    refLast4.value = ''
    confirmError.value = ''
    offlineConfirmStatus.value = ''
  }

  return {
    wechatQr,
    alipayQr,
    offlineNoteCode,
    offlineHint,
    offlineExpiresAt,
    confirming,
    refLast4,
    confirmError,
    offlineConfirmStatus,
    setOfflinePayment,
    confirm,
    resetOfflinePayment,
  }
}
