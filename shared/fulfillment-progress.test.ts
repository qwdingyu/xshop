import { describe, expect, it } from 'vitest'
import {
  FULFILLMENT_PROGRESS_OPTIONS,
  fulfillmentProgressEventLabel,
  fulfillmentProgressEventType,
  isFulfillmentProgressStage,
} from './fulfillment-progress'

describe('fulfillment progress contract', () => {
  it('keeps stages, labels, and event names aligned', () => {
    expect(FULFILLMENT_PROGRESS_OPTIONS).toEqual([
      { value: 'supplier_processing', label: '供应商处理中' },
      { value: 'failed_pending_retry', label: '失败待补单' },
      { value: 'manual_review', label: '人工复核' },
    ])
    expect(fulfillmentProgressEventType('supplier_processing')).toBe('fulfillment_supplier_processing')
    expect(fulfillmentProgressEventLabel('fulfillment_manual_review')).toBe('人工复核')
  })

  it('rejects unknown stages and event names', () => {
    expect(isFulfillmentProgressStage('unknown')).toBe(false)
    expect(fulfillmentProgressEventLabel('fulfillment_unknown')).toBeUndefined()
    expect(fulfillmentProgressEventLabel('manual_review')).toBeUndefined()
  })
})
