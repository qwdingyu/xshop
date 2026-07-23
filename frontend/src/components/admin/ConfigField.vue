<template>
  <div class="config-card" :class="{ 'config-card-primary': primary }">
    <label class="config-label">
      <span>{{ item.label }}</span>
      <input
        v-if="item.type === 'boolean'"
        type="checkbox"
        :checked="value === 'true'"
        :disabled="status === 'saving'"
        @change="emitChange(($event.target as HTMLInputElement).checked ? 'true' : 'false')"
      />
      <input
        v-else-if="item.type === 'integer'"
        type="number"
        :value="value"
        :disabled="status === 'saving'"
        @change="emitChange(($event.target as HTMLInputElement).value)"
      />
      <input
        v-else-if="item.sensitive"
        type="password"
        value=""
        :placeholder="item.configured ? '已配置，输入新值可替换' : '未配置'"
        autocomplete="new-password"
        :disabled="status === 'saving'"
        @change="emitChange(($event.target as HTMLInputElement).value)"
      />
      <textarea
        v-else
        :value="value"
        :disabled="status === 'saving'"
        @change="emitChange(($event.target as HTMLTextAreaElement).value)"
      />
    </label>
    <p v-if="item.description" class="config-help">{{ item.description }}</p>
    <p v-if="item.effect" class="config-effect">{{ item.effect }}</p>
    <p v-if="item.type === 'integer'" class="config-range">
      范围：{{ item.min ?? '不限' }} - {{ item.max ?? '不限' }}
    </p>
    <div class="config-actions">
      <span v-if="statusText" class="config-status" :class="`config-status-${status}`">{{ statusText }}</span>
      <button class="btn btn-ghost btn-xs" type="button" :disabled="status === 'saving'" @click="$emit('reset', item.key)">重置默认</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { AdminSystemConfigDefinition } from '@/types/admin'

type ConfigFieldStatus = 'idle' | 'saving' | 'saved' | 'error'

const props = defineProps<{
  item: AdminSystemConfigDefinition
  value: string
  primary?: boolean
  status?: ConfigFieldStatus
}>()

const emit = defineEmits<{
  change: [key: string, value: string]
  reset: [key: string]
}>()

function emitChange(value: string) {
  emit('change', props.item.key, value)
}

const statusText = computed(() => {
  if (props.status === 'saving') return '保存中…'
  if (props.status === 'saved') return '已保存'
  if (props.status === 'error') return '保存失败'
  return ''
})
</script>

<style scoped>
.config-card {
  background: var(--tg-bg, #fff);
  border-radius: var(--r-lg, 12px);
  padding: 12px;
  border: 0.5px solid var(--border, #e5e7eb);
  display: flex;
  flex-direction: column;
  gap: 8px;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.config-card-primary {
  border-color: rgba(59, 130, 246, 0.14);
  background: linear-gradient(180deg, rgba(59, 130, 246, 0.05), rgba(59, 130, 246, 0.02));
}

.config-card:hover {
  border-color: var(--tg-btn, #409eff);
  box-shadow: var(--shadow-sm, 0 4px 12px rgba(0, 0, 0, 0.08));
}

.config-label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--tg-text, #333);
}

.config-label span:first-child {
  font-weight: 500;
  font-size: 12px;
}

.config-help,
.config-effect,
.config-range {
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--tg-hint, #777);
}

.config-effect {
  color: var(--tg-text, #444);
}

.config-label input[type='number'],
.config-label input[type='password'],
.config-label textarea {
  padding: 8px 10px;
  border: 0.5px solid var(--border, #e5e7eb);
  border-radius: var(--r-md, 8px);
  background: var(--tg-bg, #fff);
  color: var(--tg-text, #333);
  font-size: 13px;
}

.config-label textarea {
  min-height: 72px;
  resize: vertical;
}

.config-label input[type='checkbox'] {
  width: 16px;
  height: 16px;
}

.config-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: auto;
}

.config-status {
  font-size: 12px;
}

.config-status-saving {
  color: var(--tg-hint, #6b7280);
}

.config-status-saved {
  color: #16a34a;
}

.config-status-error {
  color: #dc2626;
}
</style>
