<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <input v-model="filter.email" type="search" placeholder="到账邮箱" aria-label="搜索充值邮箱" @keyup.enter="searchData" />
        <select v-model="filter.status" aria-label="充值订单状态" @change="searchData">
          <option value="">全部状态</option><option value="pending">待支付</option><option value="paid">已入账</option><option value="expired">已过期</option><option value="failed">创建失败</option>
        </select>
        <button class="btn btn-primary btn-sm" :disabled="loading" @click="searchData">{{ loading ? '查询中…' : '查询' }}</button>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-ghost btn-sm" :disabled="loading" @click="loadData">刷新</button>
      </div>
    </div>

    <div v-if="loadError" class="table-error" role="alert"><span>{{ loadError }}</span><button class="btn btn-ghost btn-xs" @click="loadData">重试</button></div>

    <div v-if="selectedCount > 0" class="bulk-bar" role="status" aria-live="polite">
      <span>当前页已选 {{ selectedCount }} 笔充值订单</span>
      <div class="bulk-actions">
        <button class="btn btn-ghost btn-sm" @click="clearSelection">清空选择</button>
        <button class="btn btn-ghost btn-sm" @click="copySelected">复制所选</button>
        <button class="btn btn-primary btn-sm" @click="exportSelected">导出所选</button>
      </div>
    </div>

    <div class="table-wrap" role="region" aria-label="充值订单表格滚动区域" tabindex="0" :aria-busy="loading">
      <table class="admin-table" aria-label="充值订单列表">
        <thead><tr><th class="select-cell"><input type="checkbox" :checked="allVisibleSelected" :indeterminate.prop="partiallySelected" :disabled="selectableCount === 0 || loading" aria-label="选择当前页充值订单" @change="toggleAllVisible(($event.target as HTMLInputElement).checked)" /></th><th>订单号</th><th>邮箱</th><th>金额</th><th>状态</th><th>渠道</th><th>支付流水</th><th>创建时间</th><th>入账时间</th><th>操作</th></tr></thead>
        <tbody v-if="loading"><tr v-for="i in 5" :key="i" class="skeleton-row"><td colspan="10"><div class="skeleton-cell" /></td></tr></tbody>
        <tbody v-else>
          <tr v-for="item in items" :key="item.id" :class="{ 'is-selected': isSelected(item.id) }">
            <td class="select-cell"><input type="checkbox" :checked="isSelected(item.id)" :aria-label="`选择充值订单 ${item.orderNo}`" @click="setSelected(item.id, ($event.target as HTMLInputElement).checked, $event.shiftKey)" /></td>
            <td><code>{{ item.orderNo }}</code></td><td>{{ item.buyerEmail }}</td><td>{{ formatMoney(item.amountCents, item.currency) }}</td>
            <td><span class="tag" :class="statusClass(item.status)">{{ statusLabel(item.status) }}</span></td><td>{{ item.paymentProvider }}</td><td>{{ item.paymentRef || '-' }}</td><td>{{ formatDate(item.createdAt) }}</td><td>{{ formatDate(item.paidAt) }}</td>
            <td><button class="btn btn-ghost btn-xs" @click="copyOrders([item])">复制</button></td>
          </tr>
          <tr v-if="items.length === 0"><td colspan="10" class="empty-text">暂无充值订单</td></tr>
        </tbody>
      </table>
    </div>

    <AdminPagination :page="pagination.page.value" :total="pagination.total.value" :total-pages="pagination.totalPages.value" :limit="pagination.limit.value" :disabled="loading" @prev="pagination.prevPage(); loadData()" @next="pagination.nextPage(); loadData()" @jump="pagination.setPage($event); loadData()" @update:limit="pagination.setLimit($event); loadData()" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { fetchAdminRechargeOrders } from '@/api/admin'
import type { AdminRechargeOrder, AdminRechargeOrderFilter } from '@/types/admin'
import { useAdminAuth } from '@/composables/useAdminAuth'
import { useToast } from '@/composables/useToast'
import { useTablePagination } from '@/composables/useTablePagination'
import { useTableSelection } from '@/composables/useTableSelection'
import { writeClipboardText } from '@/composables/useClipboard'
import { formatDate } from '@/composables/useFormat'
import { downloadCsv } from '@/lib/csv-export'
import AdminPagination from '@/components/AdminPagination.vue'
import { formatMoney, minorToMajorString } from '@shared/money'

const { token } = useAdminAuth(); const { showToast } = useToast()
const items = ref<AdminRechargeOrder[]>([]); const loading = ref(false); const loadError = ref('')
const filter = reactive<AdminRechargeOrderFilter>({ email: '', status: '' }); const pagination = useTablePagination(); let loadSequence = 0
const { selectedIds, selectedCount, selectableCount, allVisibleSelected, partiallySelected, isSelected, setSelected, toggleAllVisible, clearSelection } = useTableSelection(items, (item) => item.id)
const selectedItems = computed(() => { const selected = new Set(selectedIds.value); return items.value.filter((item) => selected.has(item.id)) })

async function loadData() { const sequence = ++loadSequence; loading.value = true; loadError.value = ''; try { const res = await fetchAdminRechargeOrders(token.value, { ...filter, limit: pagination.limit.value, offset: (pagination.page.value - 1) * pagination.limit.value }); if (sequence !== loadSequence) return; if (pagination.setTotal(res.total)) return loadData(); items.value = res.items; clearSelection() } catch (err: any) { if (sequence !== loadSequence) return; items.value = []; clearSelection(); loadError.value = err.message || '加载充值订单失败'; showToast(loadError.value, 'error') } finally { if (sequence === loadSequence) loading.value = false } }
function searchData() { pagination.page.value = 1; loadData() }
function orderLine(item: AdminRechargeOrder) { return [item.orderNo, item.buyerEmail, minorToMajorString(item.amountCents, item.currency), item.currency, item.status, item.paymentProvider, item.paymentRef || ''].join('\t') }
async function copyOrders(rows: AdminRechargeOrder[]) { try { await writeClipboardText(rows.map(orderLine).join('\n')); showToast(`已复制 ${rows.length} 笔充值订单`, 'success') } catch { showToast('复制失败，请使用导出功能', 'error') } }
function copySelected() { return copyOrders(selectedItems.value) }
function exportSelected() { downloadCsv(`selected-recharge-orders-${new Date().toISOString().slice(0, 10)}.csv`, [['orderNo', 'buyerEmail', 'amountCents', 'currency', 'status', 'paymentProvider', 'paymentRef', 'createdAt', 'paidAt', 'expiresAt'], ...selectedItems.value.map((item) => [item.orderNo, item.buyerEmail, String(item.amountCents), item.currency, item.status, item.paymentProvider, item.paymentRef || '', item.createdAt, item.paidAt || '', item.expiresAt])]); showToast(`已导出 ${selectedItems.value.length} 笔充值订单`, 'success') }
function statusLabel(status: string) { return ({ pending: '待支付', paid: '已入账', expired: '已过期', failed: '创建失败' } as Record<string, string>)[status] || status }
function statusClass(status: string) { if (status === 'paid') return 'tag-success'; if (status === 'pending') return 'tag-warning'; if (status === 'failed') return 'tag-danger'; return 'tag-muted' }
onMounted(loadData)
</script>

<style>@import '@/assets/admin.css';</style>
