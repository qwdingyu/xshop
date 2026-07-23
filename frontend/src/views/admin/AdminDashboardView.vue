<template>
  <div class="admin-dashboard admin-page">
    <div class="toolbar">
      <h2 class="toolbar-title">运营台</h2>
    </div>

    <div v-if="summaryError" class="table-error" role="alert">
      <span>{{ summaryError }}</span>
      <button class="btn btn-ghost btn-xs" :disabled="loading" @click="loadData">重新加载</button>
    </div>

    <section class="priority-board" aria-label="优先事项">
      <div class="priority-board-head">
        <div>
          <h2 class="priority-board-title">优先事项</h2>
          <p class="priority-board-subtitle">
            按紧急程度：先确认线下到账，再完成已付履约，最后补低库存。统计含跨日未结清项。
          </p>
        </div>
        <div class="priority-board-meta">
          <button
            type="button"
            class="btn btn-ghost btn-xs"
            :disabled="pendingLoading || loading"
            @click="refreshDashboard"
          >
            {{ pendingLoading || loading ? '刷新中…' : '刷新' }}
          </button>
          <span
            class="priority-board-total"
            :class="{ 'priority-board-total--hot': hasAnyPending }"
          >
            {{ pendingTotalLabel }}
          </span>
        </div>
      </div>

      <div v-if="pendingError" class="priority-board-error" role="alert">
        <span>{{ pendingError }}</span>
        <button class="btn btn-ghost btn-xs" type="button" :disabled="pendingLoading" @click="loadPendingTasks">
          重试
        </button>
      </div>

      <div class="priority-strip" :aria-busy="pendingLoading">
        <button
          v-for="item in priorityItems"
          :key="item.id"
          type="button"
          class="priority-card"
          :class="[
            item.toneClass,
            item.count === 0 ? 'priority-card--empty' : 'priority-card--hot',
            { 'priority-card--loading': pendingLoading },
          ]"
          :disabled="pendingLoading"
          @click="item.go"
        >
          <div class="priority-card-top">
            <span class="priority-step">{{ item.step }}</span>
            <span class="priority-label">{{ item.label }}</span>
            <span v-if="item.countCap" class="priority-cap" title="列表最多展示 50 条">最多 50</span>
          </div>
          <div class="priority-value" :class="{ 'priority-value--muted': item.count === 0 }">
            <template v-if="pendingLoading">—</template>
            <template v-else>{{ item.countLabel }}</template>
          </div>
          <div class="priority-title">{{ item.title }}</div>
          <p class="priority-hint">{{ item.hint }}</p>
          <span class="priority-action">{{ item.actionLabel }}</span>
        </button>
      </div>
    </section>

    <section class="stats-grid" aria-label="经营概览">
      <div class="stat-card">
        <div class="stat-num">{{ loading ? '—' : summary.products }}</div>
        <div class="stat-label">上架商品</div>
      </div>
      <div class="stat-card">
        <div class="stat-num">{{ loading ? '—' : summary.availableCards }}</div>
        <div class="stat-label">可用卡密</div>
      </div>
      <div class="stat-card">
        <div class="stat-num">{{ loading ? '—' : summary.totalOrders }}</div>
        <div class="stat-label">总订单</div>
      </div>
      <div class="stat-card">
        <div class="stat-num">{{ loading ? '—' : summary.pendingOrders }}</div>
        <div class="stat-label">待处理订单</div>
      </div>
      <button
        type="button"
        class="stat-card stat-card--clickable"
        :disabled="loading || summary.lowStockCount === 0"
        @click="scrollToLowStock"
      >
        <div class="stat-num">{{ loading ? '—' : summary.lowStockCount }}</div>
        <div class="stat-label">低库存预警</div>
      </button>
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

    <section ref="lowStockSectionEl" class="card" id="low-stock-panel">
      <div class="card-header">
        <h2 class="card-title">低库存预警</h2>
        <div class="card-header-actions">
          <button class="btn btn-ghost btn-sm" type="button" :disabled="lowStockLoading" @click="loadLowStock">
            {{ lowStockLoading ? '刷新中…' : '刷新' }}
          </button>
          <button class="btn btn-ghost btn-sm" type="button" @click="goToLowStock">商品页筛选</button>
        </div>
      </div>
      <div v-if="lowStockLoading || pendingLoading" class="skeleton-list">
        <div v-for="i in 3" :key="i" class="skeleton-line w-40" />
      </div>
      <div v-else-if="pendingError && lowStockProducts.length === 0" class="empty-text">
        待办加载失败，低库存未同步。可点上方重试，或点本区「刷新」。
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
            <td class="mono-cell">{{ item.id }}</td>
            <td>
              <span class="stock-badge" :class="{ 'stock-badge--zero': Number(item.stock) === 0 }">
                {{ item.stock ?? '-' }}
              </span>
            </td>
            <td>
              <button class="btn btn-ghost btn-xs" type="button" @click="goProducts">前往商品页</button>
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

/** 与 getTodayPendingTasks 中 order 列表 limit 保持一致 */
const PENDING_ORDER_LIST_CAP = 50

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
const pendingLoading = ref(true)
const pendingError = ref('')
const lowStockLoading = ref(false)
const cleanupLoading = ref(false)
const cleanupResult = ref('')
const lowStockProducts = ref<AdminLowStockProduct[]>([])
const lowStockSectionEl = ref<HTMLElement | null>(null)
const pendingTasks = ref<AdminPendingTasks>({
  pendingOfflinePayments: [],
  paidButNotIssued: [],
  lowStockProducts: [],
})

function formatCappedCount(count: number, capped: boolean): string {
  if (capped && count >= PENDING_ORDER_LIST_CAP) return `${PENDING_ORDER_LIST_CAP}+`
  return String(count)
}

const offlinePendingCount = computed(() => pendingTasks.value.pendingOfflinePayments.length)
const paidPendingCount = computed(() => pendingTasks.value.paidButNotIssued.length)
const lowStockPendingCount = computed(() => pendingTasks.value.lowStockProducts.length)
const offlineCapped = computed(() => offlinePendingCount.value >= PENDING_ORDER_LIST_CAP)
const paidCapped = computed(() => paidPendingCount.value >= PENDING_ORDER_LIST_CAP)
const hasAnyPending = computed(() => (
  offlinePendingCount.value > 0 || paidPendingCount.value > 0 || lowStockPendingCount.value > 0
))

const pendingTotalLabel = computed(() => {
  if (pendingLoading.value) return '加载中…'
  if (!hasAnyPending.value) return '暂无待办'
  const parts: string[] = []
  if (offlinePendingCount.value > 0) {
    parts.push(`线下 ${formatCappedCount(offlinePendingCount.value, offlineCapped.value)}`)
  }
  if (paidPendingCount.value > 0) {
    parts.push(`已付未发 ${formatCappedCount(paidPendingCount.value, paidCapped.value)}`)
  }
  if (lowStockPendingCount.value > 0) {
    parts.push(`低库存 ${lowStockPendingCount.value}`)
  }
  return parts.join(' · ')
})

const priorityItems = computed(() => [
  {
    id: 'offline',
    step: 1,
    label: '先处理',
    title: '待确认线下付款',
    hint: 'status=pending 且线下支付；跨日未确认也会出现在这里。',
    count: offlinePendingCount.value,
    countCap: offlineCapped.value,
    countLabel: formatCappedCount(offlinePendingCount.value, offlineCapped.value),
    actionLabel: offlinePendingCount.value > 0 ? '去处理 →' : '查看订单',
    toneClass: 'priority-card--p1',
    go: goToPendingOfflinePayments,
  },
  {
    id: 'paid',
    step: 2,
    label: '再处理',
    title: '已付未发卡',
    hint: 'status=paid、尚未交付完成；跨日积压订单同样需要处理。',
    count: paidPendingCount.value,
    countCap: paidCapped.value,
    countLabel: formatCappedCount(paidPendingCount.value, paidCapped.value),
    actionLabel: paidPendingCount.value > 0 ? '去处理 →' : '查看订单',
    toneClass: 'priority-card--p2',
    go: goToPaidButNotIssued,
  },
  {
    id: 'stock',
    step: 3,
    label: '别忘了',
    title: '低库存商品',
    hint: '在售卡密商品可用库存低于预警阈值；与下方列表同源。',
    count: lowStockPendingCount.value,
    countCap: false,
    countLabel: String(lowStockPendingCount.value),
    actionLabel: lowStockPendingCount.value > 0 ? '去补货 →' : '查看商品',
    toneClass: 'priority-card--p3',
    go: goToLowStock,
  },
])

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
  pendingLoading.value = true
  pendingError.value = ''
  try {
    const tasks = await fetchAdminPendingTasks(token.value)
    pendingTasks.value = tasks
    // 优先事项与低库存表同源：待办接口已带低库存列表，直接回填，避免二次请求与挂载竞态。
    lowStockProducts.value = tasks.lowStockProducts
  } catch (err: any) {
    pendingError.value = err.message || '加载待处理任务失败'
    showToast(pendingError.value, 'error')
  } finally {
    pendingLoading.value = false
  }
}

async function loadLowStock() {
  lowStockLoading.value = true
  try {
    const res = await fetchAdminLowStockProducts(token.value)
    lowStockProducts.value = res.products
    // 与优先事项计数对齐
    pendingTasks.value = {
      ...pendingTasks.value,
      lowStockProducts: res.products,
    }
  } catch (err: any) {
    showToast(err.message || '加载低库存失败', 'error')
  } finally {
    lowStockLoading.value = false
  }
}

async function refreshDashboard() {
  await Promise.all([loadData(), loadPendingTasks()])
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

function scrollToLowStock() {
  if (lowStockProducts.value.length === 0 && summary.value.lowStockCount > 0) {
    void loadLowStock()
  }
  lowStockSectionEl.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
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
    await Promise.all([loadData(), loadPendingTasks()])
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
  void refreshDashboard()
})
</script>

<style>
@import '@/assets/admin.css';
</style>

<style scoped>
.admin-dashboard {
  display: flex;
  flex-direction: column;
  /* 区块间距与全站 stack token 对齐（略大于列表页 8/10，用 card-gap 作仪表盘段落） */
  gap: var(--admin-card-gap, 12px);
  height: 100%;
  min-height: 0;
  overflow: auto;
}

.priority-board {
  display: flex;
  flex-direction: column;
  gap: var(--admin-card-gap, 12px);
  padding: var(--admin-card-pad, 12px);
  border-radius: var(--r-lg, 12px);
  border: 1px solid var(--border, rgba(148, 163, 184, 0.22));
  background: var(--tg-secondary-bg, #151b28);
}

.priority-board-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.priority-board-title {
  margin: 0;
  font-size: 16px;
  font-weight: 650;
  color: var(--tg-text, #f0f2f5);
}

.priority-board-subtitle {
  margin: 4px 0 0;
  max-width: 52ch;
  font-size: 12px;
  line-height: 1.5;
  color: var(--tg-hint, #9aa4b2);
}

.priority-board-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}

.priority-board-total {
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 650;
  color: var(--tg-hint, #9aa4b2);
  background: rgba(148, 163, 184, 0.12);
  white-space: nowrap;
}

.priority-board-total--hot {
  color: #fbbf24;
  background: rgba(245, 158, 11, 0.16);
}

.priority-board-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 0.5px solid rgba(239, 68, 68, 0.35);
  background: rgba(239, 68, 68, 0.1);
  color: #fca5a5;
  font-size: 12px;
}

.priority-strip {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.priority-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 172px;
  padding: 14px;
  border-radius: var(--r-lg, 12px);
  border: 0.5px solid transparent;
  text-align: left;
  font: inherit;
  color: inherit;
  cursor: pointer;
  transition: transform 0.15s ease, border-color 0.2s ease, box-shadow 0.2s ease, opacity 0.2s ease;
}

.priority-card:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.22);
}

.priority-card:focus-visible {
  outline: 2px solid var(--admin-accent, #f59e0b);
  outline-offset: 2px;
}

.priority-card:disabled {
  cursor: wait;
}

.priority-card--loading {
  opacity: 0.72;
}

.priority-card--p1 {
  background: linear-gradient(180deg, rgba(239, 68, 68, 0.16), rgba(239, 68, 68, 0.05));
  border-color: rgba(239, 68, 68, 0.28);
}

.priority-card--p2 {
  background: linear-gradient(180deg, rgba(245, 158, 11, 0.16), rgba(245, 158, 11, 0.05));
  border-color: rgba(245, 158, 11, 0.28);
}

.priority-card--p3 {
  background: linear-gradient(
    180deg,
    var(--admin-accent-soft, rgba(245, 158, 11, 0.16)),
    rgba(245, 158, 11, 0.05)
  );
  border-color: var(--admin-accent-border, rgba(245, 158, 11, 0.28));
}

.priority-card--empty {
  opacity: 0.72;
}

.priority-card--hot {
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.04);
}

.priority-card-top {
  display: flex;
  align-items: center;
  gap: 8px;
}

.priority-step {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  color: var(--tg-text, #f0f2f5);
  background: #6b7280;
}

.priority-card--p1 .priority-step {
  background: #dc2626;
}

.priority-card--p2 .priority-step {
  background: #d97706;
}

.priority-card--p3 .priority-step {
  background: var(--admin-accent, #f59e0b);
}

.priority-label {
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0.02em;
  color: var(--tg-hint, #9aa4b2);
}

.priority-card--p1 .priority-label {
  color: #fca5a5;
}

.priority-card--p2 .priority-label {
  color: #fcd34d;
}

.priority-card--p3 .priority-label {
  color: var(--admin-accent-text, #fbbf24);
}

.priority-cap {
  margin-left: auto;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 650;
  color: var(--tg-hint, #9aa4b2);
  background: rgba(148, 163, 184, 0.14);
}

.priority-value {
  margin-top: 4px;
  font-size: 30px;
  font-weight: 750;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--tg-text, #f0f2f5);
}

.priority-value--muted {
  color: var(--tg-hint, #9aa4b2);
}

.priority-title {
  font-size: 14px;
  font-weight: 650;
  color: var(--tg-text, #f0f2f5);
}

.priority-hint {
  margin: 0;
  flex: 1;
  font-size: 12px;
  line-height: 1.45;
  color: var(--tg-hint, #9aa4b2);
}

.priority-action {
  margin-top: 4px;
  font-size: 12px;
  font-weight: 650;
  color: var(--admin-accent-text, #fbbf24);
}

.priority-card--p1 .priority-action {
  color: #f87171;
}

.priority-card--p2 .priority-action {
  color: #fbbf24;
}

.priority-card--p3 .priority-action {
  color: var(--admin-accent-text, #fbbf24);
}

.card-header-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* mono-cell → admin.css */

.stock-badge {
  display: inline-flex;
  min-width: 2ch;
  font-variant-numeric: tabular-nums;
  font-weight: 650;
}

.stock-badge--zero {
  color: #f87171;
}

@media (max-width: 820px) {
  .priority-board-head {
    flex-direction: column;
  }

  .priority-board-meta {
    width: 100%;
    justify-content: space-between;
  }

  .priority-strip {
    grid-template-columns: 1fr;
  }

  .priority-card {
    min-height: 0;
  }
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
  gap: var(--admin-card-gap, 12px);
}

.stat-card {
  background: var(--tg-secondary-bg, #151b28);
  border-radius: var(--r-lg, 12px);
  padding: var(--admin-card-pad, 12px);
  text-align: center;
  border: 1px solid var(--border, rgba(148, 163, 184, 0.22));
}

.stat-card--clickable {
  font: inherit;
  color: inherit;
  cursor: pointer;
  transition: transform 0.15s ease, border-color 0.2s ease, box-shadow 0.2s ease;
}
.stat-card--clickable:hover {
  transform: translateY(-1px);
  border-color: var(--admin-accent, #f59e0b);
  box-shadow: var(--shadow-sm, 0 4px 12px rgba(0, 0, 0, 0.22));
}

.stat-card--clickable:disabled {
  cursor: default;
  opacity: 0.72;
}

.stat-card--clickable:disabled:hover {
  transform: none;
  border-color: var(--border, rgba(148, 163, 184, 0.22));
  box-shadow: none;
}

.stat-num {
  font-size: 28px;
  font-weight: 700;
  color: var(--admin-accent-text, #fbbf24);
}

.stat-label {
  margin-top: 6px;
  font-size: 13px;
  color: var(--tg-hint, #9aa4b2);
}

.card {
  background: var(--tg-secondary-bg, #151b28);
  border-radius: var(--r-lg, 12px);
  padding: var(--admin-card-pad, 12px);
  border: 1px solid var(--border, rgba(148, 163, 184, 0.22));
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--admin-stack-gap, 8px);
}

.card-title {
  margin: 0;
  font-size: 16px;
}

.card-hint {
  font-size: 12px;
  color: var(--tg-hint, #9aa4b2);
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
  border: 1px solid var(--border, rgba(148, 163, 184, 0.22));
  border-radius: var(--r-lg, 12px);
  background: var(--tg-bg, #0a0e17);
  color: var(--tg-text, #f0f2f5);
  text-align: left;
  cursor: pointer;
  transition: border-color 0.2s ease, transform 0.15s ease;
}

.ops-action:hover:not(:disabled) {
  border-color: var(--admin-accent-border, rgba(245, 158, 11, 0.38));
  transform: translateY(-1px);
}

.ops-action:disabled {
  cursor: wait;
  opacity: 0.65;
}

.ops-action--maintenance {
  background: var(--admin-accent-soft, rgba(245, 158, 11, 0.1));
  border-color: var(--admin-accent-border, rgba(245, 158, 11, 0.28));
}

.ops-title {
  font-size: 14px;
  font-weight: 600;
}

.ops-desc {
  font-size: 12px;
  color: var(--tg-hint, #9aa4b2);
  line-height: 1.45;
}

.maintenance-result {
  margin: 10px 0 0;
  color: var(--tg-hint, #9aa4b2);
  font-size: 13px;
}

.launch-check-card {
  border-color: rgba(245, 158, 11, 0.28);
  background: linear-gradient(180deg, rgba(245, 158, 11, 0.08), rgba(245, 158, 11, 0.025)), var(--tg-secondary-bg, #151b28);
}

.launch-check-subtitle {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--tg-hint, #9aa4b2);
}

.launch-check-badge {
  flex: 0 0 auto;
  white-space: nowrap;
  padding: 4px 8px;
  border-radius: 999px;
  background: rgba(245, 158, 11, 0.16);
  color: #fbbf24;
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
  color: var(--tg-text, #f0f2f5);
}

.launch-check-item p {
  margin: 5px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--tg-hint, #9aa4b2);
}

.launch-check-item code {
  color: var(--tg-text, #f0f2f5);
  font-weight: 700;
}

.launch-check-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

/* skeleton-list / skeleton-line / w-40 → admin.css */

.income-header {
  align-items: flex-start;
}

.income-total {
  display: flex;
  align-items: baseline;
  gap: 10px;
  color: var(--tg-hint, #9aa4b2);
  font-size: 12px;
}

.income-total strong {
  color: var(--tg-text, #f0f2f5);
  font-size: 17px;
  font-variant-numeric: tabular-nums;
}

.income-trend {
  border-top: 0.5px solid var(--border, rgba(148, 163, 184, 0.22));
}

.income-row {
  display: grid;
  grid-template-columns: 56px minmax(80px, 1fr) minmax(90px, auto);
  align-items: center;
  gap: 14px;
  min-height: 44px;
  border-bottom: 1px solid var(--border, rgba(148, 163, 184, 0.22));
}

.income-row:last-child {
  border-bottom: 0;
}

.income-date,
.income-amount {
  font-variant-numeric: tabular-nums;
}

.income-date {
  color: var(--tg-hint, #9aa4b2);
  font-size: 13px;
}

.income-track {
  height: 8px;
  overflow: hidden;
  border-radius: 4px;
  background: rgba(148, 163, 184, 0.14);
}

.income-bar {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--admin-accent, #f59e0b);
  transition: width 0.25s ease;
}

.income-amount {
  color: var(--tg-text, #f0f2f5);
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
  /* 间距继续走 --admin-card-gap，勿硬编码放大 */

  .stats-grid {
    grid-template-columns: repeat(5, 1fr);
    gap: var(--admin-card-gap, 12px);
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

  .card {
    padding: var(--admin-card-pad, 14px);
  }

  .card-header {
    margin-bottom: var(--admin-stack-gap, 8px);
  }
}
</style>
