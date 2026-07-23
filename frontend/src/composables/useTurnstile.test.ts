import { afterEach, describe, expect, it, vi } from 'vitest'

const shopConfigState = vi.hoisted(() => ({
  turnstileEnabled: { value: false },
  turnstileSiteKey: { value: '' },
  loadShopConfig: vi.fn(),
}))

vi.mock('./useShopConfig', () => ({
  useShopConfig: () => shopConfigState,
}))

import { useTurnstile } from './useTurnstile'

afterEach(() => {
  shopConfigState.turnstileEnabled.value = false
  shopConfigState.turnstileSiteKey.value = ''
  vi.unstubAllGlobals()
})

describe('useTurnstile', () => {
  it('reads the token from the dedicated recharge widget', () => {
    const element = { innerHTML: '' }
    const getResponse = vi.fn((widgetId?: number) => widgetId === 73 ? 'recharge-token' : 'other-token')
    vi.stubGlobal('document', { getElementById: vi.fn().mockReturnValue(element) })
    vi.stubGlobal('window', {
      turnstile: {
        render: vi.fn().mockReturnValue(73),
        getResponse,
        reset: vi.fn(),
      },
    })
    shopConfigState.turnstileEnabled.value = true
    shopConfigState.turnstileSiteKey.value = 'site-key'

    const turnstile = useTurnstile()
    turnstile.renderRechargeTurnstile()

    expect(turnstile.getRechargeResponse()).toBe('recharge-token')
    expect(getResponse).toHaveBeenCalledWith(73)
  })
})
