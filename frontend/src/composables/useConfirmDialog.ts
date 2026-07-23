import { ref, watch } from 'vue'

export type ConfirmOptionDef = {
  key: string
  label: string
  /** 补充说明，显示在 label 下方 */
  hint?: string
  /** 默认 false */
  defaultChecked?: boolean
}

export type ConfirmAskOptions = {
  /** 危险操作样式（红按钮），由调用方通过 ConfirmDialog danger prop 控制亦可 */
  danger?: boolean
  /** 可选勾选项，默认全部未勾选；打开弹窗时按 defaultChecked 重置 */
  options?: ConfirmOptionDef[]
}

export type ConfirmResult = {
  confirmed: boolean
  /** key → 是否勾选；取消时各值为 defaultChecked（调用方应以 confirmed 为准） */
  options: Record<string, boolean>
}

export function useConfirmDialog() {
  const confirmVisible = ref(false)
  const confirmMessage = ref('')
  const confirmOptionDefs = ref<ConfirmOptionDef[]>([])
  const confirmOptionValues = ref<Record<string, boolean>>({})
  let confirmCallback: ((result: ConfirmResult) => void) | null = null

  function snapshotOptions(): Record<string, boolean> {
    const out: Record<string, boolean> = {}
    for (const def of confirmOptionDefs.value) {
      out[def.key] = Boolean(confirmOptionValues.value[def.key])
    }
    return out
  }

  function resetOptionValues(defs: ConfirmOptionDef[]) {
    const next: Record<string, boolean> = {}
    for (const def of defs) {
      next[def.key] = def.defaultChecked === true
    }
    confirmOptionValues.value = next
  }

  /**
   * 简单确认：仅返回 boolean（兼容旧调用）。
   * 需要读取 Checkbox 时请用 askConfirmWithOptions。
   */
  function askConfirm(message: string): Promise<boolean> {
    return askConfirmWithOptions(message).then((r) => r.confirmed)
  }

  function askConfirmWithOptions(
    message: string,
    options: ConfirmAskOptions = {},
  ): Promise<ConfirmResult> {
    confirmCallback?.({ confirmed: false, options: snapshotOptions() })
    confirmMessage.value = message
    const defs = options.options ?? []
    confirmOptionDefs.value = defs
    resetOptionValues(defs)
    confirmVisible.value = true
    return new Promise((resolve) => {
      confirmCallback = (result) => resolve(result)
    })
  }

  function onConfirm() {
    if (!confirmCallback) return
    const callback = confirmCallback
    confirmCallback = null
    callback({ confirmed: true, options: snapshotOptions() })
  }

  function setConfirmOption(key: string, checked: boolean) {
    confirmOptionValues.value = {
      ...confirmOptionValues.value,
      [key]: checked,
    }
  }

  watch(confirmVisible, (visible, wasVisible) => {
    if (wasVisible && !visible && confirmCallback) {
      const callback = confirmCallback
      confirmCallback = null
      callback({ confirmed: false, options: snapshotOptions() })
    }
  })

  return {
    confirmVisible,
    confirmMessage,
    confirmOptionDefs,
    confirmOptionValues,
    askConfirm,
    askConfirmWithOptions,
    onConfirm,
    setConfirmOption,
  }
}
