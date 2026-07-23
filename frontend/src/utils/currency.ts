import { formatMoney, minorToMajorString, parseMajorToMinor } from '@shared/money'

export function normalizeCents(value: unknown): number {
  const cents = Number(value)
  return Number.isSafeInteger(cents) ? cents : 0
}

export function formatCents(value: unknown): string {
  return minorToMajorString(normalizeCents(value), 'CNY')
}

export function parseYuanToCents(value: string): number | null {
  try {
    return parseMajorToMinor(value, 'CNY')
  } catch {
    return null
  }
}

export { formatMoney }
