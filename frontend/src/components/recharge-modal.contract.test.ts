import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./RechargeModal.vue', import.meta.url), 'utf8')

describe('recharge modal interaction contract', () => {
  it('submits verification and recharge from the form, including Enter', () => {
    expect(source).toContain('<form v-if="step === \'form\'" class="recharge-body" @submit.prevent="submit">')
    expect(source).toContain('type="submit"')
    expect(source).toContain('验证并充值')
    expect(source).toContain('autocomplete="one-time-code"')
  })

  it('explains why recharge is unavailable when no payment method is enabled', () => {
    expect(source).toContain('paymentAvailabilityError')
    expect(source).toContain('暂无可用在线支付渠道，请联系管理员启用支付配置后重试')
    expect(source).toContain('methods.length === 0')
  })

  it('validates email, verification code, amount, and payment availability before creating an order', () => {
    expect(source).toContain("error.value = '请先填写有效邮箱'")
    expect(source).toContain("error.value = '请输入邮件中的 6 位验证码'")
    expect(source).toContain('充值金额必须在')
    expect(source).toContain('if (methods.value.length === 0) return')
  })

  it('expires stale recovery state and resets the modal after closing', () => {
    expect(source).toContain('PENDING_RECHARGE_TTL_MS')
    expect(source).toContain('createdAt')
    expect(source).toContain('resetFormState()')
    expect(source).toContain('loadShopConfig(true).catch(() => undefined)')
    expect(source).toContain(':disabled="submitting" @click="close"')
    expect(source).toContain('function close() { if (submitting.value) return; stopPolling(); closeRecharge(); resetFormState() }')
    expect(source.indexOf('restore()\n  await Promise.all')).toBeGreaterThan(-1)
    expect(source.indexOf('restore()\n  await Promise.all')).toBeLessThan(source.indexOf('loadShopConfig(true).catch'))
  })
})
