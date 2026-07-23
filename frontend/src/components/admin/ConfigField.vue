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
  background: var(--tg-secondary-bg, #151b28);
  border-radius: var(--r-lg, 12px);
  padding: 12px;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
  display: flex;
  flex-direction: column;
  gap: 8px;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.config-card-primary {
  border-color: var(--admin-accent-border, rgba(245, 158, 11, 0.38));
  background: linear-gradient(
    180deg,
    var(--admin-accent-soft, rgba(245, 158, 11, 0.14)),
    rgba(245, 158, 11, 0.04)
  );
}

.config-card:hover {
  border-color: rgba(245, 158, 11, 0.55);
  box-shadow: var(--shadow-sm, 0 4px 12px rgba(0, 0, 0, 0.3));
}

.config-label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--tg-text, #f0f2f5);
}

.config-label span:first-child {
  font-weight: 500;
  font-size: 12px;
  color: var(--tg-hint, #9aa4b2);
}

.config-help,
.config-effect,
.config-range {
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--tg-hint, #9aa4b2);
}

.config-effect {
  color: var(--tg-text, #f0f2f5);
}

.config-label input[type='number'],
.config-label input[type='password'],
.config-label textarea {
  padding: 8px 10px;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
  border-radius: var(--r-md, 8px);
  background: var(--surface, rgba(255, 255, 255, 0.04));
  color: var(--tg-text, #f0f2f5);
  font-size: 13px;
}

.config-label textarea {
  min-height: 72px;
  resize: vertical;
}

.config-label input[type='checkbox'] {
  width: 14px;
  height: 14px;
  margin: 0;
  padding: 0;
  border: none;
  background: transparent;
  accent-color: var(--admin-accent, #f59e0b);
  cursor: pointer;
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
  color: var(--tg-hint, #9aa4b2);
}

.config-status-saved {
  color: #6ee7b7;
}

.config-status-error {
  color: #fca5a5;
}
</style>
