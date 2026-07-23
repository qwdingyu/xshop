import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const routerSource = readFileSync(new URL('../../router/index.ts', import.meta.url), 'utf8')

describe('admin routing contract', () => {
  it('keeps the pending-tasks URL on an explicit authenticated page route', () => {
    expect(routerSource).toContain("path: 'pending-tasks'")
    expect(routerSource).toContain("name: 'AdminPendingTasks'")
    expect(routerSource.match(/component: AdminDashboardView/g)).toHaveLength(2)
  })
})
