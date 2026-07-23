import { computed, shallowRef } from 'vue'
import type { Storefront } from '@/types'

const currentStorefront = shallowRef<Storefront | null>(null)

/**
 * 当前公开展示渠道上下文。它只承载品牌和主页定位，不参与全局余额、支付配置或后台数据范围。
 */
export function useStorefrontContext() {
  function setStorefront(storefront: Storefront): void {
    currentStorefront.value = storefront
  }

  function clearStorefront(): void {
    currentStorefront.value = null
  }

  return {
    storefront: computed(() => currentStorefront.value),
    setStorefront,
    clearStorefront,
  }
}
