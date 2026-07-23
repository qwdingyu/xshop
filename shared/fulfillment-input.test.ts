import { describe, expect, it } from 'vitest'
import {
  FULFILLMENT_INPUT_OPTIONS,
  normalizeFulfillmentInputConfig,
  parseFulfillmentInputSnapshot,
  resolveCheckoutFulfillmentInput,
  serializeFulfillmentInputSnapshot,
  validateFulfillmentInput,
} from './fulfillment-input'

describe('fulfillment input', () => {
  it('exposes one stable set of admin input options', () => {
    expect(FULFILLMENT_INPUT_OPTIONS).toEqual([
      { value: 'none', label: '无需额外填写' },
      { value: 'phone', label: '手机号' },
      { value: 'qq', label: 'QQ 号' },
      { value: 'uid', label: '用户 ID' },
      { value: 'account', label: '账号' },
      { value: 'text', label: '通用文本' },
    ])
  })
  it('keeps products without a configured input fully backward compatible', () => {
    expect(normalizeFulfillmentInputConfig({})).toEqual({ type: 'none', label: '', hint: '', required: false })
    expect(validateFulfillmentInput({}, 'ignored')).toEqual({ ok: true, value: '', snapshot: null })
  })

  it('uses a generic default label and enforces required values', () => {
    expect(validateFulfillmentInput({ type: 'account', required: true }, '')).toEqual({
      ok: false,
      message: '请填写充值账号',
    })
  })

  it('normalizes phone formatting without changing other account values', () => {
    expect(validateFulfillmentInput({ type: 'phone', label: '联系电话', required: true }, '+86 138-0013-8000')).toEqual({
      ok: true,
      value: '+8613800138000',
      snapshot: { type: 'phone', label: '联系电话', value: '+8613800138000' },
    })
    expect(validateFulfillmentInput({ type: 'account', required: true }, ' User.Name@example.com ')).toMatchObject({
      ok: true,
      value: 'User.Name@example.com',
    })
  })

  it('rejects invalid QQ, UID and control characters', () => {
    expect(validateFulfillmentInput({ type: 'qq', required: true }, '01234').ok).toBe(false)
    expect(validateFulfillmentInput({ type: 'uid', required: true }, 'with space').ok).toBe(false)
    expect(validateFulfillmentInput({ type: 'text', required: true }, 'abc\u0000def').ok).toBe(false)
  })

  it('replays a recovered checkout input despite later product configuration changes', () => {
    expect(resolveCheckoutFulfillmentInput(
      { type: 'uid', required: true },
      'new-value',
      { restoringAttempt: true, preservedValue: 'account@example.com' },
    )).toEqual({ ok: true, value: 'account@example.com', snapshot: null })
    expect(resolveCheckoutFulfillmentInput(
      { type: 'none' },
      'new-value',
      { restoringAttempt: true, preservedValue: 'account@example.com' },
    )).toEqual({ ok: true, value: 'account@example.com', snapshot: null })
  })

  it('preserves a recovered empty value and validates new checkout input', () => {
    expect(resolveCheckoutFulfillmentInput(
      { type: 'account', required: true },
      'current-value',
      { restoringAttempt: true, preservedValue: '' },
    )).toEqual({ ok: true, value: '', snapshot: null })
    expect(resolveCheckoutFulfillmentInput(
      { type: 'phone', required: true },
      ' 138-0013-8000 ',
      { restoringAttempt: false },
    )).toMatchObject({ ok: true, value: '13800138000' })
  })

  it('round-trips only bounded valid snapshots', () => {
    const json = serializeFulfillmentInputSnapshot({ type: 'uid', label: '平台 UID', value: 'user_123' })
    expect(parseFulfillmentInputSnapshot(json)).toEqual({ type: 'uid', label: '平台 UID', value: 'user_123' })
    expect(parseFulfillmentInputSnapshot('{"type":"none","label":"x","value":"secret"}')).toBeNull()
    expect(parseFulfillmentInputSnapshot('not-json')).toBeNull()
  })
})
