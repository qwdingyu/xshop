import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchAdminSummary, verifyAdminToken } from './admin'

describe('admin token verification', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('verifies the candidate token through the dedicated protected endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(verifyAdminToken('correct-token')).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/session', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer correct-token' }),
    }))
  })

  it('reports an invalid candidate without clearing state or redirecting', async () => {
    const removeItem = vi.fn()
    const assign = vi.fn()
    vi.stubGlobal('localStorage', { removeItem })
    vi.stubGlobal('window', {
      location: { pathname: '/admin/login', search: '', hash: '', assign },
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: '未授权' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })))

    await expect(verifyAdminToken('wrong-token')).rejects.toMatchObject({
      message: '管理令牌无效',
      status: 401,
      code: 'INVALID_ADMIN_TOKEN',
    })
    expect(removeItem).not.toHaveBeenCalled()
    expect(assign).not.toHaveBeenCalled()
  })

  it('keeps the existing logout redirect for an authenticated API that returns 401', async () => {
    const removeItem = vi.fn()
    const assign = vi.fn()
    vi.stubGlobal('localStorage', { removeItem })
    vi.stubGlobal('window', {
      location: { pathname: '/admin', search: '?tab=today', hash: '', assign },
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: '未授权' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })))

    await expect(fetchAdminSummary('expired-token')).rejects.toMatchObject({
      message: '登录已过期，请重新登录',
      status: 401,
      code: 'UNAUTHORIZED',
    })
    expect(removeItem).toHaveBeenCalledWith('admin_token')
    expect(assign).toHaveBeenCalledWith('/admin/login?redirect=%2Fadmin%3Ftab%3Dtoday')
  })
})
