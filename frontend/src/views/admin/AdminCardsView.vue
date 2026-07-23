<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <AdminProductSelect v-model="filter.productId" aria-label="卡密商品" @change="searchData" />
        <select v-model="filter.status" aria-label="卡密状态" @change="searchData">
          <option value="">全部状态</option>
          <option value="available">可用</option>
          <option value="locked">锁定中</option>
          <option value="issued">已发卡</option>
          <option value="disabled">禁用</option>
        </select>
        <input v-model="filter.batchId" type="search" placeholder="批次 ID" aria-label="搜索批次 ID" @keyup.enter="searchData" />
        <input v-model="filter.buyerEmail" type="search" placeholder="买家邮箱" aria-label="搜索买家邮箱" @keyup.enter="searchData" />
        <input v-model="filter.buyerContact" type="search" placeholder="买家联系码" aria-label="搜索买家联系码" @keyup.enter="searchData" />
        <button class="btn btn-primary btn-sm" :disabled="loading" @click="searchData">
          {{ loading ? '查询中…' : '查询' }}
        </button>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-primary btn-sm" :disabled="generating || importing" @click="openGenerateDialog">生成同码卡密</button>
        <button class="btn btn-primary btn-sm" :disabled="generating || importing" @click="openImportDialog">批量导入</button>
        <button class="btn btn-ghost btn-sm" :disabled="downloadingTemplate" @click="downloadTemplate">
          {{ downloadingTemplate ? '下载中…' : '下载模板' }}
        </button>
      </div>
    </div>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" :disabled="loading" @click="loadData">重新加载</button>
    </div>

    <div class="notice-card" role="note">
      <strong>同码卡密仍按库存消耗。</strong>
      <span>无限次发送同一内容，请使用商品的“虚拟资料 / 链接 / 兑换码”交付模式。</span>
    </div>

    <div class="table-command-bar">
      <div class="quick-strip" role="group" aria-label="快捷筛选">
        <button
          type="button"
          class="quick-chip"
          :class="{ 'is-active': filter.status === 'available' && !showSameCodeOnly }"
          @click="filter.status = 'available'; searchData()"
        >
          只看可用
        </button>
        <button
          type="button"
          class="quick-chip"
          :class="{ 'is-active': filter.status === 'disabled' && !showSameCodeOnly }"
          @click="filter.status = 'disabled'; searchData()"
        >
          只看禁用
        </button>
        <button
          type="button"
          class="quick-chip"
          :class="{ 'is-active': showSameCodeOnly }"
          @click="toggleSameCodeOnly"
        >
          {{ showSameCodeOnly ? '查看全部库存' : '只看同码库存' }}
        </button>
      </div>
      <div v-if="selectedCount > 0" class="table-command-actions" role="status" aria-live="polite" :aria-busy="loading || batchOperating">
        <span class="selection-summary">
          {{ batchOperating
            ? '正在处理…'
            : `已选 ${selectedCount} 张（默认可删 ${selectedSafeDeletableIds.length}；勾选「全部删除」可扩范围）` }}
        </span>
        <button class="btn btn-ghost btn-sm" :disabled="loading || batchOperating" @click="clearSelection">清空</button>
        <button class="btn btn-ghost btn-sm" :disabled="loading || batchOperating" @click="copySelectedCards">复制所选</button>
        <button class="btn btn-ghost btn-sm" :disabled="loading || batchOperating" @click="exportSelectedCards">导出所选</button>
        <button class="btn btn-primary btn-sm" :disabled="loading || batchOperating || selectedDisabledIds.length === 0" @click="batchSetStatus('available')">
          批量启用（{{ selectedDisabledIds.length }}）
        </button>
        <button class="btn btn-danger btn-sm" :disabled="loading || batchOperating || selectedAvailableIds.length === 0" @click="batchSetStatus('disabled')">
          批量禁用（{{ selectedAvailableIds.length }}）
        </button>
        <button class="btn btn-danger btn-sm" :disabled="loading || batchOperating || selectedCount === 0" @click="batchRemove">
          批量删除（{{ selectedCount }}）
        </button>
      </div>
    </div>

    <div class="table-wrap" role="region" aria-label="卡密表格滚动区域" tabindex="0" :aria-busy="loading">
      <table class="admin-table" aria-label="卡密库存列表">
        <thead>
          <tr>
            <th class="select-cell">
              <input
                type="checkbox"
                :checked="allVisibleSelected"
                :indeterminate.prop="partiallySelected"
                :disabled="selectableCount === 0 || loading || batchOperating"
                aria-label="选择当前页卡密"
                @change="toggleAllVisible(($event.target as HTMLInputElement).checked)"
              />
            </th>
            <th>ID</th>
            <th>商品</th>
            <th>账号/标签</th>
            <th>卡密内容</th>
            <th>买家邮箱</th>
            <th>买家联系码</th>
            <th>有效期</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="i in 5" :key="'sk' + i" class="skeleton-row">
            <td :colspan="10"><div class="skeleton-cell" /></td>
          </tr>
        </tbody>
        <tbody v-else>
          <tr v-for="item in visibleItems" :key="item.id" :class="{ 'is-selected': isSelected(item.id) }">
            <td class="select-cell">
              <input
                type="checkbox"
                :checked="isSelected(item.id)"
                :disabled="loading || batchOperating"
                :aria-label="`选择卡密 ${item.id}`"
                @click="setSelected(item.id, ($event.target as HTMLInputElement).checked, $event.shiftKey)"
              />
            </td>
            <td>{{ item.id.slice(0, 8) }}</td>
            <td>
              <div class="relation-cell">
                <span>{{ item.productTitle || item.productId || '-' }}</span>
                <small v-if="item.productTitle && item.productId">{{ item.productId }}</small>
              </div>
            </td>
            <td>{{ item.accountLabel || '-' }}</td>
            <td>
              <div class="secret-cell">
                <span>{{ item.deliverySecret || item.deliveryNote || '-' }}</span>
                <span v-if="!item.deliverySecret && item.deliveryNote" class="same-code-tag">同码库存</span>
              </div>
            </td>
            <td>{{ item.buyerEmail || '-' }}</td>
            <td>{{ item.buyerContact || '-' }}</td>
            <td>
              <span v-if="item.expiresAt" :class="expiresAtClass(item.expiresAt)">
                {{ expiresAtText(item.expiresAt) }}
              </span>
              <span v-else>-</span>
            </td>
            <td>
              <span class="tag" :class="statusClass(item.status)">
                {{ statusLabel(item.status) }}
              </span>
            </td>
            <td>
              <div class="table-actions">
                <button class="btn btn-ghost btn-xs" :disabled="batchOperating" @click="copyCard(item)">复制</button>
                <button
                  v-if="canToggleStatus(item.status)"
                  class="btn btn-ghost btn-xs"
                  :disabled="batchOperating || updatingId === item.id"
                  @click="updateStatus(item.id, item.status === 'available' ? 'disabled' : 'available')"
                >
                  {{ updatingId === item.id ? '更新中…' : (item.status === 'available' ? '禁用' : '启用') }}
                </button>
                <span v-else class="muted-text">订单状态机管理</span>
              </div>
            </td>
          </tr>
          <tr v-if="visibleItems.length === 0">
            <td colspan="10" class="empty-text">暂无卡密</td>
          </tr>
        </tbody>
      </table>
    </div>

    <AdminPagination
      :page="pagination.page.value"
      :total="pagination.total.value"
      :total-pages="pagination.totalPages.value"
      :limit="pagination.limit.value"
      :disabled="loading || batchOperating"
      @prev="pagination.prevPage(); loadData()"
      @next="pagination.nextPage(); loadData()"
      @jump="pagination.setPage($event); loadData()"
      @update:limit="pagination.setLimit($event); loadData()"
    />

    <AdminModal v-model="importVisible" title="批量导入卡密" max-width="520px" hide-actions>
      <form class="modal-form" @submit.prevent="doImport">
        <label>
          <span>商品</span>
          <AdminProductSelect v-model="importForm.productId" placeholder="请选择商品" required />
        </label>
        <label>
          <span>批次名称</span>
          <input v-model="importForm.batchName" required />
        </label>
        <label>
          <span>卡密列表（每行一条：账号,密码）</span>
          <textarea v-model="importForm.raw" rows="8" placeholder="账号1,密码1&#10;账号2,密码2" required></textarea>
        </label>
        <p class="hint">导入结果：成功 {{ importResult.imported }}，跳过 {{ importResult.skipped }}，失败 {{ importResult.errors.length }}</p>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" :disabled="importing" @click="importVisible = false">关闭</button>
          <button type="submit" class="btn btn-primary" :disabled="importing">
            {{ importing ? '导入中…' : '导入' }}
          </button>
        </div>
      </form>
    </AdminModal>

    <AdminModal v-model="generateVisible" title="生成同码卡密" max-width="520px" hide-actions>
      <form class="modal-form" @submit.prevent="doGenerate">
        <label>
          <span>商品</span>
          <AdminProductSelect v-model="generateForm.productId" placeholder="请选择商品" required />
        </label>
        <label>
          <span>统一交付内容</span>
          <input v-model="generateForm.genericCode" required />
        </label>
        <label>
          <span>生成数量</span>
          <input v-model.number="generateForm.count" type="number" min="1" max="1000" required />
        </label>
        <label>
          <span>批次名称</span>
          <input v-model="generateForm.batchName" required />
        </label>
        <label>
          <span>有效期（可选）</span>
          <input v-model="generateForm.expiresAt" type="datetime-local" />
        </label>
        <p class="hint">会生成多条独立库存记录，买家每次领取仍会消耗一条。真正无限次发放请使用商品的“兑换码/虚拟资料”交付模式。</p>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" :disabled="generating" @click="generateVisible = false">关闭</button>
          <button type="submit" class="btn btn-primary" :disabled="generating">
            {{ generating ? '生成中…' : '生成' }}
          </button>
        </div>
      </form>
    </AdminModal>

    <ConfirmDialog
      v-model="confirmVisible"
      :message="confirmMessage"
      :options="confirmOptionDefs"
      :option-values="confirmOptionValues"
      danger
      @confirm="onConfirm"
      @update:option="setConfirmOption"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, computed } from 'vue'
import { fetchAdminCards, updateAdminCard, importAdminCards, downloadCardImportTemplate, generateAdminGenericCards, batchDisableAdminCards, batchDeleteAdminCards } from '@/api/admin'
import type { AdminCard, AdminCardFilter, AdminImportCardsPayload, AdminImportCardItem, AdminGenerateGenericCardsPayload } from '@/types/admin'
import { useToast } from '@/composables/useToast'
import { useTablePagination } from '@/composables/useTablePagination'
import { useAdminAuth } from '@/composables/useAdminAuth'
import { useTableSelection } from '@/composables/useTableSelection'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import AdminPagination from '@/components/AdminPagination.vue'
import AdminModal from '@/components/AdminModal.vue'
import AdminProductSelect from '@/components/AdminProductSelect.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { formatDate } from '@/composables/useFormat'
import { writeClipboardText } from '@/composables/useClipboard'
import { downloadCsv } from '@/lib/csv-export'

const { showToast } = useToast()
const { token } = useAdminAuth()

const items = ref<AdminCard[]>([])
const loading = ref(false)
const loadError = ref('')
const batchOperating = ref(false)
const importing = ref(false)
const generating = ref(false)
const downloadingTemplate = ref(false)
const updatingId = ref('')
const showSameCodeOnly = ref(false)
const filter = reactive<AdminCardFilter>({
  productId: '',
  batchId: '',
  status: '',
  buyerEmail: '',
  buyerContact: '',
  genericOnly: false,
  page: 1,
})

const pagination = useTablePagination()

const importVisible = ref(false)
const importForm = reactive<{ productId: string; batchName: string; raw: string }>({
  productId: '',
  batchName: '',
  raw: '',
})
const importResult = reactive({ imported: 0, skipped: 0, errors: [] as string[] })

const generateVisible = ref(false)
const generateForm = reactive<{ productId: string; genericCode: string; count: number; batchName: string; expiresAt: string }>({
  productId: '',
  genericCode: '',
  count: 1,
  batchName: '',
  expiresAt: '',
})

const visibleItems = computed(() => items.value)

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
} = useTableSelection(visibleItems, (row) => row.id)
const selectedAvailableIds = computed(() => {
  const selected = new Set(selectedIds.value)
  return visibleItems.value.filter((item) => selected.has(item.id) && item.status === 'available').map((item) => item.id)
})
const selectedDisabledIds = computed(() => {
  const selected = new Set(selectedIds.value)
  return visibleItems.value.filter((item) => selected.has(item.id) && item.status === 'disabled').map((item) => item.id)
})
/** 未勾选「全部删除」时仅允许删除可用/禁用（与后端 SAFE_CARD_DELETE_STATUSES 同步） */
const selectedSafeDeletableIds = computed(() => {
  const selected = new Set(selectedIds.value)
  return visibleItems.value
    .filter((item) => selected.has(item.id) && canToggleStatus(item.status))
    .map((item) => item.id)
})
const selectedItems = computed(() => {
  const selected = new Set(selectedIds.value)
  return visibleItems.value.filter((item) => selected.has(item.id))
})
const CARD_DELETE_CONFIRM_OPTIONS = [
  {
    key: 'force',
    label: '全部删除（含锁定中/已发卡）',
    hint: '默认不勾选：仅删除可用与禁用卡密。勾选后删除当前选中的全部卡密。',
  },
  {
    key: 'unlinkRefs',
    label: '解绑订单引用',
    hint: '默认不勾选：仍被订单挂着（locked/issued 或 orders.issued_card_id）的卡密会拒绝删除。勾选后清空订单上的发卡引用再删。',
  },
] as const
const {
  confirmVisible,
  confirmMessage,
  confirmOptionDefs,
  confirmOptionValues,
  askConfirm,
  askConfirmWithOptions,
  onConfirm,
  setConfirmOption,
} = useConfirmDialog()
let loadSequence = 0

async function loadData() {
  const sequence = ++loadSequence
  loading.value = true
  loadError.value = ''
  try {
    const res = await fetchAdminCards(token.value, {
      ...filter,
      page: pagination.page.value,
      limit: pagination.limit.value,
    })
    if (sequence !== loadSequence) return
    if (pagination.setTotal(res.total)) return loadData()
    items.value = res.results
    clearSelection()
  } catch (err: any) {
    if (sequence !== loadSequence) return
    items.value = []
    clearSelection()
    loadError.value = err.message || '加载卡密失败'
    showToast(err.message || '加载卡密失败', 'error')
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}

function searchData() {
  pagination.page.value = 1
  loadData()
}

function toggleSameCodeOnly() {
  showSameCodeOnly.value = !showSameCodeOnly.value
  filter.genericOnly = showSameCodeOnly.value
  searchData()
}

function openImportDialog() {
  importForm.productId = ''
  importForm.batchName = ''
  importForm.raw = ''
  importResult.imported = 0
  importResult.skipped = 0
  importResult.errors = []
  importVisible.value = true
}

function openGenerateDialog() {
  generateForm.productId = ''
  generateForm.genericCode = ''
  generateForm.count = 1
  generateForm.batchName = ''
  generateForm.expiresAt = ''
  generateVisible.value = true
}

async function doImport() {
  if (importing.value) return
  const lines = importForm.raw.split('\n').filter((line) => line.trim())
  const cards: AdminImportCardItem[] = lines.map((line) => {
    const [accountLabel, deliverySecret, note] = line.split(',')
    return {
      accountLabel: (accountLabel || '').trim(),
      deliverySecret: (deliverySecret || '').trim(),
      deliveryNote: (note || '').trim() || undefined,
    }
  })

  if (cards.length === 0) {
    showToast('请输入至少一条卡密', 'error')
    return
  }

  importing.value = true
  try {
    const payload: AdminImportCardsPayload = {
      productId: importForm.productId,
      batchName: importForm.batchName,
      cards,
    }
    const res = await importAdminCards(token.value, payload)
    importResult.imported = res.imported
    importResult.skipped = 0
    importResult.errors = []
    showToast(`导入完成：成功 ${res.imported}`, 'success')
    loadData()
  } catch (err: any) {
    showToast(err.message || '导入失败', 'error')
  } finally {
    importing.value = false
  }
}

async function doGenerate() {
  if (generating.value) return
  const expiresAt = generateForm.expiresAt ? new Date(generateForm.expiresAt).toISOString() : undefined
  generating.value = true
  try {
    const payload: AdminGenerateGenericCardsPayload = {
      productId: generateForm.productId,
      genericCode: generateForm.genericCode,
      count: generateForm.count,
      batchName: generateForm.batchName,
      expiresAt,
    }
    const res = await generateAdminGenericCards(token.value, payload)
    showToast(`生成完成：${res.generated} 条同码卡密`, 'success')
    generateVisible.value = false
    loadData()
  } catch (err: any) {
    showToast(err.message || '生成同码卡密失败', 'error')
  } finally {
    generating.value = false
  }
}

async function downloadTemplate() {
  if (downloadingTemplate.value) return
  downloadingTemplate.value = true
  try {
    const blob = await downloadCardImportTemplate(token.value)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'cards-import-template.csv'
    a.click()
    URL.revokeObjectURL(url)
    showToast('模板下载成功', 'success')
  } catch (err: any) {
    showToast(err.message || '下载模板失败', 'error')
  } finally {
    downloadingTemplate.value = false
  }
}

async function updateStatus(id: string, status: 'available' | 'disabled') {
  if (updatingId.value) return
  updatingId.value = id
  try {
    await updateAdminCard(token.value, id, { status })
    showToast('已更新', 'success')
    loadData()
  } catch (err: any) {
    showToast(err.message || '更新失败', 'error')
  } finally {
    updatingId.value = ''
  }
}

async function batchSetStatus(status: 'available' | 'disabled') {
  const ids = status === 'available' ? selectedDisabledIds.value : selectedAvailableIds.value
  if (ids.length === 0 || loading.value || batchOperating.value) return
  if (!(await askConfirm(`确认${status === 'disabled' ? '禁用' : '启用'}选中的 ${ids.length} 张卡密？`))) return
  batchOperating.value = true
  try {
    const res = await batchDisableAdminCards(token.value, { ids, status })
    showToast(`已${status === 'disabled' ? '禁用' : '启用'} ${res.updated} 张卡密`, 'success')
    clearSelection()
    loadData()
  } catch (err: any) {
    showToast(err.message || '批量操作失败', 'error')
  } finally {
    batchOperating.value = false
  }
}

async function batchRemove() {
  const ids = selectedItems.value.map((item) => item.id)
  if (ids.length === 0 || loading.value || batchOperating.value) return
  const safeCount = selectedSafeDeletableIds.value.length
  const decision = await askConfirmWithOptions(
    `确认删除选中的 ${ids.length} 张卡密？\n\n默认（两个选项都不勾）：仅删除可用/禁用且无订单引用的卡密（当前选中约 ${safeCount} 张符合默认状态）。此操作不可恢复。`,
    { options: [...CARD_DELETE_CONFIRM_OPTIONS] },
  )
  if (!decision.confirmed) return
  const force = decision.options.force === true
  const unlinkRefs = decision.options.unlinkRefs === true
  batchOperating.value = true
  try {
    const res = await batchDeleteAdminCards(token.value, ids, { force, unlinkRefs })
    const flags = [
      force ? '全部删除' : '仅可用/禁用',
      unlinkRefs ? '已解绑订单' : '未解绑',
    ].join(' · ')
    showToast(`已删除 ${res.deleted} 张卡密（${flags}）`, 'success')
    clearSelection()
    loadData()
  } catch (err: any) {
    showToast(err.message || '批量删除失败', 'error')
  } finally {
    batchOperating.value = false
  }
}

function cardCopyLine(item: AdminCard) {
  return [item.accountLabel || '', item.deliverySecret || '', item.deliveryNote || ''].join('\t')
}

async function copyCard(item: AdminCard) {
  try {
    await writeClipboardText(item.deliverySecret || item.deliveryNote || item.accountLabel || '')
    showToast('卡密内容已复制', 'success')
  } catch {
    showToast('复制失败，请使用导出功能', 'error')
  }
}

async function copySelectedCards() {
  try {
    await writeClipboardText(selectedItems.value.map(cardCopyLine).join('\n'))
    showToast(`已复制 ${selectedItems.value.length} 张卡密`, 'success')
  } catch {
    showToast('复制失败，请使用导出功能', 'error')
  }
}

function exportSelectedCards() {
  downloadCsv(`selected-cards-${new Date().toISOString().slice(0, 10)}.csv`, [
    ['id', 'productTitle', 'productId', 'accountLabel', 'deliverySecret', 'deliveryNote', 'status', 'buyerEmail', 'expiresAt'],
    ...selectedItems.value.map((item) => [item.id, item.productTitle || '', item.productId || '', item.accountLabel || '', item.deliverySecret || '', item.deliveryNote || '', item.status || '', item.buyerEmail || '', item.expiresAt || '']),
  ])
  showToast(`已导出 ${selectedItems.value.length} 张卡密`, 'success')
}

function statusLabel(status?: string) {
  const labels: Record<string, string> = {
    available: '可用',
    locked: '锁定中',
    issued: '已发卡',
    disabled: '禁用',
  }
  return labels[status || ''] || status || '-'
}

function statusClass(status?: string) {
  if (status === 'available') return 'tag-success'
  if (status === 'locked') return 'tag-warning'
  if (status === 'issued') return 'tag-info'
  return 'tag-muted'
}

function canToggleStatus(status?: string) {
  return status === 'available' || status === 'disabled'
}

function expiresAtClass(expiresAt?: string) {
  if (!expiresAt) return ''
  const diff = Math.ceil((new Date(expiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
  if (diff < 0) return 'status-error'
  if (diff <= 3) return 'status-error'
  if (diff <= 7) return 'status-warning'
  return 'status-success'
}

function expiresAtText(expiresAt?: string) {
  if (!expiresAt) return '-'
  const diff = Math.ceil((new Date(expiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
  const dateText = formatDate(expiresAt)
  if (diff < 0) return `${dateText}（已过期 ${Math.abs(diff)} 天）`
  return `${dateText}（剩余 ${diff} 天）`
}

onMounted(loadData)
</script>

<style>@import '@/assets/admin.css';</style>
<style scoped>
/* notice-card / relation-cell / secret-cell / same-code-tag → admin.css
 * 垂直间距仅靠 .admin-page gap（--admin-stack-gap），禁止 margin-bottom 叠距。
 */
.notice-card strong {
  margin-right: 8px;
}

.hint {
  margin: 0;
  font-size: 12px;
  color: var(--tg-hint, #9aa4b2);
  line-height: 1.5;
}

@media (max-width: 640px) {
  .notice-card {
    display: none;
  }
}
</style>
