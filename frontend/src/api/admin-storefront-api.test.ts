import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchAdminOrders, replaceAdminStorefrontProducts } from './admin'

afterEach(() => vi.unstubAllGlobals())

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('admin storefront API contract', () => {
  it('sends the complete product mapping as one items payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, id: 'sf_software', count: 1 }))
    vi.stubGlobal('fetch', fetchMock)
    const items = [{ productId: 'prod-1', visible: true, sortOrder: 10 }]

    await replaceAdminStorefrontProducts('admin-token', 'sf_software', items)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/admin/storefronts/sf_software/products')
    expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({ method: 'PUT' }))
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ items, allowEmptyDefault: false })
  })

  it('sends explicit confirmation when clearing the default storefront', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, id: 'sf_default', count: 0 }))
    vi.stubGlobal('fetch', fetchMock)

    await replaceAdminStorefrontProducts('admin-token', 'sf_default', [], { allowEmptyDefault: true })

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      items: [],
      allowEmptyDefault: true,
    })
  })

  it('passes explicit order source and storefront filters to the backend', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, total: 0, orders: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await fetchAdminOrders('admin-token', {
      orderSource: 'storefront',
      storefrontId: 'sf_software',
      page: 2,
      limit: 20,
    })

    const url = new URL(fetchMock.mock.calls[0][0], 'https://shop.example')
    expect(url.pathname).toBe('/api/admin/orders')
    expect(url.searchParams.get('orderSource')).toBe('storefront')
    expect(url.searchParams.get('storefrontId')).toBe('sf_software')
    expect(url.searchParams.get('page')).toBe('2')
  })
})
