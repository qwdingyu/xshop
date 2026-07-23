import { nextTick } from 'vue'
import { describe, expect, it } from 'vitest'
import { useConfirmDialog } from './useConfirmDialog'

describe('useConfirmDialog', () => {
  it('resolves false when the dialog is dismissed', async () => {
    const dialog = useConfirmDialog()
    const pending = dialog.askConfirm('delete item')
    await nextTick()

    dialog.confirmVisible.value = false
    await nextTick()

    await expect(pending).resolves.toBe(false)
  })

  it('resolves true only through the confirm callback', async () => {
    const dialog = useConfirmDialog()
    const pending = dialog.askConfirm('delete item')

    dialog.onConfirm()
    dialog.confirmVisible.value = false

    await expect(pending).resolves.toBe(true)
  })

  it('cancels an older pending confirmation before opening another', async () => {
    const dialog = useConfirmDialog()
    const first = dialog.askConfirm('first')
    const second = dialog.askConfirm('second')

    await expect(first).resolves.toBe(false)
    dialog.onConfirm()
    await expect(second).resolves.toBe(true)
  })
})
