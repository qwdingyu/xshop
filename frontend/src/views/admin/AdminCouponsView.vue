<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <AdminProductSelect v-model="filter.productId" aria-label="优惠码商品" @change="searchData" />
        <select v-model="filter.status" aria-label="优惠码状态" @change="searchData">
          <option value="">全部状态</option>
          <option value="active">有效</option>
          <option value="inactive">失效</option>
        </select>
        <input v-model="filter.search" type="search" placeholder="搜索优惠码" aria-label="搜索优惠码" @keyup.enter="searchData" />
        <button class="btn btn-primary btn-sm" :disabled="loading" @click="searchData">
          {{ loading ? '查询中…' : '查询' }}
        </button>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-primary btn-sm" :disabled="saving || generating" @click="openCreate">新建</button>
        <button class="btn btn-ghost btn-sm" :disabled="saving || generating" @click="openGenerate">批量生成</button>
      </div>
    </div>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" :disabled="loading" @click="loadData">重新加载</button>
    </div>

    <div v-if="selectedCount > 0" class="bulk-bar" role="status" aria-live="polite" :aria-busy="loading || batchOperating">
      <span v-if="batchOperating">处理中 {{ batchCompleted }}/{{ batchTotal }}</span>
      <span v-else>当前页已选 {{ selectedCount }} 个优惠码</span>
      <div class="bulk-actions">
        <button class="btn btn-ghost btn-sm" :disabled="loading || batchOperating" @click="clearSelection">清空选择</button>
        <button class="btn btn-ghost btn-sm" :disabled="loading || batchOperating" @click="copySelectedCodes">复制所选</button>
        <button class="btn btn-ghost btn-sm" :disabled="loading || batchOperating" @click="exportSelectedCodes">导出所选</button>
        <button class="btn btn-primary btn-sm" :disabled="loading || batchOperating" @click="batchSetActive(true)">
          批量启用
        </button>
        <button class="btn btn-ghost btn-sm" :disabled="loading || batchOperating" @click="batchSetActive(false)">
          批量停用
        </button>
        <button class="btn btn-danger btn-sm" :disabled="loading || batchOperating" @click="batchRemove">
          批量删除
        </button>
      </div>
    </div>

    <div class="table-wrap" role="region" aria-label="优惠码表格滚动区域" tabindex="0" :aria-busy="loading">
      <table class="admin-table" aria-label="优惠码列表">
        <thead>
          <tr>
            <th class="select-cell">
              <input
                type="checkbox"
                :checked="allVisibleSelected"
                :indeterminate.prop="partiallySelected"
                :disabled="selectableCount === 0 || loading || batchOperating"
                aria-label="选择当前页优惠码"
                @change="toggleAllVisible(($event.target as HTMLInputElement).checked)"
              />
            </th>
            <th>优惠码</th>
            <th>商品</th>
            <th>类型</th>
            <th>折扣</th>
            <th>用量</th>
            <th>状态</th>
            <th>过期时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="i in 5" :key="'sk' + i" class="skeleton-row">
            <td :colspan="9"><div class="skeleton-cell" /></td>
          </tr>
        </tbody>
        <tbody v-else>
          <tr v-for="item in items" :key="item.code" :class="{ 'is-selected': isSelected(item.code) }">
            <td class="select-cell">
              <input
                type="checkbox"
                :checked="isSelected(item.code)"
                :disabled="loading || batchOperating || deletingCode === item.code"
                :aria-label="`选择优惠码 ${item.code}`"
                @click="setSelected(item.code, ($event.target as HTMLInputElement).checked, $event.shiftKey)"
              />
            </td>
            <td>{{ item.code }}</td>
            <td>
              <div class="relation-cell">
                <span>{{ item.productTitle || item.productId || '全店通用' }}</span>
                <small v-if="item.productTitle && item.productId">{{ item.productId }}</small>
              </div>
            </td>
            <td>{{ item.discountType === 'percent' ? '百分比' : '固定' }}</td>
            <td>{{ formatCouponDiscount(item) }}</td>
            <td>{{ item.usedCount ?? 0 }} / {{ item.maxUses ?? '-' }}</td>
            <td>
              <span class="tag" :class="item.active ? 'tag-success' : 'tag-muted'">
                {{ item.active ? '有效' : '失效' }}
              </span>
            </td>
            <td>{{ formatDate(item.expiresAt) }}</td>
            <td>
              <div class="table-actions">
                <button class="btn btn-ghost btn-xs" :disabled="loading || batchOperating" @click="copyCodes([item.code], '优惠码已复制')">复制</button>
                <button class="btn btn-ghost btn-xs" :disabled="saving || loading || batchOperating || deletingCode === item.code" @click="openEdit(item)">编辑</button>
                <button class="btn btn-danger btn-xs" :disabled="saving || loading || batchOperating || deletingCode === item.code" @click="remove(item.code)">
                  {{ deletingCode === item.code ? '删除中…' : '删除' }}
                </button>
              </div>
            </td>
          </tr>
          <tr v-if="items.length === 0">
            <td colspan="9" class="empty-text">暂无优惠码</td>
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

    <AdminModal v-model="formVisible" :title="editing ? '编辑优惠码' : '新建优惠码'" max-width="520px" hide-actions>
      <form class="modal-form" @submit.prevent="save">
        <label>
          <span>优惠码</span>
          <input v-model="form.code" :disabled="!!editing" placeholder="留空则自动生成" />
        </label>
        <label>
          <span>适用商品</span>
          <AdminProductSelect v-model="form.productId" placeholder="全店通用" />
        </label>
        <label>
          <span>折扣类型</span>
          <select
            :value="form.discountType"
            @change="setDiscountType(form, ($event.target as HTMLSelectElement).value)"
          >
            <option value="fixed">立减金额</option>
            <option value="percent">立减比例</option>
          </select>
        </label>
        <label>
          <span>{{ discountInputLabel(form) }}</span>
          <input
            :value="discountInputValue(form)"
            type="number"
            :min="discountInputMin(form)"
            :max="discountInputMax(form)"
            :step="discountInputStep(form)"
            :placeholder="discountInputPlaceholder(form)"
            required
            @input="setDiscountInputValue(form, ($event.target as HTMLInputElement).value)"
          />
          <small class="field-hint">{{ discountInputHint(form) }}</small>
        </label>
        <label>
          <span>最大使用次数</span>
          <input v-model.number="form.maxUses" type="number" />
        </label>
        <label>
          <span>过期时间</span>
          <input v-model="form.expiresAt" type="datetime-local" />
        </label>
        <label class="checkbox-label">
          <input v-model="form.active" type="checkbox" />
          <span>有效</span>
        </label>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" :disabled="saving" @click="formVisible = false">取消</button>
          <button type="submit" class="btn btn-primary" :disabled="saving">
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </div>
      </form>
    </AdminModal>

    <AdminModal v-model="generatedVisible" title="优惠码生成结果" max-width="620px" hide-actions>
      <div class="generated-result">
        <p>本次共生成 {{ generatedCodes.length }} 个优惠码。关闭前请复制或下载保存。</p>
        <textarea :value="generatedCodes.join('\n')" rows="12" readonly aria-label="本次生成的优惠码" />
        <div class="modal-actions">
          <button class="btn btn-ghost" @click="copyCodes(generatedCodes, '已复制全部优惠码')">复制全部</button>
          <button class="btn btn-primary" @click="exportGeneratedCodes">下载 CSV</button>
          <button class="btn btn-ghost" @click="generatedVisible = false">关闭</button>
        </div>
      </div>
    </AdminModal>

    <AdminModal v-model="generateVisible" title="批量生成优惠码" max-width="520px" hide-actions>
      <form class="modal-form" @submit.prevent="doGenerate">
        <label>
          <span>适用商品</span>
          <AdminProductSelect v-model="genForm.productId" placeholder="请选择商品" required />
        </label>
        <label>
          <span>前缀</span>
          <input v-model="genForm.prefix" />
        </label>
        <label>
          <span>折扣类型</span>
          <select
            :value="genForm.discountType"
            @change="setDiscountType(genForm, ($event.target as HTMLSelectElement).value)"
          >
            <option value="fixed">立减金额</option>
            <option value="percent">立减比例</option>
          </select>
        </label>
        <label>
          <span>{{ discountInputLabel(genForm) }}</span>
          <input
            :value="discountInputValue(genForm)"
            type="number"
            :min="discountInputMin(genForm)"
            :max="discountInputMax(genForm)"
            :step="discountInputStep(genForm)"
            :placeholder="discountInputPlaceholder(genForm)"
            required
            @input="setDiscountInputValue(genForm, ($event.target as HTMLInputElement).value)"
          />
          <small class="field-hint">{{ discountInputHint(genForm) }}</small>
        </label>
        <label>
          <span>数量</span>
          <input v-model.number="genForm.count" type="number" required />
        </label>
        <label>
          <span>最大使用次数</span>
          <input v-model.number="genForm.maxUses" type="number" />
        </label>
        <label>
          <span>过期时间</span>
          <input v-model="genForm.expiresAt" type="datetime-local" />
        </label>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" :disabled="generating" @click="generateVisible = false">取消</button>
          <button type="submit" class="btn btn-primary" :disabled="generating">
            {{ generating ? '生成中…' : '生成' }}
          </button>
        </div>
      </form>
    </AdminModal>

    <ConfirmDialog v-model="confirmVisible" :message="confirmMessage" @confirm="onConfirm" />
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import { fetchAdminCoupons, createAdminCoupon, generateAdminCoupons, updateAdminCoupon, deleteAdminCoupon } from '@/api/admin'
import type { AdminCoupon, AdminCouponFilter, AdminCreateCouponBody, AdminGenerateCouponBody } from '@/types/admin'
import { useToast } from '@/composables/useToast'
import { useTablePagination } from '@/composables/useTablePagination'
import { useAdminAuth } from '@/composables/useAdminAuth'
import { useTableSelection } from '@/composables/useTableSelection'
import { useAdminBatchOperation } from '@/composables/useAdminBatchOperation'
import AdminPagination from '@/components/AdminPagination.vue'
import AdminModal from '@/components/AdminModal.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import AdminProductSelect from '@/components/AdminProductSelect.vue'
import { formatDate, toDateTimeLocalValue, dateTimeLocalToIso } from '@/composables/useFormat'
import { writeClipboardText } from '@/composables/useClipboard'
import { downloadCsv } from '@/lib/csv-export'
import { formatMoney, minorToMajorString, parseMajorToMinor } from '@shared/money'

const { showToast } = useToast()
const { token } = useAdminAuth()

const items = ref<AdminCoupon[]>([])
const loading = ref(false)
const loadError = ref('')
const saving = ref(false)
const generating = ref(false)
const deletingCode = ref('')
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
} = useTableSelection(items, (item) => item.code)
const filter = reactive<AdminCouponFilter>({
  productId: '',
  status: '',
  search: '',
  page: 1,
})

const pagination = useTablePagination()

const formVisible = ref(false)
const editing = ref(false)
const form = reactive<AdminCreateCouponBody>({
  productId: '',
  code: '',
  discountType: 'fixed',
  discountValue: 0,
  maxUses: 1,
  active: true,
  expiresAt: '',
})
let editingCode = ''

const generateVisible = ref(false)
const generatedVisible = ref(false)
const generatedCodes = ref<string[]>([])
const genForm = reactive<AdminGenerateCouponBody>({
  productId: '',
  prefix: '',
  discountType: 'fixed',
  discountValue: 0,
  maxUses: 1,
  active: true,
  expiresAt: '',
  count: 10,
})

const { confirmVisible, confirmMessage, askConfirm, onConfirm } = useConfirmDialog()
let loadSequence = 0

async function loadData() {
  const sequence = ++loadSequence
  loading.value = true
  loadError.value = ''
  try {
    const res = await fetchAdminCoupons(token.value, {
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
    loadError.value = err.message || '加载优惠码失败'
    showToast(err.message || '加载优惠码失败', 'error')
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}

function searchData() {
  pagination.page.value = 1
  loadData()
}

function openCreate() {
  editing.value = false
  editingCode = ''
  Object.assign(form, {
    productId: '',
    code: '',
    discountType: 'fixed',
    discountValue: 0,
    maxUses: 1,
    active: true,
    expiresAt: '',
  })
  formVisible.value = true
}

function openEdit(item: AdminCoupon) {
  editing.value = true
  editingCode = item.code
  Object.assign(form, {
    productId: item.productId || '',
    code: item.code,
    discountType: item.discountType || 'fixed',
    discountValue: item.discountValue || 0,
    maxUses: item.maxUses || 1,
    active: item.active ?? true,
    expiresAt: toDateTimeLocalValue(item.expiresAt),
  })
  formVisible.value = true
}

async function save() {
  if (saving.value) return
  if (!validateCouponForm(form)) return
  saving.value = true
  try {
    const payload = couponPayload(form)
    if (editing.value) {
      await updateAdminCoupon(token.value, editingCode, payload)
      showToast('已保存', 'success')
    } else {
      await createAdminCoupon(token.value, payload)
      showToast('已创建', 'success')
    }
    formVisible.value = false
    loadData()
  } catch (err: any) {
    showToast(err.message || '保存失败', 'error')
  } finally {
    saving.value = false
  }
}

function openGenerate() {
  Object.assign(genForm, {
    productId: '',
    prefix: '',
    discountType: 'fixed',
    discountValue: 0,
    maxUses: 1,
    active: true,
    expiresAt: '',
    count: 10,
  })
  generateVisible.value = true
}

async function doGenerate() {
  if (generating.value) return
  if (!validateCouponForm(genForm)) return
  generating.value = true
  try {
    const res = await generateAdminCoupons(token.value, couponPayload(genForm))
    generatedCodes.value = res.codes
    showToast(`已生成 ${res.codes.length} 个`, 'success')
    generateVisible.value = false
    generatedVisible.value = true
    loadData()
  } catch (err: any) {
    showToast(err.message || '生成失败', 'error')
  } finally {
    generating.value = false
  }
}

async function copyCodes(codes: string[], successMessage: string) {
  if (codes.length === 0) return
  try {
    await writeClipboardText(codes.join('\n'))
    showToast(successMessage, 'success')
  } catch {
    showToast('复制失败，请使用导出功能', 'error')
  }
}

function copySelectedCodes() {
  return copyCodes([...selectedIds.value], `已复制 ${selectedIds.value.length} 个优惠码`)
}

function exportSelectedCodes() {
  const selected = new Set(selectedIds.value)
  const rows = items.value.filter((item) => selected.has(item.code))
  downloadCsv(`selected-coupons-${new Date().toISOString().slice(0, 10)}.csv`, [
    ['code', 'productTitle', 'productId', 'discountType', 'discountValue', 'maxUses', 'usedCount', 'active', 'expiresAt'],
    ...rows.map((item) => [item.code, item.productTitle || '', item.productId || '', item.discountType || '', String(item.discountValue || 0), String(item.maxUses || ''), String(item.usedCount || 0), String(item.active ?? true), item.expiresAt || '']),
  ])
  showToast(`已导出 ${rows.length} 个优惠码`, 'success')
}

function exportGeneratedCodes() {
  downloadCsv(`generated-coupons-${new Date().toISOString().slice(0, 10)}.csv`, [
    ['code'],
    ...generatedCodes.value.map((code) => [code]),
  ])
  showToast('优惠码文件已下载', 'success')
}

type CouponForm = AdminCreateCouponBody | AdminGenerateCouponBody

function normalizeDiscountType(value: string): CouponForm['discountType'] {
  return value === 'percent' ? 'percent' : 'fixed'
}

function setDiscountType(target: CouponForm, value: string) {
  target.discountType = normalizeDiscountType(value)
  target.discountValue = 0
}

function discountInputLabel(target: CouponForm) {
  return target.discountType === 'percent' ? '立减比例（%）' : '立减金额（元）'
}

function discountInputPlaceholder(target: CouponForm) {
  return target.discountType === 'percent'
    ? '例如 5 表示减免 5%'
    : '例如 10 表示减免 10 元'
}

function discountInputMin(target: CouponForm) {
  return target.discountType === 'percent' ? 1 : 0.01
}

function discountInputMax(target: CouponForm) {
  return target.discountType === 'percent' ? 100 : 1000
}

function discountInputStep(target: CouponForm) {
  return target.discountType === 'percent' ? 1 : 0.01
}

function discountInputValue(target: CouponForm) {
  const value = Number(target.discountValue || 0)
  if (value <= 0) return ''
  return target.discountType === 'percent' ? String(value) : minorToMajorString(value, 'CNY')
}

function setDiscountInputValue(target: CouponForm, rawValue: string) {
  if (target.discountType === 'percent') {
    const value = Number(rawValue)
    target.discountValue = Number.isFinite(value) && value > 0 ? Math.round(value) : 0
    return
  }
  try {
    target.discountValue = parseMajorToMinor(rawValue, 'CNY')
  } catch {
    target.discountValue = 0
  }
}

function discountInputHint(target: CouponForm) {
  if (target.discountType === 'percent') {
    if (!target.discountValue) return '填写立减百分比：5 表示减免 5%，用户实付 95%，约 9.5 折。'
    return formatPercentDiscount(target.discountValue)
  }
  if (!target.discountValue) return '填写人民币金额：10 表示立减 10 元，系统保存时会转换为分。'
  return `当前为立减 ${formatMoney(target.discountValue, 'CNY')}`
}

function formatPercentDiscount(value: number) {
  const percent = Math.max(1, Math.min(100, Math.round(Number(value || 0))))
  if (percent >= 100) return '立减 100%，用户实付 0%，免费'
  const payPercent = 100 - percent
  const discountName = Number.isInteger(payPercent / 10)
    ? `${payPercent / 10} 折`
    : `${(payPercent / 10).toFixed(1)} 折`
  return `立减 ${percent}%，用户实付 ${payPercent}%，约 ${discountName}`
}

function formatCouponDiscount(item: Pick<AdminCoupon, 'discountType' | 'discountValue'>) {
  const value = Number(item.discountValue || 0)
  if (item.discountType === 'percent') return formatPercentDiscount(value)
  return `立减 ${formatMoney(value, 'CNY')}`
}

function validateCouponForm(target: CouponForm) {
  if (target.discountType === 'percent' && (target.discountValue < 1 || target.discountValue > 100)) {
    showToast('立减比例必须是 1 到 100 的整数。例：5 表示 9.5 折，20 表示 8 折。', 'error')
    return false
  }
  if (target.discountType === 'fixed' && target.discountValue < 1) {
    showToast('立减金额至少为 0.01 元。', 'error')
    return false
  }
  return true
}

function couponPayload<T extends CouponForm>(target: T): T {
  return {
    ...target,
    expiresAt: dateTimeLocalToIso(target.expiresAt),
  }
}

async function remove(code: string) {
  if (deletingCode.value || batchOperating.value) return
  if (!(await askConfirm('确认删除该优惠码？'))) return
  deletingCode.value = code
  try {
    await deleteAdminCoupon(token.value, code)
    showToast('已删除', 'success')
    loadData()
  } catch (err: any) {
    showToast(err.message || '删除失败', 'error')
  } finally {
    deletingCode.value = ''
  }
}

async function batchSetActive(active: boolean) {
  const codes = [...selectedIds.value]
  if (codes.length === 0 || loading.value || batchOperating.value) return
  if (!(await askConfirm(`确认${active ? '启用' : '停用'}选中的 ${codes.length} 个优惠码？`))) return
  const result = await runSequential(codes, async (code) => {
    await updateAdminCoupon(token.value, code, { active })
  })
  if (!result) return
  showToast(`批量${active ? '启用' : '停用'}完成：成功 ${result.success}，失败 ${result.failed}`, result.failed ? 'error' : 'success')
  await loadData()
  selectedIds.value = result.failedItems
}

async function batchRemove() {
  const codes = [...selectedIds.value]
  if (codes.length === 0 || loading.value || batchOperating.value) return
  if (!(await askConfirm(`确认删除选中的 ${codes.length} 个优惠码？此操作不可恢复。`))) return
  const result = await runSequential(codes, async (code) => {
    await deleteAdminCoupon(token.value, code)
  })
  if (!result) return
  showToast(`批量删除完成：成功 ${result.success}，失败 ${result.failed}`, result.failed ? 'error' : 'success')
  await loadData()
  selectedIds.value = result.failedItems
}

onMounted(loadData)
</script>

<style>@import '@/assets/admin.css';</style>
<style scoped>
/* 页面专属样式放这里，只保留非通用样式 */
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}

.relation-cell {
  display: inline-flex;
  flex-direction: column;
  gap: 2px;
  min-width: 120px;
}

.relation-cell small {
  color: var(--tg-hint, #6b7280);
  font-size: 11px;
}

.generated-result { display: flex; flex-direction: column; gap: 10px; }
.generated-result p { margin: 0; color: var(--tg-hint, #6b7280); font-size: 13px; }
.generated-result textarea { width: 100%; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>
