/**
 * 店面浮层共用的 body 滚动锁。
 * - 引用计数：确认层 → 收银台 handoff 时不断锁，避免底层横向跳一下
 * - 滚动条宽度补偿：hidden 时用 padding-right 顶住，避免内容区突然变宽
 *
 * 仅操作 document.body 内联样式；无 document（测试/SSR）时为 no-op。
 */

let lockCount = 0
let previousOverflow = ''
let previousPaddingRight = ''

function scrollbarWidthPx(): number {
  if (typeof window === 'undefined' || typeof document === 'undefined') return 0
  return Math.max(0, window.innerWidth - document.documentElement.clientWidth)
}

/** 当前是否由本模块持有 body 锁（测试 / 调试用） */
export function isBodyScrollLocked(): boolean {
  return lockCount > 0
}

/** 测试用：重置模块状态，勿在生产路径调用 */
export function __resetBodyScrollLockForTests(): void {
  lockCount = 0
  previousOverflow = ''
  previousPaddingRight = ''
  if (typeof document !== 'undefined') {
    document.body.style.overflow = ''
    document.body.style.paddingRight = ''
  }
}

export function lockBodyScroll(): void {
  if (typeof document === 'undefined') return
  lockCount += 1
  if (lockCount !== 1) return

  previousOverflow = document.body.style.overflow
  previousPaddingRight = document.body.style.paddingRight

  const gap = scrollbarWidthPx()
  document.body.style.overflow = 'hidden'
  if (gap > 0) {
    // 仅在当前没有内联 padding-right 时补偿，避免叠加上次未清的值
    const currentPad = Number.parseFloat(previousPaddingRight || '0') || 0
    document.body.style.paddingRight = `${currentPad + gap}px`
  }
}

export function unlockBodyScroll(): void {
  if (typeof document === 'undefined') return
  if (lockCount <= 0) {
    lockCount = 0
    return
  }
  lockCount -= 1
  if (lockCount !== 0) return

  document.body.style.overflow = previousOverflow
  document.body.style.paddingRight = previousPaddingRight
  previousOverflow = ''
  previousPaddingRight = ''
}
