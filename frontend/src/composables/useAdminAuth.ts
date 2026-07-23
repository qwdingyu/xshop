import { ref, computed } from 'vue'

const TOKEN_KEY = 'admin_token'

/** 管理端登录态：基于 localStorage 的轻量实现 */
export function useAdminAuth() {
  const token = ref<string>(localStorage.getItem(TOKEN_KEY) || '')

  const isLoggedIn = computed(() => !!token.value)

  function setToken(value: string) {
    token.value = value
    localStorage.setItem(TOKEN_KEY, value)
  }

  function clearToken() {
    token.value = ''
    localStorage.removeItem(TOKEN_KEY)
  }

  return {
    token,
    isLoggedIn,
    setToken,
    clearToken,
  }
}
