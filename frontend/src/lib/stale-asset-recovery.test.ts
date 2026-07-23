import { describe, expect, it } from 'vitest'
import {
  buildStaleAssetRecoveryUrl,
  clearStaleAssetRecoveryParam,
  isStaleAssetLoadError,
} from './stale-asset-recovery'

describe('stale asset recovery', () => {
  it('recognizes dynamic import failures caused by an old deployment', () => {
    expect(isStaleAssetLoadError(new TypeError('Failed to fetch dynamically imported module'))).toBe(true)
    expect(isStaleAssetLoadError(new Error('business request failed'))).toBe(false)
  })

  it('adds one reload marker and refuses a second reload', () => {
    const href = 'https://shop.example/_app/admin/products'
    const recovery = buildStaleAssetRecoveryUrl(href, href)
    expect(recovery).toBe('https://shop.example/_app/admin/products?__asset_reload=1')
    expect(buildStaleAssetRecoveryUrl(recovery!, href)).toBeNull()
  })

  it('clears the marker after successful navigation without dropping route query or hash', () => {
    expect(clearStaleAssetRecoveryParam('https://shop.example/_app/admin/products?tab=cards&__asset_reload=1#top'))
      .toBe('/_app/admin/products?tab=cards#top')
  })
})
