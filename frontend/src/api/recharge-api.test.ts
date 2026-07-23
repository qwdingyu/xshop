import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBalanceRecharge, fetchBalanceRechargeStatus, unifiedPay } from './index'

afterEach(() => vi.unstubAllGlobals())

describe('balance recharge API', () => {
  it('binds the idempotency key to the request header and not the JSON body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, orderId: 'order-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await createBalanceRecharge({
      buyerEmail: 'buyer@example.com',
      emailAccessCode: '123456',
      amountCents: 5000,
      paymentChannel: 'alipay',
      idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',
    })

    const [, options] = fetchMock.mock.calls[0]
    expect(new Headers(options.headers).get('Idempotency-Key')).toBe('123e4567-e89b-42d3-a456-426614174000')
    expect(JSON.parse(options.body)).toEqual({
      buyerEmail: 'buyer@example.com',
      emailAccessCode: '123456',
      amountCents: 5000,
      paymentChannel: 'alipay',
    })
  })

  it('queries status with the order token in a POST body instead of the URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, status: 'pending' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await fetchBalanceRechargeStatus('order-1', 'secret-token')

    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/recharge/status')
    expect(options.method).toBe('POST')
    expect(JSON.parse(options.body)).toEqual({ orderId: 'order-1', orderToken: 'secret-token' })
  })
})

describe('unified payment API', () => {
  it('binds the required idempotency key to the request header and not the JSON body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, orderId: 'order-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await unifiedPay({
      storefrontId: 'sf-default',
      productId: 'product-1',
      buyerEmail: 'buyer@example.com',
      idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',
    })

    const [, options] = fetchMock.mock.calls[0]
    expect(new Headers(options.headers).get('Idempotency-Key')).toBe('123e4567-e89b-42d3-a456-426614174000')
    expect(JSON.parse(options.body)).toEqual({
      storefrontId: 'sf-default',
      productId: 'product-1',
      buyerEmail: 'buyer@example.com',
    })
  })
})
