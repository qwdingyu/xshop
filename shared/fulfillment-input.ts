/**
 * 通用履约输入契约：连接商品配置、下单校验与订单快照。
 * 这里不得引入供应商或行业专用字段，历史订单也只能按下单时快照解释。
 */
export const FULFILLMENT_INPUT_TYPES = ['none', 'phone', 'qq', 'uid', 'account', 'text'] as const

export type FulfillmentInputType = typeof FULFILLMENT_INPUT_TYPES[number]

const FULFILLMENT_INPUT_OPTION_LABELS: Record<FulfillmentInputType, string> = {
  none: '无需额外填写',
  phone: '手机号',
  qq: 'QQ 号',
  uid: '用户 ID',
  account: '账号',
  text: '通用文本',
}

export const FULFILLMENT_INPUT_OPTIONS = FULFILLMENT_INPUT_TYPES.map((value) => ({
  value,
  label: FULFILLMENT_INPUT_OPTION_LABELS[value],
}))

export interface FulfillmentInputConfig {
  type?: FulfillmentInputType | string | null
  label?: string | null
  hint?: string | null
  required?: boolean | number | null
}

export interface NormalizedFulfillmentInputConfig {
  type: FulfillmentInputType
  label: string
  hint: string
  required: boolean
}

export interface FulfillmentInputSnapshot {
  type: FulfillmentInputType
  label: string
  value: string
}

const DEFAULT_LABELS: Record<FulfillmentInputType, string> = {
  none: '',
  phone: '手机号',
  qq: 'QQ 号',
  uid: '用户 ID',
  account: '充值账号',
  text: '履约信息',
}

export function isFulfillmentInputType(value: unknown): value is FulfillmentInputType {
  return typeof value === 'string' && (FULFILLMENT_INPUT_TYPES as readonly string[]).includes(value)
}

export function normalizeFulfillmentInputConfig(config: FulfillmentInputConfig): NormalizedFulfillmentInputConfig {
  const type = isFulfillmentInputType(config.type) ? config.type : 'none'
  if (type === 'none') return { type, label: '', hint: '', required: false }

  return {
    type,
    label: String(config.label || '').trim() || DEFAULT_LABELS[type],
    hint: String(config.hint || '').trim(),
    required: config.required === true || config.required === 1,
  }
}

export type FulfillmentInputValidationResult =
  | { ok: true; value: string; snapshot: FulfillmentInputSnapshot | null }
  | { ok: false; message: string }

export interface CheckoutFulfillmentInputContext {
  restoringAttempt: boolean
  preservedValue?: string
}

export function validateFulfillmentInput(
  config: FulfillmentInputConfig,
  rawValue: unknown,
): FulfillmentInputValidationResult {
  const normalized = normalizeFulfillmentInputConfig(config)
  const value = typeof rawValue === 'string' ? rawValue.trim() : ''

  if (normalized.type === 'none') {
    return { ok: true, value: '', snapshot: null }
  }
  if (!value) {
    return normalized.required
      ? { ok: false, message: `请填写${normalized.label}` }
      : { ok: true, value: '', snapshot: null }
  }
  if (value.length > 200) return { ok: false, message: `${normalized.label}不能超过 200 个字符` }
  if (/\p{Cc}/u.test(value)) return { ok: false, message: `${normalized.label}包含不支持的控制字符` }

  let canonicalValue = value
  if (normalized.type === 'phone') {
    canonicalValue = value.replace(/[\s()-]/g, '')
    if (!/^\+?\d{6,20}$/.test(canonicalValue)) {
      return { ok: false, message: `请输入有效的${normalized.label}` }
    }
  } else if (normalized.type === 'qq') {
    if (!/^[1-9]\d{4,11}$/.test(value)) {
      return { ok: false, message: `请输入有效的${normalized.label}` }
    }
  } else if (normalized.type === 'uid') {
    if (!/^[\p{L}\p{N}._@:-]{2,100}$/u.test(value)) {
      return { ok: false, message: `${normalized.label}格式无效` }
    }
  }

  return {
    ok: true,
    value: canonicalValue,
    snapshot: {
      type: normalized.type,
      label: normalized.label,
      value: canonicalValue,
    },
  }
}

/** 幂等恢复必须原样重放旧值；商品当前配置只约束新请求。 */
export function resolveCheckoutFulfillmentInput(
  config: FulfillmentInputConfig,
  currentValue: unknown,
  context: CheckoutFulfillmentInputContext,
): FulfillmentInputValidationResult {
  if (context.restoringAttempt) {
    return {
      ok: true,
      value: context.preservedValue ?? (typeof currentValue === 'string' ? currentValue : ''),
      snapshot: null,
    }
  }
  return validateFulfillmentInput(config, currentValue)
}

export function serializeFulfillmentInputSnapshot(snapshot: FulfillmentInputSnapshot | null): string {
  return snapshot ? JSON.stringify(snapshot) : ''
}

export function parseFulfillmentInputSnapshot(value: unknown): FulfillmentInputSnapshot | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = JSON.parse(value) as Partial<FulfillmentInputSnapshot>
    if (!isFulfillmentInputType(parsed.type) || parsed.type === 'none') return null
    if (typeof parsed.label !== 'string' || typeof parsed.value !== 'string' || !parsed.value) return null
    return {
      type: parsed.type,
      label: parsed.label.slice(0, 80),
      value: parsed.value.slice(0, 200),
    }
  } catch {
    return null
  }
}
