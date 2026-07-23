<template>
  <div class="admin-layout">
    <!-- 侧边栏遮罩（小屏打开侧边栏时显示） -->
    <div v-if="isMobile && sidebarOpen" class="sidebar-overlay" @click="sidebarOpen = false" />

    <!-- 侧边栏：小屏时默认隐藏，通过 hamburger 切换 -->
    <aside class="admin-sidebar" :class="{ 'sidebar-open': sidebarOpen }">
      <div class="sidebar-brand">{{ shopName }}</div>
      <nav class="sidebar-nav" @click="isMobile && (sidebarOpen = false)">
        <a
          v-for="item in menuItems"
          :key="item.to"
          class="nav-item"
          :class="{ active: currentName === item.name }"
          :href="item.to"
          :title="item.label"
          @click.prevent="onNavClick(item.to)"
        >
          <span class="nav-icon" v-html="item.icon" />
          <span class="nav-label">{{ item.label }}</span>
        </a>
      </nav>

      <div class="sidebar-footer">
        <div class="sidebar-user">
          <span class="sidebar-user-avatar">A</span>
          <span class="sidebar-user-name">管理员</span>
        </div>
        <button class="btn btn-ghost btn-xs sidebar-logout" @click="handleLogout">退出</button>
      </div>
    </aside>

    <div class="admin-main" :class="{ 'sidebar-open': sidebarOpen }">
      <header class="admin-header">
        <div class="admin-header-left">
          <!-- Hamburger button（小屏显示） -->
          <button v-if="isMobile" class="btn-hamburger" @click="toggleSidebar" type="button" aria-label="切换侧边栏">
            <span class="hamburger-line" />
            <span class="hamburger-line" />
            <span class="hamburger-line" />
          </button>
          <h1 class="admin-header-title">{{ pageTitle }}</h1>
        </div>
        <button
          class="btn btn-ghost header-logout"
          type="button"
          @click="handleLogout"
        >退出</button>
      </header>

      <main class="admin-content">
        <RouterView v-slot="{ Component }">
          <transition name="admin-fade" mode="out-in">
            <component :is="Component" />
          </transition>
        </RouterView>
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAdminAuth } from '@/composables/useAdminAuth'
import { useToast } from '@/composables/useToast'
import { useShopConfig } from '@/composables/useShopConfig'

const route = useRoute()
const router = useRouter()
const { clearToken } = useAdminAuth()
const { showToast } = useToast()
const { shopName, loadShopConfig } = useShopConfig()

// ── 侧边栏响应式控制 ──
/** 是否小屏（<1024px），侧边栏默认隐藏，通过 hamburger 切换 */
const isMobile = ref(false)
/** 侧边栏是否展开（仅对小屏有效） */
const sidebarOpen = ref(false)

let mql: MediaQueryList | null = null
function onMqChange(e: MediaQueryListEvent | MediaQueryList) {
  isMobile.value = e.matches
  if (!e.matches) {
    // 切回大屏时恢复侧边栏
    sidebarOpen.value = false
  }
}

onMounted(() => {
  loadShopConfig()
  mql = window.matchMedia('(max-width: 1023px)')
  onMqChange(mql)
  mql.addEventListener('change', onMqChange)
})

onUnmounted(() => {
  mql?.removeEventListener('change', onMqChange)
})

function toggleSidebar() {
  sidebarOpen.value = !sidebarOpen.value
}

// ── 菜单数据 ──
const menuItems = [
  { name: 'AdminDashboard', to: '/admin', label: '运营台', icon: '&#x1F4CA;' },
  { name: 'AdminProducts', to: '/admin/products', label: '商品', icon: '&#x1F6D2;' },
  { name: 'AdminStorefronts', to: '/admin/storefronts', label: '展示渠道', icon: '&#x1F5C2;' },
  { name: 'AdminCards', to: '/admin/cards', label: '卡密', icon: '&#x1F3B3;' },
  { name: 'AdminOrders', to: '/admin/orders', label: '订单', icon: '&#x1F4CB;' },
  { name: 'AdminCoupons', to: '/admin/coupons', label: '优惠码', icon: '&#x1F3AB;' },
  { name: 'AdminVouchers', to: '/admin/vouchers', label: '充值码', icon: '&#x1F39F;' },
  { name: 'AdminBalance', to: '/admin/balance', label: '用户余额', icon: '&#x1F4B0;' },
  { name: 'AdminRecharges', to: '/admin/recharges', label: '充值订单', icon: '&#x1F4B5;' },
  { name: 'AdminConfig', to: '/admin/config', label: '系统配置', icon: '&#x2699;&#xFE0F;' },
  { name: 'AdminPayment', to: '/admin/payment', label: '支付', icon: '&#x1F4B3;' },
  { name: 'AdminLogs', to: '/admin/logs', label: '操作日志', icon: '&#x1F4DD;' },
]

const currentName = computed(() => {
  const name = route.name as string | undefined
  // pending-tasks 路由复用运营台组件，导航上视为运营台，确保标题和高亮正确
  if (name === 'AdminPendingTasks') return 'AdminDashboard'
  return name
})

const pageTitle = computed(() => {
  const item = menuItems.find((item) => item.name === currentName.value)
  return item?.label || '管理后台'
})

function onNavClick(to: string) {
  if (route.fullPath === to) return
  router.push(to)
}

function handleLogout() {
  clearToken()
  showToast('已退出登录', 'success')
  router.replace('/admin/login')
}
</script>

<style scoped>
.admin-layout {
  display: flex;
  height: 100vh;
  /* 整页底：用实色 token，勿用半透明 surface（会透出下层且分层发虚） */
  background: var(--tg-bg, #0a0e17);
  overflow: hidden;
}

.admin-sidebar {
  width: var(--admin-sidebar-w, 220px);
  background: #1a1a2e;
  color: #fff;
  display: flex;
  flex-direction: column;
  position: fixed;
  inset: 0 auto 0 0;
  z-index: 100;
  overflow-y: auto;
}

.sidebar-brand {
  padding: 16px 14px;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.3px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.sidebar-nav {
  flex: 1;
  padding: 8px 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 14px;
  color: rgba(255, 255, 255, 0.72);
  text-decoration: none;
  font-size: 13px;
  transition: background 0.15s ease, color 0.15s ease;
  border-left: 3px solid transparent;
}

.nav-item:hover {
  background: rgba(255, 255, 255, 0.08);
  color: #fff;
}

.nav-item.active {
  background: rgba(255, 255, 255, 0.14);
  color: #fff;
  font-weight: 600;
  border-left-color: var(--admin-accent, #f59e0b);
}

.nav-icon {
  font-size: 16px;
  width: 20px;
  text-align: center;
}

.admin-main {
  flex: 1;
  margin-left: var(--admin-sidebar-w, 220px);
  display: flex;
  flex-direction: column;
  min-width: 0;
  height: 100vh;
  overflow: hidden;
}

.admin-header {
  position: sticky;
  top: 0;
  z-index: 50;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px var(--admin-content-pad, 12px);
  border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.1));
  backdrop-filter: saturate(180%) blur(12px);
  background: rgba(var(--tg-bg-rgb, 10, 14, 23), 0.88);
}

.admin-header-title {
  margin: 0;
  font-size: 15px;
}

.admin-content {
  flex: 1;
  padding: var(--admin-content-pad, 16px);
  overflow: hidden;
  min-width: 0;
}

.header-logout {
  padding: 2px 6px;
  font-size: 11px;
  border-radius: var(--r-sm, 6px);
  color: var(--tg-hint, #9aa4b2);
}

.header-logout:hover {
  color: var(--tg-text, #f0f2f5);
  background: var(--surface-hover, rgba(255, 255, 255, 0.1));
}

/* ── Hamburger button ── */
.btn-hamburger {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  width: 24px;
  height: 24px;
  padding: 4px;
  border: none;
  border-radius: var(--r-sm, 4px);
  background: transparent;
  cursor: pointer;
  flex-shrink: 0;
}

.btn-hamburger:hover {
  background: var(--surface-hover, rgba(255, 255, 255, 0.1));
}

.hamburger-line {
  display: block;
  width: 100%;
  height: 1.5px;
  background: var(--tg-text, #f0f2f5);
  border-radius: 1px;
  transition: transform var(--duration-fast, 0.15s) ease;
}

/* Header left 区域（hamburger + 标题） */
.admin-header-left {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* ── 侧边栏遮罩（小屏） ── */
.sidebar-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  z-index: 99;
}

/* ── 侧边栏底部用户区 ── */
.sidebar-footer {
  padding: 10px 14px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.sidebar-user {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sidebar-user-avatar {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.14);
  color: #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 600;
}

.sidebar-user-name {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.84);
}

.sidebar-logout {
  padding: 3px 8px;
  font-size: 12px;
  border-radius: 6px;
  color: rgba(255, 255, 255, 0.64);
}

.sidebar-logout:hover {
  color: #fff;
  background: rgba(255, 255, 255, 0.08);
}

/* ── 小屏响应式（< 1024px） ── */
@media (max-width: 1023px) {
  .admin-sidebar {
    width: 260px;
    transform: translateX(-100%);
    transition: transform 0.25s ease;
  }

  .admin-sidebar.sidebar-open {
    transform: translateX(0);
  }

  .admin-main {
    margin-left: 0;
  }
}
</style>
