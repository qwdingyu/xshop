import { afterEach, describe, expect, it, vi } from 'vitest'
import { uploadAdminMediaImage } from './admin'

describe('admin media upload API', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses authenticated FormData without setting an invalid JSON content type', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      key: 'images/id.png',
      url: 'https://shop.example.com/api/media/images/id.png',
      contentType: 'image/png',
      size: 12,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const file = new File([new Uint8Array(12)], 'cover.png', { type: 'image/png' })

    await expect(uploadAdminMediaImage('admin-token', file)).resolves.toMatchObject({
      key: 'images/id.png',
      contentType: 'image/png',
    })
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(options.headers).toEqual({ Authorization: 'Bearer admin-token' })
    expect(options.body).toBeInstanceOf(FormData)
  })

  it('rejects oversized files before making a network request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const file = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' })
    await expect(uploadAdminMediaImage('admin-token', file)).rejects.toThrow('图片不能超过 5MiB')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
