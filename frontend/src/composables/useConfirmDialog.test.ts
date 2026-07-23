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

  it('returns option checkbox values on confirm, defaults unchecked', async () => {
    const dialog = useConfirmDialog()
    const pending = dialog.askConfirmWithOptions('force delete?', {
      options: [
        { key: 'force', label: '全部删除' },
        { key: 'unlinkRefs', label: '解绑引用' },
      ],
    })
    await nextTick()

    expect(dialog.confirmOptionValues.value).toEqual({ force: false, unlinkRefs: false })
    dialog.setConfirmOption('force', true)
    dialog.setConfirmOption('unlinkRefs', true)
    dialog.onConfirm()

    await expect(pending).resolves.toEqual({
      confirmed: true,
      options: { force: true, unlinkRefs: true },
    })
  })

  it('resets option values each time the dialog opens', async () => {
    const dialog = useConfirmDialog()
    const first = dialog.askConfirmWithOptions('first', {
      options: [{ key: 'force', label: '全部删除', defaultChecked: false }],
    })
    await nextTick()
    dialog.setConfirmOption('force', true)
    dialog.confirmVisible.value = false
    await nextTick()
    await expect(first).resolves.toMatchObject({ confirmed: false })

    const second = dialog.askConfirmWithOptions('second', {
      options: [{ key: 'force', label: '全部删除' }],
    })
    await nextTick()
    expect(dialog.confirmOptionValues.value.force).toBe(false)
    dialog.onConfirm()
    await expect(second).resolves.toEqual({
      confirmed: true,
      options: { force: false },
    })
  })
})
