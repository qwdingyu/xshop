<template>
  <div class="admin-page">
    <div class="toolbar">
      <h2 class="page-title">系统配置</h2>
      <button class="btn btn-primary btn-sm" :disabled="loading" @click="loadData">刷新</button>
    </div>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" :disabled="loading" @click="loadData">重新加载</button>
    </div>

    <div class="config-scroll">
      <div v-if="!loading && !loadError" class="status-banner" :class="turnstileBannerClass">
        {{ turnstileBannerText }}
      </div>

      <div v-if="loading" class="skeleton-list">
        <div v-for="i in 6" :key="i" class="skeleton-line w-80" />
      </div>

      <template v-else-if="!loadError">
        <section class="config-section" aria-labelledby="primary-config-title">
          <div class="config-section-head">
            <h3 id="primary-config-title">常用配置</h3>
            <p>高频调整项，修改后即时保存并按后端规则生效。</p>
          </div>
          <div class="config-grid">
            <ConfigField
              v-for="item in primaryDefinitions"
              :key="`primary-${item.key}`"
              :item="item"
              :value="config[item.key] || ''"
              :status="fieldStatus[item.key] || 'idle'"
              primary
              @change="update"
              @reset="reset"
            />
          </div>
        </section>

        <section class="config-section" aria-labelledby="advanced-config-title">
          <div class="config-section-head config-section-head--advanced">
            <div>
              <h3 id="advanced-config-title">高级配置</h3>
              <p>低频但关键的运行参数，按业务影响分组，避免和常用项混在一起。</p>
            </div>
            <span class="config-count">{{ advancedConfigCount }} 项</span>
          </div>

          <div v-if="groupedDefinitions.length === 0" class="empty-text config-empty">
            暂无高级配置项
          </div>

          <div v-for="group in groupedDefinitions" :key="group.name" class="config-group">
            <div class="config-group-title">
              <span>{{ group.name }}</span>
              <span>{{ group.items.length }} 项</span>
            </div>
            <div class="config-grid">
              <ConfigField
                v-for="item in group.items"
                :key="item.key"
                :item="item"
                :value="config[item.key] || ''"
                :status="fieldStatus[item.key] || 'idle'"
                @change="update"
                @reset="reset"
              />
            </div>
            <div v-if="group.name === '邮件服务'" class="config-test-panel">
              <div class="config-test-main">
                <label>
                  <span>测试收件邮箱</span>
                  <input v-model="testEmailTo" type="email" placeholder="ops@example.com" />
                </label>
                <button
                  type="button"
                  class="btn btn-primary btn-sm"
                  :disabled="emailTestDisabled"
                  @click="sendTestEmail"
                >
                  {{ sendingTestEmail ? '发送中…' : '发送测试邮件' }}
                </button>
              </div>
              <p class="config-test-help">{{ emailTestHelp }}</p>
              <p
                v-if="testEmailStatus"
                class="config-test-status"
                :class="testEmailOk ? 'config-test-status--success' : 'config-test-status--error'"
              >
                {{ testEmailStatus }}
              </p>
            </div>
          </div>
        </section>

        <section class="config-section danger-section" aria-labelledby="data-maintenance-title">
          <div class="config-section-head">
            <div>
              <h3 id="data-maintenance-title">数据维护</h3>
              <p>
                固定四档清理（禁止自由拼表）。系统配置、支付配置、分类、API Key、迁移记录始终保留，并写回本次清理凭证。
                清订单时卡密策略固定为「清空全部卡密」，不会留下已发卡密指向已删订单。
              </p>
            </div>
          </div>
          <div class="danger-profiles" role="radiogroup" aria-label="清理档位">
            <label
              v-for="item in clearProfiles"
              :key="item.id"
              class="danger-profile"
              :class="{ 'danger-profile--active': clearProfile === item.id }"
            >
              <input v-model="clearProfile" type="radio" name="clear-profile" :value="item.id" />
              <span class="danger-profile-body">
                <strong>{{ item.title }}</strong>
                <span>{{ item.summary }}</span>
              </span>
            </label>
          </div>
          <p class="danger-profile-detail">{{ activeClearProfile.detail }}</p>
          <div class="danger-panel">
            <label>
              <span>确认短语（须与所选档位完全一致）</span>
              <input
                v-model="clearBusinessConfirmText"
                type="text"
                autocomplete="off"
                :placeholder="activeClearProfile.confirmation"
              />
            </label>
            <button
              type="button"
              class="btn btn-danger btn-sm"
              :disabled="!canClearBusinessData"
              @click="clearBusinessData"
            >
              {{ clearingBusinessData ? '清除中…' : activeClearProfile.buttonLabel }}
            </button>
          </div>
          <p v-if="clearBusinessDataStatus" class="danger-status">{{ clearBusinessDataStatus }}</p>
        </section>
      </template>
    </div>

    <ConfirmDialog v-model="confirmVisible" :message="confirmMessage" danger @confirm="onConfirm" />
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted } from 'vue'
import { clearAdminBusinessData, fetchAdminSystemConfig, testAdminEmail, updateAdminSystemConfig } from '@/api/admin'
import type { AdminClearBusinessDataProfile } from '@/api/admin'
import type { AdminSystemConfigResult, AdminSystemConfigDefinition } from '@/types/admin'
import { useToast } from '@/composables/useToast'
import { useAdminAuth } from '@/composables/useAdminAuth'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import ConfigField from '@/components/admin/ConfigField.vue'
import { useShopConfig } from '@/composables/useShopConfig'

const { showToast } = useToast()
const { token } = useAdminAuth()
const { loadShopConfig } = useShopConfig()

const loading = ref(false)
const loadError = ref('')
const config = reactive<Record<string, string>>({})
const fieldStatus = reactive<Record<string, 'idle' | 'saving' | 'saved' | 'error'>>({})
const definitions = ref<AdminSystemConfigDefinition[]>([])
const turnstileStatus = ref<AdminSystemConfigResult['turnstileStatus']>()
const testEmailTo = ref('')
const sendingTestEmail = ref(false)
const testEmailStatus = ref('')
const testEmailOk = ref(false)
const clearProfiles = [
  {
    id: 'runtime' as const,
    title: '仅运行态与日志',
    summary: '清请求/邮件日志、限流、幂等、旧审计。不动订单、卡密、余额、商品、渠道。',
    detail: '最安全。适合幂等脏数据、限流挡测试、日志胀库。对账与货架完全保留。',
    confirmation: '清除运行态与日志',
    buttonLabel: '清除运行态与日志',
  },
  {
    id: 'keep_trade' as const,
    title: '清账本与营销（保留交易）',
    summary: '清余额账本、充值单、优惠券/活动/推广、日志与运行态；保留商品、渠道、卡密、订单。',
    detail: '适合清测试余额与营销脏数据，同时保留完整订单与库存。不碰卡密与订单，卡密策略为 none。注意：余额账本清空后，历史订单金额无法与账本逐笔对平——这不是对账修复工具。',
    confirmation: '清除账本营销保留交易',
    buttonLabel: '清除账本与营销',
  },
  {
    id: 'keep_catalog' as const,
    title: '清交易（保留商品与渠道）',
    summary: '清订单、全部卡密、余额账本、营销、日志与运行态；保留商品目录与展示渠道。',
    detail: '验收主档。卡密固定清空（S1），避免已售密悬空。测试后需重新导入卡密，无需重配商品与渠道。',
    confirmation: '清除交易数据保留商品',
    buttonLabel: '清除交易（保留货架）',
  },
  {
    id: 'full' as const,
    title: '清除所有业务数据',
    summary: '在上一档基础上再清商品与渠道-商品映射；系统配置/支付/分类/API Key/迁移仍保留。',
    detail: '上线前 smoke 清空。会删除商品，需重新上架。确认短语与历史行为一致。',
    confirmation: '清除所有业务数据',
    buttonLabel: '清除所有业务数据',
  },
] as const

const clearProfile = ref<AdminClearBusinessDataProfile>('keep_trade')
const clearBusinessConfirmText = ref('')
const clearBusinessDataStatus = ref('')
const clearingBusinessData = ref(false)

// 切换档位时清空已输入短语，避免用上一档短语误触高危档位（服务端仍会校验，此处减少误操作）。
watch(clearProfile, () => {
  clearBusinessConfirmText.value = ''
  clearBusinessDataStatus.value = ''
})
const emailConfigKeys = ['resend_api_key', 'email_from']
const primaryConfigKeys = [
  'shop_name',
  'support_email',
  'turnstile_enabled',
  'turnstile_site_key',
  'balance_payment_enabled',
  'offline_pay_hint',
  'order_expire_minutes',
]

const primaryDefinitions = computed(() =>
  definitions.value
    .filter((item) => primaryConfigKeys.includes(item.key))
    .sort((a, b) => primaryConfigKeys.indexOf(a.key) - primaryConfigKeys.indexOf(b.key))
)

const groupedDefinitions = computed(() => {
  const groups = new Map<string, { name: string; items: AdminSystemConfigDefinition[] }>()
  for (const item of definitions.value.filter((entry) => !primaryConfigKeys.includes(entry.key))) {
    const name = item.group || '其他'
    if (!groups.has(name)) {
      groups.set(name, { name, items: [] })
    }
    groups.get(name)!.items.push(item)
  }
  return Array.from(groups.values()).map((group) => ({
    ...group,
    items: group.items.sort((a, b) => (a.order ?? 999) - (b.order ?? 999)),
  }))
})

const advancedConfigCount = computed(() =>
  groupedDefinitions.value.reduce((sum, group) => sum + group.items.length, 0),
)
const emailConfigSaving = computed(() =>
  emailConfigKeys.some((key) => fieldStatus[key] === 'saving'),
)
const emailTestDisabled = computed(() =>
  sendingTestEmail.value || emailConfigSaving.value || !testEmailTo.value.trim(),
)
const emailTestHelp = computed(() =>
  emailConfigSaving.value
    ? '邮件配置正在保存，保存完成后再测试。'
    : '测试使用当前已保存的 Resend API Key 和发件人。',
)
const activeClearProfile = computed(() => {
  const matched = clearProfiles.find((item) => item.id === clearProfile.value)
  if (matched) return matched
  // 未知档位回退到默认 keep_trade（与 clearProfile 初始值一致），禁止静默落到高危档。
  return clearProfiles.find((item) => item.id === 'keep_trade') || clearProfiles[0]
})
const canClearBusinessData = computed(() =>
  !clearingBusinessData.value
    && clearBusinessConfirmText.value.trim() === activeClearProfile.value.confirmation,
)

const { confirmVisible, confirmMessage, askConfirm, onConfirm } = useConfirmDialog()
let resetKey: string | null = null

async function refreshPublicConfig(scope?: AdminSystemConfigDefinition['scope']): Promise<boolean> {
  if (scope !== 'public') return true
  try {
    await loadShopConfig(true)
    return true
  } catch {
    return false
  }
}

function showSavedStatus(message: string, publicConfigSynced: boolean) {
  if (publicConfigSynced) {
    showToast(message, 'success')
    return
  }
  showToast(`${message}，但当前页面未能刷新前台配置；重新加载页面后可同步`, 'info', 5000)
}

async function loadData() {
  loading.value = true
  loadError.value = ''
  try {
    const res: AdminSystemConfigResult = await fetchAdminSystemConfig(token.value)
    Object.assign(config, res.config)
    definitions.value = res.definitions
    turnstileStatus.value = res.turnstileStatus
    if (!testEmailTo.value.trim() && res.config.support_email) {
      testEmailTo.value = res.config.support_email
    }
  } catch (err: any) {
    definitions.value = []
    turnstileStatus.value = undefined
    for (const key of Object.keys(config)) delete config[key]
    loadError.value = err.message || '加载系统配置失败'
    showToast(err.message || '加载系统配置失败', 'error')
  } finally {
    loading.value = false
  }
}

async function update(key: string, value: string) {
  fieldStatus[key] = 'saving'
  try {
    const res = await updateAdminSystemConfig(token.value, { key, value })
    config[key] = res.value
    const publicConfigSynced = await refreshPublicConfig(definitions.value.find((item) => item.key === key)?.scope)
    if (res.configured !== undefined) {
      const definition = definitions.value.find((item) => item.key === key)
      if (definition) definition.configured = res.configured
    }
    if (res.turnstileStatus) turnstileStatus.value = res.turnstileStatus
    fieldStatus[key] = 'saved'
    markEmailTestStale(key)
    showSavedStatus('已保存', publicConfigSynced)
  } catch (err: any) {
    fieldStatus[key] = 'error'
    showToast(err.message || '保存失败', 'error')
  }
}

async function sendTestEmail() {
  if (sendingTestEmail.value) return
  if (emailConfigSaving.value) {
    testEmailOk.value = false
    testEmailStatus.value = '邮件配置正在保存，保存完成后再测试。'
    return
  }
  const to = testEmailTo.value.trim()
  if (!to) return
  sendingTestEmail.value = true
  testEmailStatus.value = ''
  testEmailOk.value = false
  try {
    const res = await testAdminEmail(token.value, { to })
    testEmailOk.value = true
    testEmailStatus.value = res.resendId
      ? `发送成功，Resend ID：${res.resendId}`
      : (res.message || '测试邮件已发送')
    showToast('测试邮件已发送', 'success')
  } catch (err: any) {
    testEmailOk.value = false
    testEmailStatus.value = err.message || '测试邮件发送失败'
    showToast(testEmailStatus.value, 'error')
  } finally {
    sendingTestEmail.value = false
  }
}

async function clearBusinessData() {
  if (!canClearBusinessData.value) return
  const profile = activeClearProfile.value
  const confirmed = await askConfirm(
    `确认执行「${profile.title}」？\n\n${profile.detail}\n\n此操作不可恢复。系统配置、支付配置、分类、API Key 和迁移记录会保留；旧管理员审计会被本次清理凭证替代。`,
  )
  if (!confirmed) return

  clearingBusinessData.value = true
  clearBusinessDataStatus.value = ''
  try {
    const result = await clearAdminBusinessData(token.value, profile.confirmation, profile.id)
    clearBusinessConfirmText.value = ''
    clearBusinessDataStatus.value = `档位 ${result.profile}：已清除 ${result.deleted} 条，凭证 ${result.retainedAuditId}（卡密策略 ${result.cardStrategy}）。`
    showToast(`${profile.title}已完成`, 'success')
  } catch (err: any) {
    clearBusinessDataStatus.value = err.message || '清除业务数据失败'
    showToast(clearBusinessDataStatus.value, 'error')
  } finally {
    clearingBusinessData.value = false
  }
}

const turnstileBannerClass = computed(() => {
  if (!turnstileStatus.value?.enabled) return 'status-banner-info'
  return turnstileStatus.value.complete ? 'status-banner-success' : 'status-banner-error'
})

const turnstileBannerText = computed(() => {
  if (!turnstileStatus.value?.enabled) {
    return 'Turnstile 当前已关闭：普通下单、充值码兑换和发送邮箱验证码不会要求人机验证；余额与精确查单仍要求邮箱验证码。'
  }
  if (turnstileStatus.value.complete) {
    return 'Turnstile 当前已完整启用：普通下单、充值码兑换和发送邮箱验证码会强制校验 token；余额与精确查单使用邮箱验证码。'
  }
  return 'Turnstile 已开启但配置不完整：请同时配置 Site Key 与 Secret Key，避免用户请求被后端拒绝。'
})

async function reset(key: string) {
  const def = definitions.value.find((d) => d.key === key)
  if (!def) return
  resetKey = key
  if (!(await askConfirm(`确认重置 ${key} 为默认值？`))) return
  fieldStatus[key] = 'saving'
  try {
    const res = await updateAdminSystemConfig(token.value, {
      key: resetKey,
      value: def.defaultValue || '',
    })
    config[resetKey] = res.value
    const publicConfigSynced = await refreshPublicConfig(def.scope)
    if (res.configured !== undefined) {
      const definition = definitions.value.find((item) => item.key === resetKey)
      if (definition) definition.configured = res.configured
    }
    if (res.turnstileStatus) turnstileStatus.value = res.turnstileStatus
    fieldStatus[key] = 'saved'
    markEmailTestStale(key)
    showSavedStatus('已重置', publicConfigSynced)
  } catch (err: any) {
    fieldStatus[key] = 'error'
    showToast(err.message || '重置失败', 'error')
  } finally {
    resetKey = null
  }
}

function markEmailTestStale(key: string) {
  if (!emailConfigKeys.includes(key)) return
  testEmailOk.value = false
  testEmailStatus.value = '邮件配置已更新，请重新发送测试邮件确认。'
}

onMounted(loadData)
</script>

<style>
@import '@/assets/admin.css';
</style>

<style scoped>
/*
 * page-title / skeleton-* / status-banner* / config-grid /
 * config-section* / config-count → admin.css
 */
.config-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 2px 24px;
  display: flex;
  flex-direction: column;
  gap: var(--admin-stack-gap, 8px);
}

.config-section-head--advanced {
  align-items: flex-start;
}

/* 系统配置字段卡：比通用 two-cols 更宽的自适应列 */
.config-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--admin-card-gap, 10px);
}

.config-group {
  display: flex;
  flex-direction: column;
  gap: var(--admin-stack-gap, 8px);
}

.config-group-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--tg-text, #f0f2f5);
  font-size: 13px;
  font-weight: 600;
}

.config-group-title span:last-child {
  color: var(--tg-hint, #9aa4b2);
  font-size: 12px;
  font-weight: 400;
}

.config-empty {
  border: 1px dashed var(--border, rgba(255, 255, 255, 0.1));
  border-radius: var(--r-lg, 12px);
  background: var(--surface, rgba(255, 255, 255, 0.04));
}

.config-test-panel {
  border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
  border-radius: var(--r-lg, 12px);
  padding: 10px;
  background: var(--surface-2, rgba(255, 255, 255, 0.07));
}

.config-test-main {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) auto;
  gap: 10px;
  align-items: end;
}

.config-test-main label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  color: var(--tg-hint, #9aa4b2);
}

.config-test-main input {
  min-width: 0;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
  border-radius: var(--r-md, 8px);
  padding: 8px 10px;
  font-size: 13px;
  background: var(--surface, rgba(255, 255, 255, 0.04));
  color: var(--tg-text, #f0f2f5);
}

.config-test-status {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.45;
  word-break: break-word;
}

.config-test-help {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--tg-hint, #9aa4b2);
}

.config-test-status--success {
  color: #6ee7b7;
}

.config-test-status--error {
  color: #fca5a5;
}

.danger-section {
  border-color: rgba(220, 38, 38, 0.28);
}

.danger-profiles {
  display: grid;
  gap: var(--admin-inline-gap, 8px);
  margin: 0 0 var(--admin-stack-gap, 8px);
}

.danger-profile {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 10px;
  align-items: start;
  padding: 10px 12px;
  border: 0.5px solid rgba(220, 38, 38, 0.22);
  border-radius: var(--r-md, 8px);
  background: var(--tg-secondary-bg, #151b28);
  cursor: pointer;
}

.danger-profile--active {
  border-color: rgba(220, 38, 38, 0.55);
  box-shadow: inset 0 0 0 1px rgba(220, 38, 38, 0.12);
}

.danger-profile input {
  margin-top: 3px;
}

.danger-profile-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--tg-hint, #9aa4b2);
}

.danger-profile-body strong {
  font-size: 13px;
  color: var(--tg-text, #f0f2f5);
}

.danger-profile-detail {
  margin: 0 0 10px;
  font-size: 12px;
  line-height: 1.5;
  color: #fdba74;
}

.danger-panel {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) auto;
  gap: 10px;
  align-items: end;
}

.danger-panel label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  color: var(--tg-hint, #9aa4b2);
}

.danger-panel input {
  min-width: 0;
  border: 0.5px solid rgba(220, 38, 38, 0.35);
  border-radius: var(--r-md, 8px);
  padding: 8px 10px;
  font-size: 13px;
  background: var(--tg-secondary-bg, #151b28);
  color: var(--tg-text, #f0f2f5);
}

.danger-status {
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
  color: #fca5a5;
  word-break: break-word;
}

@media (max-width: 560px) {
  .config-test-main {
    grid-template-columns: 1fr;
  }

  .danger-panel {
    grid-template-columns: 1fr;
  }
}
</style>
