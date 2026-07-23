import { ref } from 'vue'

export interface AdminBatchOperationResult<T> {
  total: number
  success: number
  failed: number
  failedItems: T[]
}

export function useAdminBatchOperation() {
  const operating = ref(false)
  const completed = ref(0)
  const total = ref(0)

  async function runSequential<T>(items: T[], action: (item: T) => Promise<void>): Promise<AdminBatchOperationResult<T> | null> {
    if (operating.value) return null
    operating.value = true
    completed.value = 0
    total.value = items.length
    const result: AdminBatchOperationResult<T> = {
      total: items.length,
      success: 0,
      failed: 0,
      failedItems: [],
    }

    try {
      for (const item of items) {
        try {
          await action(item)
          result.success += 1
        } catch {
          result.failed += 1
          result.failedItems.push(item)
        } finally {
          completed.value += 1
        }
      }
      return result
    } finally {
      operating.value = false
    }
  }

  return {
    operating,
    completed,
    total,
    runSequential,
  }
}
