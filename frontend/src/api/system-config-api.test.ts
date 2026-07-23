import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchConfig, fetchPaymentMethods, getPayStatus } from './index'

afterEach(() => vi.unstubAllGlobals())

describe('public system config API', () => {
  it('bypasses any browser-cached config left by an older deployment', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      config: { balance_payment_enabled: 'false' },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await fetchConfig()

    expect(fetchMock).toHaveBeenCalledWith('/api/system-config', expect.objectContaining({
      cache: 'no-store',
    }))
  })

  it('does not reuse stale payment capabilities after an admin update', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, methods: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await fetchPaymentMethods()

    expect(fetchMock).toHaveBeenCalledWith('/api/pay/methods', expect.objectContaining({
      cache: 'no-store',
    }))
  })

  it('does not cache token-authorized payment status or delivery data', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      status: 'pending',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await getPayStatus('order-1', 'secret-token')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/pay/status/order-1?token=secret-token',
      expect.objectContaining({ cache: 'no-store' }),
    )
  })
})
