import { describe, expect, it } from 'vitest'
import { formatCents, normalizeCents, parseYuanToCents } from './currency'

describe('admin currency formatting', () => {
  it('formats integer cents as a fixed two-decimal yuan value', () => {
    expect(formatCents(1234)).toBe('12.34')
    expect(formatCents(0)).toBe('0.00')
  })

  it('does not expose invalid numeric values in the UI', () => {
    expect(normalizeCents(undefined)).toBe(0)
    expect(normalizeCents(Number.NaN)).toBe(0)
    expect(normalizeCents(1.5)).toBe(0)
    expect(formatCents(Number.POSITIVE_INFINITY)).toBe('0.00')
  })
})

describe('parseYuanToCents', () => {
  it('converts valid yuan input without floating point drift', () => {
    expect(parseYuanToCents('0.01')).toBe(1)
    expect(parseYuanToCents('50')).toBe(5000)
    expect(parseYuanToCents(' 50.5 ')).toBe(5050)
  })

  it('rejects ambiguous or over-precise monetary input', () => {
    expect(parseYuanToCents('')).toBeNull()
    expect(parseYuanToCents('1.001')).toBeNull()
    expect(parseYuanToCents('-1')).toBeNull()
    expect(parseYuanToCents('1e2')).toBeNull()
  })
})
