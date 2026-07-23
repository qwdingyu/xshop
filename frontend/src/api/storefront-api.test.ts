import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchProductCatalog, fetchProductDetail, unifiedPay, verifyCoupon } from './index'

afterEach(() => vi.unstubAllGlobals())

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('public storefront API', () => {
  it('passes the URL slug to catalog and product detail requests', async () => {
    const storefront = {
      id: 'sf-software',
      slug: 'software',
      name: 'Software',
      logoUrl: '',
      supportEmail: 'support@example.com',
      isDefault: false,
      homePath: '/s/software',
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, storefront, products: [], categories: [] }))
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        storefront,
        product: { id: 'product/one', title: 'Product', priceCents: 100, currency: 'CNY' },
      }))
    vi.stubGlobal('fetch', fetchMock)

    const catalog = await fetchProductCatalog({ storefront: 'software' })
    await fetchProductDetail('product/one', catalog.storefront.slug)

    expect(fetchMock.mock.calls[0][0]).toBe('/api/products?storefront=software')
    expect(fetchMock.mock.calls[1][0]).toBe('/api/products/product%2Fone?storefront=software')
    expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({ cache: 'no-store' }))
    expect(fetchMock.mock.calls[1][1]).toEqual(expect.objectContaining({ cache: 'no-store' }))
    expect(catalog.storefront).toEqual(storefront)
  })

  it('binds quote and payment requests to the stable storefront id', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, valid: true, discountCents: 10 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, orderId: 'order-1' }))
    vi.stubGlobal('fetch', fetchMock)

    await verifyCoupon('SAVE10', 'product-1', 'sf-software', 2)
    await unifiedPay({
      storefrontId: 'sf-software',
      productId: 'product-1',
      buyerEmail: 'buyer@example.com',
      quantity: 2,
      idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',
    })

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      productId: 'product-1',
      storefrontId: 'sf-software',
      quantity: 2,
      couponCode: 'SAVE10',
    })
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      storefrontId: 'sf-software',
      productId: 'product-1',
      buyerEmail: 'buyer@example.com',
      quantity: 2,
    })
  })

  it('preserves the backend storefront error code and message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      ok: false,
      error: '商品不属于当前展示渠道或已下架',
      details: { code: 'PRODUCT_NOT_IN_STOREFRONT' },
    }, 404)))

    await expect(fetchProductDetail('product-1', 'software')).rejects.toMatchObject({
      status: 404,
      code: 'PRODUCT_NOT_IN_STOREFRONT',
      message: '商品不属于当前展示渠道或已下架',
    })
  })
})
