import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeClipboardText } from './useClipboard'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('writeClipboardText', () => {
  it('uses the asynchronous Clipboard API when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    await writeClipboardText('VCH-ABCDEF23')

    expect(writeText).toHaveBeenCalledWith('VCH-ABCDEF23')
  })
})
