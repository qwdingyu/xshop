<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <input
          v-model="filter.q"
          type="search"
          placeholder="搜索商品名称/ID/分类"
          aria-label="搜索商品名称、ID 或分类"
          @keyup.enter="searchData"
        />
        <select v-model="filter.active" aria-label="商品状态" @change="searchData">
          <option value="">全部状态</option>
          <option value="true">上架</option>
          <option value="false">下架</option>
        </select>
        <select v-model="filter.category" aria-label="商品分类" @change="searchData">
          <option value="">全部分类</option>
          <option v-for="category in categoryOptions" :key="category.id" :value="category.name">
            {{ category.name }}
          </option>
        </select>
        <select v-model="filter.storefrontId" aria-label="展示渠道" @change="searchData">
          <option value="">全部渠道</option>
          <option v-for="storefront in storefronts" :key="storefront.id" :value="storefront.id">{{ storefront.name }}</option>
        </select>
        <button class="btn btn-primary btn-sm" :disabled="loading" @click="searchData">
          {{ loading ? '查询中…' : '查询' }}
        </button>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-ghost btn-sm" :disabled="loading" @click="loadData">刷新</button>
        <button class="btn btn-primary btn-sm" @click="openDialog()">新增商品</button>
      </div>
    </div>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" :disabled="loading" @click="loadData">重新加载</button>
    </div>

    <div class="sort-context" role="status">
      <span v-if="activeStorefrontName">
        当前按“{{ activeStorefrontName }}”渠道排序展示，排序数字越小越靠前。
      </span>
      <span v-else>
        选择展示渠道后，可直接调整该渠道内的商品展示顺序。
      </span>
    </div>

    <div v-if="selectedCount > 0" class="bulk-bar" role="status" aria-live="polite" :aria-busy="loading || batchOperating">
      <span v-if="batchOperating">处理中 {{ batchCompleted }}/{{ batchTotal }}</span>
      <span v-else>当前页已选 {{ selectedCount }} 个商品</span>
      <div class="bulk-actions">
        <button class="btn btn-ghost btn-sm" :disabled="loading || batchOperating" @click="clearSelection">清空选择</button>
        <button class="btn btn-ghost btn-sm" :disabled="loading || batchOperating" @click="copySelectedProducts">复制所选</button>
        <button class="btn btn-ghost btn-sm" :disabled="loading || batchOperating" @click="exportSelectedProducts">导出所选</button>
        <button class="btn btn-primary btn-sm" :disabled="loading || batchOperating" @click="batchSetActive(true)">批量上架</button>
        <button class="btn btn-ghost btn-sm" :disabled="loading || batchOperating" @click="batchSetActive(false)">批量下架</button>
        <button class="btn btn-danger btn-sm" :disabled="loading || batchOperating" @click="batchRemove">
          批量删除
        </button>
      </div>
    </div>

    <div class="table-wrap" role="region" aria-label="商品表格滚动区域" tabindex="0" :aria-busy="loading">
      <table class="admin-table" aria-label="商品列表">
        <thead>
          <tr>
            <th class="select-cell">
              <input
                type="checkbox"
                :checked="allVisibleSelected"
                :indeterminate.prop="partiallySelected"
                :disabled="selectableCount === 0 || loading || batchOperating"
                aria-label="选择当前页商品"
                @change="toggleAllVisible(($event.target as HTMLInputElement).checked)"
              />
            </th>
            <th>名称</th>
            <th>图片</th>
            <th>ID</th>
            <th>分类</th>
            <th>价格</th>
            <th>库存</th>
            <th>已购</th>
            <th>交付模式</th>
            <th>限购</th>
            <th>展示渠道</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="i in 5" :key="'sk' + i" class="skeleton-row">
            <td colspan="13"><div class="skeleton-cell" /></td>
          </tr>
        </tbody>
        <tbody v-else>
          <tr v-for="item in visibleItems" :key="item.id" :class="{ 'is-selected': isSelected(item.id) }">
            <td class="select-cell">
              <input
                type="checkbox"
                :checked="isSelected(item.id)"
                :disabled="loading || batchOperating || deletingId === item.id"
                :aria-label="`选择商品 ${item.title}`"
                @click="setSelected(item.id, ($event.target as HTMLInputElement).checked, $event.shiftKey)"
              />
            </td>
            <td>{{ item.title }}</td>
            <td class="cover-cell">
              <img
                v-if="item.coverUrl && !brokenCoverIds[item.id]"
                :src="item.coverUrl"
                :alt="`${item.title}封面`"
                class="product-cover-thumb"
                loading="lazy"
                @error="markCoverBroken(item.id)"
              />
              <span v-else class="cover-placeholder">无图片</span>
            </td>
            <td>{{ item.id }}</td>
            <td>{{ item.category || '-' }}</td>
            <td>{{ formatProductMoney(item) }}</td>
            <td>{{ item.stock ?? '-' }}</td>
            <td>{{ item.purchasedCount ?? 0 }}</td>
            <td>
              <div class="mode-cell">
                <span>{{ fulfillmentModeText(item.fulfillmentMode) }}</span>
                <span class="mode-tag" :class="item.issueMode === 'manual' ? 'mode-tag-warn' : 'mode-tag-success'">
                  {{ item.issueMode === 'manual' ? '付款后处理' : '自动发货' }}
                </span>
                <span v-if="item.deliveryVisibility === 'email_only'" class="mode-tag mode-tag-info">仅邮件</span>
                <span class="mode-tag">{{ stockDisplayModeText(item.stockDisplayMode) }}</span>
              </div>
            </td>
            <td>{{ purchaseLimitText(item.purchaseLimit) }}</td>
            <td>
              <div v-if="productStorefronts(item).length" class="channel-tags">
                <span
                  v-for="storefront in productStorefronts(item)"
                  :key="storefront.id"
                  class="tag tag-info channel-sort-tag"
                  :class="{ 'tag-muted': storefront.visible === false }"
                  :title="storefront.visible === false ? '该渠道已分配但前台不可见' : '该渠道内数字越小越靠前'"
                >
                  {{ storefront.name || storefrontName(storefront.id) }}
                  <small>排序 {{ storefront.sortOrder ?? '-' }}</small>
                  <small v-if="storefront.visible === false">隐藏</small>
                </span>
              </div>
              <span v-else class="tag tag-warning">未发布</span>
              <label v-if="filter.storefrontId && currentStorefrontMapping(item)" class="channel-inline-sort">
                <span>当前渠道排序</span>
                <input
                  type="number"
                  min="0"
                  max="99999"
                  step="1"
                  :value="currentStorefrontMapping(item)?.sortOrder ?? 100"
                  :disabled="savingSortKey === storefrontSortKey(item) || loading || batchOperating"
                  @change="saveCurrentStorefrontSort(item, ($event.target as HTMLInputElement).value)"
                  @keyup.enter="saveCurrentStorefrontSort(item, ($event.target as HTMLInputElement).value)"
                />
              </label>
            </td>
            <td>
              <span class="tag product-status" :class="item.active ? 'tag-success' : 'tag-muted'">
                {{ item.active ? '上架' : '下架' }}
              </span>
            </td>
            <td>
              <div class="table-actions">
                <button class="btn btn-ghost btn-xs" title="复制为新商品" :disabled="saving || loading || batchOperating || duplicatingId === item.id" @click="duplicateProductRow(item)">
                  {{ duplicatingId === item.id ? '复制中…' : '复制' }}
                </button>
                <button class="btn btn-ghost btn-xs" :disabled="saving || loading || batchOperating || deletingId === item.id" @click="openDialog(item)">编辑</button>
                <button class="btn btn-ghost btn-xs" :title="filter.storefrontId ? '管理当前渠道排序' : '选择渠道后管理排序'" :disabled="loading || batchOperating" @click="goStorefrontSort(item)">
                  排序
                </button>
                <button class="btn btn-danger btn-xs" :disabled="saving || loading || batchOperating || deletingId === item.id" @click="remove(item.id)">
                  {{ deletingId === item.id ? '删除中…' : '删除' }}
                </button>
              </div>
            </td>
          </tr>
          <tr v-if="visibleItems.length === 0">
            <td colspan="13" class="empty-text">暂无商品</td>
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

    <AdminModal v-model="dialogVisible" :title="editing ? '编辑商品' : '新增商品'" max-width="720px" hide-actions>
      <form class="modal-form product-editor-form" @submit.prevent="save">
        <div class="product-editor-scroll">
          <!-- 基本信息：名称 / 分类 / 说明 -->
          <section class="form-section" aria-labelledby="pe-basic">
            <header class="form-section-head">
              <h4 id="pe-basic" class="form-section-title">基本信息</h4>
              <p class="form-section-desc">前台展示名称、分类与购买前说明</p>
            </header>
            <div class="form-grid two-cols">
              <label class="field-span-2">
                <span>名称</span>
                <input v-model="form.title" required maxlength="120" autocomplete="off" />
              </label>
              <label>
                <span>分类</span>
                <input v-model="form.category" list="product-category-options" placeholder="选择或输入新分类" />
                <datalist id="product-category-options">
                  <option v-for="category in categoryOptions" :key="category.id" :value="category.name" />
                </datalist>
              </label>
              <label class="field-span-2">
                <span>购买前说明</span>
                <textarea
                  v-model="form.description"
                  rows="3"
                  maxlength="500"
                  placeholder="适用范围、到账时间、限制与售后；勿写交付密钥"
                ></textarea>
                <small class="field-hint">对买家可见，控制在简短说明即可</small>
              </label>
            </div>
          </section>

          <!-- 图片与定价 -->
          <section class="form-section" aria-labelledby="pe-media">
            <header class="form-section-head">
              <h4 id="pe-media" class="form-section-title">图片与定价</h4>
              <p class="form-section-desc">封面与售价是列表页最显眼的信息</p>
            </header>
            <div class="media-price-layout">
              <div class="cover-panel">
                <div class="cover-preview-frame" :class="{ 'has-image': Boolean(form.coverUrl) && !coverPreviewFailed }">
                  <img
                    v-if="form.coverUrl && !coverPreviewFailed"
                    :src="form.coverUrl"
                    :alt="`${form.title || '商品'}封面预览`"
                    class="cover-preview"
                    @error="coverPreviewFailed = true"
                  />
                  <div v-else class="cover-empty">
                    <span>{{ coverPreviewFailed ? '图片无法加载' : '暂无封面' }}</span>
                    <small v-if="coverPreviewFailed">请检查 URL 是否可公开访问</small>
                  </div>
                </div>
                <div class="image-upload-row">
                  <label class="btn btn-ghost btn-sm image-upload-button" :class="{ 'is-disabled': uploadingCover }">
                    {{ uploadingCover ? '上传中…' : '上传图片' }}
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/avif"
                      :disabled="uploadingCover"
                      @change="uploadCoverImage"
                    />
                  </label>
                  <small class="field-hint">JPEG / PNG / WebP / AVIF，≤5MiB</small>
                </div>
                <label>
                  <span>图片 URL</span>
                  <input
                    v-model.trim="form.coverUrl"
                    type="text"
                    inputmode="url"
                    maxlength="500"
                    placeholder="https:// 或上传后自动填写"
                    autocomplete="url"
                  />
                  <small class="field-hint">优先站内 R2；外部 HTTPS 仅作兼容</small>
                </label>
              </div>

              <div class="price-panel">
                <div class="form-grid two-cols">
                  <label>
                    <span>币种</span>
                    <select v-model="form.currency">
                      <option v-for="currency in currencyOptions" :key="currency.code" :value="currency.code">
                        {{ currency.code }} · {{ currency.name }}
                      </option>
                    </select>
                  </label>
                  <label>
                    <span>价格（{{ priceInputUnit }}）</span>
                    <input
                      v-model.trim="form.priceMajor"
                      type="text"
                      :inputmode="currentCurrencyMeta.exponent === 0 ? 'numeric' : 'decimal'"
                      :placeholder="currentCurrencyMeta.exponent === 0 ? '例如 500' : '例如 9.90'"
                      required
                    />
                  </label>
                </div>
                <p v-if="pricePreview" class="price-preview-line">
                  保存后展示 <strong>{{ pricePreview }}</strong>
                </p>
                <small class="field-hint">{{ currencyPaymentHint }}</small>
                <p v-if="isFreeProductPrice" class="inline-callout">
                  免费商品前台每次领取 1 件，不展示支付、余额、折扣与数量。活动建议设「每邮箱限购 1 次」。
                </p>
              </div>
            </div>
          </section>

          <!-- 交付与履约 -->
          <section class="form-section" aria-labelledby="pe-fulfill">
            <header class="form-section-head">
              <h4 id="pe-fulfill" class="form-section-title">交付与履约</h4>
              <p class="form-section-desc">决定如何发货、是否收集买家信息</p>
            </header>
            <div class="form-grid two-cols">
              <label>
                <span>交付模式</span>
                <select v-model="form.fulfillmentMode">
                  <option v-for="option in FULFILLMENT_MODE_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option>
                </select>
                <small class="field-hint">{{ fulfillmentModeGuide }}</small>
              </label>
              <label>
                <span>交付展示方式</span>
                <select v-model="form.deliveryVisibility">
                  <option v-for="option in DELIVERY_VISIBILITY_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option>
                </select>
                <small class="field-hint">「仅邮件」会隐藏卡密，适合邮箱限领活动</small>
              </label>
              <label>
                <span>下单履约信息</span>
                <select v-model="form.fulfillmentInputType" @change="handleFulfillmentInputTypeChange">
                  <option v-for="option in FULFILLMENT_INPUT_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option>
                </select>
                <small class="field-hint">充值账号、预约信息等通用字段，不绑定行业</small>
              </label>
              <label v-if="form.fulfillmentMode !== 'card'" class="field-span-2">
                <span>交付内容</span>
                <textarea v-model="form.salesCopy" rows="2" placeholder="非卡密商品的交付说明 / 资料 / 链接"></textarea>
              </label>
            </div>
            <div v-if="form.fulfillmentInputType !== 'none'" class="fulfillment-input-box">
              <div class="form-grid two-cols">
                <label>
                  <span>字段名称</span>
                  <input v-model.trim="form.fulfillmentInputLabel" maxlength="80" placeholder="例如：充值账号" />
                </label>
                <label>
                  <span>填写提示</span>
                  <input v-model.trim="form.fulfillmentInputHint" maxlength="200" placeholder="例如：请核对后提交，不要填写密码" />
                </label>
              </div>
              <label class="checkbox-label">
                <input v-model="form.fulfillmentInputRequired" type="checkbox" />
                <span>客户下单时必须填写</span>
              </label>
            </div>
          </section>

          <!-- 库存、限购与上架 -->
          <section class="form-section" aria-labelledby="pe-stock">
            <header class="form-section-head">
              <h4 id="pe-stock" class="form-section-title">库存与销售规则</h4>
              <p class="form-section-desc">库存展示、限购与上架状态</p>
            </header>
            <div
              v-if="editing && form.fulfillmentMode === 'card' && editingStock !== undefined"
              class="stock-hint"
            >
              <span class="stock-hint-label">可用库存：{{ editingStock }}</span>
              <span class="stock-hint-desc">由卡密数量决定，不可直接编辑</span>
            </div>
            <div class="form-grid two-cols">
              <label>
                <span>前台库存展示</span>
                <select v-model="form.stockDisplayMode">
                  <option v-for="option in STOCK_DISPLAY_MODE_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option>
                </select>
              </label>
              <label>
                <span>限购数量（每邮箱）</span>
                <input v-model.trim="form.purchaseLimit" type="number" min="0" placeholder="留空或 0 表示不限购" />
              </label>
            </div>
            <div class="toggle-row">
              <label class="checkbox-label">
                <input v-model="form.purchaseLimitDisplay" type="checkbox" />
                <span>前台显示限购数量</span>
              </label>
              <label class="checkbox-label">
                <input v-model="form.active" type="checkbox" :disabled="form.currency !== 'CNY'" />
                <span>上架{{ form.currency !== 'CNY' ? '（仅 CNY 可上架）' : '' }}</span>
              </label>
            </div>
          </section>

          <fieldset v-if="!editing" class="storefront-fieldset">
            <legend>发布到展示渠道</legend>
            <div class="storefront-check-grid">
              <label v-for="storefront in storefronts" :key="storefront.id" class="checkbox-label">
                <input v-model="form.storefrontIds" type="checkbox" :value="storefront.id" />
                <span>{{ storefront.name }}{{ storefront.isDefault ? '（默认）' : '' }}</span>
              </label>
            </div>
            <small v-if="form.storefrontIds.length === 0" class="field-hint">未选渠道将保存为未发布草稿</small>
          </fieldset>
        </div>

        <div class="product-editor-footer modal-actions">
          <button type="button" class="btn btn-ghost" :disabled="saving || uploadingCover" @click="dialogVisible = false">取消</button>
          <button type="submit" class="btn btn-primary" :disabled="saving || uploadingCover">
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </div>
      </form>
    </AdminModal>

    <ConfirmDialog v-model="confirmVisible" :message="confirmMessage" danger @confirm="onConfirm" />
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { fetchAdminProducts, fetchAdminProductCategories, fetchAdminStorefronts, createAdminProductCategory, createAdminProduct, duplicateAdminProduct, updateAdminProduct, updateAdminStorefrontProduct, deleteAdminProduct, uploadAdminMediaImage } from '@/api/admin'
import type { AdminProduct, AdminProductCategory, AdminProductFilter, AdminStorefront } from '@/types/admin'
import { useToast } from '@/composables/useToast'
import { useTablePagination } from '@/composables/useTablePagination'
import { useAdminAuth } from '@/composables/useAdminAuth'
import { useTableSelection } from '@/composables/useTableSelection'
import { useAdminBatchOperation } from '@/composables/useAdminBatchOperation'
import AdminPagination from '@/components/AdminPagination.vue'
import AdminModal from '@/components/AdminModal.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import { writeClipboardText } from '@/composables/useClipboard'
import { downloadCsv } from '@/lib/csv-export'
import {
  CURRENCY_CODES,
  formatMoney,
  getCurrencyMeta,
  minorToMajorString,
  normalizeCurrencyCode,
  parseMajorToMinor,
  type CurrencyCode,
} from '@shared/money'
import { FULFILLMENT_INPUT_OPTIONS } from '@shared/fulfillment-input'
import {
  DELIVERY_VISIBILITY_OPTIONS,
  FULFILLMENT_MODE_OPTIONS,
  STOCK_DISPLAY_MODE_OPTIONS,
  fulfillmentModeLabel,
  stockDisplayModeLabel,
} from '@shared/product-contract'

const { showToast } = useToast()
const { token } = useAdminAuth()
const route = useRoute()
const router = useRouter()

const items = ref<AdminProduct[]>([])
const categoryOptions = ref<AdminProductCategory[]>([])
const storefronts = ref<AdminStorefront[]>([])
const loading = ref(false)
const filter = reactive<AdminProductFilter>({
  q: '',
  active: '',
  category: '',
  stock: '',
  storefrontId: '',
  page: 1,
  limit: 20,
})

const pagination = useTablePagination()

const dialogVisible = ref(false)
const editing = ref(false)
const saving = ref(false)
const loadError = ref('')
const deletingId = ref('')
const duplicatingId = ref('')
const savingSortKey = ref('')
const {
  operating: batchOperating,
  completed: batchCompleted,
  total: batchTotal,
  runSequential,
} = useAdminBatchOperation()
/** 当前编辑商品的库存（仅展示，不可编辑） */
const editingStock = ref<number | undefined>(undefined)
type ProductForm = {
  title: string
  description: string
  coverUrl: string
  priceMajor: string
  currency: CurrencyCode
  category: string
  fulfillmentMode: string
  deliveryVisibility: NonNullable<AdminProduct['deliveryVisibility']>
  stockDisplayMode: NonNullable<AdminProduct['stockDisplayMode']>
  salesCopy: string
  fulfillmentInputType: NonNullable<AdminProduct['fulfillmentInputType']>
  fulfillmentInputLabel: string
  fulfillmentInputHint: string
  fulfillmentInputRequired: boolean
  purchaseLimit: string
  purchaseLimitDisplay: boolean
  active: boolean
  storefrontIds: string[]
}

const form = reactive<ProductForm>({
  title: '',
  description: '',
  coverUrl: '',
  priceMajor: '0.00',
  currency: 'CNY' as CurrencyCode,
  category: '',
  fulfillmentMode: 'card',
  deliveryVisibility: 'web_and_email',
  stockDisplayMode: 'exact',
  salesCopy: '',
  fulfillmentInputType: 'none',
  fulfillmentInputLabel: '',
  fulfillmentInputHint: '',
  fulfillmentInputRequired: false,
  purchaseLimit: '',
  purchaseLimitDisplay: false,
  active: true,
  storefrontIds: [],
})
const brokenCoverIds = ref<Record<string, boolean>>({})
const coverPreviewFailed = ref(false)
const uploadingCover = ref(false)
let editingId = ''

const currencyOptions = CURRENCY_CODES.map((code) => getCurrencyMeta(code))
const currentCurrencyMeta = computed(() => getCurrencyMeta(form.currency))
const priceInputUnit = computed(() => {
  if (form.currency === 'CNY') return '元'
  if (form.currency === 'JPY') return '日元'
  if (form.currency === 'KRW') return '韩元'
  return form.currency
})
const pricePreview = computed(() => {
  try {
    return formatMoney(parseMajorToMinor(form.priceMajor, form.currency), form.currency)
  } catch {
    return ''
  }
})
const isFreeProductPrice = computed(() => {
  try {
    return parseMajorToMinor(form.priceMajor, form.currency) === 0
  } catch {
    return false
  }
})
const currencyPaymentHint = computed(() => form.currency === 'CNY'
  ? `金额会按 ${currentCurrencyMeta.value.exponent} 位小数精确保存；数据库继续使用兼容字段 priceCents，实际语义为币种最小单位。`
  : `${form.currency} 已建立输入和展示规则，但当前支付、余额、充值和固定通用优惠仍仅支持 CNY；该商品只能保存为下架草稿。`)

const fulfillmentModeGuide = computed(() => {
  const mode = form.fulfillmentMode || 'card'
  const guides: Record<string, string> = {
    card: '卡密模式：每卖出一次消耗一条独立库存，适合账号、密码、序列号等一客一份的商品。',
    virtual: '虚拟资料：统一文本内容直接交付，适合资料包、说明文档、下载说明等。',
    link: '链接交付：适合网盘、邀请页、下载页等统一链接内容。',
    code: '兑换码：适合同一类兑换内容，但每单仍按当前配置返回商品交付内容。',
    invite: '邀请码：适合社群、平台、工具类邀请场景，建议在交付内容中写清使用说明。',
  }
  return guides[mode] || '请选择与商品交付方式最接近的模式。'
})

const { confirmVisible, confirmMessage, askConfirm, onConfirm } = useConfirmDialog()

const visibleItems = computed(() => {
  return items.value
})
const activeStorefrontName = computed(() => {
  if (!filter.storefrontId) return ''
  return storefrontName(filter.storefrontId)
})
const selectedItems = computed(() => {
  const selected = new Set(selectedIds.value)
  return visibleItems.value.filter((item) => selected.has(item.id))
})

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

let loadSequence = 0

async function loadData() {
  const sequence = ++loadSequence
  loading.value = true
  loadError.value = ''
  try {
    const res = await fetchAdminProducts(token.value, {
      ...filter,
      page: pagination.page.value,
      limit: pagination.limit.value,
    })
    if (sequence !== loadSequence) return
    if (pagination.setTotal(res.total)) return loadData()
    items.value = res.products
    brokenCoverIds.value = {}
    clearSelection()
  } catch (err: any) {
    if (sequence !== loadSequence) return
    items.value = []
    clearSelection()
    loadError.value = err.message || '加载商品失败'
    showToast(err.message || '加载商品失败', 'error')
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}

async function loadCategories() {
  try {
    const res = await fetchAdminProductCategories(token.value)
    categoryOptions.value = res.categories
  } catch (err: any) {
    showToast(err.message || '加载分类失败', 'error')
  }
}

async function loadStorefronts() {
  try {
    storefronts.value = (await fetchAdminStorefronts(token.value)).storefronts
  } catch (error) {
    showToast(error instanceof Error ? error.message : '加载展示渠道失败', 'error')
  }
}

function storefrontName(id: string) {
  return storefronts.value.find(item => item.id === id)?.name || id
}

function productStorefronts(item: AdminProduct): NonNullable<AdminProduct['storefronts']> {
  if (item.storefronts?.length) return item.storefronts
  return (item.storefrontIds || []).map(id => ({ id, name: storefrontName(id), visible: true, sortOrder: undefined }))
}

function currentStorefrontMapping(item: AdminProduct) {
  if (!filter.storefrontId) return undefined
  return productStorefronts(item).find(storefront => storefront.id === filter.storefrontId)
}

function storefrontSortKey(item: AdminProduct) {
  return `${filter.storefrontId}:${item.id}`
}

async function saveCurrentStorefrontSort(item: AdminProduct, rawValue: string) {
  const storefrontId = filter.storefrontId
  const mapping = currentStorefrontMapping(item)
  if (!storefrontId || !mapping) return
  const parsed = Number(rawValue)
  if (!Number.isFinite(parsed)) {
    showToast('排序值必须是数字', 'error')
    return
  }
  const sortOrder = Math.trunc(parsed)
  if (sortOrder < 0 || sortOrder > 99999) {
    showToast('排序值必须在 0 到 99999 之间', 'error')
    return
  }
  if (sortOrder === mapping.sortOrder) return
  const key = storefrontSortKey(item)
  savingSortKey.value = key
  try {
    await updateAdminStorefrontProduct(token.value, storefrontId, item.id, { sortOrder })
    mapping.sortOrder = sortOrder
    showToast('渠道排序已保存', 'success')
    await loadData()
  } catch (err: any) {
    showToast(err.message || '保存渠道排序失败', 'error')
  } finally {
    if (savingSortKey.value === key) savingSortKey.value = ''
  }
}

function goStorefrontSort(item: AdminProduct) {
  const targetStorefrontId = filter.storefrontId || productStorefronts(item)[0]?.id || ''
  const query = targetStorefrontId ? { storefrontId: targetStorefrontId, productId: item.id } : { productId: item.id }
  void router.push({ path: '/admin/storefronts', query })
}

async function ensureCategoryExists() {
  const name = (form.category || '').trim()
  if (!name) return
  if (categoryOptions.value.some(category => category.name === name)) return
  await createAdminProductCategory(token.value, { name })
  await loadCategories()
}

function searchData() {
  pagination.page.value = 1
  const query: Record<string, string> = {}
  if (filter.q) query.q = filter.q
  if (filter.active) query.active = filter.active
  if (filter.category) query.category = filter.category
  if (filter.stock) query.stock = filter.stock
  if (filter.storefrontId) query.storefrontId = filter.storefrontId
  const target = router.resolve({ path: route.path, query }).fullPath
  if (target === route.fullPath) {
    void loadData()
    return
  }
  void router.replace({ path: route.path, query })
}

function initFilterFromRoute() {
  filter.q = String(route.query.q || '')
  filter.active = String(route.query.active || '')
  filter.category = String(route.query.category || '')
  filter.stock = String(route.query.stock || '')
  filter.storefrontId = String(route.query.storefrontId || '')
  if (route.query.lowStock === 'true') {
    filter.active = 'true'
    filter.stock = 'low'
  }
}

function openDialog(item?: AdminProduct) {
  if (item) {
    let currency: CurrencyCode
    try {
      currency = normalizeCurrencyCode(item.currency || 'CNY')
    } catch {
      showToast(`商品 ${item.id} 的币种配置无效，请先通过数据修复工具处理`, 'error')
      return
    }
    editing.value = true
    editingId = item.id
    editingStock.value = item.stock
    Object.assign(form, {
      title: item.title,
      description: item.description || '',
      coverUrl: item.coverUrl || '',
      priceMajor: minorToMajorString(item.priceCents, currency),
      currency,
      category: item.category || '',
      fulfillmentMode: item.fulfillmentMode || 'card',
      deliveryVisibility: item.deliveryVisibility || 'web_and_email',
      stockDisplayMode: item.stockDisplayMode || 'exact',
      salesCopy: item.salesCopy || '',
      fulfillmentInputType: item.fulfillmentInputType || 'none',
      fulfillmentInputLabel: item.fulfillmentInputLabel || '',
      fulfillmentInputHint: item.fulfillmentInputHint || '',
      fulfillmentInputRequired: item.fulfillmentInputRequired ?? false,
      purchaseLimit: item.purchaseLimit == null ? '' : String(item.purchaseLimit),
      purchaseLimitDisplay: item.purchaseLimitDisplay === true,
      active: item.active !== false,
      storefrontIds: item.storefrontIds || [],
    })
  } else {
    editing.value = false
    editingId = ''
    editingStock.value = undefined
    Object.assign(form, {
      title: '',
      description: '',
      coverUrl: '',
      priceMajor: '0.00',
      currency: 'CNY',
      category: '',
      fulfillmentMode: 'card',
      deliveryVisibility: 'web_and_email',
      stockDisplayMode: 'exact',
      salesCopy: '',
      fulfillmentInputType: 'none',
      fulfillmentInputLabel: '',
      fulfillmentInputHint: '',
      fulfillmentInputRequired: false,
      purchaseLimit: '',
      purchaseLimitDisplay: false,
      active: true,
      storefrontIds: storefronts.value.filter(item => item.isDefault).map(item => item.id),
    })
  }
  coverPreviewFailed.value = false
  dialogVisible.value = true
}

function normalizedPurchaseLimit(): number | null {
  const raw = String(form.purchaseLimit || '').trim()
  if (!raw) return null
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return null
  const value = Math.trunc(parsed)
  return value > 0 ? value : null
}

async function uploadCoverImage(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || uploadingCover.value) return

  uploadingCover.value = true
  try {
    const result = await uploadAdminMediaImage(token.value, file)
    form.coverUrl = result.url
    coverPreviewFailed.value = false
    showToast('商品图片已上传', 'success')
  } catch (error) {
    showToast(error instanceof Error ? error.message : '图片上传失败', 'error')
  } finally {
    uploadingCover.value = false
  }
}

async function save() {
  if (saving.value || uploadingCover.value) return
  let priceCents: number
  try {
    priceCents = parseMajorToMinor(form.priceMajor, form.currency)
  } catch (err) {
    showToast(err instanceof Error ? `价格格式无效：${err.message}` : '价格格式无效', 'error')
    return
  }
  if (form.currency !== 'CNY' && form.active) {
    showToast('当前支付链路仅支持 CNY，非 CNY 商品必须保持下架', 'error')
    return
  }
  saving.value = true
  try {
    await ensureCategoryExists()
    const purchaseLimit = normalizedPurchaseLimit()
    const payload: Partial<AdminProduct> & Pick<AdminProduct, 'title' | 'priceCents'> = {
      title: form.title,
      description: form.description,
      coverUrl: form.coverUrl,
      priceCents,
      currency: form.currency,
      category: form.category,
      fulfillmentMode: form.fulfillmentMode,
      deliveryVisibility: form.deliveryVisibility,
      stockDisplayMode: form.stockDisplayMode,
      salesCopy: form.salesCopy,
      fulfillmentInputType: form.fulfillmentInputType,
      fulfillmentInputLabel: form.fulfillmentInputLabel,
      fulfillmentInputHint: form.fulfillmentInputHint,
      fulfillmentInputRequired: form.fulfillmentInputRequired,
      purchaseLimit,
      purchaseLimitDisplay: purchaseLimit !== null && form.purchaseLimitDisplay,
      active: form.active,
    }
    if (editing.value) {
      await updateAdminProduct(token.value, editingId, payload)
      showToast('已保存', 'success')
    } else {
      const res = await createAdminProduct(token.value, { ...payload, storefrontIds: form.storefrontIds })
      showToast(`已创建，系统编号：${res.productId}`, 'success')
    }
    dialogVisible.value = false
    loadCategories()
    loadData()
  } catch (err: any) {
    showToast(err.message || '保存失败', 'error')
  } finally {
    saving.value = false
  }
}

function handleFulfillmentInputTypeChange() {
  if (form.fulfillmentInputType === 'none') {
    form.fulfillmentInputLabel = ''
    form.fulfillmentInputHint = ''
    form.fulfillmentInputRequired = false
    return
  }
  if (!form.fulfillmentInputLabel.trim()) form.fulfillmentInputLabel = ''
  form.fulfillmentInputRequired = true
}

async function remove(id: string) {
  if (deletingId.value || batchOperating.value) return
  if (!(await askConfirm('确认删除该商品？'))) return
  deletingId.value = id
  try {
    await deleteAdminProduct(token.value, id)
    showToast('已删除', 'success')
    loadData()
  } catch (err: any) {
    showToast(err.message || '删除失败', 'error')
  } finally {
    deletingId.value = ''
  }
}

async function batchSetActive(active: boolean) {
  const ids = selectedIds.value.slice()
  if (ids.length === 0 || loading.value || batchOperating.value) return
  if (!(await askConfirm(`确认${active ? '上架' : '下架'}选中的 ${ids.length} 个商品？`))) return
  const result = await runSequential(ids, async (id) => {
    await updateAdminProduct(token.value, id, { active })
  })
  if (!result) return
  showToast(`批量${active ? '上架' : '下架'}完成：成功 ${result.success}，失败 ${result.failed}`, result.failed ? 'error' : 'success')
  await loadData()
  selectedIds.value = result.failedItems
}

async function batchRemove() {
  const ids = selectedIds.value.slice()
  if (ids.length === 0 || loading.value || batchOperating.value) return
  if (!(await askConfirm(`确认删除选中的 ${ids.length} 个商品？`))) return
  const result = await runSequential(ids, async (id) => {
    deletingId.value = id
    await deleteAdminProduct(token.value, id)
  })
  deletingId.value = ''
  if (!result) return
  showToast(`批量删除完成：成功 ${result.success}，失败 ${result.failed}`, result.failed ? 'error' : 'success')
  await loadData()
  selectedIds.value = result.failedItems
}

function productLine(item: AdminProduct) {
  const currency = item.currency || 'CNY'
  return [item.id, item.title, item.category || '', minorToMajorString(item.priceCents, currency), currency, String(item.stock ?? ''), String(item.purchasedCount ?? 0), item.active ? '上架' : '下架'].join('\t')
}

function markCoverBroken(id: string) {
  brokenCoverIds.value = { ...brokenCoverIds.value, [id]: true }
}

async function duplicateProductRow(item: AdminProduct) {
  if (duplicatingId.value || saving.value || loading.value || batchOperating.value) return
  duplicatingId.value = item.id
  try {
    const res = await duplicateAdminProduct(token.value, item.id)
    showToast(`已拷贝为新商品：${res.productId}`, 'success')
    await loadData()
  } catch (err: any) {
    showToast(err.message || '拷贝商品失败', 'error')
  } finally {
    duplicatingId.value = ''
  }
}

async function copySelectedProducts() {
  try { await writeClipboardText(selectedItems.value.map(productLine).join('\n')); showToast(`已复制 ${selectedItems.value.length} 个商品`, 'success') }
  catch { showToast('复制失败，请使用导出功能', 'error') }
}

function exportSelectedProducts() {
  downloadCsv(`selected-products-${new Date().toISOString().slice(0, 10)}.csv`, [
    ['id', 'title', 'category', 'priceCents', 'currency', 'stock', 'purchasedCount', 'fulfillmentMode', 'purchaseLimit', 'purchaseLimitDisplay', 'active'],
    ...selectedItems.value.map((item) => [item.id, item.title, item.category || '', String(item.priceCents), item.currency || 'CNY', String(item.stock ?? ''), String(item.purchasedCount ?? 0), item.fulfillmentMode || '', String(item.purchaseLimit ?? ''), String(item.purchaseLimitDisplay === true), String(item.active ?? true)]),
  ])
  showToast(`已导出 ${selectedItems.value.length} 个商品`, 'success')
}

function fulfillmentModeText(mode?: string) {
  return fulfillmentModeLabel(mode) || mode || '-'
}

function stockDisplayModeText(mode?: AdminProduct['stockDisplayMode']) {
  return stockDisplayModeLabel(mode || 'exact') || '精确库存'
}

function purchaseLimitText(limit?: number | null) {
  if (limit == null || limit === undefined) return '-'
  if (limit <= 0) return '-'
  return `${limit} 次`
}

function formatProductMoney(item: AdminProduct) {
  try {
    return formatMoney(item.priceCents, item.currency || 'CNY')
  } catch {
    return `${item.currency || 'UNKNOWN'} ${item.priceCents}（配置异常）`
  }
}

onMounted(() => {
  initFilterFromRoute()
  loadCategories()
  loadStorefronts()
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

watch(
  () => form.currency,
  (currency) => {
    if (currency !== 'CNY') form.active = false
    if (getCurrencyMeta(currency).exponent === 0 && form.priceMajor.includes('.')) {
      form.priceMajor = /^\d+\.0+$/.test(form.priceMajor)
        ? form.priceMajor.split('.')[0]
        : '0'
    }
  },
)

watch(() => form.coverUrl, () => {
  coverPreviewFailed.value = false
})
</script>

<style>@import '@/assets/admin.css';</style>
<style scoped>
.cover-cell {
  width: 68px;
}

.product-cover-thumb {
  display: block;
  object-fit: cover;
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 6px;
  background: var(--tg-secondary-bg, #fff);
}

/* ── 商品编辑弹窗：分区、双列、固定脚部 ── */
.product-editor-form {
  gap: 0;
  min-height: 0;
  flex: 1 1 auto;
  max-height: min(78dvh, 720px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.product-editor-scroll {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 0;
  flex: 1 1 auto;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding-right: 2px;
  padding-bottom: 4px;
}

.form-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 12px 14px;
  border: 0.5px solid var(--border, rgba(255, 255, 255, 0.12));
  border-radius: var(--r-md, 8px);
  background: var(--tg-secondary-bg, rgba(0, 0, 0, 0.18));
}

.form-section-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-bottom: 2px;
  border-bottom: 0.5px solid var(--border, rgba(255, 255, 255, 0.08));
  margin-bottom: 2px;
}

.form-section-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--tg-text, #e5e7eb);
}

.form-section-desc {
  margin: 0;
  font-size: 11px;
  line-height: 1.4;
  color: var(--tg-hint, #9ca3af);
}

.form-grid {
  display: grid;
  gap: 10px 12px;
}

.form-grid.two-cols {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.form-grid .field-span-2 {
  grid-column: 1 / -1;
}

.product-editor-form :deep(.field-hint),
.product-editor-form .field-hint {
  display: block;
  margin-top: 2px;
  color: var(--tg-hint, #9ca3af);
  font-size: 11px;
  line-height: 1.4;
  font-weight: 400;
}

.media-price-layout {
  display: grid;
  grid-template-columns: minmax(160px, 0.9fr) minmax(0, 1.2fr);
  gap: 14px;
  align-items: start;
}

.cover-panel,
.price-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.cover-preview-frame {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: var(--r-md, 8px);
  border: 0.5px dashed var(--border, rgba(255, 255, 255, 0.2));
  background: var(--tg-bg, #0b1220);
  overflow: hidden;
}

.cover-preview-frame.has-image {
  border-style: solid;
}

.cover-preview {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border: none;
  border-radius: 0;
  background: transparent;
}

.cover-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 12px;
  color: var(--tg-hint, #9ca3af);
  font-size: 12px;
  text-align: center;
}

.cover-empty small {
  font-size: 11px;
  opacity: 0.85;
}

.image-upload-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.image-upload-button {
  position: relative;
  overflow: hidden;
  cursor: pointer;
}

.image-upload-button.is-disabled {
  cursor: wait;
  opacity: 0.65;
}

.image-upload-button input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}

.product-cover-thumb {
  width: 48px;
  height: 48px;
}

.cover-placeholder {
  color: var(--tg-hint, #6b7280);
  font-size: 12px;
  white-space: nowrap;
}

.price-preview-line {
  margin: 0;
  font-size: 12px;
  line-height: 1.4;
  color: var(--tg-text, #e5e7eb);
}

.price-preview-line strong {
  font-weight: 600;
  color: var(--tg-btn, #60a5fa);
}

.inline-callout {
  margin: 0;
  padding: 8px 10px;
  border-radius: var(--r-md, 8px);
  background: rgba(96, 165, 250, 0.1);
  border: 0.5px solid rgba(96, 165, 250, 0.22);
  color: var(--tg-hint, #cbd5e1);
  font-size: 11px;
  line-height: 1.45;
}

.fulfillment-input-box {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border-radius: var(--r-md, 8px);
  border: 0.5px solid var(--border, rgba(255, 255, 255, 0.1));
  background: var(--tg-bg, rgba(0, 0, 0, 0.15));
}

.toggle-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px 18px;
}

.storefront-check-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 14px;
}

.product-editor-footer.modal-actions {
  flex: 0 0 auto;
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 0;
  padding-top: 12px;
  border-top: 0.5px solid var(--border, rgba(255, 255, 255, 0.12));
  background: var(--tg-bg, #0f172a);
}

@media (max-width: 640px) {
  .form-grid.two-cols,
  .media-price-layout {
    grid-template-columns: 1fr;
  }

  .form-section {
    padding: 10px;
  }
}

.sort-context {
  margin: -4px 0 10px;
  color: var(--admin-text-muted, #6b7280);
  font-size: 12px;
  line-height: 1.5;
}

.mode-cell {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.channel-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  min-width: 120px;
}

.channel-sort-tag {
  align-items: center;
  gap: 4px;
  border-radius: 6px;
  white-space: nowrap;
}

.channel-sort-tag small {
  font-size: 11px;
  opacity: 0.8;
}

.channel-inline-sort {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  font-size: 12px;
  color: var(--tg-hint, #6b7280);
  white-space: nowrap;
}

.channel-inline-sort input {
  width: 68px;
  min-height: 28px;
  padding: 3px 6px;
  color: var(--tg-text, #e5e7eb);
  background: var(--tg-secondary-bg, #111827);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.18));
  border-radius: 6px;
  caret-color: var(--tg-btn, #60a5fa);
}

.channel-inline-sort input:focus {
  border-color: var(--tg-btn, #60a5fa);
}

.channel-inline-sort input:disabled {
  opacity: 0.65;
  cursor: wait;
}

.product-status {
  min-width: 42px;
  justify-content: center;
  border-radius: 6px;
  padding-inline: 8px;
}

.storefront-fieldset {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 10px 12px 12px;
  border: 0.5px solid var(--border, rgba(255, 255, 255, 0.12));
  border-radius: var(--r-md, 8px);
  background: var(--tg-secondary-bg, rgba(0, 0, 0, 0.18));
}

.storefront-fieldset legend {
  padding: 0 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--tg-text, #e5e7eb);
}

.mode-tag {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  padding: 2px 6px;
  border-radius: var(--r-full, 999px);
  font-size: 11px;
  line-height: 1.4;
  border: 0.5px solid transparent;
  white-space: nowrap;
}

.mode-tag-success {
  color: #22c55e;
  background: rgba(34, 197, 94, 0.12);
  border-color: rgba(34, 197, 94, 0.2);
}

.mode-tag-warn {
  color: #f59e0b;
  background: rgba(245, 158, 11, 0.12);
  border-color: rgba(245, 158, 11, 0.22);
}

.mode-tag-info {
  color: #38bdf8;
  background: rgba(14, 165, 233, 0.12);
  border-color: rgba(14, 165, 233, 0.22);
}

/* 库存只读提示行（页面专属样式） */
.stock-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  background: rgba(245, 158, 11, 0.08);
  border-radius: var(--r-md, 8px);
  font-size: 12px;
}

.stock-hint-label {
  font-weight: 600;
  color: var(--tg-text, #333);
}

.stock-hint-desc {
  color: var(--tg-hint, #999);
  font-size: 12px;
}
</style>
