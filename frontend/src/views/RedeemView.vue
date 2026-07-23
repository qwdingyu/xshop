<template>
  <div class="redeem-view">
    <div class="page-section">
      <div class="section-label">余额兑换</div>
      <h1 class="section-title">充值码兑换</h1>
      <p class="hint-text">这里用于把已购买的充值码兑换成邮箱余额；在线购买商品请到商品页直接支付。</p>
    </div>

    <div class="form-card">
      <form @submit.prevent="handleSubmit">
        <div class="form-field">
          <label class="form-label" for="redeem-code">充值码</label>
          <input
            id="redeem-code"
            v-model="code"
            type="text"
            placeholder="例如 VCH-ABCDEFGH"
            autocomplete="one-time-code"
            minlength="8"
            maxlength="80"
            required
          />
        </div>

        <div class="form-field">
          <label class="form-label" for="redeem-email">邮箱</label>
          <input
            id="redeem-email"
            v-model="email"
            type="email"
            placeholder="输入邮箱（用于绑定余额）"
            required
          />
        </div>

        <!-- Turnstile -->
        <Turnstile container-id="turnstile-container" />

        <button class="btn btn-primary btn-full" type="submit" :disabled="submitting">
          {{ submitting ? '兑换中…' : '兑换充值码' }}
        </button>
      </form>

      <div v-if="result" class="result-box" :class="resultType">
        {{ result }}
      </div>

      <div v-if="resultType === 'status-success'" class="redeem-guide">
        <p>余额已绑定到该邮箱，购买商品时可选择余额支付。</p>
        <RouterLink :to="shopHomePath" class="btn btn-ghost">去选购商品 →</RouterLink>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import Turnstile from '@/components/Turnstile.vue'
import { redeemVoucher } from '@/api'
import { useTurnstile } from '@/composables/useTurnstile'
import { useStorefrontContext } from '@/composables/useStorefrontContext'

const { homePath: storefrontHomePath } = useStorefrontContext()
const shopHomePath = computed(() => storefrontHomePath.value)

const code = ref('')
const email = ref('')
const submitting = ref(false)
const result = ref('')
const resultType = ref('')
const { getResponse, reset } = useTurnstile()

async function handleSubmit() {
  submitting.value = true
  result.value = ''
  resultType.value = ''
  try {
    const token = getResponse()
    const res = await redeemVoucher({
      code: code.value.trim(),
      email: email.value.trim(),
      turnstileToken: token || undefined,
    })
    resultType.value = 'status-success'
    result.value = res.message || `兑换成功，已入账 ¥${res.amountYuan}`
    code.value = ''
    email.value = ''
    reset()
  } catch (err: any) {
    reset()
    resultType.value = 'status-error'
    result.value = err.message || '兑换失败，请检查充值码是否完整、邮箱是否正确'
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.redeem-view {
  padding-top: 16px;
  padding-bottom: 24px;
}

.hint-text {
  margin-top: 6px;
  font-size: 14px;
  line-height: 1.5;
  color: var(--tg-hint);
}

.btn-full {
  width: 100%;
  margin-top: 4px;
}

/* Delivery info */
.delivery-info {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 0.5px solid var(--border);
}

.delivery-title {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 10px;
}

.delivery-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 6px 0;
  font-size: 14px;
}

.delivery-label {
  color: var(--tg-hint);
  flex-shrink: 0;
  min-width: 32px;
}

.delivery-value {
  font-family: var(--font-mono);
  font-weight: 500;
  word-break: break-all;
}

/* Copy button */
.btn-copy {
  flex-shrink: 0;
  padding: 2px 6px;
  border: none;
  border-radius: var(--r-sm);
  background: transparent;
  cursor: pointer;
  font-size: 14px;
  transition: background var(--duration-fast) var(--ease-out);
}

.btn-copy:hover {
  background: var(--surface-hover);
}

.redeem-guide {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 0.5px solid var(--border);
  text-align: center;
}

.redeem-guide p {
  font-size: 14px;
  color: var(--tg-hint);
  margin-bottom: 8px;
}
</style>
