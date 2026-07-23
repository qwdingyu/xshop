import { nextTick, ref } from 'vue'
import { describe, expect, it } from 'vitest'
import { useTableSelection } from './useTableSelection'

interface Row {
  id: string
  locked?: boolean
}

describe('useTableSelection', () => {
  it('selects only selectable rows when selecting the visible page', () => {
    const rows = ref<Row[]>([
      { id: 'a' },
      { id: 'b', locked: true },
      { id: 'c' },
    ])
    const selection = useTableSelection(rows, (row) => row.id, {
      isSelectable: (row) => !row.locked,
    })

    selection.toggleAllVisible(true)

    expect(selection.selectedIds.value).toEqual(['a', 'c'])
    expect(selection.selectableCount.value).toBe(2)
    expect(selection.allVisibleSelected.value).toBe(true)
  })

  it('supports shift range selection and deselection', () => {
    const rows = ref<Row[]>(['a', 'b', 'c', 'd'].map((id) => ({ id })))
    const selection = useTableSelection(rows, (row) => row.id)

    selection.setSelected('a', true)
    selection.setSelected('c', true, true)
    expect(selection.selectedIds.value).toEqual(['a', 'b', 'c'])

    selection.setSelected('a', false, true)
    expect(selection.selectedIds.value).toEqual([])
  })

  it('drops selections and the range anchor when rows leave the current view', async () => {
    const rows = ref<Row[]>([{ id: 'a' }, { id: 'b' }])
    const selection = useTableSelection(rows, (row) => row.id)
    selection.setSelected('a', true)

    rows.value = [{ id: 'c' }, { id: 'd' }]
    await nextTick()
    selection.setSelected('d', true, true)

    expect(selection.selectedIds.value).toEqual(['d'])
    expect(selection.partiallySelected.value).toBe(true)
  })
})
