<template>
  <nav class="admin-pagination" aria-label="列表分页">
    <div class="pagination-left">
      <span class="pagination-info">共 {{ total }} 条</span>
    </div>
    <div class="pagination-right">
      <!-- 每页条数选择器 -->
      <label class="pagination-limit">
        每页
        <select
          :value="limit"
          class="limit-select"
          :disabled="disabled"
          @change="onLimitChange"
        >
          <option :value="10">10</option>
          <option :value="20">20</option>
          <option :value="50">50</option>
        </select>
        条
      </label>

      <!-- 上下翻页 -->
      <div class="pagination-controls">
        <button
          type="button"
          class="btn btn-ghost btn-xs"
          :disabled="disabled || page <= 1"
          aria-label="上一页"
          @click="$emit('prev')"
        >
          上一页
        </button>
        <span v-if="cursorMode" class="pagination-page" aria-live="polite">第 {{ page }} 页</span>
        <span v-else class="pagination-page" aria-live="polite">{{ page }} / {{ totalPages }}</span>
        <button
          type="button"
          class="btn btn-ghost btn-xs"
          :disabled="disabled || (cursorMode ? !hasMore : page >= totalPages)"
          aria-label="下一页"
          @click="$emit('next')"
        >
          下一页
        </button>
      </div>

      <!-- 页码跳转 -->
      <div v-if="!cursorMode" class="pagination-jump">
        跳至
        <input
          type="number"
          :min="1"
          :max="totalPages"
          :step="1"
          inputmode="numeric"
          class="jump-input"
          :disabled="disabled"
          aria-label="跳转页码"
          v-model.number="jumpValue"
          @keyup.enter="handleJump"
        />
        页
        <button type="button" class="btn btn-ghost btn-xs" @click="handleJump" :disabled="disabled || !jumpValue">跳转</button>
      </div>
    </div>
  </nav>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'

const props = defineProps<{
  page: number
  total: number
  totalPages: number
  limit?: number
  cursorMode?: boolean
  hasMore?: boolean
  disabled?: boolean
}>()

const emit = defineEmits<{
  prev: []
  next: []
  jump: [page: number]
  'update:limit': [limit: number]
}>()

/** 跳转输入框的当前值，翻页后自动清空 */
const jumpValue = ref<number | undefined>(undefined)

function onLimitChange(e: Event) {
  const val = Number((e.target as HTMLSelectElement).value)
  if ([10, 20, 50].includes(val)) emit('update:limit', val)
}

function handleJump() {
  const p = Number(jumpValue.value)
  if (!Number.isFinite(p) || p <= 0) {
    jumpValue.value = undefined
    return
  }
  const clamped = Math.max(1, Math.min(Math.trunc(p), props.totalPages))
  if (clamped !== props.page) {
    emit('jump', clamped)
  }
  jumpValue.value = undefined
}

// 翻页后清空跳转输入
watch(() => props.page, () => {
  jumpValue.value = undefined
})
</script>

<style scoped>
.admin-pagination {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  background: var(--tg-bg, #fff);
  border: 0.5px solid var(--border, #e5e7eb);
  border-radius: var(--r-lg, 12px);
  padding: 10px 12px;
}

.pagination-info {
  font-size: 13px;
  color: var(--tg-hint, #999);
}

.pagination-right {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}

/* 每页条数 */
.pagination-limit {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: var(--tg-hint, #999);
  white-space: nowrap;
}

.limit-select {
  padding: 4px 28px 4px 8px;
  border: 0.5px solid var(--border, #e5e7eb);
  border-radius: var(--r-sm, 8px);
  background: var(--tg-bg, #fff);
  color: var(--tg-text, #333);
  font-size: 13px;
  outline: none;
  cursor: pointer;
  appearance: none;
  -webkit-appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 6px center;
}

/* 翻页控制 */
.pagination-controls {
  display: flex;
  align-items: center;
  gap: 10px;
}

.pagination-page {
  font-size: 14px;
  white-space: nowrap;
}

/* 跳转输入 */
.pagination-jump {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: var(--tg-hint, #999);
  white-space: nowrap;
}

.jump-input {
  width: 48px;
  padding: 4px 6px;
  border: 0.5px solid var(--border, #e5e7eb);
  border-radius: var(--r-sm, 8px);
  background: var(--tg-bg, #fff);
  color: var(--tg-text, #333);
  font-size: 13px;
  text-align: center;
  outline: none;
  -moz-appearance: textfield;
}

.jump-input::-webkit-inner-spin-button,
.jump-input::-webkit-outer-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

@media (max-width: 640px) {
  .admin-pagination,
  .pagination-right {
    align-items: stretch;
  }

  .pagination-right {
    width: 100%;
    gap: 10px;
  }

  .pagination-controls {
    justify-content: space-between;
    flex: 1;
  }

  .pagination-jump {
    display: none;
  }
}
</style>
