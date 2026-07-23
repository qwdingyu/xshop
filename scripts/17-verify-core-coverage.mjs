import { readFileSync } from "node:fs";

/*
 * cf-shop 核心测试覆盖门禁。
 *
 * 目标不是替代单元测试和真实 smoke，而是防止关键业务保护被误删：
 * - 超卖/锁库存/发卡原子性
 * - 余额支付扣款失败补偿
 * - 充值码并发消费
 * - 幂等下单
 * - 数据库唯一约束
 * - 三类核心 smoke 入口
 */

function read(path) {
  return readFileSync(path, "utf8");
}

const files = {
  packageJson: read("package.json"),
  architectureVerify: read("scripts/23-verify-light-architecture.mjs"),
  lightweightVerify: read("scripts/24-verify-lightweight-principles.mjs"),
  issueTest: read("src/services/issue-service.test.ts"),
  fulfillmentTest: read("src/services/fulfillment-service.test.ts"),
  orderTest: read("src/services/order-service.test.ts"),
  orderRealDbTest: read("src/services/order-service.real-db.test.ts"),
  orderService: read("src/services/order-service.ts"),
  ordersRouteTest: read("src/routes/orders.test.ts"),
  payTest: read("src/routes/pay.test.ts"),
  payIdempotencyRejectionTest: read("src/routes/pay-idempotency-rejection.test.ts"),
  payRealDbTest: read("src/routes/pay.real-db.test.ts"),
  payRoute: read("src/routes/pay.ts"),
  paymentReconciliationService: read("src/services/payment-reconciliation-service.ts"),
  paymentReconciliationTest: read("src/services/payment-reconciliation-service.test.ts"),
  emailAccess: read("src/lib/email-access.ts"),
  emailAccessTest: read("src/lib/email-access.test.ts"),
  emailAccessRoute: read("src/routes/email-access.ts"),
  emailAccessRouteTest: read("src/routes/email-access.test.ts"),
  vouchersRoute: read("src/routes/vouchers.ts"),
  vouchersRouteTest: read("src/routes/vouchers.test.ts"),
  adminPublicTest: read("src/routes/admin-public.test.ts"),
  telegramBot: read("src/telegram-bot/index.ts"),
  telegramBotTest: read("src/telegram-bot/index.test.ts"),
  easyPayProvider: read("src/services/payments/easypay.ts"),
  easyPayProviderTest: read("src/services/payments/easypay.test.ts"),
  md5Test: read("src/lib/md5.test.ts"),
  redeemRoute: read("src/routes/redeem.ts"),
  redeemRouteTest: read("src/routes/redeem.test.ts"),
  frontendApi: read("frontend/src/api/index.ts"),
  frontendSystemConfigApiTest: read("frontend/src/api/system-config-api.test.ts"),
  adminCardsView: read("frontend/src/views/admin/AdminCardsView.vue"),
  adminOrdersView: read("frontend/src/views/admin/AdminOrdersView.vue"),
  adminLogsView: read("frontend/src/views/admin/AdminLogsView.vue"),
  adminRouteTest: read("src/routes/admin.test.ts"),
  ordersRoute: read("src/routes/orders.ts"),
  productsRoute: read("src/routes/products.ts"),
  productsRouteTest: read("src/routes/products.test.ts"),
  systemConfigRoute: read("src/routes/system-config.ts"),
  systemConfigRouteTest: read("src/routes/system-config.test.ts"),
  adminSystemConfigRouteTest: read("src/routes/admin-system-config.test.ts"),
  adminSystemConfigRoute: read("src/routes/admin-system-config.ts"),
  adminSystemConfigView: read("frontend/src/views/admin/AdminSystemConfigView.vue"),
  adminPaymentView: read("frontend/src/views/admin/AdminPaymentView.vue"),
  adminStorefrontsView: read("frontend/src/views/admin/AdminStorefrontsView.vue"),
  shopView: read("frontend/src/views/ShopView.vue"),
  productCard: read("frontend/src/components/ProductCard.vue"),
  storefrontService: read("src/services/storefront-service.ts"),
  adminStorefrontRoute: read("src/routes/admin-storefronts.ts"),
  storefrontTemplateMigration: read("migrations/0012_storefront_templates.sql"),
  shopConfigComposable: read("frontend/src/composables/useShopConfig.ts"),
  shopConfigComposableTest: read("frontend/src/composables/useShopConfig.test.ts"),
  adminPublicConfigSyncContract: read("frontend/src/views/admin/admin-public-config-sync.contract.test.ts"),
  systemConfigDefinitions: read("src/lib/system-config-definitions.json"),
  productServiceTest: read("src/services/product-service.test.ts"),
  productService: read("src/services/product-service.ts"),
  shopView: read("frontend/src/views/ShopView.vue"),
  productCard: read("frontend/src/components/ProductCard.vue"),
  storefrontStock: read("frontend/src/lib/storefront-stock.ts"),
  storefrontStockTest: read("frontend/src/lib/storefront-stock.test.ts"),
  deliveryInfo: read("frontend/src/components/DeliveryInfo.vue"),
  deliveryDisplay: read("frontend/src/composables/useDeliveryDisplay.ts"),
  orderView: read("frontend/src/views/OrderView.vue"),
  lookupView: read("frontend/src/views/LookupView.vue"),
  checkoutFlow: read("frontend/src/composables/useCheckoutFlow.ts"),
  formatUtil: read("frontend/src/composables/useFormat.ts"),
  frontendTypes: read("frontend/src/types/index.ts"),
  payModal: read("frontend/src/components/PayModal.vue"),
  paymentComposable: read("frontend/src/composables/usePayment.ts"),
  sharedMoney: read("shared/money.ts"),
  sharedMoneyTest: read("shared/money.test.ts"),
  sharedOrderStatus: read("shared/order-status.ts"),
  sharedOrderStatusTest: read("shared/order-status.test.ts"),
  paymentAdapter: read("src/services/payments/index.ts"),
  frontendEntry: read("frontend/src/main.ts"),
  adminModal: read("frontend/src/components/AdminModal.vue"),
  adminSmoke: read("scripts/05-smoke-admin.mjs"),
  adminService: read("src/services/admin-service.ts"),
  adminServiceTest: read("src/services/admin-service.test.ts"),
  adminServiceRealDbTest: read("src/services/admin-service.real-db.test.ts"),
  voucherService: read("src/services/voucher-service.ts"),
  voucherTest: read("src/services/voucher-service.test.ts"),
  couponTest: read("src/services/coupon-service.test.ts"),
  cleanupTest: read("src/services/cleanup-service.test.ts"),
  cleanupService: read("src/services/cleanup-service.ts"),
  businessScenarioTest: read("src/services/business-scenarios.integration.test.ts"),
  idempotencyTest: read("src/lib/idempotency.test.ts"),
  migrationBaseline: read("migrations/0001_init.sql"),
  retentionMigration: read("migrations/0005_operational_retention_indexes.sql"),
  stockVisibilityMigration: read("migrations/0008_product_stock_visibility.sql"),
  smokeReadonly: read("scripts/04-smoke-readonly.mjs"),
  smokeAdmin: read("scripts/05-smoke-admin.mjs"),
  smokeWrite: read("scripts/06-smoke-write.mjs"),
  smokeLegacyGuards: read("scripts/20-smoke-legacy-guards.mjs"),
  smokeInventory: read("scripts/21-smoke-inventory-closure.mjs"),
  smokeCatalogAdmin: read("scripts/18-smoke-catalog-admin.mjs"),
  smokeOps: read("scripts/19-smoke-ops-crud.mjs"),
  smokeFrontendAssets: read("scripts/26-smoke-frontend-assets.mjs"),
  businessCleanupScript: read("scripts/22-cleanup-business-data.sh"),
  tursoExecScript: read("scripts/turso-exec.mjs"),
  scriptsReadme: read("scripts/README.md"),
  launchVerify: read("scripts/16-verify-launch.mjs"),
  launchGate: read("scripts/launch-gate.mjs"),
  launchGateTest: read("scripts/launch-gate.test.mjs"),
};

const checks = [
  [
    files.packageJson.includes('"verify:core": "node scripts/17-verify-core-coverage.mjs"') &&
      files.packageJson.includes("npm run verify:core") &&
      files.packageJson.includes('"verify:architecture": "node scripts/23-verify-light-architecture.mjs"') &&
      files.packageJson.includes("npm run verify:architecture") &&
      files.packageJson.includes('"verify:lightweight": "node scripts/24-verify-lightweight-principles.mjs"') &&
      files.packageJson.includes("npm run verify:lightweight") &&
      files.architectureVerify.includes("services layer must not import routes") &&
      files.architectureVerify.includes("admin API client must stay inside admin surfaces") &&
      files.lightweightVerify.includes("allowedRuntimeDependencies") &&
      files.lightweightVerify.includes("legacy smoke wrappers"),
    "package.json must expose verify:core/verify:architecture/verify:lightweight and include them in verify:delivery; gates must protect layer, dependency, and smoke-entry boundaries",
  ],
  [
    files.issueTest.includes("prefers locked card for the same order") &&
      files.issueTest.includes("does not lock already locked card") &&
      files.issueTest.includes("releases expired locked cards before locking available card") &&
      files.businessScenarioTest.includes("卡密自身过期时：前台库存、详情库存和下单锁卡必须一致排除") &&
      files.businessScenarioTest.includes("已锁定订单付款时如果卡密自身过期，不得继续发放过期卡密") &&
      files.issueTest.includes("does not issue a card locked by another order") &&
      files.issueTest.includes("does not issue an available card from another product") &&
      files.issueTest.includes("does not lock an available card from another product"),
    "issue-service tests must cover locked-card priority, locked-card exclusion, expired-lock recovery, card secret expiry across read/lock/issue paths, and cross-order/product isolation",
  ],
  [
    files.fulfillmentTest.includes("locks every requested inventory item for multi-quantity orders") &&
      files.fulfillmentTest.includes("cannot reserve the full quantity") &&
      files.fulfillmentTest.includes("issues every requested card for direct multi-quantity orders") &&
      files.fulfillmentTest.includes("cannot fulfill the full quantity"),
    "fulfillment-service tests must cover full-quantity lock/issue success and shortage failure paths",
  ],
  [
    !files.productsRoute.includes("cacheGet") &&
      !files.productsRoute.includes("cachePut") &&
      files.productsRoute.includes("no-store, no-cache, must-revalidate") &&
      files.productsRouteTest.includes("Cache-Control") &&
      files.productsRouteTest.includes("does not import or touch Workers Cache API for product responses") &&
      files.productsRouteTest.includes("does not reuse stale product list stock or price between requests") &&
      files.productsRouteTest.includes("does not reuse stale product detail stock or price between requests") &&
      files.productsRouteTest.includes("priceCents") &&
      !files.systemConfigRoute.includes("cacheGet") &&
      !files.systemConfigRoute.includes("cachePut") &&
      files.systemConfigRoute.includes("no-store, no-cache, must-revalidate") &&
      files.systemConfigRouteTest.includes("reads public config directly from DB with no-store headers") &&
      !files.adminSystemConfigRoute.includes("cacheDelete") &&
      files.frontendApi.includes("fetchConfig(): Promise<SystemConfig>") &&
      files.frontendApi.includes("request('/api/system-config', { cache: 'no-store' })") &&
      files.frontendApi.includes("request('/api/pay/methods', { cache: 'no-store' })") &&
      files.frontendSystemConfigApiTest.includes("does not cache token-authorized payment status or delivery data") &&
      files.adminSystemConfigView.includes("refreshPublicConfig") &&
      files.adminSystemConfigView.includes("loadShopConfig(true)") &&
      files.adminPaymentView.includes("refreshPublicShopConfig") &&
      files.adminPaymentView.includes("loadShopConfig(true)") &&
      files.shopConfigComposable.includes("queuedForcedLoad") &&
      files.shopConfigComposableTest.includes("runs a forced refresh after an in-flight request") &&
      files.adminPublicConfigSyncContract.includes("visibilitychange"),
    "storefront inventory, public feature switches, and payment capabilities must bypass browser/Workers Cache state",
  ],
  [
    files.packageJson.includes('"@usethink/cf-core": "^0.3.7"') &&
      files.sharedMoney.includes('@usethink/cf-core/features/payment/currency') &&
      files.sharedMoneyTest.includes('fails closed for unsupported provider currencies or malformed values') &&
      files.paymentAdapter.includes('selectPaymentProviderForCurrency') &&
      !files.paymentAdapter.includes('supportedCurrencies.some'),
    "money parsing and currency-aware provider selection must stay delegated to cf-core while cf-shop keeps its provider allowlist policy",
  ],
  [
    files.shopView.includes("stock: latest.stock") &&
      files.shopView.includes("fetchProductDetail(product.id, activeStorefront.slug)") &&
      files.shopView.includes("payment:closed") &&
      files.payModal.includes("await handleClose()") &&
      files.payModal.includes("fetchProductDetail(product.value.id, product.value.storefrontSlug)") &&
      files.payModal.includes("storefrontQuantityLimit(product.value)") &&
      files.payModal.includes("exactStockOrNull(latest)") &&
      files.storefrontStockTest.includes("uses the real stock only when exact visibility is enabled") &&
      files.storefrontStockTest.includes("without reconstructing hidden stock"),
    "frontend payment flow must refresh live stock, share the visibility policy, and never reconstruct hidden stock",
  ],
  [
    files.productServiceTest.includes("keeps non-card products purchasable without card inventory") &&
      files.productCard.includes("productIsSoldOut") &&
      files.productCard.includes("productStockLabel") &&
      files.shopView.includes("productIsSoldOut(latest)") &&
      files.shopView.includes("stockDisplayMode: latest.stockDisplayMode") &&
      files.payModal.includes("product.value.canPurchase !== false") &&
      files.payModal.includes("quantityHint") &&
      files.storefrontStock.includes("if (!requiresInventory(product)) return '不限库存'") &&
      files.storefrontStock.includes("product.canPurchase === false"),
    "storefront must use one stock policy so non-card products stay purchasable and sold-out products remain blocked",
  ],
  [
    files.deliveryInfo.includes("fulfillmentMode") &&
      files.deliveryInfo.includes("showCardDelivery") &&
      files.deliveryDisplay.includes("includeLegacyDeliveryFields") &&
      files.orderView.includes(":fulfillment-mode=\"deliveryFulfillmentMode\"") &&
      files.orderView.includes("isCardDelivery ? '卡密信息' : '交付内容'") &&
      files.orderView.includes("getDeliveryEntries") &&
      files.lookupView.includes("deliveryFulfillmentMode(order)") &&
      files.lookupView.includes("Object.values(order.delivery).some(Boolean)") &&
      files.adminOrdersView.includes("currentOrderFulfillmentMode") &&
      files.adminOrdersView.includes("<DeliveryInfo") &&
      files.adminOrdersView.includes("isCurrentOrderCardDelivery"),
    "delivery UI must use fulfillment mode instead of guessing from deliverySecret/accountLabel so virtual products are not shown as card passwords in storefront or admin",
  ],
  [
    files.ordersRoute.includes("LEGACY_ORDER_DISABLED") &&
      files.ordersRoute.includes("/api/pay/unified") &&
      files.ordersRouteTest.includes("rejects legacy order creation and directs clients to unified payment") &&
      !files.frontendApi.includes("export function createOrder"),
    "legacy public order creation must stay disabled so every paid checkout goes through /api/pay/unified payment and inventory state machine",
  ],
  [
    files.emailAccess.includes('name: "HMAC"') &&
      files.emailAccess.includes('hash: "SHA-256"') &&
      files.emailAccess.includes("currentWindow - 1") &&
      files.emailAccessTest.includes("accepts the current and immediately previous window only") &&
      files.emailAccessRoute.includes('post("/email/access-code"') &&
      files.emailAccessRoute.includes("verifyTurnstile") &&
      files.emailAccessRouteTest.includes("without returning it in the response") &&
      files.vouchersRoute.includes("verifyEmailAccessCode") &&
      files.vouchersRouteTest.includes("mailbox ownership is not verified") &&
      files.ordersRoute.includes('post("/orders/lookup"') &&
      files.ordersRoute.includes("getOrderSummariesByEmail") &&
      !files.ordersRoute.includes("getOrderSummaryByNoAndEmail") &&
      files.ordersRouteTest.includes("lists redacted order summaries for the verified mailbox") &&
      files.orderRealDbTest.includes("never selects private delivery fields") &&
      files.payRoute.indexOf("const mailboxVerified") < files.payRoute.indexOf("const idempotencyKey") &&
      files.payTest.includes("before idempotency replay or inventory locking") &&
      files.frontendApi.includes("requestEmailAccessCode") &&
      files.frontendApi.includes("X-Email-Access-Code") &&
      files.frontendApi.includes("lookupOrdersByEmail") &&
      files.frontendApi.includes("request<{ orders: Order[] }>") &&
      files.frontendApi.includes("body: JSON.stringify({ email })") &&
      files.ordersRoute.includes('c.req.header("x-email-access-code")') &&
      files.lookupView.includes("emailAccessCode") &&
      !files.lookupView.includes("本机最近购买记录") &&
      !files.payModal.includes("addRecentOrder") &&
      files.payModal.includes("balanceChecked"),
    "email ownership must be proven before mailbox-scoped summaries, balance reads/debits, or cached delivery replay; summaries must stay redacted",
  ],
  [
    !files.payModal.includes("addRecentOrder") &&
      files.paymentComposable.includes("sessionStorage.getItem(PENDING_ATTEMPTS_KEY)") &&
      !files.paymentComposable.includes("localStorage.getItem(PENDING_ATTEMPTS_KEY)") &&
      files.frontendEntry.includes("localStorage.removeItem('recent_orders')") &&
      files.frontendEntry.includes("localStorage.removeItem('pending_checkout_attempts')"),
    "storefront must not persist order access or checkout recovery credentials across browser sessions",
  ],
  [
    files.stockVisibilityMigration.includes("stock_display_mode") &&
      files.stockVisibilityMigration.includes("availability_only") &&
      files.stockVisibilityMigration.includes("hidden") &&
      files.productService.includes("toStorefrontProduct") &&
      files.productServiceTest.includes("removes exact stock fields in availability-only mode") &&
      files.productServiceTest.includes("removes stock and low-stock signals in hidden mode") &&
      files.storefrontStockTest.includes("still blocking sold-out products"),
    "stock visibility must be enforced by the migration, backend response projection, and shared storefront regression tests",
  ],
  [
    files.adminModal.includes("closeOnBackdrop: false") &&
      files.adminModal.includes("closeOnEscape: false") &&
      files.adminModal.includes("max-height: calc(100dvh - 48px)") &&
      files.adminModal.includes("bodyRef.value.scrollTop = 0") &&
      files.adminOrdersView.includes('title="订单详情"'),
    "admin order details must use a viewport-bounded modal that cannot be dismissed accidentally and opens at the top",
  ],
  [
    files.adminRouteTest.includes("clears all merged logs only with the explicit confirmation phrase") &&
      files.adminServiceRealDbTest.includes("retaining one purge audit") &&
      files.adminLogsView.includes("clearAllAdminLogs") &&
      files.adminLogsView.includes("清除全部日志"),
    "clear-all operation logs must require explicit confirmation, retain a transactionally tested audit, and have an admin UI entry",
  ],
  [
    files.orderService.includes('input.status !== "issued"') &&
      files.orderService.includes("邮件可能延迟") &&
      files.orderTest.includes("does not claim email delivery before an email-only order is issued") &&
      files.payTest.includes("does not claim email delivery while an email-only order is still pending") &&
      files.payRoute.includes("status: order.status") &&
      files.payRoute.includes("status: \"issued\"") &&
      files.lookupView.includes("order.deliveryMessage"),
    "email-only delivery messages must only claim delivery after the immutable order status reaches issued",
  ],
  [
    files.payRoute.includes("orderFulfillmentModeSnapshot") &&
      files.frontendApi.includes("fulfillmentMode?: string") &&
      files.payModal.includes("orderState?.fulfillmentMode || product.fulfillmentMode") &&
      files.orderView.includes("order.value?.fulfillmentMode") &&
      files.lookupView.includes("order.fulfillmentMode"),
    "user-facing payment and order views must consume the order fulfillment snapshot instead of reinterpreting delivery from the current product mode",
  ],
  [
    files.adminServiceRealDbTest.includes("real libSQL order snapshots") &&
      files.adminServiceRealDbTest.includes("getOrderList") &&
      files.adminServiceRealDbTest.includes("exportOrders") &&
      files.adminServiceRealDbTest.includes("getOrderDetail") &&
      files.adminServiceRealDbTest.includes('toBe("virtual")'),
    "admin list, export, and detail fulfillment snapshots must be covered against real libSQL, not only ORM mocks",
  ],
  [
    files.adminPublicTest.includes("different Telegram user") &&
      files.adminPublicTest.includes("empty admin token") &&
      files.telegramBot.includes("providedAdminToken") &&
      files.telegramBotTest.includes("rejects unauthenticated setup requests"),
    "Telegram admin JWT exchange must enforce owner identity and webhook setup must require ADMIN_TOKEN",
  ],
  [
    files.orderService.includes("checkProductPurchaseLimitForQuantity") &&
      files.orderService.includes("COALESCE(SUM(${orders.quantity}), 0)") &&
      files.orderService.includes("eq(orders.status, 'issued')") &&
      files.payRoute.includes("checkProductPurchaseLimitForQuantity") &&
      files.payTest.includes("enforces product purchase limit before unified payment locks inventory") &&
      !files.payRoute.includes('post("/pay/offline"') &&
      files.orderTest.includes("returns 429 when product purchase limit reached by quantity") &&
      files.businessScenarioTest.includes("商品限购按购买件数累计，超过限购时不再锁库存"),
    "product purchase limits must count purchased quantity, include issued orders, run before unified inventory locking, and keep the removed offline creation route absent",
  ],
  [
    files.payRoute.includes("order.status === \"issued\"") &&
      files.payRoute.includes('["pending", "paid"].includes(order.status)') &&
      files.payRoute.includes("chargePendingInternalOrder") &&
      files.payRoute.includes("compensateFailedInternalOrder") &&
      files.payRoute.includes("订单状态不可站内结算") &&
      files.payRoute.includes('order.paymentProvider === "free"') &&
      files.payRoute.includes("const orderFulfillmentMode = FULFILLMENT_MODES.includes") &&
      files.payTest.includes("already issued balance orders as idempotent") &&
      files.payTest.includes("retries fulfillment for paid balance orders without charging again") &&
      files.payTest.includes("uses the order fulfillment snapshot when the product setting has changed") &&
      files.payTest.includes("uses the order fulfillment snapshot for balance cleanup and delivery") &&
      files.businessScenarioTest.includes("余额支付已发卡订单重试时不能二次扣款或释放已交付卡密") &&
      files.businessScenarioTest.includes("BALANCE-ONCE") &&
      files.businessScenarioTest.includes("expect(coupon.usedCount).toBe(1)"),
    "internal settlement must distinguish free from balance, remain idempotent, use order snapshots, and never double-charge, double-consume coupons, or release delivered inventory on retries",
  ],
  [
    files.telegramBot.includes('paymentProvider: "easypay"') &&
      files.telegramBot.includes('registry.get("easypay")') &&
      files.telegramBot.includes('eq(orders.productId, "tg_custom")') &&
      files.telegramBot.includes('eq(orders.paymentMethod, "tg_easypay")') &&
      files.telegramBot.includes('eq(orders.paymentProvider, "easypay")') &&
      !files.telegramBot.includes('eq(orders.paymentProvider, "")') &&
      files.telegramBot.includes('.returning({ id: orders.id })') &&
      files.telegramBot.includes('order.status !== "pending"') &&
      files.telegramBot.includes("didClose = closed.rowsAffected > 0") &&
      files.telegramBot.includes('"notification_failed"') &&
      files.telegramBotTest.includes("拒绝金额不匹配的回调并记录事件") &&
      files.telegramBotTest.includes("订单不存在时返回 404 以保留支付平台重试") &&
      files.telegramBotTest.includes("records a verified payment even when the user closed the Telegram order first") &&
      files.telegramBotTest.includes("records a verified Telegram payment even when its notification arrives after expiry") &&
      files.telegramBotTest.includes("拒绝与已支付订单记录不一致的支付流水") &&
      files.telegramBotTest.includes("recovers a verified payment when close wins the first callback CAS") &&
      files.telegramBotTest.includes("CAS 失败后恢复并记录过期前已付款的 Telegram 订单") &&
      files.telegramBotTest.includes("支付回调抢先改变状态时不误记 expired 事件") &&
      files.telegramBotTest.includes("支付回调抢先完成时关闭订单不能覆盖 paid 状态") &&
      files.telegramBotTest.includes("拒绝 payment provider 快照为空的 Telegram 待支付订单") &&
      files.telegramBotTest.includes("拒绝缺少币种的 Telegram 支付回调") &&
      files.telegramBot.includes("tryNormalizeCurrencyCode(callbackResult.currency)") &&
      files.telegramBotTest.includes("拒绝 provider 非空且不是 easypay 的 Telegram 回调") &&
      files.telegramBotTest.includes("支付落库后 Telegram 通知失败仍确认回调并记录失败事件") &&
      files.telegramBotTest.includes("支付状态落库后审计事件失败不触发支付平台重试") &&
      files.telegramBot.includes('inArray(orders.status, ["pending", "expired", "closed"])') &&
      files.telegramBot.match(/notification = await tgSendHtml/g)?.length === 2 &&
      files.telegramBot.includes('currentOrder.paymentRef === callbackResult.providerTradeNo') &&
      files.telegramBot.includes("normalizeTelegramPaymentUrl") &&
      files.telegramBotTest.includes("does not trust a success query parameter when the order does not exist") &&
      files.telegramBotTest.includes("does not trust a success query parameter when database access is unavailable") &&
      files.telegramBotTest.includes("accepts only absolute HTTP(S) payment URLs"),
    "Telegram collection must use EasyPay consistently, fail closed for unverified result pages and unsafe payment URLs, protect state transitions against races, and keep notification or audit failures from corrupting persisted results",
  ],
  [
    files.orderService.includes("const visibilityPayload = deliveryVisibilityPayload") &&
      files.orderService.includes('deliveryVisibility !== "email_only"') &&
      files.orderService.includes("await assertProductPurchaseLimit(tx, normalizedBuyerEmail, product, quantity)") &&
      files.orderTest.includes("does not return virtual delivery plaintext for email-only direct orders") &&
      files.orderTest.includes("does not return card plaintext for email-only direct orders") &&
      files.orderTest.includes("rechecks direct purchase limit inside its write transaction") &&
      files.orderTest.includes("consumes a free coupon when creating a virtual direct order"),
    "internal direct orders must enforce transactional purchase limits and coupon consumption while keeping email-only delivery plaintext out of API results",
  ],
  [
    files.sharedOrderStatus.includes('if (raw === "cancelled") return "canceled"') &&
      files.sharedOrderStatus.includes("SAFE_DELETE_ORDER_STATUSES") &&
      files.sharedOrderStatus.includes("expandOrderStatusFilter") &&
      files.sharedOrderStatusTest.includes("normalizes cancelled to canceled") &&
      files.sharedOrderStatusTest.includes("expands canceled filter to include legacy cancelled spelling") &&
      files.checkoutFlow.includes("normalizeOrderStatus") &&
      files.checkoutFlow.includes("=== 'canceled'") &&
      files.checkoutFlow.includes("=== 'closed'") &&
      files.checkoutFlow.includes("'refunded'") &&
      files.formatUtil.includes("orderStatusLabel") &&
      files.formatUtil.includes("@shared/order-status") &&
      files.orderView.includes("closed: '已关闭'") &&
      files.orderView.includes("refunded: '已退款'") &&
      files.orderView.includes("normalizeOrderStatus") &&
      files.orderView.includes("TERMINAL_ORDER_STATUS_SET") &&
      files.adminOrdersView.includes("closed: '已关闭'") &&
      files.adminOrdersView.includes("refunded: '已退款'") &&
      files.adminOrdersView.includes("ABNORMAL_ORDER_STATUSES") &&
      files.adminOrdersView.includes("isSafeDeleteOrderStatus") &&
      files.adminOrdersView.includes("normalizeOrderStatus") &&
      files.adminOrdersView.includes("currentOrder.events") &&
      files.adminOrdersView.includes("notification_failed: '通知失败'") &&
      files.adminService.includes("expandOrderStatusFilter") &&
      files.adminService.includes("isSafeDeleteOrderStatus") &&
      files.adminService.includes("原关联订单已删除") &&
      files.adminService.includes("eq(balanceTransactions.referenceType, \"order\")") &&
      files.adminService.includes(".from(orderEvents)") &&
      files.adminService.includes(".limit(50)") &&
      files.adminServiceTest.includes("订单存在时应包含 items、cards 和最近事件聚合字段") &&
      files.adminServiceRealDbTest.includes("normalizes cancelled spelling for safe delete and clears balance ledger order refs") &&
      files.frontendTypes.includes("export type { OrderStatus }") &&
      !files.frontendApi.includes("deliveryJson?: string"),
    "shared order-status must normalize cancelled→canceled; frontend polling/detail/admin abnormal views consume it; delete clears balance ledger order refs; admin order detail exposes bounded events; public API types must not advertise raw deliveryJson",
  ],
  [
    files.payModal.includes("未配置<br />收款码") &&
      files.payModal.includes("offline-order-summary") &&
      files.payModal.includes("orderState?.orderNo") &&
      files.payModal.includes("pay-timer-inline") &&
      files.payModal.includes("微信/支付宝账单详情里的交易单号或商户单号后 4 位") &&
      files.payModal.includes("canSubmitOrder") &&
      files.adminSmoke.includes("normalizeOfflinePayHintForSmoke(originalHint)") &&
      !files.adminSmoke.includes("const smokeHint = `线下付款 smoke 提示") &&
      !files.adminSmoke.includes("originalHint === \"true\" ? \"false\" : \"true\""),
    "offline payment UI must explain missing QR codes, inline countdown, payment reference meaning, and smoke must preserve merchant text while repairing known generated values",
  ],
  [
      files.easyPayProvider.includes("md5Hex") &&
      files.easyPayProvider.includes("callback missing trade_no") &&
      files.easyPayProvider.includes("api.php") &&
      files.easyPayProvider.includes("?act=order") &&
      files.easyPayProvider.includes("mapi.php") &&
      files.easyPayProviderTest.includes("without a provider trade number") &&
      files.easyPayProviderTest.includes("queries api.php") &&
      !files.easyPayProvider.includes('crypto.subtle.digest("MD5"') &&
      files.md5Test.includes("matches standard MD5 test vectors"),
    "EasyPay-compatible callbacks must use portable MD5 verification, reject signed success payloads without provider trade numbers, and keep mapi/api endpoint coverage",
  ],
  [
    files.orderTest.includes("returns 409 when manual mode and no card available") &&
      files.orderTest.includes("keeps paid order paid when issuing fails") &&
      files.businessScenarioTest.includes("expect(order.status).toBe(\"paid\")") &&
      files.cleanupTest.includes("does not release expired locks that still belong to active orders") &&
      files.businessScenarioTest.includes("清理任务不得释放已付款订单的过期锁定卡密") &&
      files.businessScenarioTest.includes("回调到达前不得重新分配仍属于 pending 订单的过期锁") &&
      files.adminService.includes('order.status !== "pending"') &&
      files.adminServiceTest.includes("cancelOrder 对 paid 订单拒绝取消且不释放库存或优惠券") &&
      files.adminOrdersView.includes("canManualConfirmPayment") &&
      files.adminRouteTest.includes("rejects manual mark-paid for online pending orders") &&
      files.businessScenarioTest.includes("后台取消不得取消已付款未发货订单") &&
      files.orderTest.includes("reuses existing issued card for paid order instead of issuing another card") &&
      files.orderTest.includes("concurrent"),
    "order-service, admin payment operations, and cleanup tests must cover no-stock failure, paid-state preservation, paid-order lock preservation, paid-order cancel rejection, offline-only manual payment confirmation, existing-card reuse, and concurrency paths",
  ],
  [
    files.cleanupTest.includes("prunes bounded-lifetime operational data during the scheduled cleanup") &&
      files.cleanupService.includes("delete(rateLimitWindows)") &&
      files.cleanupService.includes("delete(idempotencyKeys)") &&
      files.cleanupService.includes("delete(cardLogs)") &&
      files.retentionMigration.includes("idx_rate_limit_windows_window_start") &&
      files.retentionMigration.includes("idx_idempotency_keys_created_at") &&
      files.retentionMigration.includes("idx_card_logs_created_at") &&
      files.retentionMigration.includes("idx_admin_audit_logs_created_at"),
    "scheduled cleanup must bound rate-limit, idempotency, request, email, card, order-event, and admin-audit data with indexed retention predicates",
  ],
  [
    files.adminSystemConfigRouteTest.includes("without returning secret values") &&
      files.adminSystemConfigRouteTest.includes("does not write sensitive configuration values") &&
      files.adminSystemConfigRoute.includes("isSensitiveSystemConfigKey") &&
      files.systemConfigDefinitions.match(/"sensitive": true/g)?.length === 2 &&
      files.adminServiceTest.includes("redacts historical sensitive system config values") &&
      files.adminService.includes("sensitiveSystemConfigUpdate"),
    "admin system configuration must expose only configured-state for secrets and redact both new and historical sensitive audit metadata",
  ],
  [
    files.adminServiceRealDbTest.includes("keeps merged log pages stable when new rows arrive") &&
      files.adminServiceRealDbTest.includes("keeps email log pages on the first-request snapshot") &&
      files.adminService.includes("ORDER BY createdAt DESC, type DESC, id DESC") &&
      files.adminLogsView.includes("snapshotAt.value = res.snapshotAt"),
    "admin merged and email logs must use a first-request snapshot, stable identifiers, and deterministic ordering across offset pages",
  ],
  [
    files.payTest.includes("refunds balance, releases stock, and marks order failed when issuing fails") &&
      files.payTest.includes("commits the balance deduction and pending-to-paid claim in the same transaction") &&
      files.payTest.includes("does not refund or release inventory when concurrent fulfillment already issued the order") &&
      files.payTest.includes("compensates a previously charged paid order exactly once when retry fulfillment fails") &&
      files.payRealDbTest.includes("refunds a failed fulfillment exactly once across retries") &&
      files.payTest.includes("caches the completed balance response for idempotent replay") &&
      files.payTest.includes("stores a recoverable balance response before fulfillment starts") &&
      files.payTest.includes("retries fulfillment for a paid balance order and returns the refreshed issued state") &&
      files.payTest.includes("releases stock and closes order when balance is insufficient") &&
      files.payTest.includes("releases stock and closes order when balance deduction loses the race") &&
      files.payTest.includes("does not refund or release stock after balance payment issues successfully") &&
      files.payTest.includes("lockFulfillmentInventory") &&
      files.payTest.includes("locks the requested quantity for unified manual card orders") &&
      files.payTest.includes("does not create or lock an offline order when no collection QR is configured") &&
      files.payTest.includes("cancels a pending offline order and releases locked stock by order token") &&
      files.payTest.includes("rejects expired offline payment confirmation before saving payment reference") &&
      files.payTest.includes("does not cancel when payment confirmation wins the concurrent update") &&
      files.payTest.includes("does not confirm when cancellation wins the concurrent update") &&
      files.payTest.includes("does not overwrite or release an online order when callback wins the provider creation failure race") &&
      files.payTest.includes("keeps the online order pending when provider creation times out ambiguously") &&
      files.payTest.includes("backfills an issued order payment reference before acknowledging the callback") &&
      files.adminServiceRealDbTest.includes("rolls back the canceled status when locked-card release fails") &&
      files.payRoute.includes("chargePendingInternalOrder") &&
      files.payRoute.includes("compensateFailedInternalOrder") &&
      files.payRoute.includes("failPendingOrderAndRelease") &&
      files.payRoute.includes("internalRecoveryResponse") &&
      files.payRoute.includes("clearCachedIdempotentResponse") &&
      files.payRoute.includes('order.paymentProvider === "balance"') &&
      files.payRoute.includes("eq(orders.paymentRef, order.paymentRef || \"\")"),
    "pay route tests must cover atomic internal settlement and balance compensation, provider failure races, fulfillment locks, quantity propagation, offline QR readiness, and transaction-safe cancellation",
  ],
  [
    files.voucherTest.includes("concurrently consumed") &&
      files.voucherTest.includes("writes spend and refund ledger entries") &&
      files.voucherTest.includes("does not write spend ledger when balance is insufficient") &&
      files.voucherTest.includes("treats zero amount deduction as a no-op without ledger noise") &&
      files.voucherService.includes("crypto.getRandomValues") &&
      !files.voucherService.includes("Math.random()"),
    "voucher tests must cover concurrent voucher consumption, balance ledger entries, insufficient funds, zero-amount no-op, and voucher code generation must use Web Crypto",
  ],
  [
    files.redeemRoute.includes("withDbTransaction") &&
      files.redeemRoute.includes("checkProductPurchaseLimitForQuantity") &&
      files.redeemRouteTest.includes("consumes coupon, issues card, writes order, and returns delivery in one transaction") &&
      files.redeemRouteTest.includes("rechecks the purchase limit inside the redeem transaction") &&
      files.redeemRouteTest.includes("does not issue a card when coupon consumption loses the race") &&
      files.redeemRouteTest.includes("rolls back coupon consumption automatically when stock is unavailable") &&
      files.redeemRouteTest.includes("transaction roll back card issue and coupon consumption when order insert fails"),
    "redeem route must transact coupon consumption, card issue, and order write, with tests for race, stock shortage, and order-write failure rollback",
  ],
  [
    files.orderService.includes("const couponResult = await consumeCoupon(tx, couponCode)") &&
      files.orderService.includes("orders.fulfillmentMode") &&
      files.orderService.includes("orderItems.fulfillmentMode") &&
      files.orderService.includes(".returning({ id: orders.id, couponCode: orders.couponCode })") &&
      files.orderService.includes("releaseCouponReservation(tx, expiredOrder.couponCode)") &&
      files.payRoute.includes("restoreVerifiedExpiredPayment") &&
      files.paymentReconciliationService.includes("restoreVerifiedExpiredPayment") &&
      files.paymentReconciliationService.includes("restoreCouponReservation(tx, restored.couponCode)") &&
      files.paymentReconciliationService.includes("reconcileOnlineOrderPayment") &&
      files.paymentReconciliationTest.includes("restores an expired order only when EasyPay timing proves payment happened before expiry") &&
      files.paymentReconciliationTest.includes("refuses to reconcile when EasyPay query trade number conflicts with the recorded payment ref") &&
      files.payTest.includes("recovers a verified pre-expiry payment when expiration wins the first update race") &&
      files.couponTest.includes("restores one previously released use for a verified payment") &&
      files.orderTest.includes("issues reserved coupon card order without consuming coupon again") &&
      files.orderTest.includes("does not consume coupon again when issuing reserved coupon card order") &&
      files.orderTest.includes("does not consume coupon again when issuing reserved coupon virtual order") &&
      files.orderTest.includes("does not overwrite a canceled order when recovering an existing card") &&
      files.payRoute.includes("releaseOrderCouponReservation") &&
      files.payTest.includes("does not lock stock when coupon reservation fails") &&
      files.payTest.includes("rejects invalid coupon before unified payment locks inventory") &&
      !files.payRoute.includes('post("/pay/offline"') &&
      files.adminCardsView.includes("订单状态机管理") &&
      files.orderService.includes("优惠码已被他人使用或已失效，请重试") &&
      !files.orderService.includes("coupon_consume_failed") &&
      !files.orderTest.includes("warns but does not fail when coupon consume fails"),
    "paid-order coupon flow must reserve coupons in the order transaction, release reservations on cancel/expiry/failure, and never consume again during fulfillment",
  ],
  [
      files.idempotencyTest.includes("shouldProceed") &&
      files.idempotencyTest.includes("pending") &&
      files.idempotencyTest.includes("clearPendingIdempotency") &&
      files.ordersRouteTest.includes("LEGACY_ORDER_DISABLED") &&
      files.payTest.includes("same Idempotency-Key is already in flight") &&
      files.payTest.includes("clears pending idempotency reservation when unified payment rejects invalid coupon") &&
      files.payIdempotencyRejectionTest.includes("payment rate limit rejects the request") &&
      files.payIdempotencyRejectionTest.includes("Turnstile rejects the request") &&
      files.payTest.includes("requires Idempotency-Key in the header and ignores a body compatibility field") &&
      files.payTest.includes("rejects invalid coupon before unified payment locks inventory") &&
      !files.payRoute.includes('post("/pay/offline"') &&
      files.payTest.includes("rejects callbacks for canceled orders and does not try fulfillment") &&
      files.payTest.includes("rejects callbacks for expired orders and does not try fulfillment") &&
      files.payTest.includes("rejects callback amount mismatch before updating payment state") &&
      files.payTest.includes("continues fulfillment retry for paid callback when payment state update succeeds") &&
      files.payTest.includes("persists paid status before fulfillment and returns retryable failure when issuing fails") &&
      files.payTest.includes("returns every issued card for multi-quantity balance payments") &&
      files.payTest.includes("settles zero-amount orders without creating an external payment") &&
      files.payTest.includes("retries fulfillment for a paid zero-amount order without invoking an external provider") &&
      files.payTest.includes("FREE-ACC") &&
      files.payTest.includes("fails and closes the local order when EasyPay returns no safe payment entry") &&
      files.payTest.includes("keeps EasyPay qrcode content separate from the image field") &&
      files.orderTest.includes("returns { expired: false } when status is paid and past expiresAt") &&
      files.payRoute.includes("if (couponCode && !quote.valid)") &&
      files.payRoute.includes('status: "paid"') &&
      files.payRoute.includes('order.paymentProvider === "free" && Number(order.amountCents || 0) === 0') &&
      files.payRoute.includes("PAYMENT_CREATION_FAILED") &&
      files.payRoute.includes("PAYMENT_CREATION_UNCERTAIN") &&
      files.payRoute.includes("qrImageUrl") &&
      files.payRoute.includes("callback_timing_unverified") &&
      files.payRoute.includes("eq(cards.issuedOrderId, orderId)") &&
      files.payRoute.includes("cardData: [card.accountLabel, card.deliverySecret].filter(Boolean).join") &&
      files.payRoute.includes("callback_amount_mismatch") &&
      files.payRoute.includes("callback_rejected") &&
      files.payRoute.includes("clearPendingIdempotency") &&
      files.frontendApi.includes("idempotencyKey: string") &&
      files.frontendApi.includes("'Idempotency-Key': payload.idempotencyKey") &&
      files.smokeWrite.includes("Idempotency-Key"),
    "idempotency, coupon validation, and payment callbacks/status polling must cover pending conflicts, rate-limit/Turnstile cleanup, invalid coupon rejection before inventory lock, EasyPay callback validation, free/balance fulfillment recovery, frontend header propagation, and write smoke",
  ],
  [
    files.adminCardsView.includes("locked: '锁定中'") &&
      files.adminCardsView.includes("issued: '已发卡'") &&
      files.adminCardsView.includes("canToggleStatus") &&
      files.adminCardsView.includes("订单状态机管理"),
    "admin card UI must display locked/issued states accurately and prevent manual toggles outside available/disabled inventory",
  ],
  [
    files.migrationBaseline.includes("CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_product_delivery_secret_unique") &&
      files.migrationBaseline.includes("delivery_json TEXT NOT NULL DEFAULT ''") &&
      files.businessScenarioTest.includes("真实 libSQL + 真实服务层"),
    "baseline migration and business scenario tests must cover unique card secrets, virtual delivery, and real libSQL flows",
  ],
  [
    files.smokeReadonly.includes("/api/health") &&
      files.smokeReadonly.includes("/api/products") &&
      files.smokeReadonly.includes("assertNoStore") &&
      files.smokeReadonly.includes("assertSameProductSummary") &&
      files.smokeReadonly.includes("Product category count mismatch") &&
      files.smokeReadonly.includes("Product list/detail ${field} mismatch") &&
      files.smokeReadonly.includes('"priceCents"') &&
      files.smokeReadonly.includes('"stockDisplayMode"') &&
      files.smokeReadonly.includes("must not expose ${field}") &&
      files.smokeReadonly.includes("must not expose isLowStock") &&
      files.smokeReadonly.includes("/api/system-config"),
    "readonly smoke must cover health, live product contracts for every stock visibility mode, category counts, and public system config",
  ],
  [
    files.smokeAdmin.includes("/api/admin/products") &&
      files.smokeAdmin.includes("/api/admin/cards/import") &&
      files.smokeAdmin.includes("/mark-paid") &&
      files.smokeAdmin.includes("/api/admin/system-config") &&
      files.smokeAdmin.includes("finally") &&
      files.smokeAdmin.includes("restoreSystemConfig") &&
      files.smokeAdmin.includes("cleanupSmokeData") &&
      files.smokeAdmin.includes("/api/admin/products/${encodeURIComponent(productId)}") &&
      files.smokeAdmin.includes("Smoke product still active after cleanup") &&
      files.smokeAdmin.includes("/api/pay/unified") &&
      files.smokeAdmin.includes("quantity: 2") &&
      files.smokeAdmin.includes("Storefront stock should update to 1 after quantity=2 lock") &&
      files.smokeAdmin.includes("Storefront stock should return to 3 after cancel") &&
      files.smokeAdmin.includes("Quantity=2 issued order did not return two cards"),
    "admin smoke must cover product creation, card import, manual issue, system config update with failure-safe restore, generated fixture cleanup, unified quantity=2 locking, storefront stock recovery after cancel, and quantity=2 delivery lookup",
  ],
  [
    files.smokeWrite.includes("/api/pay/unified") &&
      files.smokeWrite.includes("/api/orders/lookup") &&
      !files.smokeWrite.includes('request("/api/orders"') &&
      files.smokeWrite.includes("finally") &&
      files.smokeWrite.includes("cleanupSmokeData") &&
      files.smokeWrite.includes("deliverySecret"),
    "write smoke must cover unified payment creation, lookup, delivery, idempotency, and failure-safe cleanup for created fixtures",
  ],
  [
    files.packageJson.includes('"smoke:legacy-guards"') &&
      files.launchVerify.includes("scripts/20-smoke-legacy-guards.mjs") &&
      files.smokeLegacyGuards.includes("LEGACY_ORDER_DISABLED") &&
      files.smokeLegacyGuards.includes("response.statusCode !== 410") &&
      files.smokeLegacyGuards.includes("/api/pay/unified") &&
      !files.payRoute.includes('post("/pay/offline"') &&
      !files.payRoute.includes("LEGACY_OFFLINE_DISABLED"),
    "launch verification must keep legacy /api/orders disabled and the removed /api/pay/offline creation route absent",
  ],
  [
    files.packageJson.includes('"smoke:inventory"') &&
      files.launchVerify.includes("scripts/21-smoke-inventory-closure.mjs") &&
      files.smokeInventory.includes("/api/products/${encodeURIComponent(productId)}") &&
      files.smokeInventory.includes("await expectUnifiedFailure(3, 409") &&
      files.smokeInventory.includes("await createOfflineOrder(2") &&
      files.smokeInventory.includes("/api/pay/offline/cancel") &&
      files.smokeInventory.includes("Number(canceled.releasedCards) !== 2") &&
      files.smokeInventory.includes("Number(adminCanceled.releasedCards) !== 2") &&
      files.smokeInventory.includes("await getStorefrontProduct(0)") &&
      files.smokeInventory.includes("await getStorefrontProduct(2)") &&
      files.smokeInventory.includes("assertVirtualProductNoInventoryPurchase") &&
      files.smokeInventory.includes("product.requiresInventory !== false") &&
      files.smokeInventory.includes("Number(canceled.releasedCards) !== 0") &&
      files.smokeInventory.includes("finally") &&
      files.smokeInventory.includes("cleanupInventorySmokeData"),
    "inventory smoke must cover storefront live stock, quantity shortage rejection, user/admin cancel release, non-card no-inventory purchase, re-order after cancellation, launch inclusion, and failure-safe cleanup",
  ],
  [
    files.smokeCatalogAdmin.includes("/api/admin/product-categories") &&
      files.smokeCatalogAdmin.includes("/api/products") &&
      files.smokeCatalogAdmin.includes("/api/admin/coupons") &&
      files.smokeCatalogAdmin.includes("finally") &&
      files.smokeCatalogAdmin.includes("cleanupSmokeData") &&
      files.smokeCatalogAdmin.includes("productId"),
    "catalog admin smoke must cover category config, storefront category contract, auto product id, auto coupon code, and failure-safe cleanup",
  ],
  [
    files.smokeOps.includes("/api/admin/cards/import-template") &&
      files.smokeOps.includes("/api/admin/cards/batch-disable") &&
      files.smokeOps.includes("finally") &&
      files.smokeOps.includes("cleanupOpsData") &&
      files.smokeOps.includes("/api/admin/orders/export") &&
      files.smokeOps.includes("/api/admin/finance/export") &&
      files.smokeOps.includes("/api/admin/pending-tasks"),
    "ops smoke must cover card operations, exports, pending task/log read paths, and failure-safe cleanup",
  ],
  [
    files.businessCleanupScript.includes("validate_table_name") &&
      files.businessCleanupScript.includes("idempotency_keys") &&
      files.businessCleanupScript.includes("rate_limit_windows") &&
      files.businessCleanupScript.includes("DATABASE_PROVIDER") &&
      files.businessCleanupScript.includes('case "$DB_PROVIDER" in') &&
      files.businessCleanupScript.includes("read -r confirm_input") &&
      files.businessCleanupScript.includes("数据库标识") &&
      files.businessCleanupScript.includes("trap 'rm -f") &&
      files.businessCleanupScript.includes("clear_business_data") &&
      files.businessCleanupScript.includes('table" == "admin_audit_logs"') &&
      files.businessCleanupScript.includes("node scripts/turso-exec.mjs scalar") &&
      files.tursoExecScript.includes("assertSafeTableName") &&
      files.tursoExecScript.includes("mode === 'scalar'") &&
      files.scriptsReadme.includes("22-cleanup-business-data.sh"),
    "business data cleanup tooling must validate table names, clear transient idempotency/rate-limit state, require exact database identifier confirmation, support Turso scalar reads, and be documented",
  ],
  [
    files.adminSystemConfigRoute.includes('post("/clear-business-data"') &&
      files.adminSystemConfigRoute.includes("clearBusinessDataPreservingConfig") &&
      files.adminSystemConfigRoute.includes("preserveConfigAndSystemParams") &&
      files.adminService.includes("clearBusinessDataPreservingConfig") &&
      files.adminService.includes("清除所有业务数据") &&
      files.adminService.includes("payment_provider:") &&
      files.adminService.includes("rate_limit_windows") &&
      files.adminService.includes("idempotency_keys") &&
      files.adminService.includes("旧 admin_audit_logs") &&
      files.adminService.includes("clear_business_data") &&
      files.adminServiceRealDbTest.includes("clears business and transient tables while preserving configuration tables") &&
      files.adminServiceRealDbTest.includes("payment_provider:easypay") &&
      files.adminServiceRealDbTest.includes("expect(result.tables.admin_audit_logs).toBe(1)") &&
      files.adminSystemConfigRouteTest.includes("clears business data only with matching profile confirmation"),
    "admin business-data clear must require explicit confirmation, preserve config/payment/category/API/migration tables, clear transient/old audit state, and keep real-db coverage",
  ],
  [
    files.launchVerify.includes("scripts/04-smoke-readonly.mjs") &&
      files.launchVerify.includes("scripts/26-smoke-frontend-assets.mjs") &&
      files.smokeFrontendAssets.includes("waitForCurrentEntry") &&
      files.smokeFrontendAssets.includes("collectFrontendAssetPaths") &&
      files.launchVerify.includes("scripts/05-smoke-admin.mjs") &&
      files.launchVerify.includes("scripts/06-smoke-write.mjs") &&
      files.launchVerify.includes("checkTurnstileStrictness") &&
      files.launchVerify.includes("checkPaymentReadiness") &&
      files.launchVerify.includes("checkEmailReadiness") &&
      files.launchVerify.includes("checkBackupReadiness") &&
      files.launchVerify.includes("checkStorefrontCleanliness") &&
      files.launchVerify.includes("activeSmokeProducts") &&
      files.launchVerify.includes("checkStorefrontCatalogReadiness") &&
      files.launchVerify.includes("salableProducts") &&
      files.launchVerify.includes("LAUNCH_ALLOW_EMPTY_CATALOG") &&
      files.launchVerify.includes("resolveRemoteAdminToken") &&
      files.launchVerify.includes("/api/admin/verify-jwt") &&
      files.launchVerify.includes("checkPaymentSecretReadiness") &&
      files.launchVerify.includes("/api/admin/payment/health") &&
      files.launchVerify.includes("attempts=${attempt}") &&
      files.launchVerify.includes("LAUNCH_MODE=trial") &&
      files.launchVerify.includes("shouldFailLaunchGate") &&
      files.launchGate.includes("PUBLIC") &&
      files.launchGate.includes("TRIAL") &&
      files.launchGateTest.includes("defaults to strict public launch mode") &&
      files.launchGateTest.includes("allows warnings only for explicit trial mode"),
    "launch verification must chain frontend-asset/business smoke plus Turnstile, payment, payment-secret, email, backup, storefront fixture-cleanliness, salable catalog, remote admin-token gates, and strict public vs explicit trial mode",
  ],
  [
    files.storefrontTemplateMigration.includes("template_key IN ('catalog', 'compact')") &&
      files.storefrontService.includes('STOREFRONT_TEMPLATE_KEYS = ["catalog", "compact"]') &&
      files.adminStorefrontRoute.includes("z.enum(STOREFRONT_TEMPLATE_KEYS)") &&
      files.adminStorefrontsView.includes('v-model="form.templateKey"') &&
      files.shopView.includes(':display-mode="storefrontTemplate"') &&
      files.productCard.includes("displayMode?: 'catalog' | 'compact'") &&
      !files.shopView.includes('<h1 class="section-title">{{ storefrontName }}</h1>'),
    "storefront templates must remain a database/API/admin/public two-template contract without duplicate brand headings",
  ],
];

const failed = checks.filter(([ok]) => !ok);
if (failed.length > 0) {
  for (const [, message] of failed) console.error(message);
  process.exit(1);
}

console.log("cf-shop core coverage checks passed.");
