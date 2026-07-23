import { describe, expect, it, vi } from 'vitest'
import { useAdminBatchOperation } from './useAdminBatchOperation'

describe('useAdminBatchOperation', () => {
  it('tracks progress and returns failed items for a focused retry', async () => {
    const batch = useAdminBatchOperation()
    const action = vi.fn(async (item: string) => {
      if (item === 'b') throw new Error('failed')
    })

    const result = await batch.runSequential(['a', 'b', 'c'], action)

    expect(result).toEqual({
      total: 3,
      success: 2,
      failed: 1,
      failedItems: ['b'],
    })
    expect(batch.completed.value).toBe(3)
    expect(batch.total.value).toBe(3)
    expect(batch.operating.value).toBe(false)
  })

  it('rejects overlapping runs without starting a second operation', async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const batch = useAdminBatchOperation()
    const first = batch.runSequential(['a'], () => pending)

    expect(await batch.runSequential(['b'], async () => undefined)).toBeNull()
    release()
    await first
  })
})
