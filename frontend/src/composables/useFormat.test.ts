import { describe, expect, it } from 'vitest'
import { dateTimeLocalToIso, formatDate, formatIpFingerprint, toDateTimeLocalValue } from './useFormat'

describe('useFormat', () => {
  it('formats dates as readable local timestamps', () => {
    expect(formatDate('')).toBe('-')
    expect(formatDate('not-a-date')).toBe('not-a-date')
    expect(formatDate('2026-07-18T13:10:45.965Z')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })

  it('round-trips datetime-local values through ISO', () => {
    expect(toDateTimeLocalValue('')).toBe('')
    expect(dateTimeLocalToIso('')).toBe('')
    expect(toDateTimeLocalValue('2026-07-18T13:10:00.000Z')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
  })

  it('shortens ip fingerprints without hiding the whole value', () => {
    expect(formatIpFingerprint('')).toBe('-')
    expect(formatIpFingerprint('abcdef1234567890')).toBe('abcdef1234567890')
    expect(formatIpFingerprint('d713b57b9955fb55053388afa16eecd1b0ee6b06d238a322df11153847ed3e86')).toBe('d713b57b99...ed3e86')
  })
})
