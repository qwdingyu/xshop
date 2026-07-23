<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <input v-model="filter.action" type="search" placeholder="操作类型" aria-label="搜索操作类型" @keyup.enter="searchData" />
        <input v-model="filter.targetType" type="search" placeholder="目标类型" aria-label="搜索目标类型" @keyup.enter="searchData" />
        <input v-model="filter.targetId" type="search" placeholder="目标 ID" aria-label="搜索目标 ID" @keyup.enter="searchData" />
        <button class="btn btn-primary btn-sm" @click="searchData">查询</button>
      </div>
      <div class="toolbar-actions">
        <button
          class="btn btn-danger btn-sm"
          type="button"
          :disabled="loading || logsMutating"
          @click="clearAllLogs"
        >
          {{ clearingAll ? '清除中…' : '清除全部日志' }}
        </button>
      </div>
    </div>

    <div class="preset-strip">
      <button
        v-for="preset in presets"
        :key="preset.label"
        class="preset-btn"
        :class="{ 'is-active': isPresetActive(preset) }"
        type="button"
        :aria-pressed="isPresetActive(preset)"
        :disabled="logsMutating"
        @click="applyPreset(preset)"
      >
        <span class="preset-title">{{ preset.label }}</span>
        <span class="preset-desc">{{ preset.description }}</span>
      </button>
      <button
        class="preset-btn preset-btn--ghost"
        :class="{ 'is-active': isPresetActive() }"
        type="button"
        :aria-pressed="isPresetActive()"
        :disabled="logsMutating"
        @click="clearFilters"
      >
        <span class="preset-title">全部日志</span>
        <span class="preset-desc">清空筛选条件</span>
      </button>
    </div>

    <div v-if="error" class="table-error" role="alert">
      <span>{{ error }}</span>
      <button class="btn btn-ghost btn-xs" :disabled="loading" @click="loadData">重新加载</button>
    </div>

    <div v-if="selectedCount > 0" class="bulk-bar" role="status" aria-live="polite" :aria-busy="loading || logsMutating">
      <span>当前页已选 {{ selectedCount }} 条日志</span>
      <div class="bulk-actions">
        <button class="btn btn-ghost btn-sm" :disabled="loading || logsMutating" @click="clearSelection">清空选择</button>
        <button class="btn btn-ghost btn-sm" :disabled="loading || logsMutating" @click="copySelectedLogs">复制已选</button>
        <button class="btn btn-primary btn-sm" :disabled="loading || logsMutating" @click="exportSelectedLogs">导出已选 CSV</button>
        <button class="btn btn-danger btn-sm" :disabled="loading || logsMutating || selectedDeletableLogs.length === 0" @click="batchRemoveLogs">
          {{ batchDeleting ? '删除中…' : `批量删除（${selectedDeletableLogs.length}）` }}
        </button>
      </div>
    </div>

    <div class="table-wrap" role="region" aria-label="日志表格滚动区域" tabindex="0" :aria-busy="loading">
      <table class="admin-table" aria-label="管理日志列表">
        <thead>
          <tr>
            <th class="select-cell">
              <input
                type="checkbox"
                :checked="allVisibleSelected"
                :indeterminate.prop="partiallySelected"
                :disabled="selectableCount === 0 || loading || logsMutating"
                aria-label="选择当前页日志"
                @change="toggleAllVisible(($event.target as HTMLInputElement).checked)"
              />
            </th>
            <th>时间</th>
            <th>操作</th>
            <th>目标类型</th>
            <th>目标 ID</th>
            <th>IP 标识</th>
            <th>元数据</th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="i in 5" :key="'sk' + i" class="skeleton-row">
            <td :colspan="7"><div class="skeleton-cell" /></td>
          </tr>
        </tbody>
        <tbody v-else>
          <tr v-for="item in items" :key="logKey(item)" :class="{ 'is-selected': isSelected(logKey(item)) }">
            <td class="select-cell">
              <input
                type="checkbox"
                :checked="isSelected(logKey(item))"
                :disabled="loading || logsMutating"
                :aria-label="`选择日志 ${item.action || item.id || ''}`"
                @click="setSelected(logKey(item), ($event.target as HTMLInputElement).checked, $event.shiftKey)"
              />
            </td>
            <td>{{ formatDate(item.createdAt) }}</td>
            <td>{{ item.action }}</td>
            <td>{{ item.targetType }}</td>
            <td>{{ item.targetId }}</td>
            <td>
              <span class="hash-fingerprint" :title="item.ipHash || ''">{{ formatIpFingerprint(item.ipHash) }}</span>
            </td>
            <td>
              <button class="btn btn-ghost btn-xs" :disabled="loading || logsMutating" @click="viewMetadata(item)">查看</button>
            </td>
          </tr>
          <tr v-if="items.length === 0">
            <td colspan="7" class="empty-text">暂无日志</td>
          </tr>
        </tbody>
      </table>
    </div>

    <AdminPagination
      :page="page"
      :total="total"
      :total-pages="totalPages"
      :limit="limit"
      cursor-mode
      :has-more="hasMore"
      :disabled="loading || logsMutating"
      @prev="previousPage"
      @next="nextPage"
      @update:limit="changeLimit"
    />

    <AdminModal v-model="metadataVisible" title="日志详情" max-width="640px">
      <div v-if="currentLog" class="detail-box">
        <div class="detail-section">
          <div class="detail-title">基本信息</div>
          <div class="detail-row"><span class="detail-label">操作</span><span class="detail-value">{{ currentLog.action }}</span></div>
          <div class="detail-row"><span class="detail-label">目标类型</span><span class="detail-value">{{ currentLog.targetType }}</span></div>
          <div class="detail-row"><span class="detail-label">目标 ID</span><span class="detail-value">{{ currentLog.targetId }}</span></div>
          <div class="detail-row"><span class="detail-label">时间</span><span class="detail-value">{{ formatDate(currentLog.createdAt) }}</span></div>
          <div class="detail-row"><span class="detail-label">IP 标识（哈希）</span><span class="detail-value">{{ currentLog.ipHash || '-' }}</span></div>
        </div>
        <div class="detail-section" v-if="currentLog.metadata && Object.keys(currentLog.metadata).length > 0">
          <div class="detail-title">元数据</div>
          <pre class="detail-json">{{ formatMetadata(currentLog.metadata) }}</pre>
        </div>
      </div>
    </AdminModal>

    <ConfirmDialog v-model="confirmVisible" :message="confirmMessage" danger @confirm="onConfirm" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, reactive, onMounted } from 'vue'
import { batchDeleteAdminLogs, clearAllAdminLogs, fetchAdminLogs } from '@/api/admin'
import type { AdminAuditLog, AdminAuditLogFilter } from '@/types/admin'
import { useAdminAuth } from '@/composables/useAdminAuth'
import { useToast } from '@/composables/useToast'
import { useTableSelection } from '@/composables/useTableSelection'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import { downloadCsv } from '@/lib/csv-export'
import { writeClipboardText } from '@/composables/useClipboard'
import { formatDate, formatIpFingerprint } from '@/composables/useFormat'
import AdminPagination from '@/components/AdminPagination.vue'
import AdminModal from '@/components/AdminModal.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'

const { token } = useAdminAuth()
const { showToast } = useToast()
const items = ref<AdminAuditLog[]>([])
const loading = ref(false)
const batchDeleting = ref(false)
const clearingAll = ref(false)
const logsMutating = computed(() => batchDeleting.value || clearingAll.value)
const snapshotAt = ref('')
const page = ref(1)
const limit = ref(20)
const total = ref(0)
const hasMore = ref(false)
const nextCursor = ref('')
const pageCursors = ref<string[]>([''])
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / limit.value)))
const {
  selectedIds,
  selectedCount,
  selectableCount,
  allVisibleSelected,
  partiallySelected,
  isSelected,
  setSelected,
  toggleAllVisible,
  clearSelection,
} = useTableSelection(items, logKey)
const selectedDeletableLogs = computed(() => selectedLogs()
  .filter((item): item is AdminAuditLog & { type: 'request' | 'admin'; id: string } =>
    (item.type === 'request' || item.type === 'admin') && Boolean(item.id),
  ))
const filter = reactive<AdminAuditLogFilter>({
  action: '',
  targetType: '',
  targetId: '',
})

const presets = [
  { label: '订单处理', description: '付款确认、取消、补偿备注', action: '', targetType: 'order', targetId: '' },
  { label: '库存维护', description: '导入、启停、批量禁用卡密', action: '', targetType: 'card', targetId: '' },
  { label: '商品调整', description: '创建、更新、删除商品', action: '', targetType: 'product', targetId: '' },
  { label: '系统清理', description: '过期订单和锁定库存清理', action: 'run_cleanup', targetType: 'system', targetId: 'cleanup' },
]

const metadataVisible = ref(false)
const currentLog = ref<AdminAuditLog | null>(null)
const error = ref('')
const { confirmVisible, confirmMessage, askConfirm, onConfirm } = useConfirmDialog()
let loadSequence = 0

function logKey(item: AdminAuditLog) {
  return item.id ? `${item.type || 'log'}:${item.id}` : `${item.createdAt || ''}:${item.action || ''}:${item.targetType || ''}:${item.targetId || ''}`
}

async function loadData() {
  const sequence = ++loadSequence
  loading.value = true
    error.value = ''
  try {
    const res = await fetchAdminLogs(token.value, {
      ...filter,
      limit: limit.value,
      snapshotAt: snapshotAt.value || undefined,
      cursor: pageCursors.value[page.value - 1] || undefined,
    })
    if (sequence !== loadSequence) return
    items.value = res.logs
    snapshotAt.value = res.snapshotAt
    total.value = res.total
    hasMore.value = res.hasMore
    nextCursor.value = res.nextCursor
    clearSelection()
  } catch (err: any) {
    if (sequence !== loadSequence) return
    items.value = []
    clearSelection()
    error.value = err.message || '加载日志失败'
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}

function resetPagination() {
  page.value = 1
  snapshotAt.value = ''
  hasMore.value = false
  nextCursor.value = ''
  pageCursors.value = ['']
}

function previousPage() {
  if (loading.value || page.value <= 1) return
  page.value -= 1
  loadData()
}

function nextPage() {
  if (loading.value || !hasMore.value || !nextCursor.value) return
  pageCursors.value[page.value] = nextCursor.value
  page.value += 1
  loadData()
}

function changeLimit(value: number) {
  limit.value = value
  resetPagination()
  loadData()
}

function searchData() {
  resetPagination()
  loadData()
}

function applyPreset(preset: AdminAuditLogFilter & { label: string; description: string }) {
  filter.action = preset.action || ''
  filter.targetType = preset.targetType || ''
  filter.targetId = preset.targetId || ''
  resetPagination()
  loadData()
}

function isPresetActive(preset?: AdminAuditLogFilter) {
  return filter.action === (preset?.action || '')
    && filter.targetType === (preset?.targetType || '')
    && filter.targetId === (preset?.targetId || '')
}

function clearFilters() {
  filter.action = ''
  filter.targetType = ''
  filter.targetId = ''
  resetPagination()
  loadData()
}

function viewMetadata(item: AdminAuditLog) {
  currentLog.value = item
  metadataVisible.value = true
}

function formatMetadata(metadata: Record<string, unknown>) {
  try {
    return JSON.stringify(metadata, null, 2)
  } catch {
    return String(metadata)
  }
}

function selectedLogs() {
  const selected = new Set(selectedIds.value)
  return items.value.filter((item) => selected.has(logKey(item)))
}

function logRows(logs: AdminAuditLog[]) {
  return logs.map((item) => [
    item.createdAt || '',
    item.action || '',
    item.targetType || '',
    item.targetId || '',
    item.ipHash || '',
    item.metadata ? formatMetadata(item.metadata) : '',
  ])
}

async function copySelectedLogs() {
  const logs = selectedLogs()
  if (logs.length === 0) return
  const lines = logRows(logs).map((row) => row.join('\t')).join('\n')
  try {
    await writeClipboardText(lines)
    showToast(`已复制 ${logs.length} 条日志`, 'success')
  } catch {
    showToast('复制失败，请手动查看或导出 CSV', 'error')
  }
}

function exportSelectedLogs() {
  const logs = selectedLogs()
  if (logs.length === 0) return
  downloadCsv(`selected-admin-logs-${new Date().toISOString().slice(0, 10)}.csv`, [
    ['createdAt', 'action', 'targetType', 'targetId', 'ipHash', 'metadata'],
    ...logRows(logs),
  ])
  showToast(`已导出 ${logs.length} 条日志`, 'success')
}

async function batchRemoveLogs() {
  const logs = selectedDeletableLogs.value.map((item) => ({ type: item.type, id: item.id }))
  if (logs.length === 0 || loading.value || batchDeleting.value) return
  if (!(await askConfirm(`确认删除选中的 ${logs.length} 条日志？删除后会新增一条审计记录说明本次批量删除。`))) return
  batchDeleting.value = true
  try {
    const res = await batchDeleteAdminLogs(token.value, logs)
    showToast(`已删除 ${res.deleted} 条日志`, 'success')
    clearSelection()
    resetPagination()
    loadData()
  } catch (err: any) {
    showToast(err.message || '批量删除日志失败', 'error')
  } finally {
    batchDeleting.value = false
  }
}

async function clearAllLogs() {
  if (loading.value || logsMutating.value) return
  const confirmed = await askConfirm(
    '确认清除全部操作日志？请求日志和管理员审计日志都会删除，系统仅保留一条本次清理凭证。此操作不可撤销。',
  )
  if (!confirmed) return

  clearingAll.value = true
  try {
    const res = await clearAllAdminLogs(token.value)
    showToast(`已清除 ${res.deleted} 条日志，并保留清理审计记录`, 'success')
    filter.action = ''
    filter.targetType = ''
    filter.targetId = ''
    resetPagination()
    await loadData()
  } catch (err: any) {
    showToast(err.message || '清除全部日志失败', 'error')
  } finally {
    clearingAll.value = false
  }
}

onMounted(loadData)
</script>

<style>@import '@/assets/admin.css';</style>
<style scoped>
.preset-strip {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 10px;
  margin-bottom: 12px;
}

.hash-fingerprint {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  white-space: nowrap;
}

.preset-btn {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border: 0.5px solid var(--border, #e5e7eb);
  border-radius: var(--r-lg, 12px);
  background: var(--tg-bg, #fff);
  color: var(--tg-text, #111827);
  text-align: left;
  cursor: pointer;
}

.preset-btn:hover {
  border-color: var(--tg-btn, #409eff);
}

.preset-btn.is-active {
  border-color: rgba(59, 130, 246, 0.5);
  background: rgba(59, 130, 246, 0.1);
}

.preset-btn:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.preset-btn--ghost {
  background: rgba(107, 114, 128, 0.06);
}

.preset-title {
  font-size: 13px;
  font-weight: 600;
}

.preset-desc {
  font-size: 12px;
  color: var(--tg-hint, #6b7280);
  line-height: 1.4;
}

.detail-json {
  background: var(--tg-secondary-bg, #f5f7fa);
  padding: 12px;
  border-radius: var(--r-md, 8px);
  font-size: 13px;
  overflow: auto;
  max-height: 50vh;
}

@media (max-width: 640px) {
  .preset-strip {
    display: flex;
    overflow-x: auto;
    overscroll-behavior-x: contain;
    scrollbar-width: thin;
    margin-bottom: 0;
    padding-bottom: 2px;
  }

  .preset-btn {
    flex: 0 0 164px;
  }
}
</style>
