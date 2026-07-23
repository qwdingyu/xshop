<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <input v-model="filter.email" type="search" placeholder="邮箱" aria-label="搜索用户邮箱" @keyup.enter="searchData" />
        <select v-model="filter.type" aria-label="流水类型" @change="searchData">
          <option value="">全部类型</option>
          <option value="voucher_redeem">充值码兑换</option>
          <option value="recharge">在线充值</option>
          <option value="order_spend">消费</option>
          <option value="refund">退款</option>
          <option value="adjustment">调整</option>
        </select>
        <input v-model="filter.referenceType" type="search" placeholder="关联类型" aria-label="搜索关联类型" @keyup.enter="searchData" />
        <input v-model="filter.referenceId" type="search" placeholder="关联 ID" aria-label="搜索关联 ID" @keyup.enter="searchData" />
        <button class="btn btn-primary btn-sm" @click="searchData">查询</button>
      </div>
    </div>

    <section v-if="filter.email" class="balance-snapshot">
      <div class="snapshot-card snapshot-card--primary">
        <div class="snapshot-label">当前余额</div>
        <div class="snapshot-value">{{ formatCents(latestBalanceCents) }}</div>
        <div class="snapshot-hint">按最新流水的变动后余额估算</div>
      </div>
      <div class="snapshot-card">
        <div class="snapshot-label">当前筛选流水</div>
        <div class="snapshot-value">{{ pagination.total.value }}</div>
        <div class="snapshot-hint">用于排查该邮箱近期余额变化</div>
      </div>
      <div class="snapshot-card">
        <div class="snapshot-label">本页净变动</div>
        <div class="snapshot-value" :class="netChangeCents >= 0 ? 'is-positive' : 'is-negative'">
          {{ formatSignedCents(netChangeCents) }}
        </div>
        <div class="snapshot-hint">仅统计当前页，不代替财务对账</div>
      </div>
    </section>

    <p v-else class="balance-helper">
      输入邮箱后可快速查看该用户的最新余额、流水数量和本页净变动，用于客服排障。
    </p>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" :disabled="loading" @click="loadData">重新加载</button>
    </div>

    <div v-if="selectedCount > 0" class="bulk-bar" role="status" aria-live="polite" :aria-busy="loading">
      <span>当前页已选 {{ selectedCount }} 条流水</span>
      <div class="bulk-actions">
        <button class="btn btn-ghost btn-sm" :disabled="loading" @click="clearSelection">清空选择</button>
        <button class="btn btn-ghost btn-sm" :disabled="loading" @click="copySelectedTransactions">复制已选</button>
        <button class="btn btn-primary btn-sm" :disabled="loading" @click="exportSelectedTransactions">导出已选 CSV</button>
      </div>
    </div>

    <div class="table-wrap" role="region" aria-label="余额流水表格滚动区域" tabindex="0" :aria-busy="loading">
      <table class="admin-table" aria-label="余额流水列表">
        <thead>
          <tr>
            <th class="select-cell">
              <input
                type="checkbox"
                :checked="allVisibleSelected"
                :indeterminate.prop="partiallySelected"
                :disabled="selectableCount === 0 || loading"
                aria-label="选择当前页余额流水"
                @change="toggleAllVisible(($event.target as HTMLInputElement).checked)"
              />
            </th>
            <th>ID</th>
            <th>邮箱</th>
            <th>类型</th>
            <th>变动（元）</th>
            <th>变动后余额（元）</th>
            <th>关联类型</th>
            <th>关联ID</th>
            <th>时间</th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="i in 5" :key="'sk' + i" class="skeleton-row">
            <td :colspan="9"><div class="skeleton-cell" /></td>
          </tr>
        </tbody>
        <tbody v-else>
          <tr v-for="item in items" :key="transactionKey(item)" :class="{ 'is-selected': isSelected(transactionKey(item)) }">
            <td class="select-cell">
              <input
                type="checkbox"
                :checked="isSelected(transactionKey(item))"
                :disabled="loading"
                :aria-label="`选择余额流水 ${item.id || item.createdAt || ''}`"
                @click="setSelected(transactionKey(item), ($event.target as HTMLInputElement).checked, $event.shiftKey)"
              />
            </td>
            <td>{{ item.id }}</td>
            <td>{{ item.email || '-' }}</td>
            <td>{{ typeText(item.type) }}</td>
            <td :class="Number(item.amountCents || 0) >= 0 ? 'is-positive' : 'is-negative'">{{ formatSignedCents(item.amountCents || 0) }}</td>
            <td>{{ formatCents(item.balanceAfterCents || 0) }}</td>
            <td>{{ item.referenceType || '-' }}</td>
            <td>{{ item.referenceId || '-' }}</td>
            <td>{{ formatDate(item.createdAt) }}</td>
          </tr>
          <tr v-if="items.length === 0">
            <td colspan="9" class="empty-text">暂无流水</td>
          </tr>
        </tbody>
      </table>
    </div>

    <AdminPagination
      :page="pagination.page.value"
      :total="pagination.total.value"
      :total-pages="pagination.totalPages.value"
      :limit="pagination.limit.value"
      :disabled="loading"
      @prev="pagination.prevPage(); loadData()"
      @next="pagination.nextPage(); loadData()"
      @jump="pagination.setPage($event); loadData()"
      @update:limit="pagination.setLimit($event); loadData()"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import { fetchAdminBalanceTransactions } from '@/api/admin'
import type { AdminBalanceTransaction, AdminBalanceTransactionFilter } from '@/types/admin'
import { useToast } from '@/composables/useToast'
import { useTablePagination } from '@/composables/useTablePagination'
import { useAdminAuth } from '@/composables/useAdminAuth'
import { useTableSelection } from '@/composables/useTableSelection'
import { downloadCsv } from '@/lib/csv-export'
import { writeClipboardText } from '@/composables/useClipboard'
import { formatDate } from '@/composables/useFormat'
import AdminPagination from '@/components/AdminPagination.vue'
import { formatMoney } from '@shared/money'

const { showToast } = useToast()
const { token } = useAdminAuth()

const items = ref<AdminBalanceTransaction[]>([])
const loading = ref(false)
const loadError = ref('')
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
} = useTableSelection(items, transactionKey)
const filter = reactive<AdminBalanceTransactionFilter>({
  email: '',
  type: '',
  referenceType: '',
  referenceId: '',
  offset: 0,
})

const pagination = useTablePagination()

const latestBalanceCents = computed(() => Number(items.value[0]?.balanceAfterCents || 0))
const netChangeCents = computed(() => items.value.reduce((sum, item) => sum + Number(item.amountCents || 0), 0))
let loadSequence = 0

function transactionKey(item: AdminBalanceTransaction) {
  return item.id || `${item.email || ''}:${item.type || ''}:${item.referenceType || ''}:${item.referenceId || ''}:${item.createdAt || ''}`
}

async function loadData() {
  const sequence = ++loadSequence
  loading.value = true
  loadError.value = ''
  try {
    const res = await fetchAdminBalanceTransactions(token.value, {
      ...filter,
      limit: pagination.limit.value,
      offset: (pagination.page.value - 1) * pagination.limit.value,
    })
    if (sequence !== loadSequence) return
    if (pagination.setTotal(res.total)) return loadData()
    items.value = res.transactions
    clearSelection()
  } catch (err: any) {
    if (sequence !== loadSequence) return
    items.value = []
    clearSelection()
    loadError.value = err.message || '加载余额流水失败'
    showToast(err.message || '加载余额流水失败', 'error')
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}

function searchData() {
  pagination.page.value = 1
  loadData()
}

function typeText(type?: string) {
  const map: Record<string, string> = {
    voucher_redeem: '充值码兑换',
    recharge: '在线充值',
    order_spend: '消费',
    refund: '退款',
    adjustment: '调整',
  }
  return map[type || ''] || type || '-'
}

function formatCents(cents: number) {
  return formatMoney(Number(cents || 0), 'CNY')
}

function formatSignedCents(cents: number) {
  const value = Number(cents || 0)
  return value > 0 ? `+${formatMoney(value, 'CNY')}` : formatMoney(value, 'CNY')
}

function selectedTransactions() {
  const selected = new Set(selectedIds.value)
  return items.value.filter((item) => selected.has(transactionKey(item)))
}

function transactionRows(transactions: AdminBalanceTransaction[]) {
  return transactions.map((item) => [
    item.id || '',
    item.email || '',
    typeText(item.type),
    String(item.amountCents ?? ''),
    String(item.balanceAfterCents ?? ''),
    item.referenceType || '',
    item.referenceId || '',
    item.createdAt || '',
  ])
}

async function copySelectedTransactions() {
  const transactions = selectedTransactions()
  if (transactions.length === 0) return
  try {
    await writeClipboardText(transactionRows(transactions).map((row) => row.join('\t')).join('\n'))
    showToast(`已复制 ${transactions.length} 条流水`, 'success')
  } catch {
    showToast('复制失败，请手动查看或导出 CSV', 'error')
  }
}

function exportSelectedTransactions() {
  const transactions = selectedTransactions()
  if (transactions.length === 0) return
  downloadCsv(`selected-balance-transactions-${new Date().toISOString().slice(0, 10)}.csv`, [
    ['id', 'email', 'type', 'amountCents', 'balanceAfterCents', 'referenceType', 'referenceId', 'createdAt'],
    ...transactionRows(transactions),
  ])
  showToast(`已导出 ${transactions.length} 条流水`, 'success')
}

onMounted(loadData)
</script>

<style>@import '@/assets/admin.css';</style>
<style scoped>
.balance-helper {
  margin: 0 0 12px;
  color: var(--tg-hint, #6b7280);
  font-size: 13px;
}

.balance-snapshot {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px;
  margin-bottom: 12px;
}

.snapshot-card {
  padding: 12px;
  border-radius: var(--r-lg, 12px);
  border: 0.5px solid var(--border, #e5e7eb);
  background: var(--tg-bg, #fff);
}

.snapshot-card--primary {
  background: rgba(59, 130, 246, 0.06);
}

.snapshot-label {
  font-size: 12px;
  color: var(--tg-hint, #6b7280);
}

.snapshot-value {
  margin-top: 6px;
  font-size: 22px;
  font-weight: 700;
  color: var(--tg-text, #111827);
}

.snapshot-hint {
  margin-top: 4px;
  font-size: 12px;
  color: var(--tg-hint, #6b7280);
}

.is-positive {
  color: #16a34a;
  font-weight: 600;
}

.is-negative {
  color: #dc2626;
  font-weight: 600;
}
</style>
