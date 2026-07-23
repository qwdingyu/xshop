<template>
  <div class="app" :class="`platform-${platform}`">
    <HeaderBar v-if="!isAdminRoute" />

    <!-- Main content -->
    <main class="app-main">
      <RouterView />
    </main>

    <footer v-if="!isAdminRoute" class="app-footer">
      <span>{{ publicBrandName }}</span>
      <a v-if="publicSupportEmail" :href="`mailto:${publicSupportEmail}`">{{ publicSupportEmail }}</a>
    </footer>

    <PayModal v-if="!isAdminRoute" />
    <RechargeModal v-if="!isAdminRoute" />

    <!-- Global Toasts -->
    <ToastContainer />
  </div>
</template>

<script setup lang="ts">
import HeaderBar from '@/components/HeaderBar.vue'
import PayModal from '@/components/PayModal.vue'
import RechargeModal from '@/components/RechargeModal.vue'
import ToastContainer from '@/components/ToastContainer.vue'
import { computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import { usePlatform } from '@/composables/usePlatform'
import { useTelegram } from '@/composables/useTelegram'
import { useShopConfig } from '@/composables/useShopConfig'
import { useStorefrontContext } from '@/composables/useStorefrontContext'

const route = useRoute()
const { platform } = usePlatform()
const { shopName, supportEmail, loadShopConfig } = useShopConfig()
const { storefront, clearStorefront } = useStorefrontContext()
const isAdminRoute = computed(() => route.path.startsWith('/admin'))
const isStorefrontRoute = computed(() => route.name === 'Shop' || route.name === 'Storefront')
const publicBrandName = computed(() => storefront.value?.name || shopName.value)
const publicSupportEmail = computed(() => storefront.value?.supportEmail || supportEmail.value)
useTelegram()
loadShopConfig()

// 渠道品牌只在商品主页有效；余额、兑换、查单和后台必须回退到全局系统品牌。
watch(isStorefrontRoute, (active) => {
  if (!active) clearStorefront()
}, { immediate: true })

watch([publicBrandName, isStorefrontRoute], ([brandName, active]) => {
  if (typeof document !== 'undefined') {
    document.title = active ? brandName : shopName.value
  }
}, { immediate: true })
</script>

<style scoped>
.app {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.app-main {
  flex: 1;
}

.app-footer {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px 16px;
  padding: 16px;
  color: var(--tg-hint);
  font-size: 12px;
}

.app-footer a {
  color: var(--tg-link);
  text-decoration: none;
}
</style>
