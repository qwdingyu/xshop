import { ref } from 'vue'

type ToastType = 'success' | 'error' | 'info'

const toasts = ref<Array<{ id: number; message: string; type: ToastType }>>([])
let count = 0

function showToast(message: string, type: ToastType = 'info', duration = 3000) {
  const id = ++count
  toasts.value.push({ id, message, type })
  setTimeout(() => {
    toasts.value = toasts.value.filter(t => t.id !== id)
  }, duration)
}

export function useToast() {
  return {
    toasts,
    showToast,
  }
}
