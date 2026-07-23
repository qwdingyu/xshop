import { ref, watch } from 'vue'

export function useConfirmDialog() {
  const confirmVisible = ref(false)
  const confirmMessage = ref('')
  let confirmCallback: ((confirmed: boolean) => void) | null = null

  function askConfirm(message: string): Promise<boolean> {
    confirmCallback?.(false)
    confirmMessage.value = message
    confirmVisible.value = true
    return new Promise((resolve) => {
      confirmCallback = (confirmed) => resolve(confirmed)
    })
  }

  function onConfirm() {
    if (!confirmCallback) return
    const callback = confirmCallback
    confirmCallback = null
    callback(true)
  }

  watch(confirmVisible, (visible, wasVisible) => {
    if (wasVisible && !visible && confirmCallback) {
      const callback = confirmCallback
      confirmCallback = null
      callback(false)
    }
  })

  return {
    confirmVisible,
    confirmMessage,
    askConfirm,
    onConfirm,
  }
}
