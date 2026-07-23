<template>
  <div class="admin-dashboard admin-page">
    <div class="toolbar">
      <h2 class="toolbar-title">运营台</h2>
    </div>

    <div v-if="summaryError" class="table-error" role="alert">
      <span>{{ summaryError }}</span>
      <button class="btn btn-ghost btn-xs" :disabled="loading" @click="loadData">重新加载</button>
    </div>

    <section class="priority-strip">
      <div class="priority-card">
        <div class="priority-label">先处理</div>
        <div class="priority-value">{{ pendingTasks.pendingOfflinePayments.length }}</div>
        <div class="priority-title">待确认线下付款</div>
        <button class="btn btn-primary btn-xs" @click="goToPendingOfflinePayments">去处理</button>
      </div>
      <div class="priority-card">
        <div class="priority-label">再处理</div>
        <div class="priority-value">{{ pendingTasks.paidButNotIssued.length }}</div>
        <div class="priority-title">已付未发卡</div>
        <button class="btn btn-primary btn-xs" @click="goToPaidButNotIssued">去处理</button>
      </div>
      <div class="priority-card">
        <div class="priority-label">别忘了</div>
        <div class="priority-value">{{ pendingTasks.lowStockProducts.length }}</div>
        <div class="priority-title">低库存商品</div>
        <button class="btn btn-primary btn-xs" @click="goToLowStock">去查看</button>
      </div>
    </section>

    <section class="stats-grid">
      <div class="stat-card">
        <div class="stat-num">{{ summary.products }}</div>
        <div class="stat-label">上架商品</div>
      </div>
      <div class="stat-card">
        <div class="stat-num">{{ summary.availableCards }}</div>
        <div class="stat-label">可用卡密</div>
      </div>
      <div class="stat-card">
        <div class="stat-num">{{ summary.totalOrders }}</div>
        <div class="stat-label">总订单</div>
      </div>
      <div class="stat-card">
        <div class="stat-num">{{ summary.pendingOrders }}</div>
        <div class="stat-label">待处理订单</div>
      </div>
      <button type="button" class="stat-card stat-card--clickable" :disabled="summary.lowStockCount === 0" @click="loadLowStock">
        <div class="stat-num">{{ summary.lowStockCount }}</div>
        <div class="stat-label">低库存预警</div>
      </button>
    </section>

    <section class="card">
      <h2 class="card-title">今日待处理</h2>
      <div class="pending-tasks">
        <button type="button" class="pending-task-item" @click="goToPendingOfflinePayments">
          <div class="pending-task-title">待确认线下付款</div>
          <div class="pending-task-count">{{ pendingTasks.pendingOfflinePayments.length }}</div>
        </button>
        <button type="button" class="pending-task-item" @click="goToPaidButNotIssued">
          <div class="pending-task-title">已付未发卡</div>
          <div class="pending-task-count">{{ pendingTasks.paidButNotIssued.length }}</div>
        </button>
        <button type="button" class="pending-task-item" @click="goToLowStock">
          <div class="pending-task-title">低库存预警</div>
          <div class="pending-task-count">{{ pendingTasks.lowStockProducts.length }}</div>
        </button>
      </div>
    </section>

    <section class="card">
      <div class="card-header">
        <h2 class="card-title">运营工具</h2>
        <span class="card-hint">只放高频排障和维护入口</span>
      </div>
      <div class="ops-grid">
        <button class="ops-action" type="button" @click="goToBalance">
          <span class="ops-title">余额流水</span>
          <span class="ops-desc">按邮箱排查充值、消费、退款</span>
        </button>
        <button class="ops-action" type="button" @click="goToLogs">
          <span class="ops-title">操作日志</span>
          <span class="ops-desc">查看后台操作和系统清理记录</span>
        </button>
        <button class="ops-action" type="button" @click="goToConfig">
          <span class="ops-title">上线配置</span>
          <span class="ops-desc">检查 Turnstile、邮件、支付配置</span>
        </button>
        <button class="ops-action ops-action--maintenance" type="button" :disabled="cleanupLoading" @click="confirmCleanup">
          <span class="ops-title">{{ cleanupLoading ? '清理中…' : '清理过期数据' }}</span>
          <span class="ops-desc">释放过期订单锁定库存，禁用过期卡密</span>
        </button>
      </div>
      <p v-if="cleanupResult" class="maintenance-result">
        {{ cleanupResult }}
      </p>
    </section>

    <section class="card launch-check-card">
      <div class="card-header">
        <div>
          <h2 class="card-title">上线前检查</h2>
          <p class="launch-check-subtitle">正式开放前请完成远程门禁与真实链路验收；这里不自动标记通过，避免误判。</p>
        </div>
        <span class="launch-check-badge">人工确认</span>
      </div>
      <div class="launch-check-grid">
        <div class="launch-check-item">
          <span class="launch-check-dot" />
          <div>
            <strong>远程上线门禁</strong>
            <p><code>verify:launch</code> 必须在真实 Worker + libSQL 环境通过</p>
          </div>
        </div>
        <div class="launch-check-item">
          <span class="launch-check-dot" />
          <div>
            <strong>核心 smoke</strong>
            <p><code>smoke:readonly</code>、<code>smoke:write</code>、<code>smoke:ops</code>、<code>smoke:inventory</code> 覆盖下单与库存闭环</p>
          </div>
        </div>
        <div class="launch-check-item">
          <span class="launch-check-dot" />
          <div>
            <strong>真实小额支付</strong>
            <p>完成真实付款、回调、发卡、邮件投递和订单查询验收</p>
          </div>
        </div>
        <div class="launch-check-item">
          <span class="launch-check-dot" />
          <div>
            <strong>运维兜底</strong>
            <p>确认备份可读、操作日志可查、支付配置和系统配置已保存</p>
          </div>
        </div>
      </div>
      <div class="launch-check-actions">
        <button class="btn btn-primary btn-sm" type="button" @click="goToPayment">支付配置</button>
        <button class="btn btn-ghost btn-sm" type="button" @click="goToConfig">系统配置</button>
        <button class="btn btn-ghost btn-sm" type="button" @click="goToLogs">操作日志</button>
      </div>
    </section>

    <section class="card">
      <h2 class="card-title">今日运营</h2>
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-num">{{ summary.ordersToday }}</div>
          <div class="stat-label">今日订单</div>
        </div>
        <div class="stat-card">
          <div class="stat-num">{{ summary.issuedToday }}</div>
          <div class="stat-label">今日发卡</div>
        </div>
        <div class="stat-card">
          <div class="stat-num">{{ formatMoney(summary.todayIncomeCents, 'CNY') }}</div>
          <div class="stat-label">今日收入（CNY）</div>
        </div>
        <div class="stat-card">
          <div class="stat-num">{{ formatMoney(summary.totalIncomeCents, 'CNY') }}</div>
          <div class="stat-label">总收入（CNY）</div>
        </div>
      </div>
    </section>

    <section class="card">
      <h2 class="card-title">今日渠道收入</h2>
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-num">{{ formatMoney(summary.todayAlipayCents, 'CNY') }}</div>
          <div class="stat-label">历史其他渠道（CNY）</div>
        </div>
        <div class="stat-card">
          <div class="stat-num">{{ formatMoney(summary.todayEasyPayCents, 'CNY') }}</div>
          <div class="stat-label">易支付聚合（CNY）</div>
        </div>
      </div>
    </section>

    <section class="card income-card">
      <div class="card-header income-header">
        <h2 class="card-title">近 7 日收入</h2>
        <div class="income-total">
          <span>7 日合计</span>
          <strong>{{ formatMoney(weeklyIncomeCents, 'CNY') }}</strong>
        </div>
      </div>
      <div v-if="loading" class="skeleton-list">
        <div v-for="i in 7" :key="i" class="skeleton-line income-skeleton" />
      </div>
      <div v-else-if="dailyIncome.length === 0" class="empty-text">暂无数据</div>
      <div v-else class="income-trend" role="list" aria-label="近 7 日收入">
        <div v-for="row in incomeTrendRows" :key="row.date" class="income-row" role="listitem">
          <span class="income-date">{{ row.date }}</span>
          <span class="income-track" aria-hidden="true">
            <span class="income-bar" :style="{ width: row.barWidth }" />
          </span>
          <strong class="income-amount">{{ formatMoney(row.amountCents, 'CNY') }}</strong>
        </div>
      </div>
    </section>

    <section class="card">
      <div class="card-header">
        <h2 class="card-title">低库存预警</h2>
        <button class="btn btn-ghost btn-sm" @click="loadLowStock">刷新</button>
      </div>
      <div v-if="lowStockLoading" class="skeleton-list">
        <div v-for="i in 3" :key="i" class="skeleton-line w-40" />
      </div>
      <div v-else-if="lowStockProducts.length === 0" class="empty-text">暂无低库存商品</div>
      <table v-else class="admin-table" aria-label="低库存商品">
        <thead>
          <tr>
            <th>商品</th>
            <th>ID</th>
            <th>库存</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in lowStockProducts" :key="item.id">
            <td>{{ item.title }}</td>
            <td>{{ item.id }}</td>
            <td>{{ item.stock ?? '-' }}</td>
            <td>
              <button class="btn btn-ghost btn-xs" @click="goProducts">前往商品页</button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <ConfirmDialog v-model="confirmVisible" :message="confirmMessage" danger @confirm="onConfirm" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { fetchAdminSummary, fetchAdminLowStockProducts, fetchAdminPendingTasks, runAdminCleanup } from '@/api/admin'
import type { AdminSummary, DailyIncome, AdminLowStockProduct, AdminPendingTasks } from '@/types/admin'
import { useToast } from '@/composables/useToast'
import { useAdminAuth } from '@/composables/useAdminAuth'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import { normalizeCents } from '@/utils/currency'
import { formatMoney } from '@shared/money'
import ConfirmDialog from '@/components/ConfirmDialog.vue'

const { showToast } = useToast()
const { token } = useAdminAuth()
const router = useRouter()
const { confirmVisible, confirmMessage, askConfirm, onConfirm } = useConfirmDialog()

const summary = ref<AdminSummary>({
  products: 0,
  availableCards: 0,
  totalCards: 0,
  totalOrders: 0,
  pendingOrders: 0,
  lowStockCount: 0,
  ordersToday: 0,
  issuedToday: 0,
  totalIncomeCents: 0,
  todayIncomeCents: 0,
  todayAlipayCents: 0,
  todayEasyPayCents: 0,
})
const dailyIncome = ref<DailyIncome[]>([])
const loading = ref(true)
const summaryError = ref('')
const lowStockLoading = ref(false)
const cleanupLoading = ref(false)
const cleanupResult = ref('')
const lowStockProducts = ref<AdminLowStockProduct[]>([])
const pendingTasks = ref<AdminPendingTasks>({
  pendingOfflinePayments: [],
  paidButNotIssued: [],
  lowStockProducts: [],
})

const incomeTrendRows = computed(() => {
  const rows = dailyIncome.value.map((row) => ({
    ...row,
    amountCents: normalizeCents(row.amountCents),
  }))
  const maxCents = Math.max(0, ...rows.map((row) => row.amountCents))

  return rows.map((row) => ({
    ...row,
    barWidth: maxCents > 0 && row.amountCents > 0
      ? `${Math.max(2, (row.amountCents / maxCents) * 100)}%`
      : '0%',
  }))
})

const weeklyIncomeCents = computed(() => (
  incomeTrendRows.value.reduce((total, row) => total + row.amountCents, 0)
))

async function loadData() {
  loading.value = true
  summaryError.value = ''
  try {
    const res = await fetchAdminSummary(token.value)
    summary.value = res.summary
    dailyIncome.value = res.dailyIncome
  } catch (err: any) {
    summaryError.value = err.message || '加载概览失败'
    showToast(err.message || '加载概览失败', 'error')
  } finally {
    loading.value = false
  }
}

async function loadPendingTasks() {
  try {
    const tasks = await fetchAdminPendingTasks(token.value)
    pendingTasks.value = tasks
    // 如果低库存列表为空，自动加载低库存商品
    if (tasks.lowStockProducts.length > 0 && lowStockProducts.value.length === 0) {
      lowStockProducts.value = tasks.lowStockProducts
    }
  } catch (err: any) {
    showToast(err.message || '加载待处理任务失败', 'error')
  }
}

async function loadLowStock() {
  lowStockLoading.value = true
  try {
    const res = await fetchAdminLowStockProducts(token.value)
    lowStockProducts.value = res.products
  } catch (err: any) {
    showToast(err.message || '加载低库存失败', 'error')
  } finally {
    lowStockLoading.value = false
  }
}

function goProducts() {
  router.push('/admin/products')
}

function goToPendingOfflinePayments() {
  router.push({ path: '/admin/orders', query: { tab: 'pending', paymentMethod: 'offline' } })
}

function goToPaidButNotIssued() {
  router.push({ path: '/admin/orders', query: { tab: 'all', status: 'paid' } })
}

function goToLowStock() {
  router.push({ path: '/admin/products', query: { lowStock: 'true' } })
}

function goToBalance() {
  router.push('/admin/balance')
}

function goToLogs() {
  router.push('/admin/logs')
}

function goToConfig() {
  router.push('/admin/config')
}

function goToPayment() {
  router.push('/admin/payment')
}

async function runCleanup() {
  if (cleanupLoading.value) return
  cleanupLoading.value = true
  cleanupResult.value = ''
  try {
    const result = await runAdminCleanup(token.value)
    const deletedRows = Object.values(result.operationalData?.deleted || {}).reduce((sum, count) => sum + count, 0)
    const retentionResult = result.operationalData?.enabled ? `，清理运行数据 ${deletedRows}` : '，运行数据保留已暂停'
    cleanupResult.value = `清理完成：主动找回支付 ${result.reconciledPayments ?? 0}，过期订单 ${result.expiredOrders}，过期充值 ${result.expiredRechargeOrders ?? 0}，释放卡密 ${result.releasedCards}，禁用过期卡密 ${result.disabledExpiredCards ?? 0}${retentionResult}`
    showToast(result.message || '清理完成', 'success')
    await Promise.all([loadData(), loadPendingTasks(), loadLowStock()])
  } catch (err: any) {
    showToast(err.message || '清理失败', 'error')
  } finally {
    cleanupLoading.value = false
  }
}

async function confirmCleanup() {
  if (!(await askConfirm('确认清理过期数据？这会处理过期订单、释放锁定库存并禁用过期卡密。'))) return
  await runCleanup()
}

onMounted(() => {
  loadData()
  loadPendingTasks()
  if (summary.value.lowStockCount > 0) {
    loadLowStock()
  }
})
</script>

<style>
@import '@/assets/admin.css';
</style>

<style scoped>
.admin-dashboard {
  display: flex;
  flex-direction: column;
  gap: 20px;
  height: 100%;
  min-height: 0;
  overflow: auto;
}

.priority-strip {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.priority-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  border-radius: var(--r-lg, 12px);
  background: linear-gradient(180deg, rgba(59, 130, 246, 0.08), rgba(59, 130, 246, 0.03));
  border: 0.5px solid rgba(59, 130, 246, 0.14);
}

.priority-label {
  font-size: 12px;
  color: var(--tg-hint, #6b7280);
}

.priority-value {
  font-size: 26px;
  font-weight: 700;
  line-height: 1;
  color: var(--tg-text, #111827);
}

.priority-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--tg-text, #111827);
}

.admin-dashboard .toolbar {
  margin-bottom: 4px;
}

.toolbar-title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 12px;
}

.stat-card {
  background: var(--tg-bg, #fff);
  border-radius: var(--r-lg, 12px);
  padding: 14px 14px;
  text-align: center;
  border: 0.5px solid var(--border, #e5e7eb);
}

.stat-card--clickable {
  font: inherit;
  color: inherit;
  cursor: pointer;
  transition: transform 0.15s ease, border-color 0.2s ease, box-shadow 0.2s ease;
}
.stat-card--clickable:hover {
  transform: translateY(-1px);
  border-color: var(--tg-btn, #409eff);
  box-shadow: var(--shadow-sm, 0 4px 12px rgba(0, 0, 0, 0.08));
}

.stat-card--clickable:disabled {
  cursor: default;
  opacity: 0.72;
}

.stat-card--clickable:disabled:hover {
  transform: none;
  border-color: var(--border, #e5e7eb);
  box-shadow: none;
}

.stat-num {
  font-size: 28px;
  font-weight: 700;
  color: var(--tg-btn, #409eff);
}

.stat-label {
  margin-top: 6px;
  font-size: 13px;
  color: var(--tg-hint, #999);
}

.pending-tasks {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
}

.pending-task-item {
  width: 100%;
  font: inherit;
  color: inherit;
  background: var(--tg-bg, #fff);
  border-radius: var(--r-lg, 12px);
  padding: 14px 14px;
  text-align: center;
  border: 0.5px solid var(--border, #e5e7eb);
  cursor: pointer;
  transition: border-color 0.2s;
}

.pending-task-item:hover {
  border-color: var(--tg-btn, #409eff);
}

.pending-task-title {
  font-size: 13px;
  color: var(--tg-hint, #999);
  margin-bottom: 8px;
}

.pending-task-count {
  font-size: 28px;
  font-weight: 700;
  color: var(--tg-btn, #409eff);
}

.card {
  background: var(--tg-bg, #fff);
  border-radius: var(--r-lg, 12px);
  padding: 14px 14px;
  border: 0.5px solid var(--border, #e5e7eb);
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}

.card-title {
  margin: 0;
  font-size: 16px;
}

.card-hint {
  font-size: 12px;
  color: var(--tg-hint, #6b7280);
}

.ops-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px;
}

.ops-action {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 12px;
  border: 0.5px solid var(--border, #e5e7eb);
  border-radius: var(--r-lg, 12px);
  background: var(--tg-bg, #fff);
  color: var(--tg-text, #111827);
  text-align: left;
  cursor: pointer;
  transition: border-color 0.2s ease, transform 0.15s ease;
}

.ops-action:hover:not(:disabled) {
  border-color: var(--tg-btn, #409eff);
  transform: translateY(-1px);
}

.ops-action:disabled {
  cursor: wait;
  opacity: 0.65;
}

.ops-action--maintenance {
  background: rgba(59, 130, 246, 0.06);
}

.ops-title {
  font-size: 14px;
  font-weight: 600;
}

.ops-desc {
  font-size: 12px;
  color: var(--tg-hint, #6b7280);
  line-height: 1.45;
}

.maintenance-result {
  margin: 10px 0 0;
  color: var(--tg-hint, #6b7280);
  font-size: 13px;
}

.launch-check-card {
  border-color: rgba(245, 158, 11, 0.28);
  background: linear-gradient(180deg, rgba(245, 158, 11, 0.08), rgba(245, 158, 11, 0.025)), var(--tg-bg, #fff);
}

.launch-check-subtitle {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--tg-hint, #6b7280);
}

.launch-check-badge {
  flex: 0 0 auto;
  white-space: nowrap;
  padding: 4px 8px;
  border-radius: 999px;
  background: rgba(245, 158, 11, 0.16);
  color: #b45309;
  font-size: 12px;
  font-weight: 700;
}

.launch-check-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px;
}

.launch-check-item {
  display: flex;
  gap: 10px;
  padding: 12px;
  border: 0.5px solid rgba(245, 158, 11, 0.2);
  border-radius: var(--r-lg, 12px);
  background: var(--tg-secondary-bg, rgba(245, 158, 11, 0.06));
}

.launch-check-dot {
  width: 8px;
  height: 8px;
  margin-top: 6px;
  border-radius: 999px;
  background: #f59e0b;
  box-shadow: 0 0 0 4px rgba(245, 158, 11, 0.14);
}

.launch-check-item strong {
  display: block;
  font-size: 14px;
  color: var(--tg-text, #111827);
}

.launch-check-item p {
  margin: 5px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--tg-hint, #6b7280);
}

.launch-check-item code {
  color: var(--tg-text, #111827);
  font-weight: 700;
}

.launch-check-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.skeleton-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.skeleton-line {
  height: 14px;
  border-radius: 6px;
  background: var(--tg-secondary-bg, #f5f7fa);
}

.skeleton-line.w-40 {
  width: 40%;
}

.income-header {
  align-items: flex-start;
}

.income-total {
  display: flex;
  align-items: baseline;
  gap: 10px;
  color: var(--tg-hint, #6b7280);
  font-size: 12px;
}

.income-total strong {
  color: var(--tg-text, #111827);
  font-size: 17px;
  font-variant-numeric: tabular-nums;
}

.income-trend {
  border-top: 0.5px solid var(--border, #e5e7eb);
}

.income-row {
  display: grid;
  grid-template-columns: 56px minmax(80px, 1fr) minmax(90px, auto);
  align-items: center;
  gap: 14px;
  min-height: 44px;
  border-bottom: 0.5px solid var(--border, #e5e7eb);
}

.income-row:last-child {
  border-bottom: 0;
}

.income-date,
.income-amount {
  font-variant-numeric: tabular-nums;
}

.income-date {
  color: var(--tg-hint, #6b7280);
  font-size: 13px;
}

.income-track {
  height: 8px;
  overflow: hidden;
  border-radius: 4px;
  background: var(--tg-secondary-bg, #f3f4f6);
}

.income-bar {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--tg-btn, #409eff);
  transition: width 0.25s ease;
}

.income-amount {
  color: var(--tg-text, #111827);
  font-size: 13px;
  text-align: right;
}

.income-skeleton {
  width: 100%;
  height: 12px;
}

@media (max-width: 480px) {
  .income-row {
    grid-template-columns: 48px minmax(32px, 1fr) minmax(78px, auto);
    gap: 8px;
  }

  .income-total {
    gap: 6px;
  }

  .income-total strong {
    font-size: 15px;
  }

  .income-amount {
    font-size: 12px;
  }
}

/* ── 桌面断点 ── */
@media (min-width: 1024px) {
  .admin-dashboard {
    gap: 20px;
  }

  .stats-grid {
    grid-template-columns: repeat(5, 1fr);
    gap: 14px;
  }

  .stat-card {
    padding: var(--admin-card-pad, 14px);
  }

  .stat-num {
    font-size: 26px;
  }

  .stat-label {
    margin-top: 6px;
    font-size: 13px;
  }

  .pending-tasks {
    grid-template-columns: repeat(3, 1fr);
    gap: 14px;
  }

  .pending-task-item {
    padding: var(--admin-card-pad, 14px);
  }

  .card {
    padding: var(--admin-card-pad, 14px);
  }

  .card-header {
    margin-bottom: 12px;
  }
}
</style>
