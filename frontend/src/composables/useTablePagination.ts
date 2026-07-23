import { ref, computed, type Ref, type ComputedRef } from 'vue'

export interface UseTablePaginationOptions {
  initialPage?: number
  initialLimit?: number
}

export interface UseTablePaginationReturn {
  page: Ref<number>
  limit: Ref<number>
  total: Ref<number>
  totalPages: ComputedRef<number>
  setPage: (page: number) => void
  setLimit: (limit: number) => void
  setTotal: (total: number) => boolean
  nextPage: () => void
  prevPage: () => void
  reset: () => void
  offset: ComputedRef<number>
}

export function useTablePagination(options: UseTablePaginationOptions = {}): UseTablePaginationReturn {
  const page = ref(options.initialPage ?? 1)
  const limit = ref(options.initialLimit ?? 20)
  const total = ref(0)

  const totalPages = computed(() => Math.max(1, Math.ceil(total.value / limit.value)))
  const offset = computed(() => (page.value - 1) * limit.value)

  function setPage(p: number) {
    if (!Number.isFinite(p)) return
    page.value = Math.max(1, Math.min(Math.trunc(p), totalPages.value))
  }

  function setLimit(l: number) {
    if (!Number.isFinite(l) || l <= 0) return
    limit.value = Math.trunc(l)
    page.value = 1
  }

  function setTotal(nextTotal: number) {
    const numericTotal = Number(nextTotal)
    total.value = Number.isFinite(numericTotal) ? Math.max(0, Math.trunc(numericTotal)) : 0
    const nextPage = Math.max(1, Math.min(page.value, totalPages.value))
    if (nextPage === page.value) return false
    page.value = nextPage
    return true
  }

  function nextPage() {
    if (page.value < totalPages.value) {
      page.value += 1
    }
  }

  function prevPage() {
    if (page.value > 1) {
      page.value -= 1
    }
  }

  function reset() {
    page.value = options.initialPage ?? 1
    limit.value = options.initialLimit ?? 20
    total.value = 0
  }

  return {
    page,
    limit,
    total,
    totalPages,
    setPage,
    setLimit,
    setTotal,
    nextPage,
    prevPage,
    reset,
    offset,
  }
}
