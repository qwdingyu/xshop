import { ref } from 'vue'

const visible = ref(false)

export function useRecharge() {
  return {
    visible,
    openRecharge: () => { visible.value = true },
    closeRecharge: () => { visible.value = false },
  }
}
