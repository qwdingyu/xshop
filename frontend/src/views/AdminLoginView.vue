<template>
  <div class="admin-login">
    <div class="login-card">
      <h1 class="login-title">{{ shopName }}管理后台</h1>
      <p class="login-subtitle">请输入管理令牌继续</p>

      <form class="login-form" @submit.prevent="handleLogin">
        <label class="field-label">
          <span>管理令牌</span>
          <input
            v-model="adminToken"
            type="password"
            placeholder="ADMIN_TOKEN"
            autocomplete="current-password"
            autofocus
            :disabled="loading"
          />
        </label>

        <button class="btn btn-primary login-btn" type="submit" :disabled="loading">
          {{ loading ? '验证中…' : '登 录' }}
        </button>

        <p v-if="error" class="login-error">{{ error }}</p>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAdminAuth } from '@/composables/useAdminAuth'
import { adminVerifyJwt, verifyAdminToken } from '@/api/admin'
import { useToast } from '@/composables/useToast'
import { useShopConfig } from '@/composables/useShopConfig'

const route = useRoute()
const router = useRouter()
const { setToken } = useAdminAuth()
const { showToast } = useToast()
const { shopName, loadShopConfig } = useShopConfig()

const adminToken = ref('')
const loading = ref(false)
const error = ref('')

function redirectAfterLogin() {
  const redirect = typeof route.query.redirect === 'string' && route.query.redirect.startsWith('/admin')
    ? route.query.redirect
    : '/admin'
  return router.replace(redirect)
}

async function handleLogin() {
  error.value = ''
  if (!adminToken.value.trim()) {
    error.value = '请输入管理令牌'
    return
  }

  const candidateToken = adminToken.value.trim()
  loading.value = true
  try {
    // 未经后端确认的候选令牌绝不能进入持久化登录态，也不能提前提示成功。
    await verifyAdminToken(candidateToken)
    setToken(candidateToken)
    showToast('登录成功', 'success')
    await redirectAfterLogin()
  } catch (err: any) {
    error.value = err.message || '登录失败，请检查令牌'
  } finally {
    loading.value = false
  }
}

async function consumeJwtLogin(jwt: string) {
  error.value = ''
  loading.value = true
  try {
    const res = await adminVerifyJwt('', jwt)
    setToken(res.adminToken)
    showToast('登录成功', 'success')
    await redirectAfterLogin()
  } catch (err: any) {
    error.value = err.message || '登录链接已失效，请重新获取'
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  loadShopConfig()
  const jwt = route.query.jwt
  if (typeof jwt === 'string' && jwt) {
    consumeJwtLogin(jwt)
  }
})
</script>

<style scoped>
.admin-login {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--tg-secondary-bg, #f5f7fa);
}

.login-card {
  width: 100%;
  max-width: 420px;
  background: var(--tg-bg, #fff);
  border-radius: var(--r-lg, 12px);
  padding: 26px 22px;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.08);
}

.login-title {
  margin: 0 0 6px;
  font-size: 20px;
  text-align: center;
}

.login-subtitle {
  margin: 0 0 18px;
  font-size: 13px;
  color: var(--tg-hint, #999);
  text-align: center;
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.field-label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: var(--tg-text, #333);
}

.field-label input {
  width: 100%;
  padding: 10px 12px;
  border: 0.5px solid var(--border, #e5e7eb);
  border-radius: var(--r-md, 8px);
  background: var(--tg-bg, #fff);
  color: var(--tg-text, #333);
  font-size: 14px;
}

.login-btn {
  margin-top: 4px;
}

.login-error {
  margin: 0;
  font-size: 13px;
  color: #ef4444;
  text-align: center;
}
</style>
