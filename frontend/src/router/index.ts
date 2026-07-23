import { createRouter, createWebHistory } from 'vue-router'
import AdminLoginView from '@/views/AdminLoginView.vue'
import AdminLayout from '@/views/AdminLayout.vue'

const AdminDashboardView = () => import('@/views/admin/AdminDashboardView.vue')

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      redirect: '/shop',
    },
    {
      path: '/shop',
      name: 'Shop',
      component: () => import('@/views/ShopView.vue'),
    },
    {
      path: '/s/:storefrontSlug',
      name: 'Storefront',
      component: () => import('@/views/ShopView.vue'),
    },
    {
      path: '/redeem',
      name: 'Redeem',
      component: () => import('@/views/RedeemView.vue'),
    },
    {
      path: '/lookup',
      name: 'Lookup',
      component: () => import('@/views/LookupView.vue'),
    },
    {
      path: '/order',
      name: 'Order',
      component: () => import('@/views/OrderView.vue'),
    },
    {
      path: '/admin/login',
      name: 'AdminLogin',
      component: AdminLoginView,
      meta: { requiresGuest: true },
    },
    {
      path: '/admin',
      component: AdminLayout,
      meta: { requiresAuth: true },
      children: [
        {
          path: '',
          name: 'AdminDashboard',
          component: AdminDashboardView,
        },
        {
          path: 'pending-tasks',
          name: 'AdminPendingTasks',
          component: AdminDashboardView,
        },
        {
          path: 'products',
          name: 'AdminProducts',
          component: () => import('@/views/admin/AdminProductsView.vue'),
        },
        {
          path: 'storefronts',
          name: 'AdminStorefronts',
          component: () => import('@/views/admin/AdminStorefrontsView.vue'),
        },
        {
          path: 'cards',
          name: 'AdminCards',
          component: () => import('@/views/admin/AdminCardsView.vue'),
        },
        {
          path: 'orders',
          name: 'AdminOrders',
          component: () => import('@/views/admin/AdminOrdersView.vue'),
        },
        {
          path: 'coupons',
          name: 'AdminCoupons',
          component: () => import('@/views/admin/AdminCouponsView.vue'),
        },
        {
          path: 'balance',
          name: 'AdminBalance',
          component: () => import('@/views/admin/AdminBalanceView.vue'),
        },
        {
          path: 'vouchers',
          name: 'AdminVouchers',
          component: () => import('@/views/admin/AdminVouchersView.vue'),
        },
        {
          path: 'recharges',
          name: 'AdminRecharges',
          component: () => import('@/views/admin/AdminRechargesView.vue'),
        },
        {
          path: 'config',
          name: 'AdminConfig',
          component: () => import('@/views/admin/AdminSystemConfigView.vue'),
        },
        {
          path: 'payment',
          name: 'AdminPayment',
          component: () => import('@/views/admin/AdminPaymentView.vue'),
        },
        {
          path: 'logs',
          name: 'AdminLogs',
          component: () => import('@/views/admin/AdminLogsView.vue'),
        },
      ],
    },
    {
      path: '/admin/:pathMatch(.*)*',
      redirect: '/admin',
    },
  ],
})

router.beforeEach((to) => {
  // 轻量路由守卫：管理端登录态检查
  // 注意：此处仅做前端跳转保护，真正权限仍由后端接口返回
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminToken = (() => {
    try {
      return localStorage.getItem('admin_token')
    } catch {
      return ''
    }
  })()

  const requiresAuth = to.meta.requiresAuth as boolean | undefined
  const requiresGuest = to.meta.requiresGuest as boolean | undefined

  if (requiresAuth && !adminToken) {
    return { name: 'AdminLogin', query: { redirect: to.fullPath }, replace: true }
  }

  if (requiresGuest && adminToken) {
    return { name: 'AdminDashboard', replace: true }
  }

  return true
})

export default router
