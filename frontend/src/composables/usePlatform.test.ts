import { describe, expect, it } from 'vitest'
import { detectPlatform } from './usePlatform'

describe('platform detection', () => {
  it('detects desktop and mobile H5 user agents', () => {
    expect(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X)', false)).toBe('h5-desktop')
    expect(detectPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', false)).toBe('h5-mobile')
    expect(detectPlatform('Mozilla/5.0 (Linux; Android 15; Pixel 9)', false)).toBe('h5-mobile')
  })

  it('keeps the device class when a verified Telegram context is available', () => {
    expect(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', true)).toBe('telegram-desktop')
    expect(detectPlatform('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)', true)).toBe('telegram-mobile')
  })
})
