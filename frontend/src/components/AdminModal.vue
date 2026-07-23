<template>
  <div v-if="modelValue" class="modal-mask" @click.self="handleBackdropClick">
    <div
      ref="modalRef"
      class="modal"
      :style="{ maxWidth }"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="title ? titleId : undefined"
      aria-label="管理后台弹窗"
      tabindex="-1"
      @keydown="handleKeydown"
    >
      <h3 v-if="title" :id="titleId" class="modal-title">{{ title }}</h3>
      <div ref="bodyRef" class="modal-body">
        <slot />
      </div>
      <div v-if="$slots.actions || !hideActions" class="modal-actions">
        <slot name="actions">
          <button type="button" class="btn btn-ghost" @click="close">关闭</button>
        </slot>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'

const props = withDefaults(defineProps<{
  modelValue: boolean
  title?: string
  maxWidth?: string
  hideActions?: boolean
  closeOnBackdrop?: boolean
  closeOnEscape?: boolean
}>(), {
  hideActions: false,
  closeOnBackdrop: false,
  closeOnEscape: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const modalRef = ref<HTMLElement | null>(null)
const bodyRef = ref<HTMLElement | null>(null)
const titleId = `admin-modal-title-${useId()}`
let restoreFocus: HTMLElement | null = null

function close() {
  emit('update:modelValue', false)
}

function handleBackdropClick() {
  if (props.closeOnBackdrop) close()
}

function getFocusableElements() {
  return Array.from(modalRef.value?.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
  ) || [])
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    if (!props.closeOnEscape) return
    event.preventDefault()
    close()
    return
  }
  if (event.key !== 'Tab') return

  const focusable = getFocusableElements()
  if (focusable.length === 0) {
    event.preventDefault()
    modalRef.value?.focus()
    return
  }

  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (event.shiftKey && (document.activeElement === first || document.activeElement === modalRef.value)) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

watch(() => props.modelValue, async (visible, wasVisible) => {
  if (visible && !wasVisible) {
    restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    await nextTick()
    // 长详情中的第一个按钮通常位于正文底部；若直接聚焦它，浏览器会把滚动区自动拉到底部。
    // 打开时先回到正文顶部并聚焦对话框容器，用户可以从订单基本信息开始阅读，再用 Tab 进入控件。
    if (bodyRef.value) bodyRef.value.scrollTop = 0
    modalRef.value?.focus({ preventScroll: true })
  } else if (!visible && wasVisible) {
    restoreFocus?.focus()
    restoreFocus = null
  }
})

onBeforeUnmount(() => {
  restoreFocus?.focus()
})
</script>

<style scoped>
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  overflow: hidden;
  z-index: 200;
  backdrop-filter: saturate(180%) blur(10px);
  -webkit-backdrop-filter: saturate(180%) blur(10px);
}

.modal {
  box-sizing: border-box;
  width: 100%;
  max-height: calc(100dvh - 48px);
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--tg-bg, #fff);
  border-radius: var(--r-lg, 12px);
  padding: 22px;
  border: 0.5px solid var(--border, #e5e7eb);
  box-shadow: var(--shadow-lg, 0 20px 50px rgba(0, 0, 0, 0.18));
  overflow: hidden;
}

.modal-title {
  flex: 0 0 auto;
  margin: 0 0 16px;
  font-size: 18px;
}

.modal-body {
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}

.modal-actions {
  flex: 0 0 auto;
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 14px;
}

@media (max-width: 640px) {
  .modal-mask {
    padding: 12px;
  }

  .modal {
    max-height: calc(100dvh - 24px);
    padding: 16px;
  }
}
</style>
