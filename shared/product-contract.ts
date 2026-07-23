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
