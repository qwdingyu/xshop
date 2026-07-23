import { computed, shallowRef } from 'vue'
import type { Storefront } from '@/types'

const currentStorefront = shallowRef<Storefront | null>(null)
/** 最近一次渠道主页路径；离开商品页会 clear 品牌，但仍用于「返回选购」等回跳。 */
const lastHomePath = shallowRef('/shop')

/**
 * 当前公开展示渠道上下文。它只承载品牌和主页定位，不参与全局余额、支付配置或后台数据范围。
 */
export function useStorefrontContext() {
  function setStorefront(storefront: Storefront): void {
    currentStorefront.value = storefront
    if (storefront.homePath) lastHomePath.value = storefront.homePath
  }

  function clearStorefront(): void {
    currentStorefront.value = null
  }

  return {
    storefront: computed(() => currentStorefront.value),
    /** 当前渠道 homePath，或会话内最近一次渠道路径，最终回退 /shop */
    homePath: computed(() => currentStorefront.value?.homePath || lastHomePath.value || '/shop'),
    setStorefront,
    clearStorefront,
  }
}
