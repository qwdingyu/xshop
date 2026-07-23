import { afterEach, describe, expect, it, vi } from 'vitest'
import { retryAfterSecondsFromError, useEmailCodeCooldown } from './useEmailCodeCooldown'

describe('useEmailCodeCooldown', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('counts down from the configured resend cooldown', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-17T00:00:00Z'))

    const cooldown = useEmailCodeCooldown(60)
    cooldown.startCooldown()

    expect(cooldown.remainingSeconds.value).toBe(60)
    expect(cooldown.isCoolingDown.value).toBe(true)
    expect(cooldown.buttonText.value).toBe('60s后重发')

    vi.advanceTimersByTime(1000)
    expect(cooldown.remainingSeconds.value).toBe(59)

    vi.advanceTimersByTime(59_000)
    expect(cooldown.remainingSeconds.value).toBe(0)
    expect(cooldown.isCoolingDown.value).toBe(false)
    expect(cooldown.buttonText.value).toBe('发送验证码')
  })

  it('extracts retry seconds from API error details', () => {
    expect(retryAfterSecondsFromError({ details: { retryAfterSeconds: 42.2 } })).toBe(43)
    expect(retryAfterSecondsFromError({ details: { retryAfterSeconds: 0 } })).toBe(0)
    expect(retryAfterSecondsFromError(new Error('failed'))).toBe(0)
  })
})
