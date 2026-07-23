export function downloadCsv(filename: string, rows: string[][]) {
  const content = `\uFEFF${rows.map((row) => row.map(safeCsvCell).join(',')).join('\n')}`
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

export function safeCsvCell(value: string) {
  const text = String(value ?? '')
  const escaped = text.replace(/"/g, '""')
  return /^[=+\-@\t\n]/.test(escaped) ? `"\t${escaped}"` : `"${escaped}"`
}
