<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <input v-model="query" type="search" placeholder="搜索名称或 slug" aria-label="搜索展示渠道" />
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-primary btn-sm" type="button" @click="openEditor()">新建渠道</button>
      </div>
    </div>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" type="button" :disabled="loading" @click="loadData">重新加载</button>
    </div>

    <div class="table-wrap" role="region" aria-label="展示渠道列表" tabindex="0" :aria-busy="loading">
      <table class="admin-table">
        <thead>
          <tr>
            <th>渠道</th>
            <th>路径</th>
            <th>模板</th>
            <th>状态</th>
            <th>商品</th>
            <th>历史订单</th>
            <th>更新时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="i in 4" :key="i" class="skeleton-row"><td colspan="8"><div class="skeleton-cell" /></td></tr>
        </tbody>
        <tbody v-else>
          <tr v-for="item in filteredItems" :key="item.id">
            <td>
              <div class="channel-name">
                <img v-if="item.logoUrl" :src="item.logoUrl" alt="" class="channel-logo" />
                <span>{{ item.name }}</span>
                <span v-if="item.isDefault" class="tag tag-info">默认</span>
              </div>
            </td>
            <td><code>{{ item.homePath }}</code></td>
            <td><span class="tag tag-muted">{{ templateLabel(item.templateKey) }}</span></td>
            <td><span class="tag" :class="item.active ? 'tag-success' : 'tag-muted'">{{ item.active ? '启用' : '停用' }}</span></td>
            <td>{{ item.productCount }}</td>
            <td>{{ item.orderCount }}</td>
            <td>{{ formatDate(item.updatedAt) }}</td>
            <td>
              <div class="table-actions channel-actions">
                <button class="btn btn-ghost btn-xs" type="button" @click="preview(item)">预览</button>
                <button class="btn btn-ghost btn-xs" type="button" @click="copyUrl(item)">复制 URL</button>
                <button class="btn btn-ghost btn-xs" type="button" @click="openEditor(item)">编辑</button>
                <button class="btn btn-ghost btn-xs" type="button" @click="openProducts(item)">选择商品（{{ item.productCount }}）</button>
                <button v-if="!item.isDefault" class="btn btn-ghost btn-xs" type="button" @click="makeDefault(item)">设为默认</button>
                <button v-if="!item.isDefault" class="btn btn-ghost btn-xs" type="button" @click="toggleActive(item)">{{ item.active ? '停用' : '启用' }}</button>
                <button v-if="!item.isDefault && item.orderCount === 0" class="btn btn-danger btn-xs" type="button" @click="remove(item)">删除</button>
              </div>
            </td>
          </tr>
          <tr v-if="filteredItems.length === 0"><td colspan="8" class="empty-text">暂无展示渠道</td></tr>
        </tbody>
      </table>
    </div>

    <AdminModal v-model="editorVisible" :title="editingId ? '编辑展示渠道' : '新建展示渠道'" max-width="560px" hide-actions>
      <form class="modal-form" @submit.prevent="saveEditor">
        <label>
          <span>名称</span>
          <input v-model.trim="form.name" required maxlength="60" autocomplete="off" />
        </label>
        <label>
          <span>slug</span>
          <input v-model.trim="form.slug" :disabled="Boolean(editingId)" required minlength="2" maxlength="48" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" autocomplete="off" />
        </label>
        <label>
          <span>页面模板</span>
          <select v-model="form.templateKey">
            <option value="catalog">catalog · 图片卡片模板</option>
            <option value="compact">compact · 紧凑列表模板</option>
          </select>
          <small class="field-hint">图片卡片适合默认综合商店；紧凑列表适合卡密、兑换码等信息型商品。</small>
        </label>
        <label>
          <span>Logo URL</span>
          <input v-model.trim="form.logoUrl" type="text" inputmode="url" maxlength="500" placeholder="https:// 或上传 Logo 后自动填写" autocomplete="url" />
        </label>
        <div class="image-upload-row">
          <label class="btn btn-ghost btn-sm image-upload-button" :class="{ 'is-disabled': uploadingLogo }">
            {{ uploadingLogo ? '上传中…' : '上传 Logo' }}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,image/avif"
              :disabled="uploadingLogo"
              @change="uploadLogoImage"
            />
          </label>
          <span class="field-hint">JPEG、PNG、WebP 或 AVIF，最大 5MiB</span>
        </div>
        <img v-if="form.logoUrl" :src="form.logoUrl" alt="Logo 预览" class="logo-preview" />
        <label>
          <span>客服邮箱</span>
          <input v-model.trim="form.supportEmail" type="email" maxlength="160" autocomplete="email" />
        </label>
        <label>
          <span>排序</span>
          <input v-model.number="form.sortOrder" type="number" min="0" max="99999" step="1" required />
        </label>
        <label v-if="!editingDefault" class="checkbox-label">
          <input v-model="form.active" type="checkbox" />
          <span>启用渠道</span>
        </label>
        <div class="modal-actions">
          <button class="btn btn-ghost" type="button" :disabled="saving || uploadingLogo" @click="editorVisible = false">取消</button>
          <button class="btn btn-primary" type="submit" :disabled="saving || uploadingLogo">{{ saving ? '保存中…' : '保存' }}</button>
        </div>
      </form>
    </AdminModal>

    <AdminModal v-model="productsVisible" :title="`管理商品 · ${currentStorefront?.name || ''}`" max-width="760px" hide-actions>
      <div class="mapping-panel">
        <div class="mapping-toolbar">
          <input v-model="productQuery" type="search" placeholder="搜索商品" aria-label="搜索渠道商品" />
          <span class="muted-text">已选 {{ selectedProductCount }} 个</span>
          <button class="btn btn-ghost btn-sm" type="button" @click="selectFilteredProducts(true)">选择筛选项</button>
          <button class="btn btn-ghost btn-sm" type="button" @click="selectFilteredProducts(false)">取消筛选项</button>
        </div>
        <div v-if="productsLoading" class="empty-text">加载中…</div>
        <div v-else class="mapping-list">
          <div v-for="row in filteredProductRows" :key="row.product.id" class="mapping-row">
            <label class="mapping-product">
              <input v-model="row.selected" type="checkbox" />
              <span>{{ row.product.title }}</span>
              <code>{{ row.product.id }}</code>
            </label>
            <label class="mapping-visible">
              <input v-model="row.visible" type="checkbox" :disabled="!row.selected" />
              <span>可见</span>
            </label>
            <label class="mapping-sort">
              <span>排序</span>
              <input v-model.number="row.sortOrder" type="number" min="0" max="99999" step="1" :disabled="!row.selected" />
            </label>
            <button
              class="btn btn-ghost btn-xs"
              type="button"
              title="复制该渠道下的用户购买链接"
              :disabled="!row.selected || !row.visible || !currentStorefront?.active || row.product.active === false"
              @click="copyProductBuyLink(row)"
            >
              购买链接
            </button>
          </div>
          <div v-if="filteredProductRows.length === 0" class="empty-text">没有匹配商品</div>
        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost" type="button" :disabled="savingProducts" @click="productsVisible = false">取消</button>
          <button class="btn btn-primary" type="button" :disabled="savingProducts || productsLoading" @click="saveProducts">{{ savingProducts ? '保存中…' : '保存商品映射' }}</button>
        </div>
      </div>
    </AdminModal>

    <ConfirmDialog v-model="confirmVisible" :message="confirmMessage" @confirm="onConfirm" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import {
  createAdminStorefront,
  deleteAdminStorefront,
  fetchAdminProducts,
  fetchAdminStorefront,
  fetchAdminStorefronts,
  replaceAdminStorefrontProducts,
  setAdminDefaultStorefront,
  updateAdminStorefront,
  uploadAdminMediaImage,
} from '@/api/admin'
import type { StorefrontTemplate } from '@/types'
import type { AdminProduct, AdminStorefront } from '@/types/admin'
import AdminModal from '@/components/AdminModal.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { useAdminAuth } from '@/composables/useAdminAuth'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import { useToast } from '@/composables/useToast'
import { formatDate } from '@/composables/useFormat'
import { writeClipboardText } from '@/composables/useClipboard'
import {
  adminBuyLinkFailureMessage,
  resolveAdminBuyLink,
} from '@/lib/resolve-admin-buy-link'

type MappingRow = {
  product: AdminProduct
  selected: boolean
  visible: boolean
  sortOrder: number
}

const { token } = useAdminAuth()
const { showToast } = useToast()
const { confirmVisible, confirmMessage, askConfirm, onConfirm } = useConfirmDialog()
const route = useRoute()
const items = ref<AdminStorefront[]>([])
const loading = ref(false)
const loadError = ref('')
const query = ref('')
const editorVisible = ref(false)
const saving = ref(false)
const uploadingLogo = ref(false)
const editingId = ref('')
const editingDefault = ref(false)
const productsVisible = ref(false)
const productsLoading = ref(false)
const savingProducts = ref(false)
const currentStorefront = ref<AdminStorefront | null>(null)
const productRows = ref<MappingRow[]>([])
const productQuery = ref('')

const form = reactive<{
  slug: string
  name: string
  logoUrl: string
  supportEmail: string
  templateKey: StorefrontTemplate
  active: boolean
  sortOrder: number
}>({
  slug: '',
  name: '',
  logoUrl: '',
  supportEmail: '',
  templateKey: 'compact',
  active: true,
  sortOrder: 100,
})

const filteredItems = computed(() => {
  const value = query.value.trim().toLowerCase()
  if (!value) return items.value
  return items.value.filter(item => item.name.toLowerCase().includes(value) || item.slug.toLowerCase().includes(value))
})

const filteredProductRows = computed(() => {
  const value = productQuery.value.trim().toLowerCase()
  if (!value) return productRows.value
  return productRows.value.filter(row => row.product.title.toLowerCase().includes(value) || row.product.id.toLowerCase().includes(value))
})
const selectedProductCount = computed(() => productRows.value.filter(row => row.selected).length)

function templateLabel(templateKey: StorefrontTemplate) {
  return templateKey === 'compact' ? 'compact · 紧凑列表模板' : 'catalog · 图片卡片模板'
}

async function loadData() {
  loading.value = true
  loadError.value = ''
  try {
    const result = await fetchAdminStorefronts(token.value)
    items.value = result.storefronts
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : '加载展示渠道失败'
    showToast(loadError.value, 'error')
  } finally {
    loading.value = false
  }
}

async function openProductsFromQuery() {
  const storefrontId = String(route.query.storefrontId || '')
  const productId = String(route.query.productId || '')
  if (!storefrontId && !productId) return
  const target = storefrontId
    ? items.value.find(item => item.id === storefrontId)
    : items.value.find(item => item.isDefault) || items.value[0]
  if (!target) return
  await openProducts(target)
  if (productId) productQuery.value = productId
}

function openEditor(item?: AdminStorefront) {
  editingId.value = item?.id || ''
  editingDefault.value = item?.isDefault || false
  Object.assign(form, item
    ? { slug: item.slug, name: item.name, logoUrl: item.logoUrl, supportEmail: item.supportEmail, templateKey: item.templateKey, active: item.active, sortOrder: item.sortOrder }
    : { slug: '', name: '', logoUrl: '', supportEmail: '', templateKey: 'compact', active: true, sortOrder: 100 })
  editorVisible.value = true
}

async function uploadLogoImage(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || uploadingLogo.value) return

  uploadingLogo.value = true
  try {
    const result = await uploadAdminMediaImage(token.value, file)
    form.logoUrl = result.url
    showToast('渠道 Logo 已上传', 'success')
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Logo 上传失败', 'error')
  } finally {
    uploadingLogo.value = false
  }
}

async function saveEditor() {
  if (saving.value || uploadingLogo.value) return
  saving.value = true
  try {
    if (editingId.value) {
      await updateAdminStorefront(token.value, editingId.value, {
        name: form.name,
        logoUrl: form.logoUrl,
        supportEmail: form.supportEmail,
        templateKey: form.templateKey,
        active: editingDefault.value ? true : form.active,
        sortOrder: form.sortOrder,
      })
    } else {
      await createAdminStorefront(token.value, { ...form, slug: form.slug.toLowerCase() })
    }
    editorVisible.value = false
    showToast('展示渠道已保存', 'success')
    await loadData()
  } catch (error) {
    showToast(error instanceof Error ? error.message : '保存失败', 'error')
  } finally {
    saving.value = false
  }
}

async function loadAllProducts(): Promise<AdminProduct[]> {
  const result: AdminProduct[] = []
  for (let page = 1; page <= 100; page += 1) {
    const response = await fetchAdminProducts(token.value, { page, limit: 100 })
    result.push(...response.products)
    if (result.length >= response.total) return result
  }
  throw new Error('商品数量超过管理上限，请先使用商品筛选进行整理')
}

async function openProducts(item: AdminStorefront) {
  currentStorefront.value = item
  productQuery.value = ''
  productRows.value = []
  productsVisible.value = true
  productsLoading.value = true
  try {
    const [detail, products] = await Promise.all([fetchAdminStorefront(token.value, item.id), loadAllProducts()])
    const mapping = new Map(detail.products.map(entry => [entry.productId, entry]))
    productRows.value = products.map((product, index) => {
      const existing = mapping.get(product.id)
      return {
        product,
        selected: Boolean(existing),
        visible: existing?.visible ?? true,
        sortOrder: existing?.sortOrder ?? ((index + 1) * 10),
      }
    }).sort(compareMappingRows)
  } catch (error) {
    showToast(error instanceof Error ? error.message : '加载渠道商品失败', 'error')
    productsVisible.value = false
  } finally {
    productsLoading.value = false
  }
}

function compareMappingRows(a: MappingRow, b: MappingRow) {
  if (a.selected !== b.selected) return a.selected ? -1 : 1
  if (a.selected && b.selected && a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder
  return a.product.title.localeCompare(b.product.title, 'zh-Hans-CN')
}

function selectFilteredProducts(selected: boolean) {
  for (const row of filteredProductRows.value) row.selected = selected
  productRows.value = productRows.value.slice().sort(compareMappingRows)
}

async function saveProducts() {
  if (!currentStorefront.value || savingProducts.value) return
  savingProducts.value = true
  try {
    const products = productRows.value
      .filter(row => row.selected)
      .map(row => ({ productId: row.product.id, visible: row.visible, sortOrder: row.sortOrder }))
    const visibleProducts = products.filter(product => product.visible)
    // 默认 /shop 是公共商品入口，保存为空会直接呈现空页面。
    // 允许管理员明确确认该结果，但避免筛选或批量操作造成静默下线。
    let allowEmptyDefault = false
    if (currentStorefront.value.isDefault && visibleProducts.length === 0) {
      if (!(await askConfirm('默认 /shop 将没有可见商品，前台会变为空页面。确认继续保存吗？'))) return
      allowEmptyDefault = true
    }
    await replaceAdminStorefrontProducts(token.value, currentStorefront.value.id, products, { allowEmptyDefault })
    productsVisible.value = false
    showToast(`已保存 ${products.length} 个商品映射`, 'success')
    await loadData()
  } catch (error) {
    showToast(error instanceof Error ? error.message : '保存商品映射失败', 'error')
  } finally {
    savingProducts.value = false
  }
}

function storefrontUrl(item: AdminStorefront) {
  return new URL(item.homePath, window.location.origin).toString()
}

function preview(item: AdminStorefront) {
  window.open(storefrontUrl(item), '_blank', 'noopener,noreferrer')
}

async function copyUrl(item: AdminStorefront) {
  try {
    await writeClipboardText(storefrontUrl(item))
    showToast('渠道 URL 已复制', 'success')
  } catch {
    showToast('复制失败', 'error')
  }
}

/**
 * 当前渠道内单商品购买链接。
 * 编辑面板里的 selected/visible 是未保存草稿态：仅当已选且可见时才允许复制；
 * 商品上架与渠道启用仍走 resolveAdminBuyLink 硬闸门。
 */
async function copyProductBuyLink(row: MappingRow) {
  const channel = currentStorefront.value
  if (!channel) return
  if (!row.selected || !row.visible) {
    showToast('仅可为已选且可见的商品复制购买链接', 'error')
    return
  }
  const resolved = resolveAdminBuyLink({
    product: {
      id: row.product.id,
      slug: row.product.slug,
      active: row.product.active,
      storefronts: [{ id: channel.id, visible: true }],
    },
    filterStorefrontId: channel.id,
    storefronts: [{
      id: channel.id,
      name: channel.name,
      homePath: channel.homePath,
      active: channel.active,
    }],
    origin: window.location.origin,
  })
  if (!resolved.ok) {
    showToast(adminBuyLinkFailureMessage(resolved.reason), 'error')
    return
  }
  try {
    await writeClipboardText(resolved.url)
    showToast('购买链接已复制', 'success')
  } catch {
    showToast('复制购买链接失败', 'error')
  }
}

async function makeDefault(item: AdminStorefront) {
  if (!(await askConfirm(`将“${item.name}”设为默认渠道？/shop 将立即切换到该渠道。`))) return
  try {
    await setAdminDefaultStorefront(token.value, item.id)
    showToast('默认渠道已切换', 'success')
    await loadData()
  } catch (error) {
    showToast(error instanceof Error ? error.message : '切换默认渠道失败', 'error')
  }
}

async function toggleActive(item: AdminStorefront) {
  const action = item.active ? '停用' : '启用'
  if (!(await askConfirm(`${action}“${item.name}”？${item.active ? '该主页将停止接受新访问和下单。' : ''}`))) return
  try {
    await updateAdminStorefront(token.value, item.id, { active: !item.active })
    showToast(`渠道已${action}`, 'success')
    await loadData()
  } catch (error) {
    showToast(error instanceof Error ? error.message : `${action}失败`, 'error')
  }
}

async function remove(item: AdminStorefront) {
  if (!(await askConfirm(`永久删除“${item.name}”？该操作仅允许无历史订单的非默认渠道。`))) return
  try {
    await deleteAdminStorefront(token.value, item.id)
    showToast('渠道已删除', 'success')
    await loadData()
  } catch (error) {
    showToast(error instanceof Error ? error.message : '删除失败', 'error')
  }
}

onMounted(async () => {
  await loadData()
  await openProductsFromQuery()
})
</script>

<style>@import '@/assets/admin.css';</style>
<style scoped>
.channel-name,
.mapping-toolbar,
.mapping-row,
.mapping-product,
.mapping-visible,
.mapping-sort {
  display: flex;
  align-items: center;
  gap: 8px;
}

.channel-logo {
  width: 24px;
  height: 24px;
  object-fit: contain;
  border-radius: 4px;
}

.channel-actions {
  flex-wrap: wrap;
  min-width: 260px;
}

.logo-preview {
  width: 64px;
  height: 64px;
  object-fit: contain;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
  border-radius: 6px;
  background: #fff;
}

/* image-upload-* / field-hint → admin.css */

.mapping-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.mapping-toolbar {
  flex-wrap: wrap;
}

.mapping-toolbar input[type='search'] {
  min-width: 220px;
  flex: 1;
  padding: 8px 10px;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
  border-radius: 6px;
}

.mapping-list {
  max-height: 52vh;
  overflow: auto;
  border-block: 1px solid var(--border, rgba(255, 255, 255, 0.1));
}

.mapping-row {
  min-height: 46px;
  padding: 7px 4px;
  border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.1));
}

.mapping-product {
  min-width: 0;
  flex: 1;
}

.mapping-product span {
  min-width: 0;
  overflow-wrap: anywhere;
}

.mapping-product code {
  color: var(--tg-hint, #9aa4b2);
  font-size: 11px;
}

.mapping-visible {
  flex: 0 0 auto;
}

.mapping-sort input {
  width: 78px;
  padding: 6px;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
  border-radius: 6px;
}

@media (max-width: 680px) {
  .mapping-row {
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .mapping-product {
    flex-basis: 100%;
  }
}
</style>
