/** 剪贴板工具：一键复制文本到剪贴板，带按钮视觉反馈 */

const FEEDBACK_MS = 1500

/** 复制文本，更新按钮文字反馈 */
export async function writeClipboardText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  textarea.remove()
  if (!copied) throw new Error('Clipboard copy failed')
}

export function copyText(text: string, e: Event) {
  writeClipboardText(text).then(() => {
    feedback(e, '✅')
  }).catch(() => {
    feedback(e, '❌')
  })
}

function feedback(e: Event, icon: string) {
  const btn = e.currentTarget as HTMLButtonElement
  const original = btn.textContent
  btn.textContent = icon
  setTimeout(() => { btn.textContent = original }, FEEDBACK_MS)
}
