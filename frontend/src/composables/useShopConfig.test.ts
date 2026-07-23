import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchConfig } from '@/api'
import { useShopConfig } from './useShopConfig'

vi.mock('@/api', () => ({
  fetchConfig: vi.fn(),
}))

describe('useShopConfig', () => {
  beforeEach(() => vi.clearAllMocks())

  it('falls back to safe recharge limits when legacy config values are invalid', async () => {
    vi.mocked(fetchConfig).mockResolvedValue({
      config: {
        balance_recharge_min_cents: 'not-a-number',
        balance_recharge_max_cents: 'Infinity',
      },
    })

    const config = useShopConfig()
    await config.loadShopConfig(true)

    expect(config.balanceRechargeMinCents.value).toBe(100)
    expect(config.balanceRechargeMaxCents.value).toBe(500000)
  })

  it('keeps the maximum greater than or equal to the minimum', async () => {
    vi.mocked(fetchConfig).mockResolvedValue({
      config: {
        balance_recharge_min_cents: '1000',
        balance_recharge_max_cents: '500',
      },
    })

    const config = useShopConfig()
    await config.loadShopConfig(true)

    expect(config.balanceRechargeMinCents.value).toBe(1000)
    expect(config.balanceRechargeMaxCents.value).toBe(1000)
  })

  it('runs a forced refresh after an in-flight request instead of silently reusing stale state', async () => {
    let resolveFirst!: (value: { config: { balance_payment_enabled: string } }) => void
    vi.mocked(fetchConfig)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
      .mockResolvedValueOnce({ config: { balance_payment_enabled: 'false' } })

    const config = useShopConfig()
    const initialLoad = config.loadShopConfig(true)
    const forcedRefresh = config.loadShopConfig(true)

    resolveFirst({ config: { balance_payment_enabled: 'true' } })
    await Promise.all([initialLoad, forcedRefresh])

    expect(fetchConfig).toHaveBeenCalledTimes(2)
    expect(config.balancePaymentEnabled.value).toBe(false)
  })
})
