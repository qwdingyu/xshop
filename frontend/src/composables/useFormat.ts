/** 格式化工具：价格、状态标签 */

import { formatMoney } from '@shared/money'
import {
  ORDER_STATUS_LABELS as SHARED_ORDER_STATUS_LABELS,
  normalizeOrderStatus,
  orderStatusLabel,
} from '@shared/order-status'

/** 订单状态中文映射（规范键为 canceled；读路径请用 statusLabel / normalizeOrderStatus） */
export const ORDER_STATUS_LABELS: Record<string, string> = {
  ...SHARED_ORDER_STATUS_LABELS,
}

/** 按订单币种的最小单位格式化价格。 */
export function formatPrice(minorUnits: number, currency: string): string {
  try {
    return formatMoney(minorUnits, currency)
  } catch {
    return '币种配置异常'
  }
}

/** 格式化 ISO 时间为本地可读字符串 */
export function formatDate(iso?: string | null): string {
  if (!iso) return '-'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (num: number) => String(num).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** 将后端时间转换为 datetime-local 可接受的本地输入值 */
export function toDateTimeLocalValue(value?: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value.slice(0, 16)
  const pad = (num: number) => String(num).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 将 datetime-local 输入值保存为 ISO，避免不同浏览器保存出不一致的时间字符串 */
export function dateTimeLocalToIso(value?: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toISOString()
}

/** 后台只存 IP 哈希，列表展示短标识，详情和导出保留完整值。 */
export function formatIpFingerprint(value?: string | null): string {
  const text = value?.trim()
  if (!text) return '-'
  if (text.length <= 18) return text
  return `${text.slice(0, 10)}...${text.slice(-6)}`
}

/** 获取订单状态中文标签（cancelled 会归一为 canceled 再映射） */
export function statusLabel(status: string): string {
  return orderStatusLabel(status)
}

export { normalizeOrderStatus, orderStatusLabel }
