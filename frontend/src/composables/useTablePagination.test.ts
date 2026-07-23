import { describe, expect, it } from 'vitest'
import { useTablePagination } from './useTablePagination'

describe('useTablePagination', () => {
  it('clamps to the last valid page after a destructive refresh', () => {
    const pagination = useTablePagination({ initialLimit: 2 })
    pagination.setTotal(5)
    pagination.setPage(3)

    expect(pagination.setTotal(4)).toBe(true)
    expect(pagination.page.value).toBe(2)
    expect(pagination.totalPages.value).toBe(2)
  })

  it('normalizes invalid totals without creating an invalid page', () => {
    const pagination = useTablePagination({ initialPage: 4, initialLimit: 20 })

    expect(pagination.setTotal(-10)).toBe(true)
    expect(pagination.page.value).toBe(1)
    expect(pagination.total.value).toBe(0)
  })

  it('ignores non-finite pages and invalid page sizes', () => {
    const pagination = useTablePagination({ initialLimit: 20 })
    pagination.setTotal(100)
    pagination.setPage(3)

    pagination.setPage(Number.NaN)
    pagination.setLimit(0)

    expect(pagination.page.value).toBe(3)
    expect(pagination.limit.value).toBe(20)
    expect(pagination.offset.value).toBe(40)
  })

  it('uses integer page and page-size values', () => {
    const pagination = useTablePagination({ initialLimit: 20 })
    pagination.setTotal(100)

    pagination.setPage(2.9)
    pagination.setLimit(10.8)

    expect(pagination.page.value).toBe(1)
    expect(pagination.limit.value).toBe(10)
  })
})
