<template>
  <div class="admin-page">
    <div class="tabs" role="tablist" aria-label="订单视图">
      <button
        type="button"
        class="tab"
        role="tab"
        :aria-selected="activeTab === 'all'"
        :class="{ active: activeTab === 'all' }"
        @click="switchTab('all')"
      >
        全部订单
      </button>
      <button
        type="button"
        class="tab"
        role="tab"
        :aria-selected="activeTab === 'pending'"
        :class="{ active: activeTab === 'pending' }"
        @click="switchTab('pending')"
      >
        待收款
      </button>
      <button
        type="button"
        class="tab"
        role="tab"
        :aria-selected="activeTab === 'paid'"
        :class="{ active: activeTab === 'paid' }"
        @click="switchTab('paid')"
      >
        待交付
      </button>
      <button
        type="button"
        class="tab"
        role="tab"
        :aria-selected="activeTab === 'abnormal'"
        :class="{ active: activeTab === 'abnormal' }"
        @click="switchTab('abnormal')"
      >
        售后异常
      </button>
    </div>
    <p class="tab-hint">{{ tabHint }}</p>
    <div class="toolbar">
      <div class="filters">
        <select v-model="filter.status" aria-label="订单状态" @change="searchData">
          <option value="">全部状态</option>
          <option value="pending">待支付</option>
          <option value="paid">已支付</option>
          <option value="issued">已发货</option>
          <option value="expired">已过期</option>
          <option value="failed">失败</option>
          <option value="canceled">已取消</option>
          <option value="closed">已关闭</option>
          <option value="refunded">已退款</option>
        </select>
        <AdminProductSelect v-model="filter.productId" aria-label="订单商品" @change="searchData" />
        <select v-model="filter.orderSource" aria-label="订单来源" @change="searchData">
          <option value="">全部来源</option>
          <option value="storefront">商品主页</option>
          <option value="coupon_redeem">全额优惠码兑换</option>
          <option value="telegram">Telegram</option>
        </select>
        <select v-model="filter.storefrontId" aria-label="展示渠道" @change="searchData">
          <option value="">全部渠道</option>
          <option v-for="storefront in storefronts" :key="storefront.id" :value="storefront.id">{{ storefront.name }}</option>
        </select>
        <input v-model="filter.q" type="search" placeholder="订单号/联系人" aria-label="搜索订单号或联系人" @keyup.enter="searchData" />
        <select v-model="filter.paymentMethod" aria-label="支付方式" @change="searchData">
          <option value="">全部支付方式</option>
          <option value="online">在线</option>
          <option value="offline">线下</option>
          <option value="balance">余额</option>
        </select>
        <button class="btn btn-primary btn-sm" :disabled="loading" @click="searchData">
          {{ loading ? '查询中…' : '查询' }}
        </button>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-ghost btn-sm" @click="exportCsv">导出 CSV</button>
        <button class="btn btn-ghost btn-sm" @click="exportFinance">导出财务</button>
        <button class="btn btn-ghost btn-sm" :disabled="notifying" @click="notifyLowStock">
          {{ notifying ? '发送中...' : '发送低库存邮件' }}
        </button>
      </div>
    </div>

    <div class="table-command-bar">
      <div class="action-strip">
        <button class="action-chip" @click="switchTab('pending')">
          待收款 {{ items.filter((item) => item.status === 'pending').length }}
        </button>
        <button class="action-chip" @click="switchTab('paid')">
          待交付 {{ items.filter((item) => item.status === 'paid').length }}
        </button>
        <button class="action-chip" @click="switchTab('abnormal')">
          售后异常 {{ items.filter((item) => ABNORMAL_ORDER_STATUS_SET.has(normalizeOrderStatus(item.status))).length }}
        </button>
      </div>
      <div v-if="selectedCount > 0" class="table-command-actions" role="status" aria-live="polite" :aria-busy="loading || batchOperating">
        <span class="selection-summary">
          {{ batchOperating
            ? `处理中 ${batchCompleted}/${batchTotal}`
            : `已选 ${selectedCount} 个（默认可删 ${selectedSafeDeletableOrders.length}；勾选「全部删除」可扩范围）` }}
        </span>
        <button class="btn btn-ghost btn-sm" :disabled="loading || batchOperating" @click="clearSelection">清空</button>
        <button class="btn btn-ghost btn-sm" :disabled="loading || batchOperating" @click="copySelectedOrders">复制所选</button>
        <button class="btn btn-ghost btn-sm" :disabled="loading || batchOperating" @click="exportSelectedCsv">导出已选</button>
        <button class="btn btn-primary btn-sm" :disabled="loading || batchOperating" @click="batchResendEmail">批量重发邮件</button>
        <button class="btn btn-danger btn-sm" :disabled="loading || batchOperating || selectedCancelableOrders.length === 0" @click="batchCancelPending">
          取消待支付（{{ selectedCancelableOrders.length }}）
        </button>
        <button class="btn btn-danger btn-sm" :disabled="loading || batchOperating || selectedCount === 0" @click="batchRemoveOrders">
          批量删除（{{ selectedCount }}）
        </button>
      </div>
    </div>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" :disabled="loading" @click="loadData">重新加载</button>
    </div>

    <div class="table-wrap" role="region" aria-label="订单表格滚动区域" tabindex="0" :aria-busy="loading">
      <table class="admin-table" aria-label="订单列表">
        <thead>
          <tr>
            <th class="select-cell">
              <input
                type="checkbox"
                :checked="allVisibleSelected"
                :indeterminate.prop="partiallySelected"
                :disabled="selectableCount === 0 || loading || batchOperating"
                aria-label="选择当前页订单"
                @change="toggleAllVisible(($event.target as HTMLInputElement).checked)"
              />
            </th>
            <th>订单号</th>
            <th>商品</th>
            <th>来源</th>
            <th>金额</th>
            <th>状态</th>
            <th>支付方式</th>
            <th>联系人</th>
            <th>创建时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="i in 5" :key="'sk' + i" class="skeleton-row">
            <td :colspan="10"><div class="skeleton-cell" /></td>
          </tr>
        </tbody>
        <tbody v-else>
          <tr v-for="item in items" :key="item.id" :class="{ 'is-selected': isSelected(item.id) }">
            <td class="select-cell">
              <input
                type="checkbox"
                :checked="isSelected(item.id)"
                :disabled="loading || batchOperating"
                :aria-label="`选择订单 ${item.orderNo || item.id}`"
                @click="setSelected(item.id, ($event.target as HTMLInputElement).checked, $event.shiftKey)"
              />
            </td>
            <td>{{ item.orderNo }}</td>
            <td>{{ item.productTitle || item.productId }}</td>
            <td>
              <span>{{ orderSourceText(item) }}</span>
              <div v-if="item.orderSource === 'storefront'" class="muted-text">{{ storefrontSnapshotText(item) }}</div>
            </td>
            <td>{{ formatOrderMoney(item.amountCents ?? 0, item.currency) }}</td>
            <td>
              <span class="tag" :class="statusClass(item.status)">{{ statusText(item.status) }}</span>
            </td>
            <td>{{ item.paymentMethod || '-' }}</td>
            <td>
              <span v-if="item.buyerEmail" class="tag tag-muted" style="margin-right:4px">{{ item.buyerEmail }}</span>
              <span>{{ item.buyerContact || '-' }}</span>
            </td>
            <td>{{ formatDate(item.createdAt) }}</td>
            <td>
              <div class="table-actions">
                <button class="btn btn-ghost btn-xs" @click="viewDetail(item)">详情</button>
                <button
                  v-if="canManualConfirmPayment(item)"
                  class="btn btn-primary btn-xs"
                  :disabled="markingPaidId === item.id || cancelingId === item.id"
                  @click="markPaid(item.id)"
                >
                  {{ markingPaidId === item.id ? '标记中…' : '标记已付' }}
                </button>
                <button
                  v-if="item.status === 'pending'"
                  class="btn btn-danger btn-xs"
                  :disabled="markingPaidId === item.id || cancelingId === item.id"
                  @click="cancel(item.id)"
                >
                  {{ cancelingId === item.id ? '取消中…' : '取消' }}
                </button>
                <button
                  v-if="item.status === 'paid'"
                  class="btn btn-primary btn-xs"
                  :disabled="retryingFulfillmentId === item.id"
                  @click="retryFulfillment(item.id)"
                >
                  {{ retryingFulfillmentId === item.id ? '重试中…' : '重试交付' }}
                </button>
                <button
                  class="btn btn-ghost btn-xs"
                  @click="openCustomerServiceMenu(item.id)"
                >
                  客服
                </button>
              </div>
            </td>
          </tr>
          <tr v-if="items.length === 0">
            <td colspan="10" class="empty-text">暂无订单</td>
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

    <AdminModal v-model="detailVisible" title="订单详情" max-width="640px">
      <div v-if="currentOrder" class="detail-box">
        <div class="detail-section">
          <div class="detail-title">订单信息</div>
          <div class="detail-row"><span class="detail-label">订单号</span><span class="detail-value">{{ currentOrder.orderNo }}</span></div>
          <div class="detail-row"><span class="detail-label">商品</span><span class="detail-value">{{ currentOrder.productTitle || currentOrder.productId }}</span></div>
          <div class="detail-row"><span class="detail-label">订单来源</span><span class="detail-value">{{ orderSourceText(currentOrder) }}</span></div>
          <div v-if="currentOrder.orderSource === 'storefront'" class="detail-row"><span class="detail-label">渠道快照</span><span class="detail-value">{{ storefrontSnapshotText(currentOrder) }}</span></div>
          <div v-if="currentOrder.storefrontId" class="detail-row"><span class="detail-label">渠道 ID</span><span class="detail-value">{{ currentOrder.storefrontId }}</span></div>
          <div class="detail-row"><span class="detail-label">数量</span><span class="detail-value">{{ currentOrder.quantity || 1 }}</span></div>
          <div class="detail-row"><span class="detail-label">金额</span><span class="detail-value">{{ formatOrderMoney(currentOrder.amountCents ?? 0, currentOrder.currency) }}</span></div>
          <div class="detail-row"><span class="detail-label">状态</span><span class="detail-value">{{ statusText(currentOrder.status) }}</span></div>
          <div class="detail-row"><span class="detail-label">支付方式</span><span class="detail-value">{{ currentOrder.paymentMethod || '-' }}</span></div>
          <div class="detail-row"><span class="detail-label">支付流水</span><span class="detail-value">{{ currentOrder.paymentRef || '-' }}</span></div>
          <div class="detail-row"><span class="detail-label">创建时间</span><span class="detail-value">{{ formatDate(currentOrder.createdAt) }}</span></div>
          <div class="detail-row"><span class="detail-label">支付时间</span><span class="detail-value">{{ formatDate(currentOrder.paidAt) }}</span></div>
          <div class="detail-row"><span class="detail-label">发货时间</span><span class="detail-value">{{ formatDate(currentOrder.issuedAt) }}</span></div>
          <div class="detail-row"><span class="detail-label">IP 标识（哈希）</span><span class="detail-value">{{ currentOrder.ipHash || '-' }}</span></div>
          <div class="detail-row"><span class="detail-label">User Agent</span><span class="detail-value">{{ currentOrder.userAgent || '-' }}</span></div>
        </div>

        <div class="detail-section">
          <div class="detail-title">买家信息</div>
          <div class="detail-row"><span class="detail-label">邮箱</span><span class="detail-value">{{ currentOrder.buyerEmail || '-' }}</span></div>
          <div class="detail-row"><span class="detail-label">联系人</span><span class="detail-value">{{ currentOrder.buyerContact || '-' }}</span></div>
        </div>

        <div class="detail-section" v-if="currentOrder.fulfillmentInput">
          <div class="detail-title">履约信息</div>
          <div class="detail-row">
            <span class="detail-label">{{ currentOrder.fulfillmentInput.label }}</span>
            <span class="detail-value">{{ currentOrder.fulfillmentInput.value }}</span>
          </div>
          <div class="detail-actions">
            <button class="btn btn-ghost btn-sm" type="button" @click="copyFulfillmentInput">复制履约信息</button>
          </div>
        </div>

        <div class="detail-section" v-if="currentOrder.items && currentOrder.items.length">
          <div class="detail-title">订单明细</div>
          <div class="detail-row" v-for="item in currentOrder.items" :key="item.id">
            <span class="detail-label">{{ item.productTitle || item.productId }}</span>
            <span class="detail-value">x{{ item.quantity }} · {{ formatOrderMoney(item.amountCents, currentOrder.currency) }}</span>
          </div>
        </div>

        <div class="detail-section" v-if="hasOrderDelivery">
          <div class="detail-title">交付内容</div>
          <DeliveryInfo :delivery="currentOrder.delivery" :cards="currentOrder.cards" :fulfillment-mode="currentOrderFulfillmentMode" />
          <div class="detail-actions">
            <button v-if="deliveryCopyText" class="btn btn-ghost btn-sm" @click="copyDelivery($event)">复制交付内容</button>
          </div>
        </div>
        <div class="detail-section" v-if="currentOrder.cards && currentOrder.cards.length > 1">
          <div class="detail-title">卡密列表</div>
          <div class="detail-row" v-for="(card, index) in currentOrder.cards" :key="card.id || index">
            <span class="detail-label">卡密 #{{ index + 1 }}</span>
            <span class="detail-value">{{ card.cardData || card.deliverySecret || '-' }}</span>
          </div>
        </div>

        <div class="detail-section" v-if="currentOrder.events && currentOrder.events.length">
          <div class="detail-title">订单事件（最近 50 条）</div>
          <div class="detail-row" v-for="event in currentOrder.events" :key="event.id">
            <span class="detail-label">{{ formatDate(event.createdAt) }}</span>
            <span class="detail-value event-value">
              <span class="tag" :class="eventTypeClass(event.type)">{{ eventTypeText(event.type) }}</span>
              <span>{{ event.message || '-' }}</span>
            </span>
          </div>
        </div>

        <div class="detail-actions">
          <button
            v-if="currentOrder.status === 'paid'"
            class="btn btn-primary btn-sm"
            :disabled="retryingFulfillmentId === currentOrder.id"
            @click="retryFulfillment(currentOrder.id)"
          >
            {{ retryingFulfillmentId === currentOrder.id ? '重试中…' : '重试交付' }}
          </button>
          <button v-if="currentOrder.status === 'paid'" class="btn btn-ghost btn-sm" @click="openFulfillmentProgressDialog(currentOrder.id)">履约进度</button>
          <button class="btn btn-primary btn-sm" :disabled="resendingEmailId === currentOrder.id" @click="resendEmail(currentOrder.id)">
            {{ resendingEmailId === currentOrder.id ? '重发中…' : '重发邮件' }}
          </button>
          <button class="btn btn-ghost btn-sm" :disabled="savingCompensation" @click="openCompensationDialog(currentOrder.id)">补偿备注</button>
        </div>
      </div>
    </AdminModal>

    <AdminModal v-model="fulfillmentProgressVisible" title="记录履约进度" max-width="480px" hide-actions>
      <form class="modal-form" @submit.prevent="submitFulfillmentProgress">
        <label>
          <span>当前阶段</span>
          <select v-model="fulfillmentProgressStage">
            <option v-for="option in fulfillmentProgressOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
        </label>
        <label>
          <span>供应商订单号</span>
          <input v-model.trim="supplierOrderRef" maxlength="120" placeholder="选填，但建议填写便于对账" />
        </label>
        <label>
          <span>处理备注</span>
          <textarea v-model.trim="fulfillmentProgressNote" rows="4" maxlength="500" placeholder="记录提交时间、失败原因或补单说明"></textarea>
        </label>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" :disabled="savingFulfillmentProgress" @click="fulfillmentProgressVisible = false">取消</button>
          <button type="submit" class="btn btn-primary" :disabled="savingFulfillmentProgress">
            {{ savingFulfillmentProgress ? '保存中…' : '保存进度' }}
          </button>
        </div>
      </form>
    </AdminModal>

    <AdminModal v-model="compensationVisible" title="添加补偿备注" max-width="480px" hide-actions>
      <form class="modal-form" @submit.prevent="submitCompensation">
        <label>
          <span>备注内容</span>
          <textarea v-model="compensationNote" rows="4" placeholder="请输入客服备注..." required></textarea>
        </label>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" :disabled="savingCompensation" @click="compensationVisible = false">取消</button>
          <button type="submit" class="btn btn-primary" :disabled="savingCompensation">
            {{ savingCompensation ? '提交中…' : '提交' }}
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
import { ref, reactive, onMounted, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { fetchAdminOrders, fetchAdminOrder, fetchAdminStorefronts, markAdminOrderPaid, retryAdminOrderFulfillment, updateAdminOrderFulfillmentProgress, cancelAdminOrder, batchDeleteAdminOrders, downloadAdminOrdersExport, downloadAdminFinanceExport, notifyAdminLowStock, resendAdminOrderEmail, addAdminOrderCompensationNote } from '@/api/admin'
import type { AdminOrder, AdminOrderFilter, AdminStorefront } from '@/types/admin'
import { useToast } from '@/composables/useToast'
import { useTablePagination } from '@/composables/useTablePagination'
import { useAdminAuth } from '@/composables/useAdminAuth'
import { useTableSelection } from '@/composables/useTableSelection'
import { useAdminBatchOperation } from '@/composables/useAdminBatchOperation'
import { formatDate, statusLabel } from '@/composables/useFormat'
import { copyText, writeClipboardText } from '@/composables/useClipboard'
import { fieldLabel, getDeliveryEntries } from '@/composables/useDeliveryDisplay'
import { downloadCsv } from '@/lib/csv-export'
import { formatMoney } from '@shared/money'
import {
  ABNORMAL_ORDER_STATUSES,
  isSafeDeleteOrderStatus,
  normalizeOrderStatus,
} from '@shared/order-status'

const ABNORMAL_ORDER_STATUS_SET = new Set<string>(ABNORMAL_ORDER_STATUSES)
const ABNORMAL_ORDER_STATUS_FILTER = [...ABNORMAL_ORDER_STATUSES]
import AdminPagination from '@/components/AdminPagination.vue'
import AdminModal from '@/components/AdminModal.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import AdminProductSelect from '@/components/AdminProductSelect.vue'
import DeliveryInfo from '@/components/DeliveryInfo.vue'
import {
  DEFAULT_FULFILLMENT_PROGRESS_STAGE,
  FULFILLMENT_PROGRESS_OPTIONS,
  fulfillmentProgressEventLabel,
  type FulfillmentProgressStage,
} from '@shared/fulfillment-progress'

const route = useRoute()
const router = useRouter()
const { showToast } = useToast()
const { token } = useAdminAuth()

function formatOrderMoney(amountCents: number, currency?: string) {
  try {
    return formatMoney(amountCents, currency || 'CNY')
  } catch {
    return `${currency || 'UNKNOWN'} ${amountCents}（币种异常）`
  }
}

// 标签页：全部 / 待收款 / 待交付 / 售后异常（失败/取消/关闭/过期/退款）
// 这里的异常集合要和后端订单终态同步，否则运营会漏看关闭、退款等需要人工判断的订单。
type TabKey = 'all' | 'pending' | 'paid' | 'abnormal'
const activeTab = ref<TabKey>('all')

const items = ref<AdminOrder[]>([])
const storefronts = ref<AdminStorefront[]>([])
const loading = ref(false)
const loadError = ref('')
const notifying = ref(false)
const markingPaidId = ref('')
const retryingFulfillmentId = ref('')
const cancelingId = ref('')
const resendingEmailId = ref('')
const savingCompensation = ref(false)
const fulfillmentProgressVisible = ref(false)
const savingFulfillmentProgress = ref(false)
const fulfillmentProgressOptions = FULFILLMENT_PROGRESS_OPTIONS
const fulfillmentProgressStage = ref<FulfillmentProgressStage>(DEFAULT_FULFILLMENT_PROGRESS_STAGE)
const supplierOrderRef = ref('')
const fulfillmentProgressNote = ref('')
let fulfillmentProgressOrderId: string | null = null
const {
  operating: batchOperating,
  completed: batchCompleted,
  total: batchTotal,
  runSequential,
} = useAdminBatchOperation()
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
} = useTableSelection(items, (item) => item.id)
const filter = reactive<AdminOrderFilter>({
  status: '',
  productId: '',
  q: '',
  paymentMethod: '',
  orderSource: '',
  storefrontId: '',
  page: 1,
})

const pagination = useTablePagination()
const selectedOrders = computed(() => {
  const selected = new Set(selectedIds.value)
  return items.value.filter((item) => selected.has(item.id))
})
const selectedCancelableOrders = computed(() => selectedOrders.value.filter((item) => item.status === 'pending'))
/** 未勾选「全部删除」时后端允许的安全终态（与 shared SAFE_DELETE_ORDER_STATUSES 同步，含历史 cancelled） */
const selectedSafeDeletableOrders = computed(() => selectedOrders.value.filter((item) => (
  isSafeDeleteOrderStatus(item.status)
)))
const ORDER_DELETE_CONFIRM_OPTIONS = [
  {
    key: 'force',
    label: '全部删除（含进行中/已支付/已发货等非终态）',
    hint: '默认不勾选：仅删除失败/取消/关闭/过期订单。勾选后删除当前选中的全部订单。',
  },
  {
    key: 'unlinkRefs',
    label: '解绑卡密引用',
    hint: '默认不勾选：仍挂着锁定/已发卡密的订单会拒绝删除。勾选后：锁定卡回库存，已发卡仅清订单关联（不重卖）。',
  },
] as const
let loadSequence = 0

// 从路由 query 初始化筛选条件（支持从 Dashboard 跳转）
function initFilterFromRoute() {
  const query = route.query
  activeTab.value = 'all'
  filter.status = ''
  filter.productId = ''
  filter.q = ''
  filter.paymentMethod = ''
  filter.orderSource = ''
  filter.storefrontId = ''
  if (query.tab) {
    const tab = String(query.tab) as TabKey
    if (tab === 'all' || tab === 'pending' || tab === 'paid' || tab === 'abnormal') {
      activeTab.value = tab
    }
  }
  if (!query.status && activeTab.value !== 'all') {
    if (activeTab.value === 'pending') {
      filter.status = 'pending'
    } else if (activeTab.value === 'paid') {
      filter.status = 'paid'
    } else if (activeTab.value === 'abnormal') {
      filter.status = ABNORMAL_ORDER_STATUS_FILTER
    }
  }
  if (query.status) {
    const status = String(query.status)
    if (status.includes(',')) {
      filter.status = status.split(',')
    } else {
      filter.status = status
    }
  }
  if (query.paymentMethod) {
    filter.paymentMethod = String(query.paymentMethod)
  }
  if (query.q) {
    filter.q = String(query.q)
  }
  if (query.productId) {
    filter.productId = String(query.productId)
  }
  if (query.orderSource) {
    filter.orderSource = String(query.orderSource)
  }
  if (query.storefrontId) {
    filter.storefrontId = String(query.storefrontId)
  }
}

function switchTab(tab: TabKey) {
  activeTab.value = tab
  filter.productId = ''
  filter.q = ''
  filter.paymentMethod = ''
  pagination.page.value = 1

  if (tab === 'all') {
    filter.status = ''
  } else if (tab === 'pending') {
    filter.status = 'pending'
  } else if (tab === 'paid') {
    filter.status = 'paid'
  } else if (tab === 'abnormal') {
    filter.status = ABNORMAL_ORDER_STATUS_FILTER
  }
  searchData()
}

const tabHint = computed(() => {
  const hints: Record<TabKey, string> = {
    all: '查看全部订单，适合做检索、对账和综合排查。',
    pending: '优先处理尚未收款完成的订单，尤其是需要人工确认的线下付款。',
    paid: '这里应重点关注已支付但尚未完成交付的订单。',
    abnormal: '集中处理失败、取消、关闭、过期、退款等需要人工判断的售后异常。',
  }
  return hints[activeTab.value]
})

const detailVisible = ref(false)
const currentOrder = ref<AdminOrder | null>(null)

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

// 客服动作：打开菜单（后续可扩展为下拉或弹窗）
function openCustomerServiceMenu(orderId: string) {
  // 当前直接打开详情，已在详情中提供“重发邮件 / 补偿备注”
  const item = items.value.find((entry) => entry.id === orderId)
  if (item) viewDetail(item)
}

const compensationVisible = ref(false)
const compensationNote = ref('')
let compensationOrderId: string | null = null

const currentOrderFulfillmentMode = computed(() => {
  // 后台详情优先展示订单明细快照，避免商品后来改交付模式后误导客服处理历史订单。
  const firstItem = currentOrder.value?.items?.find(item => item.fulfillmentMode)
  return firstItem?.fulfillmentMode || currentOrder.value?.fulfillmentMode || (currentOrder.value?.cards?.length ? 'card' : '')
})

const isCurrentOrderCardDelivery = computed(() => currentOrderFulfillmentMode.value === 'card' || Boolean(currentOrder.value?.cards?.length))

const hasOrderDelivery = computed(() => Boolean(
  (currentOrder.value?.delivery && Object.values(currentOrder.value.delivery).some(Boolean)) ||
  (currentOrder.value?.cards && currentOrder.value.cards.length > 0),
))

const deliveryCopyText = computed(() => {
  if (!currentOrder.value?.delivery) return ''
  const delivery = currentOrder.value.delivery
  const lines: string[] = []
  if (isCurrentOrderCardDelivery.value) {
    if (delivery.accountLabel) lines.push(`卡号：${delivery.accountLabel}`)
    if (delivery.deliverySecret) lines.push(`密码：${delivery.deliverySecret}`)
    if (delivery.deliveryNote) lines.push(`备注：${delivery.deliveryNote}`)
  } else {
    getDeliveryEntries(delivery as Record<string, unknown>, { includeLegacyDeliveryFields: true })
      .forEach(([key, value]) => lines.push(`${fieldLabel(key)}：${value}`))
  }
  return lines.join('\n')
})

async function resendEmail(id: string) {
  if (resendingEmailId.value) return
  resendingEmailId.value = id
  try {
    const res = await resendAdminOrderEmail(token.value, id)
    showToast(res.message || '邮件已重发', 'success')
  } catch (err: any) {
    showToast(err.message || '重发失败', 'error')
  } finally {
    resendingEmailId.value = ''
  }
}

function copyDelivery(event: Event) {
  if (!deliveryCopyText.value) return
  copyText(deliveryCopyText.value, event)
  showToast('已复制交付内容', 'success')
}

async function copyFulfillmentInput() {
  const input = currentOrder.value?.fulfillmentInput
  if (!input) return
  try {
    await writeClipboardText(input.value)
    showToast('已复制履约信息', 'success')
  } catch {
    showToast('复制失败，请手动复制', 'error')
  }
}

function openCompensationDialog(id: string) {
  compensationOrderId = id
  compensationNote.value = ''
  compensationVisible.value = true
}

function openFulfillmentProgressDialog(id: string) {
  if (savingFulfillmentProgress.value) return
  fulfillmentProgressOrderId = id
  fulfillmentProgressStage.value = DEFAULT_FULFILLMENT_PROGRESS_STAGE
  supplierOrderRef.value = ''
  fulfillmentProgressNote.value = ''
  fulfillmentProgressVisible.value = true
}

async function submitFulfillmentProgress() {
  if (savingFulfillmentProgress.value || !fulfillmentProgressOrderId) return
  const supplierRef = supplierOrderRef.value.trim()
  const note = fulfillmentProgressNote.value.trim()
  if (!supplierRef && !note) {
    showToast('请填写供应商订单号或处理备注', 'error')
    return
  }

  savingFulfillmentProgress.value = true
  const orderId = fulfillmentProgressOrderId
  try {
    const res = await updateAdminOrderFulfillmentProgress(token.value, orderId, {
      stage: fulfillmentProgressStage.value,
      supplierOrderRef: supplierRef || undefined,
      note: note || undefined,
    })
    showToast(res.message || '履约进度已记录', 'success')
    fulfillmentProgressVisible.value = false
    fulfillmentProgressOrderId = null
    if (currentOrder.value?.id === orderId) {
      const detail = await fetchAdminOrder(token.value, orderId)
      currentOrder.value = detail.order
    }
  } catch (err: any) {
    showToast(err.message || '记录履约进度失败', 'error')
  } finally {
    savingFulfillmentProgress.value = false
  }
}

async function submitCompensation() {
  if (savingCompensation.value) return
  if (!compensationOrderId) return
  const note = compensationNote.value.trim()
  if (!note) return
  savingCompensation.value = true
  try {
    const res = await addAdminOrderCompensationNote(token.value, compensationOrderId, { note })
    showToast(res.message || '补偿备注已添加', 'success')
    compensationVisible.value = false
    compensationOrderId = null
    compensationNote.value = ''
  } catch (err: any) {
    showToast(err.message || '添加备注失败', 'error')
  } finally {
    savingCompensation.value = false
  }
}

async function loadData() {
  const sequence = ++loadSequence
  loading.value = true
  loadError.value = ''
  try {
    const res = await fetchAdminOrders(token.value, {
      ...filter,
      page: pagination.page.value,
      limit: pagination.limit.value,
    })
    if (sequence !== loadSequence) return
    if (pagination.setTotal(res.total)) return loadData()
    items.value = res.orders
    clearSelection()
  } catch (err: any) {
    if (sequence !== loadSequence) return
    items.value = []
    clearSelection()
    loadError.value = err.message || '加载订单失败'
    showToast(err.message || '加载订单失败', 'error')
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}

function searchData() {
  pagination.page.value = 1
  const query: Record<string, string> = {}
  if (activeTab.value !== 'all') query.tab = activeTab.value
  const status = Array.isArray(filter.status) ? filter.status.join(',') : filter.status
  if (status) query.status = status
  if (filter.productId) query.productId = filter.productId
  if (filter.q) query.q = filter.q
  if (filter.paymentMethod) query.paymentMethod = filter.paymentMethod
  if (filter.orderSource) query.orderSource = filter.orderSource
  if (filter.storefrontId) query.storefrontId = filter.storefrontId
  const target = router.resolve({ path: route.path, query }).fullPath
  if (target === route.fullPath) {
    void loadData()
    return
  }
  void router.replace({ path: route.path, query })
}

async function viewDetail(item: AdminOrder) {
  try {
    const res = await fetchAdminOrder(token.value, item.id)
    currentOrder.value = res.order
    detailVisible.value = true
  } catch (err: any) {
    showToast(err.message || '加载详情失败', 'error')
  }
}

async function markPaid(id: string) {
  if (markingPaidId.value || cancelingId.value) return
  if (!(await askConfirm('确认标记为已支付？'))) return
  markingPaidId.value = id
  try {
    await markAdminOrderPaid(token.value, id)
    showToast('已标记', 'success')
    loadData()
  } catch (err: any) {
    showToast(err.message || '操作失败', 'error')
  } finally {
    markingPaidId.value = ''
  }
}

async function retryFulfillment(id: string) {
  if (retryingFulfillmentId.value) return
  if (!(await askConfirm('确认重试该已支付订单的交付？系统会重新检查订单状态和库存。'))) return
  retryingFulfillmentId.value = id
  try {
    const res = await retryAdminOrderFulfillment(token.value, id)
    showToast(res.message || '交付已完成', 'success')
    detailVisible.value = false
    currentOrder.value = null
    await loadData()
  } catch (err: any) {
    showToast(err.message || '重试交付失败', 'error')
  } finally {
    retryingFulfillmentId.value = ''
  }
}

function canManualConfirmPayment(order: AdminOrder) {
  return order.status === 'pending' && order.paymentMethod === 'offline'
}

function orderSourceText(order: AdminOrder) {
  if (order.orderSource === 'coupon_redeem') return '全额优惠码兑换'
  if (order.orderSource === 'telegram') return 'Telegram'
  return '商品主页'
}

function storefrontSnapshotText(order: AdminOrder) {
  const name = order.storefrontNameSnapshot || '未知渠道'
  return order.storefrontSlugSnapshot ? `${name} (${order.storefrontSlugSnapshot})` : name
}

async function cancel(id: string) {
  if (markingPaidId.value || cancelingId.value) return
  if (!(await askConfirm('确认取消该订单？'))) return
  cancelingId.value = id
  try {
    await cancelAdminOrder(token.value, id)
    showToast('已取消', 'success')
    loadData()
  } catch (err: any) {
    showToast(err.message || '操作失败', 'error')
  } finally {
    cancelingId.value = ''
  }
}

async function batchCancelPending() {
  const orders = selectedCancelableOrders.value
  if (orders.length === 0 || loading.value || batchOperating.value) return
  if (!(await askConfirm(`确认取消选中的 ${orders.length} 个待支付订单？`))) return
  const result = await runSequential(orders, async (order) => {
    await cancelAdminOrder(token.value, order.id)
  })
  if (!result) return
  showToast(`批量取消完成：成功 ${result.success}，失败 ${result.failed}`, result.failed ? 'error' : 'success')
  await loadData()
  selectedIds.value = result.failedItems.map((order) => order.id)
}

async function batchResendEmail() {
  const orders = selectedOrders.value
  if (orders.length === 0 || loading.value || batchOperating.value) return
  if (!(await askConfirm(`确认给选中的 ${orders.length} 个订单重发邮件？`))) return
  const result = await runSequential(orders, async (order) => {
    await resendAdminOrderEmail(token.value, order.id)
  })
  if (!result) return
  showToast(`批量重发完成：成功 ${result.success}，失败 ${result.failed}`, result.failed ? 'error' : 'success')
  selectedIds.value = result.failedItems.map((order) => order.id)
}

async function batchRemoveOrders() {
  const orders = selectedOrders.value
  if (orders.length === 0 || loading.value || batchOperating.value) return
  const safeCount = selectedSafeDeletableOrders.value.length
  const decision = await askConfirmWithOptions(
    `确认永久删除选中的 ${orders.length} 个订单？\n\n默认（两个选项都不勾）：仅删除失败/取消/关闭/过期，且无卡密关联的订单（当前选中约 ${safeCount} 个符合默认条件）。相关明细、事件和邮件记录会一并删除，此操作不可恢复。`,
    { options: [...ORDER_DELETE_CONFIRM_OPTIONS] },
  )
  if (!decision.confirmed) return
  const force = decision.options.force === true
  const unlinkRefs = decision.options.unlinkRefs === true
  batchOperating.value = true
  batchCompleted.value = 0
  batchTotal.value = orders.length
  try {
    const result = await batchDeleteAdminOrders(
      token.value,
      orders.map((order) => order.id),
      { force, unlinkRefs },
    )
    batchCompleted.value = result.deleted
    const flags = [
      force ? '全部删除' : '仅终态',
      unlinkRefs ? '已解绑卡密' : '未解绑',
    ].join(' · ')
    showToast(`已删除 ${result.deleted} 个订单（${flags}）`, 'success')
    await loadData()
  } catch (err: any) {
    showToast(err.message || '批量删除失败', 'error')
  } finally {
    batchOperating.value = false
  }
}

function exportSelectedCsv() {
  const orders = selectedOrders.value
  if (orders.length === 0) return
  const headers = ['orderNo', 'productTitle', 'orderSource', 'storefrontId', 'storefrontName', 'storefrontSlug', 'buyerContact', 'buyerEmail', 'amountCents', 'currency', 'status', 'paymentMethod', 'createdAt']
  const rows = orders.map((order) => [
    order.orderNo || '',
    order.productTitle || order.productId || '',
    order.orderSource || '',
    order.storefrontId || '',
    order.storefrontNameSnapshot || '',
    order.storefrontSlugSnapshot || '',
    order.buyerContact || '',
    order.buyerEmail || '',
    String(order.amountCents ?? ''),
    order.currency || '',
    order.status || '',
    order.paymentMethod || '',
    order.createdAt || '',
  ])
  downloadCsv(`selected-orders-${new Date().toISOString().slice(0, 10)}.csv`, [headers, ...rows])
  showToast(`已导出 ${orders.length} 个已选订单`, 'success')
}

async function copySelectedOrders() {
  const orders = selectedOrders.value
  if (orders.length === 0) return
  const lines = orders.map((order) => [order.orderNo || '', order.productTitle || order.productId || '', order.buyerEmail || order.buyerContact || '', String(order.amountCents ?? ''), order.status || ''].join('\t'))
  try { await writeClipboardText(lines.join('\n')); showToast(`已复制 ${orders.length} 个订单`, 'success') }
  catch { showToast('复制失败，请使用导出功能', 'error') }
}

async function exportCsv() {
  try {
    const blob = await downloadAdminOrdersExport(token.value, {
      status: filter.status,
      productId: filter.productId,
      q: filter.q,
      paymentMethod: filter.paymentMethod,
      orderSource: filter.orderSource,
      storefrontId: filter.storefrontId,
      format: 'csv',
      limit: 1000,
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'orders.csv'
    a.click()
    URL.revokeObjectURL(url)
  } catch (err: any) {
    showToast(err.message || '导出失败', 'error')
  }
}

async function exportFinance() {
  try {
    const blob = await downloadAdminFinanceExport(token.value, {
      status: filter.status,
      productId: filter.productId,
      q: filter.q,
      paymentMethod: filter.paymentMethod,
      orderSource: filter.orderSource,
      storefrontId: filter.storefrontId,
      format: 'csv',
      limit: 2000,
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `finance-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
    showToast('财务导出已开始下载', 'success')
  } catch (err: any) {
    showToast(err.message || '导出失败', 'error')
  }
}

async function notifyLowStock() {
  if (notifying.value) return
  if (!(await askConfirm('确认发送低库存预警邮件？'))) return
  notifying.value = true
  try {
    const res = await notifyAdminLowStock(token.value, {})
    if (res.sent) {
      showToast(`低库存邮件已发送，共 ${res.count} 个商品`, 'success')
    } else {
      showToast(res.message || '当前无低库存商品', 'info')
    }
  } catch (err: any) {
    showToast(err.message || '发送低库存邮件失败', 'error')
  } finally {
    notifying.value = false
  }
}

function statusClass(status?: string) {
  const map: Record<string, string> = {
    pending: 'tag-muted',
    paid: 'tag-success',
    issued: 'tag-success',
    expired: 'tag-muted',
    failed: 'tag-danger',
    canceled: 'tag-muted',
    closed: 'tag-muted',
    refunded: 'tag-danger',
  }
  return map[normalizeOrderStatus(status)] || 'tag-muted'
}

function statusText(status?: string) {
  return statusLabel(status || '')
}

function eventTypeText(type: string) {
  const map: Record<string, string> = {
    notification_failed: '通知失败',
    issue_failed: '交付失败',
    callback_issue_failed: '回调交付失败',
    callback_issue_exception: '回调交付异常',
    payment_rejected: '支付拒绝',
    callback_rejected: '回调拒绝',
    callback_amount_mismatch: '金额异常',
    paid: '已支付',
    issued: '已交付',
    redeemed: '已兑换',
    expired: '已过期',
    canceled: '已取消',
    closed: '已关闭',
    refunded: '已退款',
  }
  return map[type] || fulfillmentProgressEventLabel(type) || type
}

function eventTypeClass(type: string) {
  if (type.includes('failed') || type.includes('exception') || type.includes('rejected') || type.includes('mismatch')) return 'tag-danger'
  if (['paid', 'issued', 'redeemed'].includes(type)) return 'tag-success'
  if (['expired', 'canceled', 'closed'].includes(type)) return 'tag-muted'
  return 'tag-info'
}

onMounted(async () => {
  initFilterFromRoute()
  try {
    storefronts.value = (await fetchAdminStorefronts(token.value)).storefronts
  } catch (error) {
    showToast(error instanceof Error ? error.message : '加载展示渠道失败', 'error')
  }
  loadData()
})

watch(
  () => route.query,
  () => {
    pagination.page.value = 1
    initFilterFromRoute()
    loadData()
  },
)
</script>

<style>@import '@/assets/admin.css';</style>
<style scoped>
/* 页面专属样式放这里，只保留非通用样式 */
.event-value {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}

.tabs {
  display: flex;
  gap: 6px;
}

.tab-hint {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--tg-hint, #6b7280);
}

.action-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
}

.action-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  padding: 7px 12px;
  border-radius: var(--r-full, 999px);
  border: 0.5px solid var(--border, #e5e7eb);
  background: var(--tg-bg, #fff);
  font-size: 13px;
  color: var(--tg-text, #333);
  cursor: pointer;
}

.detail-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.tab {
  padding: 6px 12px;
  border-radius: var(--r-md, 8px);
  border: 0.5px solid var(--border, #e5e7eb);
  background: var(--tg-bg, #fff);
  color: var(--tg-text, #333);
  font-size: 13px;
  cursor: pointer;
}

.tab.active {
  background: rgba(0, 122, 255, 0.12);
  color: #007aff;
  border-color: #007aff;
}

.detail-json {
  background: var(--tg-secondary-bg, #f5f7fa);
  padding: 10px;
  border-radius: var(--r-md, 8px);
  font-size: 12px;
  overflow: auto;
  max-height: 50vh;
}

@media (max-width: 640px) {
  .tab-hint,
  .action-strip {
    display: none;
  }
}
</style>
