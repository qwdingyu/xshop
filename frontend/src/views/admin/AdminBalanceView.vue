<template>
  <div class="admin-page">
    <div class="admin-tab-bar" role="tablist" aria-label="余额管理视图">
      <button
        type="button"
        role="tab"
        class="tab-btn"
        :class="{ active: activeTab === 'accounts' }"
        :aria-selected="activeTab === 'accounts'"
        @click="switchTab('accounts')"
      >
        用户余额
      </button>
      <button
        type="button"
        role="tab"
        class="tab-btn"
        :class="{ active: activeTab === 'ledger' }"
        :aria-selected="activeTab === 'ledger'"
        @click="switchTab('ledger')"
      >
        余额流水
      </button>
    </div>

    <!-- ════════ 用户余额账户 ════════ -->
    <template v-if="activeTab === 'accounts'">
      <div class="toolbar">
        <div class="filters">
          <input
            v-model="accountFilter.email"
            type="search"
            placeholder="邮箱（支持模糊）"
            aria-label="搜索用户邮箱"
            @keyup.enter="searchAccounts"
          />
          <label class="filter-check">
            <input v-model="accountFilter.positiveOnly" type="checkbox" @change="searchAccounts" />
            <span>仅余额 &gt; 0</span>
          </label>
          <button class="btn btn-primary btn-sm" :disabled="accountLoading" @click="searchAccounts">
            {{ accountLoading ? '查询中…' : '查询' }}
          </button>
        </div>
        <div class="toolbar-actions">
          <button class="btn btn-ghost btn-sm" :disabled="accountLoading" @click="loadAccounts">刷新</button>
          <button class="btn btn-primary btn-sm" @click="openAdjust()">手工调账</button>
        </div>
      </div>

      <p class="balance-helper">
        数据来自 <code>user_balances</code> 真实账户余额（按邮箱聚合），非流水估算。可查看全部用户、筛选、复制/导出，并对指定邮箱加款或扣款。
      </p>

      <div v-if="accountError" class="table-error" role="alert">
        <span>{{ accountError }}</span>
        <button class="btn btn-ghost btn-xs" :disabled="accountLoading" @click="loadAccounts">重新加载</button>
      </div>

      <div v-if="accountSelectedCount > 0" class="bulk-bar" role="status" aria-live="polite">
        <span>当前页已选 {{ accountSelectedCount }} 个账户</span>
        <div class="bulk-actions">
          <button class="btn btn-ghost btn-sm" @click="clearAccountSelection">清空选择</button>
          <button class="btn btn-ghost btn-sm" @click="copySelectedAccounts">复制已选</button>
          <button class="btn btn-primary btn-sm" @click="exportSelectedAccounts">导出已选 CSV</button>
        </div>
      </div>

      <div class="table-wrap" role="region" aria-label="用户余额表格" tabindex="0" :aria-busy="accountLoading">
        <table class="admin-table" aria-label="用户余额列表">
          <thead>
            <tr>
              <th class="select-cell">
                <input
                  type="checkbox"
                  :checked="allAccountsSelected"
                  :indeterminate.prop="partialAccountsSelected"
                  :disabled="accountSelectableCount === 0 || accountLoading"
                  aria-label="选择当前页账户"
                  @change="toggleAllAccounts(($event.target as HTMLInputElement).checked)"
                />
              </th>
              <th>邮箱</th>
              <th>当前余额</th>
              <th>累计充值</th>
              <th>累计消费</th>
              <th>更新时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody v-if="accountLoading">
            <tr v-for="i in 5" :key="'ask' + i" class="skeleton-row">
              <td colspan="7"><div class="skeleton-cell" /></td>
            </tr>
          </tbody>
          <tbody v-else>
            <tr
              v-for="item in accounts"
              :key="item.email"
              :class="{ 'is-selected': isAccountSelected(item.email) }"
            >
              <td class="select-cell">
                <input
                  type="checkbox"
                  :checked="isAccountSelected(item.email)"
                  :disabled="accountLoading"
                  :aria-label="`选择账户 ${item.email}`"
                  @click="setAccountSelected(item.email, ($event.target as HTMLInputElement).checked, $event.shiftKey)"
                />
              </td>
              <td><code>{{ item.email }}</code></td>
              <td :class="item.balanceCents > 0 ? 'is-positive' : ''">{{ formatCents(item.balanceCents) }}</td>
              <td>{{ formatCents(item.totalDepositedCents) }}</td>
              <td>{{ formatCents(item.totalSpentCents) }}</td>
              <td>{{ formatDate(item.updatedAt) }}</td>
              <td class="table-actions">
                <button class="btn btn-ghost btn-xs" @click="viewLedgerFor(item.email)">流水</button>
                <button class="btn btn-ghost btn-xs" @click="openAdjust(item)">调账</button>
                <button class="btn btn-ghost btn-xs" @click="copyEmail(item.email)">复制邮箱</button>
              </td>
            </tr>
            <tr v-if="accounts.length === 0">
              <td colspan="7" class="empty-text">暂无余额账户（用户兑换充值码、在线充值或调账后会出现）</td>
            </tr>
          </tbody>
        </table>
      </div>

      <AdminPagination
        :page="accountPagination.page.value"
        :total="accountPagination.total.value"
        :total-pages="accountPagination.totalPages.value"
        :limit="accountPagination.limit.value"
        :disabled="accountLoading"
        @prev="accountPagination.prevPage(); loadAccounts()"
        @next="accountPagination.nextPage(); loadAccounts()"
        @jump="accountPagination.setPage($event); loadAccounts()"
        @update:limit="accountPagination.setLimit($event); loadAccounts()"
      />
    </template>

    <!-- ════════ 余额流水 ════════ -->
    <template v-else>
      <div class="toolbar">
        <div class="filters">
          <input
            v-model="ledgerFilter.email"
            type="search"
            placeholder="邮箱（精确）"
            aria-label="搜索用户邮箱"
            @keyup.enter="searchLedger"
          />
          <select v-model="ledgerFilter.type" aria-label="流水类型" @change="searchLedger">
            <option value="">全部类型</option>
            <option value="voucher_redeem">充值码兑换</option>
            <option value="recharge">在线充值</option>
            <option value="order_spend">消费</option>
            <option value="refund">退款</option>
            <option value="adjustment">调整</option>
          </select>
          <input
            v-model="ledgerFilter.referenceType"
            type="search"
            placeholder="关联类型"
            aria-label="搜索关联类型"
            @keyup.enter="searchLedger"
          />
          <input
            v-model="ledgerFilter.referenceId"
            type="search"
            placeholder="关联 ID"
            aria-label="搜索关联 ID"
            @keyup.enter="searchLedger"
          />
          <button class="btn btn-primary btn-sm" :disabled="ledgerLoading" @click="searchLedger">
            {{ ledgerLoading ? '查询中…' : '查询' }}
          </button>
        </div>
      </div>

      <section v-if="ledgerFilter.email" class="balance-snapshot">
        <div class="snapshot-card snapshot-card--primary">
          <div class="snapshot-label">最新流水后余额</div>
          <div class="snapshot-value">{{ formatCents(latestBalanceCents) }}</div>
          <div class="snapshot-hint">按本页最新一条流水的 balanceAfter 估算，对账请以账户页为准</div>
        </div>
        <div class="snapshot-card">
          <div class="snapshot-label">当前筛选流水</div>
          <div class="snapshot-value">{{ ledgerPagination.total.value }}</div>
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
        可按邮箱 / 类型 / 关联查询全部流水；也可从「用户余额」点「流水」带入邮箱筛选。
      </p>

      <div v-if="ledgerError" class="table-error" role="alert">
        <span>{{ ledgerError }}</span>
        <button class="btn btn-ghost btn-xs" :disabled="ledgerLoading" @click="loadLedger">重新加载</button>
      </div>

      <div v-if="ledgerSelectedCount > 0" class="bulk-bar" role="status" aria-live="polite">
        <span>当前页已选 {{ ledgerSelectedCount }} 条流水</span>
        <div class="bulk-actions">
          <button class="btn btn-ghost btn-sm" @click="clearLedgerSelection">清空选择</button>
          <button class="btn btn-ghost btn-sm" @click="copySelectedTransactions">复制已选</button>
          <button class="btn btn-primary btn-sm" @click="exportSelectedTransactions">导出已选 CSV</button>
        </div>
      </div>

      <div class="table-wrap" role="region" aria-label="余额流水表格" tabindex="0" :aria-busy="ledgerLoading">
        <table class="admin-table" aria-label="余额流水列表">
          <thead>
            <tr>
              <th class="select-cell">
                <input
                  type="checkbox"
                  :checked="allLedgerSelected"
                  :indeterminate.prop="partialLedgerSelected"
                  :disabled="ledgerSelectableCount === 0 || ledgerLoading"
                  aria-label="选择当前页余额流水"
                  @change="toggleAllLedger(($event.target as HTMLInputElement).checked)"
                />
              </th>
              <th>ID</th>
              <th>邮箱</th>
              <th>类型</th>
              <th>变动（元）</th>
              <th>变动后余额（元）</th>
              <th>关联类型</th>
              <th>关联ID</th>
              <th>备注</th>
              <th>时间</th>
            </tr>
          </thead>
          <tbody v-if="ledgerLoading">
            <tr v-for="i in 5" :key="'lsk' + i" class="skeleton-row">
              <td colspan="10"><div class="skeleton-cell" /></td>
            </tr>
          </tbody>
          <tbody v-else>
            <tr
              v-for="item in ledgerItems"
              :key="transactionKey(item)"
              :class="{ 'is-selected': isLedgerSelected(transactionKey(item)) }"
            >
              <td class="select-cell">
                <input
                  type="checkbox"
                  :checked="isLedgerSelected(transactionKey(item))"
                  :disabled="ledgerLoading"
                  :aria-label="`选择余额流水 ${item.id || item.createdAt || ''}`"
                  @click="setLedgerSelected(transactionKey(item), ($event.target as HTMLInputElement).checked, $event.shiftKey)"
                />
              </td>
              <td class="id-cell">{{ item.id || '-' }}</td>
              <td>{{ item.email || '-' }}</td>
              <td>{{ typeText(item.type) }}</td>
              <td :class="Number(item.amountCents || 0) >= 0 ? 'is-positive' : 'is-negative'">
                {{ formatSignedCents(item.amountCents || 0) }}
              </td>
              <td>{{ formatCents(item.balanceAfterCents || 0) }}</td>
              <td>{{ item.referenceType || '-' }}</td>
              <td class="id-cell">{{ item.referenceId || '-' }}</td>
              <td class="note-cell">{{ item.note || '-' }}</td>
              <td>{{ formatDate(item.createdAt) }}</td>
            </tr>
            <tr v-if="ledgerItems.length === 0">
              <td colspan="10" class="empty-text">暂无流水</td>
            </tr>
          </tbody>
        </table>
      </div>

      <AdminPagination
        :page="ledgerPagination.page.value"
        :total="ledgerPagination.total.value"
        :total-pages="ledgerPagination.totalPages.value"
        :limit="ledgerPagination.limit.value"
        :disabled="ledgerLoading"
        @prev="ledgerPagination.prevPage(); loadLedger()"
        @next="ledgerPagination.nextPage(); loadLedger()"
        @jump="ledgerPagination.setPage($event); loadLedger()"
        @update:limit="ledgerPagination.setLimit($event); loadLedger()"
      />
    </template>

    <!-- 调账弹窗 -->
    <AdminModal v-model="adjustVisible" title="手工调账" max-width="440px" hide-actions>
      <form class="modal-form adjust-form" @submit.prevent="submitAdjust">
        <label>
          <span>邮箱</span>
          <input
            v-model.trim="adjustForm.email"
            type="email"
            required
            maxlength="160"
            placeholder="user@example.com"
            autocomplete="off"
          />
        </label>
        <div class="adjust-direction" role="group" aria-label="调账方向">
          <button
            type="button"
            class="dir-btn"
            :class="{ active: adjustForm.direction === 'credit' }"
            @click="adjustForm.direction = 'credit'"
          >
            加款
          </button>
          <button
            type="button"
            class="dir-btn"
            :class="{ active: adjustForm.direction === 'debit' }"
            @click="adjustForm.direction = 'debit'"
          >
            扣款
          </button>
        </div>
        <label>
          <span>金额（元）</span>
          <input
            v-model.trim="adjustForm.amountMajor"
            type="text"
            inputmode="decimal"
            required
            placeholder="例如 10.00"
            autocomplete="off"
          />
          <small class="field-hint">仅支持 CNY；正数金额，方向由上方选择</small>
        </label>
        <label>
          <span>备注（必填，审计用）</span>
          <textarea
            v-model.trim="adjustForm.note"
            rows="2"
            required
            minlength="2"
            maxlength="200"
            placeholder="例如：客服补偿 / 误充回收"
          ></textarea>
        </label>
        <p v-if="adjustPreview" class="adjust-preview">
          将{{ adjustForm.direction === 'credit' ? '加款' : '扣款' }}
          <strong>{{ adjustPreview }}</strong>
          到 <code>{{ adjustForm.email || '…' }}</code>
        </p>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" :disabled="adjustSaving" @click="adjustVisible = false">取消</button>
          <button type="submit" class="btn btn-primary" :disabled="adjustSaving">
            {{ adjustSaving ? '提交中…' : '确认调账' }}
          </button>
        </div>
      </form>
    </AdminModal>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import {
  fetchAdminBalanceTransactions,
  fetchAdminUserBalances,
  adjustAdminUserBalance,
} from '@/api/admin'
import type {
  AdminBalanceTransaction,
  AdminBalanceTransactionFilter,
  AdminUserBalance,
} from '@/types/admin'
import { useToast } from '@/composables/useToast'
import { useTablePagination } from '@/composables/useTablePagination'
import { useAdminAuth } from '@/composables/useAdminAuth'
import { useTableSelection } from '@/composables/useTableSelection'
import { downloadCsv } from '@/lib/csv-export'
import { writeClipboardText } from '@/composables/useClipboard'
import { formatDate } from '@/composables/useFormat'
import AdminPagination from '@/components/AdminPagination.vue'
import AdminModal from '@/components/AdminModal.vue'
import { formatMoney, parseMajorToMinor, minorToMajorString } from '@shared/money'

const { showToast } = useToast()
const { token } = useAdminAuth()

type BalanceTab = 'accounts' | 'ledger'
const activeTab = ref<BalanceTab>('accounts')

// ─── 用户余额账户 ───
const accounts = ref<AdminUserBalance[]>([])
const accountLoading = ref(false)
const accountError = ref('')
const accountFilter = reactive({ email: '', positiveOnly: false })
const accountPagination = useTablePagination()
let accountSeq = 0

const {
  selectedIds: accountSelectedIds,
  selectedCount: accountSelectedCount,
  selectableCount: accountSelectableCount,
  allVisibleSelected: allAccountsSelected,
  partiallySelected: partialAccountsSelected,
  isSelected: isAccountSelected,
  setSelected: setAccountSelected,
  toggleAllVisible: toggleAllAccounts,
  clearSelection: clearAccountSelection,
} = useTableSelection(accounts, (item) => item.email)

async function loadAccounts() {
  const sequence = ++accountSeq
  accountLoading.value = true
  accountError.value = ''
  try {
    const res = await fetchAdminUserBalances(token.value, {
      email: accountFilter.email.trim() || undefined,
      positiveOnly: accountFilter.positiveOnly ? '1' : undefined,
      limit: accountPagination.limit.value,
      offset: (accountPagination.page.value - 1) * accountPagination.limit.value,
    })
    if (sequence !== accountSeq) return
    if (accountPagination.setTotal(res.total)) return loadAccounts()
    accounts.value = res.items
    clearAccountSelection()
  } catch (err: any) {
    if (sequence !== accountSeq) return
    accounts.value = []
    clearAccountSelection()
    accountError.value = err.message || '加载用户余额失败'
    showToast(accountError.value, 'error')
  } finally {
    if (sequence === accountSeq) accountLoading.value = false
  }
}

function searchAccounts() {
  accountPagination.page.value = 1
  loadAccounts()
}

function selectedAccountRows() {
  const selected = new Set(accountSelectedIds.value)
  return accounts.value.filter((item) => selected.has(item.email))
}

async function copySelectedAccounts() {
  const rows = selectedAccountRows()
  if (rows.length === 0) return
  try {
    await writeClipboardText(
      rows
        .map((item) =>
          [
            item.email,
            minorToMajorString(item.balanceCents, 'CNY'),
            minorToMajorString(item.totalDepositedCents, 'CNY'),
            minorToMajorString(item.totalSpentCents, 'CNY'),
            item.updatedAt || '',
          ].join('\t'),
        )
        .join('\n'),
    )
    showToast(`已复制 ${rows.length} 个账户`, 'success')
  } catch {
    showToast('复制失败，请使用导出', 'error')
  }
}

function exportSelectedAccounts() {
  const rows = selectedAccountRows()
  if (rows.length === 0) return
  downloadCsv(`selected-user-balances-${new Date().toISOString().slice(0, 10)}.csv`, [
    ['email', 'balanceCents', 'totalDepositedCents', 'totalSpentCents', 'updatedAt'],
    ...rows.map((item) => [
      item.email,
      String(item.balanceCents),
      String(item.totalDepositedCents),
      String(item.totalSpentCents),
      item.updatedAt || '',
    ]),
  ])
  showToast(`已导出 ${rows.length} 个账户`, 'success')
}

async function copyEmail(email: string) {
  try {
    await writeClipboardText(email)
    showToast('已复制邮箱', 'success')
  } catch {
    showToast('复制失败', 'error')
  }
}

function viewLedgerFor(email: string) {
  ledgerFilter.email = email
  ledgerFilter.type = ''
  ledgerFilter.referenceType = ''
  ledgerFilter.referenceId = ''
  ledgerPagination.page.value = 1
  activeTab.value = 'ledger'
  loadLedger()
}

// ─── 流水 ───
const ledgerItems = ref<AdminBalanceTransaction[]>([])
const ledgerLoading = ref(false)
const ledgerError = ref('')
const ledgerFilter = reactive<AdminBalanceTransactionFilter>({
  email: '',
  type: '',
  referenceType: '',
  referenceId: '',
  offset: 0,
})
const ledgerPagination = useTablePagination()
let ledgerSeq = 0

const {
  selectedIds: ledgerSelectedIds,
  selectedCount: ledgerSelectedCount,
  selectableCount: ledgerSelectableCount,
  allVisibleSelected: allLedgerSelected,
  partiallySelected: partialLedgerSelected,
  isSelected: isLedgerSelected,
  setSelected: setLedgerSelected,
  toggleAllVisible: toggleAllLedger,
  clearSelection: clearLedgerSelection,
} = useTableSelection(ledgerItems, transactionKey)

const latestBalanceCents = computed(() => Number(ledgerItems.value[0]?.balanceAfterCents || 0))
const netChangeCents = computed(() =>
  ledgerItems.value.reduce((sum, item) => sum + Number(item.amountCents || 0), 0),
)

function transactionKey(item: AdminBalanceTransaction) {
  return (
    item.id
    || `${item.email || ''}:${item.type || ''}:${item.referenceType || ''}:${item.referenceId || ''}:${item.createdAt || ''}`
  )
}

async function loadLedger() {
  const sequence = ++ledgerSeq
  ledgerLoading.value = true
  ledgerError.value = ''
  try {
    const res = await fetchAdminBalanceTransactions(token.value, {
      ...ledgerFilter,
      limit: ledgerPagination.limit.value,
      offset: (ledgerPagination.page.value - 1) * ledgerPagination.limit.value,
    })
    if (sequence !== ledgerSeq) return
    if (ledgerPagination.setTotal(res.total)) return loadLedger()
    ledgerItems.value = res.transactions
    clearLedgerSelection()
  } catch (err: any) {
    if (sequence !== ledgerSeq) return
    ledgerItems.value = []
    clearLedgerSelection()
    ledgerError.value = err.message || '加载余额流水失败'
    showToast(ledgerError.value, 'error')
  } finally {
    if (sequence === ledgerSeq) ledgerLoading.value = false
  }
}

function searchLedger() {
  ledgerPagination.page.value = 1
  loadLedger()
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
  const selected = new Set(ledgerSelectedIds.value)
  return ledgerItems.value.filter((item) => selected.has(transactionKey(item)))
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
    item.note || '',
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
    ['id', 'email', 'type', 'amountCents', 'balanceAfterCents', 'referenceType', 'referenceId', 'note', 'createdAt'],
    ...transactionRows(transactions),
  ])
  showToast(`已导出 ${transactions.length} 条流水`, 'success')
}

function switchTab(tab: BalanceTab) {
  if (activeTab.value === tab) return
  activeTab.value = tab
  if (tab === 'accounts' && accounts.value.length === 0 && !accountLoading.value) {
    loadAccounts()
  }
  if (tab === 'ledger' && ledgerItems.value.length === 0 && !ledgerLoading.value) {
    loadLedger()
  }
}

// ─── 调账 ───
const adjustVisible = ref(false)
const adjustSaving = ref(false)
const adjustForm = reactive({
  email: '',
  direction: 'credit' as 'credit' | 'debit',
  amountMajor: '',
  note: '',
})

const adjustPreview = computed(() => {
  try {
    if (!adjustForm.amountMajor.trim()) return ''
    const cents = parseMajorToMinor(adjustForm.amountMajor.trim(), 'CNY')
    if (cents <= 0) return ''
    return formatMoney(cents, 'CNY')
  } catch {
    return ''
  }
})

function openAdjust(item?: AdminUserBalance) {
  adjustForm.email = item?.email || ''
  adjustForm.direction = 'credit'
  adjustForm.amountMajor = ''
  adjustForm.note = ''
  adjustVisible.value = true
}

async function submitAdjust() {
  const email = adjustForm.email.trim().toLowerCase()
  if (!email || !email.includes('@')) {
    showToast('请输入有效邮箱', 'error')
    return
  }
  let amountCents: number
  try {
    amountCents = parseMajorToMinor(adjustForm.amountMajor.trim(), 'CNY')
  } catch {
    showToast('金额格式无效', 'error')
    return
  }
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    showToast('金额必须大于 0', 'error')
    return
  }
  if (adjustForm.direction === 'debit') amountCents = -amountCents

  const note = adjustForm.note.trim()
  if (note.length < 2) {
    showToast('请填写调账备注（至少 2 字）', 'error')
    return
  }

  adjustSaving.value = true
  try {
    const res = await adjustAdminUserBalance(token.value, { email, amountCents, note })
    showToast(res.message || '调账成功', 'success')
    adjustVisible.value = false
    if (activeTab.value === 'accounts') await loadAccounts()
    else await loadLedger()
  } catch (err: any) {
    showToast(err.message || '调账失败', 'error')
  } finally {
    adjustSaving.value = false
  }
}

onMounted(() => {
  loadAccounts()
})
</script>

<style>@import '@/assets/admin.css';</style>
<style scoped>
/*
 * 共享：admin-tab-bar / balance-helper / filter-check / dir-btn /
 * is-positive / modal-actions / field-hint → admin.css
 * 本页仅保留余额快照与调账预览结构。
 */
.balance-snapshot {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: var(--admin-control-gap, 8px);
  /* 垂直间距交给 .admin-page gap */
  margin: 0;
  flex-shrink: 0;
}

.snapshot-card {
  padding: 12px;
  border-radius: var(--r-lg, 12px);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
  background: var(--tg-secondary-bg, #151b28);
}

.snapshot-card--primary {
  background: var(--admin-accent-soft, rgba(245, 158, 11, 0.12));
  border-color: var(--admin-accent-border, rgba(245, 158, 11, 0.38));
}

.snapshot-label {
  font-size: 12px;
  color: var(--tg-hint, #9aa4b2);
}

.snapshot-value {
  margin-top: 6px;
  font-size: 22px;
  font-weight: 700;
  color: var(--tg-text, #f0f2f5);
}

.snapshot-hint {
  margin-top: 4px;
  font-size: 11px;
  color: var(--tg-hint, #9aa4b2);
  line-height: 1.4;
}

.id-cell,
.note-cell {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}

.adjust-direction {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.adjust-preview {
  margin: 0;
  font-size: 12px;
  color: var(--tg-hint, #9aa4b2);
  line-height: 1.45;
}

.adjust-preview strong {
  color: var(--admin-accent-text, #fbbf24);
}
</style>
