<template>
  <AdminModal v-model="innerVisible" title="确认操作" max-width="460px" hide-actions>
    <p class="confirm-message">{{ message }}</p>
    <div v-if="options.length > 0" class="confirm-options" role="group" aria-label="删除选项">
      <label
        v-for="opt in options"
        :key="opt.key"
        class="confirm-option"
      >
        <input
          type="checkbox"
          :checked="Boolean(optionValues[opt.key])"
          :disabled="loading"
          @change="onOptionChange(opt.key, ($event.target as HTMLInputElement).checked)"
        />
        <span class="confirm-option-body">
          <span class="confirm-option-label">{{ opt.label }}</span>
          <span v-if="opt.hint" class="confirm-option-hint">{{ opt.hint }}</span>
        </span>
      </label>
    </div>
    <template #actions>
      <button type="button" class="btn btn-ghost" :disabled="loading" @click="handleClose">取消</button>
      <button
        class="btn"
        type="button"
        :class="danger ? 'btn-danger' : 'btn-primary'"
        :disabled="loading"
        @click="handleConfirm"
      >
        确定
      </button>
    </template>
  </AdminModal>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import AdminModal from './AdminModal.vue'
import type { ConfirmOptionDef } from '@/composables/useConfirmDialog'

const props = withDefaults(defineProps<{
  modelValue: boolean
  message: string
  loading?: boolean
  danger?: boolean
  /** 可选勾选项定义；无则退化为纯确认框 */
  options?: ConfirmOptionDef[]
  /** key → 是否勾选（由 useConfirmDialog 托管） */
  optionValues?: Record<string, boolean>
}>(), {
  loading: false,
  danger: false,
  options: () => [],
  optionValues: () => ({}),
})

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  confirm: []
  'update:option': [key: string, checked: boolean]
}>()

const innerVisible = ref(false)
watch(() => props.modelValue, (val) => {
  innerVisible.value = val
}, { immediate: true })
watch(innerVisible, (val, wasVisible) => {
  if (!val && wasVisible && props.modelValue) emit('update:modelValue', false)
})

function close() {
  emit('update:modelValue', false)
}

function handleClose() {
  close()
}

function handleConfirm() {
  if (!innerVisible.value || props.loading) return
  emit('confirm')
  close()
}

function onOptionChange(key: string, checked: boolean) {
  emit('update:option', key, checked)
}
</script>

<style scoped>
.confirm-message {
  font-size: 14px;
  line-height: 1.65;
  /* 支持 askConfirm(`...\n\n...`) 多段说明；否则 HTML 会把换行压成空格 */
  white-space: pre-line;
  color: var(--tg-text, #f0f2f5);
}

/* 选项区：与弹窗同属暗色表面体系，用 elevated surface 分层，禁止浅色底板 */
.confirm-options {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 6px;
  padding: 6px;
  border-radius: var(--r-md, 8px);
  background: var(--surface-2, rgba(255, 255, 255, 0.07));
  border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
}

.confirm-option {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  cursor: pointer;
  font-size: 13px;
  line-height: 1.45;
  color: var(--tg-text);
  padding: 10px;
  border-radius: var(--r-sm, 6px);
  transition: background-color var(--duration-fast, 150ms) var(--ease-out, ease);
}

.confirm-option:hover {
  background: var(--surface-hover, rgba(255, 255, 255, 0.1));
}

.confirm-option input {
  margin-top: 2px;
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  padding: 0;
  border: none;
  background: transparent;
  accent-color: var(--admin-accent, #f59e0b);
}

.confirm-option-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.confirm-option-label {
  font-weight: 600;
  font-size: 13px;
  color: var(--tg-text);
  letter-spacing: 0.01em;
}

.confirm-option-hint {
  font-size: 12px;
  color: var(--tg-hint);
  line-height: 1.5;
  opacity: 0.95;
}
</style>
