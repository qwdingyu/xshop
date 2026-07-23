<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <select v-model="filter.status" aria-label="充值码状态" @change="searchData">
          <option value="">全部状态</option>
          <option value="active">可兑换</option>
          <option value="used">已兑换</option>
          <option value="expired">已过期</option>
          <option value="revoked">已作废</option>
        </select>
        <input v-model="filter.batchId" type="search" placeholder="批次号" aria-label="搜索充值码批次" @keyup.enter="searchData" />
        <input v-model="filter.search" type="search" placeholder="搜索充值码" aria-label="搜索充值码" @keyup.enter="searchData" />
        <button class="btn btn-primary btn-sm" :disabled="loading" @click="searchData">
          {{ loading ? '查询中…' : '查询' }}
        </button>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-primary btn-sm" :disabled="generating" @click="openGenerate">批量生成</button>
      </div>
    </div>

    <section class="stat-strip" aria-label="充值码统计">
      <div class="stat-item"><span>可兑换</span><strong>{{ stats.active }}</strong><small>{{ formatMoney(stats.totalAmount, 'CNY') }}</small></div>
      <div class="stat-item"><span>已兑换</span><strong>{{ stats.used }}</strong><small>{{ formatMoney(stats.usedAmount, 'CNY') }}</small></div>
      <div class="stat-item"><span>已过期</span><strong>{{ stats.expired }}</strong></div>
      <div class="stat-item"><span>已作废</span><strong>{{ stats.revoked }}</strong></div>
    </section>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" :disabled="loading" @click="loadData">重新加载</button>
    </div>

    <div v-if="selectedCount > 0" class="bulk-bar" role="status" aria-live="polite" :aria-busy="loading || revoking">
      <span>当前页已选 {{ selectedCount }} 张充值码，可作废 {{ selectedActiveCodes.length }} 张</span>
      <div class="bulk-actions">
        <button class="btn btn-ghost btn-sm" :disabled="loading || revoking" @click="clearSelection">清空选择</button>
        <button class="btn btn-ghost btn-sm" :disabled="loading || revoking" @click="copySelected">复制所选</button>
        <button class="btn btn-ghost btn-sm" :disabled="loading || revoking" @click="exportSelected">导出所选</button>
        <button class="btn btn-danger btn-sm" :disabled="loading || revoking || selectedActiveCodes.length === 0" @click="revokeSelected">
          {{ revoking ? '作废中…' : `作废所选（${selectedActiveCodes.length}）` }}
        </button>
      </div>
    </div>

    <div class="table-wrap" role="region" aria-label="充值码表格滚动区域" tabindex="0" :aria-busy="loading">
      <table class="admin-table" aria-label="充值码列表">
        <thead>
          <tr>
            <th class="select-cell">
              <input
                type="checkbox"
                :checked="allVisibleSelected"
                :indeterminate.prop="partiallySelected"
                :disabled="selectableCount === 0 || loading || revoking"
                aria-label="选择当前页充值码"
                @change="toggleAllVisible(($event.target as HTMLInputElement).checked)"
              />
            </th>
            <th>充值码</th><th>面值</th><th>状态</th><th>批次</th><th>兑换邮箱</th><th>有效期</th><th>创建时间</th><th>操作</th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="i in 5" :key="`sk-${i}`" class="skeleton-row"><td colspan="9"><div class="skeleton-cell" /></td></tr>
        </tbody>
        <tbody v-else>
          <tr v-for="item in items" :key="item.code" :class="{ 'is-selected': isSelected(item.code) }">
            <td class="select-cell">
              <input
                type="checkbox"
                :checked="isSelected(item.code)"
                :disabled="loading || revoking"
                :aria-label="`选择充值码 ${item.code}`"
                @click="setSelected(item.code, ($event.target as HTMLInputElement).checked, $event.shiftKey)"
              />
            </td>
            <td class="code-cell"><code>{{ item.code }}</code></td>
            <td>{{ formatMoney(item.amountCents, 'CNY') }}</td>
            <td><span class="tag" :class="statusClass(item.status)">{{ statusLabel(item.status) }}</span></td>
            <td>{{ item.batchId || '-' }}</td>
            <td>{{ item.usedByEmail || '-' }}</td>
            <td>{{ item.expiresAt ? formatDate(item.expiresAt) : '长期有效' }}</td>
            <td>{{ formatDate(item.createdAt) }}</td>
            <td>
              <div class="table-actions">
                <button class="btn btn-ghost btn-xs" :disabled="revoking" @click="copyCode(item.code)">复制</button>
                <button v-if="item.status === 'active'" class="btn btn-danger btn-xs" :disabled="revoking" @click="revokeOne(item.code)">作废</button>
              </div>
            </td>
          </tr>
          <tr v-if="items.length === 0"><td colspan="9" class="empty-text">暂无充值码</td></tr>
        </tbody>
      </table>
    </div>

    <AdminPagination
      :page="pagination.page.value"
      :total="pagination.total.value"
      :total-pages="pagination.totalPages.value"
      :limit="pagination.limit.value"
      :disabled="loading || revoking"
      @prev="pagination.prevPage(); loadData()"
      @next="pagination.nextPage(); loadData()"
      @jump="pagination.setPage($event); loadData()"
      @update:limit="pagination.setLimit($event); loadData()"
    />

    <AdminModal v-model="generateVisible" title="批量生成充值码" max-width="520px" hide-actions>
      <form class="modal-form" @submit.prevent="generate">
        <label><span>面值（元）</span><input v-model="generateForm.amountYuan" inputmode="decimal" placeholder="例如 50.00" required /></label>
        <label><span>生成数量</span><input v-model.number="generateForm.count" type="number" min="1" max="500" required /></label>
        <label><span>批次号</span><input v-model="generateForm.batchId" maxlength="80" required /></label>
        <label><span>有效期（可选）</span><input v-model="generateForm.expiresAt" type="datetime-local" /></label>
        <label><span>备注（可选）</span><textarea v-model="generateForm.notes" rows="3" maxlength="500" /></label>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" :disabled="generating" @click="generateVisible = false">取消</button>
          <button type="submit" class="btn btn-primary" :disabled="generating">{{ generating ? '生成中…' : '生成' }}</button>
        </div>
      </form>
    </AdminModal>

    <AdminModal v-model="resultVisible" title="充值码生成结果" max-width="620px" hide-actions>
      <div class="generated-result">
        <p>批次 {{ generatedBatchId }}，共 {{ generatedCodes.length }} 张。关闭前请复制或下载保存。</p>
        <textarea :value="generatedCodes.join('\n')" rows="12" readonly aria-label="本次生成的充值码" />
        <div class="modal-actions">
          <button class="btn btn-ghost" @click="copyGenerated">复制全部</button>
          <button class="btn btn-primary" @click="exportGenerated">下载 CSV</button>
          <button class="btn btn-ghost" @click="resultVisible = false">关闭</button>
        </div>
      </div>
    </AdminModal>

    <ConfirmDialog v-model="confirmVisible" :message="confirmMessage" danger @confirm="onConfirm" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { fetchAdminVouchers, fetchAdminVoucherStats, generateAdminVouchers, revokeAdminVouchers } from '@/api/admin'
import type { AdminVoucher, AdminVoucherFilter, AdminVoucherStats } from '@/types/admin'
import { useAdminAuth } from '@/composables/useAdminAuth'
import { useToast } from '@/composables/useToast'
import { useTablePagination } from '@/composables/useTablePagination'
import { useTableSelection } from '@/composables/useTableSelection'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import { writeClipboardText } from '@/composables/useClipboard'
import { formatDate, dateTimeLocalToIso } from '@/composables/useFormat'
import { downloadCsv } from '@/lib/csv-export'
import AdminPagination from '@/components/AdminPagination.vue'
import AdminModal from '@/components/AdminModal.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { parseYuanToCents } from '@/utils/currency'
import { formatMoney } from '@shared/money'

const { token } = useAdminAuth()
const { showToast } = useToast()
const items = ref<AdminVoucher[]>([])
const stats = reactive<AdminVoucherStats>({ active: 0, used: 0, expired: 0, revoked: 0, totalAmount: 0, usedAmount: 0 })
const loading = ref(false)
const loadError = ref('')
const revoking = ref(false)
const generating = ref(false)
const filter = reactive<AdminVoucherFilter>({ status: '', batchId: '', search: '' })
const pagination = useTablePagination()
const { selectedIds, selectedCount, selectableCount, allVisibleSelected, partiallySelected, isSelected, setSelected, toggleAllVisible, clearSelection } = useTableSelection(items, (item) => item.code)
const selectedItems = computed(() => {
  const selected = new Set(selectedIds.value)
  return items.value.filter((item) => selected.has(item.code))
})
const selectedActiveCodes = computed(() => selectedItems.value.filter((item) => item.status === 'active').map((item) => item.code))
const { confirmVisible, confirmMessage, askConfirm, onConfirm } = useConfirmDialog()
let loadSequence = 0

const generateVisible = ref(false)
const resultVisible = ref(false)
const generatedCodes = ref<string[]>([])
const generatedBatchId = ref('')
const generateForm = reactive({ amountYuan: '50.00', count: 10, batchId: '', expiresAt: '', notes: '' })

function defaultBatchId() {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `VCH-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
}

async function loadData() {
  const sequence = ++loadSequence
  loading.value = true
  loadError.value = ''
  try {
    const [list, nextStats] = await Promise.all([
      fetchAdminVouchers(token.value, { ...filter, limit: pagination.limit.value, offset: (pagination.page.value - 1) * pagination.limit.value }),
      fetchAdminVoucherStats(token.value),
    ])
    if (sequence !== loadSequence) return
    if (pagination.setTotal(list.total)) return loadData()
    items.value = list.items
    Object.assign(stats, nextStats)
    clearSelection()
  } catch (err: any) {
    if (sequence !== loadSequence) return
    items.value = []
    clearSelection()
    loadError.value = err.message || '加载充值码失败'
    showToast(loadError.value, 'error')
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}

function searchData() { pagination.page.value = 1; loadData() }
function openGenerate() { Object.assign(generateForm, { amountYuan: '50.00', count: 10, batchId: defaultBatchId(), expiresAt: '', notes: '' }); generateVisible.value = true }

async function generate() {
  if (generating.value) return
  const amountCents = parseYuanToCents(generateForm.amountYuan)
  if (amountCents === null || amountCents < 1) { showToast('面值必须大于 0，且最多保留两位小数', 'error'); return }
  generating.value = true
  try {
    const res = await generateAdminVouchers(token.value, {
      count: generateForm.count,
      amountCents,
      batchId: generateForm.batchId.trim(),
      expiresAt: dateTimeLocalToIso(generateForm.expiresAt),
      notes: generateForm.notes.trim(),
    })
    generatedCodes.value = res.codes
    generatedBatchId.value = res.batchId
    generateVisible.value = false
    resultVisible.value = true
    showToast(`已生成 ${res.codes.length} 张充值码`, 'success')
    await loadData()
  } catch (err: any) {
    showToast(err.message || '生成充值码失败', 'error')
  } finally { generating.value = false }
}

async function copyLines(lines: string[], success: string) {
  if (lines.length === 0) return
  try { await writeClipboardText(lines.join('\n')); showToast(success, 'success') }
  catch { showToast('复制失败，请使用导出功能', 'error') }
}

function copyCode(code: string) { return copyLines([code], '充值码已复制') }
function copySelected() { return copyLines(selectedItems.value.map((item) => item.code), `已复制 ${selectedItems.value.length} 张充值码`) }
function copyGenerated() { return copyLines(generatedCodes.value, `已复制 ${generatedCodes.value.length} 张充值码`) }

function voucherRows(rows: AdminVoucher[]) {
  return rows.map((item) => [item.code, String(item.amountCents), item.status, item.batchId || '', item.usedByEmail || '', item.usedAt || '', item.expiresAt || '', item.notes || '', item.createdAt || ''])
}
function exportRows(filename: string, rows: AdminVoucher[]) { downloadCsv(filename, [['code', 'amountCents', 'status', 'batchId', 'usedByEmail', 'usedAt', 'expiresAt', 'notes', 'createdAt'], ...voucherRows(rows)]) }
function exportSelected() { exportRows(`selected-vouchers-${new Date().toISOString().slice(0, 10)}.csv`, selectedItems.value); showToast(`已导出 ${selectedItems.value.length} 张充值码`, 'success') }
function exportGenerated() { downloadCsv(`vouchers-${generatedBatchId.value}.csv`, [['code', 'batchId'], ...generatedCodes.value.map((code) => [code, generatedBatchId.value])]); showToast('充值码文件已下载', 'success') }

async function revokeCodes(codes: string[]) {
  if (codes.length === 0 || revoking.value) return
  if (!(await askConfirm(`确认作废 ${codes.length} 张充值码？作废后无法恢复。`))) return
  revoking.value = true
  try { const res = await revokeAdminVouchers(token.value, codes); showToast(res.message || `已作废 ${res.count} 张充值码`, 'success'); await loadData() }
  catch (err: any) { showToast(err.message || '作废充值码失败', 'error') }
  finally { revoking.value = false }
}
function revokeOne(code: string) { return revokeCodes([code]) }
function revokeSelected() { return revokeCodes(selectedActiveCodes.value) }
function statusLabel(status: string) { return ({ active: '可兑换', used: '已兑换', expired: '已过期', revoked: '已作废' } as Record<string, string>)[status] || status }
function statusClass(status: string) { if (status === 'active') return 'tag-success'; if (status === 'used') return 'tag-info'; if (status === 'expired') return 'tag-warning'; return 'tag-muted' }

onMounted(loadData)
</script>

<style>@import '@/assets/admin.css';</style>
<style scoped>
/* stat-strip/stat-item / generated-result / modal-actions → admin.css
 * 垂直间距仅靠 .admin-page gap，勿再写 margin-bottom。
 */
.code-cell code {
  white-space: nowrap;
  font-size: 12px;
}
</style>
