import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const loginSource = readFileSync(new URL('./AdminLoginView.vue', import.meta.url), 'utf8')

describe('admin login contract', () => {
  it('verifies a manually entered token before persisting it or reporting success', () => {
    const verifyIndex = loginSource.indexOf('await verifyAdminToken(candidateToken)')
    const persistIndex = loginSource.indexOf('setToken(candidateToken)')
    const successIndex = loginSource.indexOf("showToast('登录成功', 'success')")

    expect(verifyIndex).toBeGreaterThan(-1)
    expect(persistIndex).toBeGreaterThan(verifyIndex)
    expect(successIndex).toBeGreaterThan(persistIndex)
  })

  it('prevents duplicate edits and submissions while verification is in progress', () => {
    expect(loginSource).toContain(':disabled="loading"')
    expect(loginSource.match(/:disabled="loading"/g)).toHaveLength(2)
  })
})
