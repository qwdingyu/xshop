/**
 * 人工履约进度使用订单事件留痕，不参与订单生命周期状态转换。
 * 阶段值、事件类型和展示标签必须在此处同步演进，避免前后端各自维护。
 */
export const FULFILLMENT_PROGRESS_STAGES = [
  'supplier_processing',
  'failed_pending_retry',
  'manual_review',
] as const

const FULFILLMENT_PROGRESS_EVENT_PREFIX = 'fulfillment_' as const

export type FulfillmentProgressStage = typeof FULFILLMENT_PROGRESS_STAGES[number]
export type FulfillmentProgressEventType = `${typeof FULFILLMENT_PROGRESS_EVENT_PREFIX}${FulfillmentProgressStage}`
export const DEFAULT_FULFILLMENT_PROGRESS_STAGE: FulfillmentProgressStage = 'supplier_processing'

export interface FulfillmentProgressMetadata {
  stage: FulfillmentProgressStage
  supplierOrderRef: string
}

export const FULFILLMENT_PROGRESS_LABELS: Record<FulfillmentProgressStage, string> = {
  supplier_processing: '供应商处理中',
  failed_pending_retry: '失败待补单',
  manual_review: '人工复核',
}

export const FULFILLMENT_PROGRESS_OPTIONS = FULFILLMENT_PROGRESS_STAGES.map((value) => ({
  value,
  label: FULFILLMENT_PROGRESS_LABELS[value],
}))

export function fulfillmentProgressStageLabel(stage: FulfillmentProgressStage): string {
  return FULFILLMENT_PROGRESS_LABELS[stage]
}

export function fulfillmentProgressEventType(stage: FulfillmentProgressStage): FulfillmentProgressEventType {
  return `${FULFILLMENT_PROGRESS_EVENT_PREFIX}${stage}`
}

export function fulfillmentProgressEventLabel(type: string): string | undefined {
  if (!type.startsWith(FULFILLMENT_PROGRESS_EVENT_PREFIX)) return undefined
  const stage = type.slice(FULFILLMENT_PROGRESS_EVENT_PREFIX.length)
  return isFulfillmentProgressStage(stage) ? fulfillmentProgressStageLabel(stage) : undefined
}

export function isFulfillmentProgressStage(value: unknown): value is FulfillmentProgressStage {
  return typeof value === 'string' && (FULFILLMENT_PROGRESS_STAGES as readonly string[]).includes(value)
}
