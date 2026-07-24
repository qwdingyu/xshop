export const ISSUE_MODES = ['direct', 'manual'] as const
export type IssueMode = typeof ISSUE_MODES[number]

export const FULFILLMENT_MODES = ['card', 'virtual', 'link', 'code', 'invite'] as const
export type FulfillmentMode = typeof FULFILLMENT_MODES[number]

export const FULFILLMENT_MODE_LABELS: Record<FulfillmentMode, string> = {
  card: '卡密',
  virtual: '虚拟资料',
  link: '链接',
  code: '兑换码',
  invite: '邀请码',
}

export const FULFILLMENT_MODE_OPTIONS = FULFILLMENT_MODES.map((value) => ({
  value,
  label: FULFILLMENT_MODE_LABELS[value],
}))

export const DELIVERY_VISIBILITIES = ['web_and_email', 'email_only'] as const
export type DeliveryVisibility = typeof DELIVERY_VISIBILITIES[number]

export const DELIVERY_VISIBILITY_LABELS: Record<DeliveryVisibility, string> = {
  web_and_email: 'Web + 邮件展示',
  email_only: '仅邮件展示（活动注册码）',
}

export const DELIVERY_VISIBILITY_OPTIONS = DELIVERY_VISIBILITIES.map((value) => ({
  value,
  label: DELIVERY_VISIBILITY_LABELS[value],
}))

export const STOCK_DISPLAY_MODES = ['exact', 'availability_only', 'hidden'] as const
export type StockDisplayMode = typeof STOCK_DISPLAY_MODES[number]

export const STOCK_DISPLAY_MODE_LABELS: Record<StockDisplayMode, string> = {
  exact: '精确库存',
  availability_only: '仅库存状态',
  hidden: '隐藏库存',
}

export const STOCK_DISPLAY_MODE_OPTIONS = STOCK_DISPLAY_MODES.map((value) => ({
  value,
  label: STOCK_DISPLAY_MODE_LABELS[value],
}))

export function fulfillmentModeLabel(value: string | null | undefined): string | undefined {
  return FULFILLMENT_MODE_LABELS[value as FulfillmentMode]
}

export function stockDisplayModeLabel(value: string | null | undefined): string | undefined {
  return STOCK_DISPLAY_MODE_LABELS[value as StockDisplayMode]
}

// ── 货架对比价（划线原价）────────────────────────────────
// 仅营销展示；计费永远用 priceCents（×数量 − 券）。
// 有效条件：正整数且严格大于售价。

/** 是否展示货架促销（现价 vs 对比价） */
export function hasListDiscount(
  priceCents: number,
  originalPriceCents?: number | null,
): boolean {
  if (!Number.isFinite(priceCents) || priceCents < 0) return false
  if (originalPriceCents == null) return false
  if (!Number.isFinite(originalPriceCents)) return false
  const original = Math.trunc(originalPriceCents)
  if (original <= 0) return false
  return original > Math.trunc(priceCents)
}

/** 规范化入库/API 可选对比价：空/0/无效 → null；有效则截断为整数 */
export function normalizeOriginalPriceCents(
  value: unknown,
): number | null {
  if (value == null || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return null
  const truncated = Math.trunc(n)
  if (truncated <= 0) return null
  return truncated
}

/**
 * 写入前校验：有对比价时必须 > 售价。
 * @returns null 表示通过；否则为错误文案
 */
export function validateOriginalPriceCents(
  priceCents: number,
  originalPriceCents: number | null | undefined,
): string | null {
  const original = normalizeOriginalPriceCents(originalPriceCents ?? null)
  if (original == null) return null
  if (!Number.isFinite(priceCents) || priceCents < 0) {
    return '售价无效，无法设置划线原价'
  }
  if (original <= Math.trunc(priceCents)) {
    return '划线原价必须高于现价'
  }
  return null
}

/** 节省金额（最小货币单位）；无促销返回 null */
export function listDiscountSaveCents(
  priceCents: number,
  originalPriceCents?: number | null,
): number | null {
  if (!hasListDiscount(priceCents, originalPriceCents)) return null
  return Math.trunc(originalPriceCents as number) - Math.trunc(priceCents)
}

/**
 * 折扣力度 1–99（约等于「X 折」的百分位，如 40 → 约 4 折）。
 * 公式：floor(price/original*10) 再映射不在此层；UI 用 percentOff 拼「省 x%」或「约 X 折」。
 */
export function listDiscountPercentOff(
  priceCents: number,
  originalPriceCents?: number | null,
): number | null {
  if (!hasListDiscount(priceCents, originalPriceCents)) return null
  const original = Math.trunc(originalPriceCents as number)
  const price = Math.trunc(priceCents)
  const pct = Math.floor(((original - price) / original) * 100)
  if (pct < 1) return 1
  if (pct > 99) return 99
  return pct
}

/**
 * 角标文案：优先「省 x%」；免费+有原价用「限免」。
 * 不负责金额格式化（避免依赖币种工具）；「省 ¥x」由前端 format 层拼。
 */
export function listDiscountBadgeKind(
  priceCents: number,
  originalPriceCents?: number | null,
): 'none' | 'free_promo' | 'percent_off' {
  if (!hasListDiscount(priceCents, originalPriceCents)) return 'none'
  if (Math.trunc(priceCents) === 0) return 'free_promo'
  return 'percent_off'
}
