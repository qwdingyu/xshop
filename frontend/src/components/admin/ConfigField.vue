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
      <!-- 金额类 integer（unit=cents）：界面按「元」编辑，提交仍为分整数字符串 -->
      <input
        v-else-if="isCentsMoney"
        type="number"
        inputmode="decimal"
        step="0.01"
        min="0"
        :value="displayYuan"
        :disabled="status === 'saving'"
        @change="onYuanChange(($event.target as HTMLInputElement).value)"
      />
      <input
        v-else-if="item.type === 'integer'"
        type="number"
        step="1"
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
    <p v-if="isCentsMoney" class="config-range">
      范围：{{ rangeYuanMin }} - {{ rangeYuanMax }} 元
      <span class="config-range-hint">（按元填写，保存为分）</span>
    </p>
    <p v-else-if="item.type === 'integer'" class="config-range">
      范围：{{ item.min ?? '不限' }} - {{ item.max ?? '不限' }}
    </p>
    <p v-if="localError" class="config-local-error" role="alert">{{ localError }}</p>
    <div class="config-actions">
      <span v-if="statusText" class="config-status" :class="`config-status-${status}`">{{ statusText }}</span>
      <button class="btn btn-ghost btn-xs" type="button" :disabled="status === 'saving'" @click="$emit('reset', item.key)">重置默认</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AdminSystemConfigDefinition } from '@/types/admin'
import { formatCents, parseYuanToCents } from '@/utils/currency'

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

const localError = ref('')

/** 库内分为整数、UI 按人民币元展示的配置项 */
const isCentsMoney = computed(() => props.item.type === 'integer' && props.item.unit === 'cents')

const displayYuan = computed(() => {
  if (!isCentsMoney.value) return props.value
  const cents = Number(props.value)
  if (!Number.isSafeInteger(cents)) return props.value
  return formatCents(cents)
})

const rangeYuanMin = computed(() => {
  if (props.item.min === undefined) return '不限'
  return formatCents(props.item.min)
})

const rangeYuanMax = computed(() => {
  if (props.item.max === undefined) return '不限'
  return formatCents(props.item.max)
})

function emitChange(value: string) {
  localError.value = ''
  emit('change', props.item.key, value)
}

/**
 * 用户按元输入 → 转为分整数再交给保存链路。
 * 非法金额不 emit，避免把「50」当成 50 分写进库。
 */
function onYuanChange(raw: string) {
  localError.value = ''
  const trimmed = raw.trim()
  if (!trimmed) {
    localError.value = '请输入金额（元）'
    return
  }
  const cents = parseYuanToCents(trimmed)
  if (cents === null || cents < 0) {
    localError.value = '请输入有效金额（元，最多两位小数）'
    return
  }
  if (props.item.min !== undefined && cents < props.item.min) {
    localError.value = `不能小于 ${formatCents(props.item.min)} 元`
    return
  }
  if (props.item.max !== undefined && cents > props.item.max) {
    localError.value = `不能大于 ${formatCents(props.item.max)} 元`
    return
  }
  emitChange(String(cents))
}

watch(
  () => props.value,
  () => {
    localError.value = ''
  },
)

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

.config-range-hint {
  color: var(--admin-accent-text, #fbbf24);
}

.config-local-error {
  margin: 0;
  font-size: 12px;
  color: #fca5a5;
  line-height: 1.4;
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
