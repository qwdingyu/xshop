import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchAdminSummary } from './admin'

describe('fetchAdminSummary', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('preserves the backend amountCents field for daily income rows', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      summary: {
        products: 0,
        availableCards: 0,
        totalCards: 0,
        totalOrders: 0,
        pendingOrders: 0,
        lowStockCount: 0,
        ordersToday: 0,
        issuedToday: 0,
        totalIncomeCents: 1234,
        todayIncomeCents: 1234,
        todayAlipayCents: 0,
        todayEasyPayCents: 1234,
      },
      dailyIncome: [{ date: '07-17', amountCents: 1234 }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))

    const result = await fetchAdminSummary('admin-token')

    expect(result.dailyIncome).toEqual([{ date: '07-17', amountCents: 1234 }])
    expect(result.dailyIncome[0]?.amountCents).toBe(1234)
  })
})
