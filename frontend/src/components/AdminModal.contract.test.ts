import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./AdminModal.vue', import.meta.url), 'utf8')

describe('AdminModal layout and dismissal contract', () => {
  it('does not dismiss by default when the backdrop is clicked or Escape is pressed', () => {
    expect(source).not.toContain('@click.self="close"')
    expect(source).toContain('closeOnBackdrop: false')
    expect(source).toContain('closeOnEscape: false')
  })

  it('does not render an unhandled default confirm action in read-only detail dialogs', () => {
    expect(source).not.toContain("$emit('confirm')")
    expect(source).toContain('>关闭</button>')
  })

  it('keeps long content inside the viewport and scrolls only the body', () => {
    expect(source).toMatch(/max-height:\s*calc\(100dvh\s*-\s*48px\)/)
    expect(source).toMatch(/\.modal-body\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?overflow-y:\s*auto;/)
    expect(source).toContain('bodyRef.value.scrollTop = 0')
    expect(source).toContain('focus({ preventScroll: true })')
  })
})
