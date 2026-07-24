import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetBodyScrollLockForTests,
  isBodyScrollLocked,
  lockBodyScroll,
  unlockBodyScroll,
} from './body-scroll-lock'

/**
 * vitest environment 为 node；用最小 body 样式桩验证锁语义，不引入 happy-dom。
 */
function installDocumentStub(options?: { scrollbarGap?: number }) {
  const gap = options?.scrollbarGap ?? 0
  const bodyStyle: Record<string, string> = {
    overflow: '',
    paddingRight: '',
  }
  const documentStub = {
    body: {
      style: bodyStyle,
    },
    documentElement: {
      clientWidth: 1000,
    },
  }
  vi.stubGlobal('document', documentStub)
  vi.stubGlobal('window', {
    innerWidth: 1000 + gap,
  })
  return bodyStyle
}

describe('body scroll lock', () => {
  beforeEach(() => {
    __resetBodyScrollLockForTests()
  })

  afterEach(() => {
    __resetBodyScrollLockForTests()
    vi.unstubAllGlobals()
  })

  it('locks overflow on first acquire and restores on last release', () => {
    const style = installDocumentStub()

    lockBodyScroll()
    expect(isBodyScrollLocked()).toBe(true)
    expect(style.overflow).toBe('hidden')

    unlockBodyScroll()
    expect(isBodyScrollLocked()).toBe(false)
    expect(style.overflow).toBe('')
  })

  it('keeps lock across nested acquire/release (confirm → pay handoff)', () => {
    const style = installDocumentStub()
    lockBodyScroll()
    lockBodyScroll()
    expect(style.overflow).toBe('hidden')

    // 确认层先 unlock：仍由收银台持锁，底层不应恢复滚动
    unlockBodyScroll()
    expect(isBodyScrollLocked()).toBe(true)
    expect(style.overflow).toBe('hidden')

    unlockBodyScroll()
    expect(isBodyScrollLocked()).toBe(false)
    expect(style.overflow).toBe('')
  })

  it('is idempotent when unlock is called without a matching lock', () => {
    const style = installDocumentStub()
    unlockBodyScroll()
    unlockBodyScroll()
    expect(isBodyScrollLocked()).toBe(false)
    expect(style.overflow).toBe('')
  })

  it('restores previous inline overflow when releasing', () => {
    const style = installDocumentStub()
    style.overflow = 'auto'
    lockBodyScroll()
    unlockBodyScroll()
    expect(style.overflow).toBe('auto')
  })

  it('compensates scrollbar gap with padding-right while locked', () => {
    const style = installDocumentStub({ scrollbarGap: 15 })
    lockBodyScroll()
    expect(style.overflow).toBe('hidden')
    expect(style.paddingRight).toBe('15px')
    unlockBodyScroll()
    expect(style.paddingRight).toBe('')
  })

  it('no-ops safely when document is undefined', () => {
    // 不装 document 桩：实现应直接 return，不抛错
    lockBodyScroll()
    unlockBodyScroll()
    expect(isBodyScrollLocked()).toBe(false)
  })
})
