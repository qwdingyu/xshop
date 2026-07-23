import { computed, ref, watch, type Ref } from 'vue'

export interface UseTableSelectionOptions<T> {
  isSelectable?: (row: T) => boolean
}

export function useTableSelection<T>(
  rows: Ref<T[]>,
  getKey: (row: T) => string,
  options: UseTableSelectionOptions<T> = {},
) {
  const selectedIds = ref<string[]>([])
  const rowIds = computed(() => Array.from(new Set(
    rows.value
      .filter((row) => options.isSelectable?.(row) ?? true)
      .map(getKey)
      .filter(Boolean),
  )))
  const selectableSet = computed(() => new Set(rowIds.value))
  const selectedSet = computed(() => new Set(selectedIds.value))
  const selectedCount = computed(() => selectedIds.value.length)
  const selectableCount = computed(() => rowIds.value.length)
  const allVisibleSelected = computed(() => rowIds.value.length > 0 && rowIds.value.every((id) => selectedSet.value.has(id)))
  const partiallySelected = computed(() => selectedCount.value > 0 && selectedCount.value < rowIds.value.length)
  let rangeAnchorId = ''

  function isSelected(id: string) {
    return selectedSet.value.has(id)
  }

  function setSelected(id: string, checked: boolean, extendRange = false) {
    if (!id || !selectableSet.value.has(id)) return
    const next = new Set(selectedIds.value)
    const anchorIndex = rowIds.value.indexOf(rangeAnchorId)
    const currentIndex = rowIds.value.indexOf(id)

    if (extendRange && anchorIndex >= 0 && currentIndex >= 0) {
      const start = Math.min(anchorIndex, currentIndex)
      const end = Math.max(anchorIndex, currentIndex)
      for (const rangeId of rowIds.value.slice(start, end + 1)) {
        if (checked) next.add(rangeId)
        else next.delete(rangeId)
      }
    } else if (checked) {
      next.add(id)
    } else {
      next.delete(id)
    }

    selectedIds.value = Array.from(next)
    rangeAnchorId = id
  }

  function toggleAllVisible(checked: boolean) {
    const next = new Set(selectedIds.value)
    for (const id of rowIds.value) {
      if (checked) next.add(id)
      else next.delete(id)
    }
    selectedIds.value = Array.from(next)
  }

  function clearSelection() {
    selectedIds.value = []
    rangeAnchorId = ''
  }

  watch(rowIds, (ids) => {
    const visible = new Set(ids)
    selectedIds.value = selectedIds.value.filter((id) => visible.has(id))
    if (rangeAnchorId && !visible.has(rangeAnchorId)) rangeAnchorId = ''
  })

  return {
    selectedIds,
    selectedSet,
    selectedCount,
    selectableCount,
    allVisibleSelected,
    partiallySelected,
    isSelected,
    setSelected,
    toggleAllVisible,
    clearSelection,
  }
}
