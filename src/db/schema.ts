import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import * as z from "zod";

// ── 从 cf-core 导入公共基础设施表 ──
// import + export 确保本地可用（createInsertSchema 需要）且对外导出
import {
  systemConfig,
  adminAuditLogs,
  rateLimitWindows,
  apiKeys,
} from "@usethink/cf-core/db/schema";
export {
  systemConfig,
  adminAuditLogs,
  rateLimitWindows,
  apiKeys,
};

// cf-core 的基础表没有请求摘要；支付幂等需要把键绑定到原始业务请求，
// 因此在应用侧维护同名扩展 schema。
export const idempotencyKeys = sqliteTable("idempotency_keys", {
  key: text("key").notNull(),
  action: text("action").notNull(),
  resourceId: text("resource_id").default("").notNull(),
  requestHash: text("request_hash").default("").notNull(),
  responseJson: text("response_json").default("").notNull(),
  createdAt: text("created_at").default("").notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.key, table.action] }),
}));

// ── 商品表 ──
export const products = sqliteTable("products", {
  id: text("id").primaryKey(),
  slug: text("slug"),
  title: text("title").notNull(),
  description: text("description").default("").notNull(),
  salesCopy: text("sales_copy").default("").notNull(),
  coverUrl: text("cover_url").default("").notNull(),
  tagsJson: text("tags_json").default("[]").notNull(),
  priceCents: integer("price_cents").default(0).notNull(),
  currency: text("currency").default("CNY").notNull(),
  fulfillmentMode: text("fulfillment_mode").default("card").notNull(),
  issueMode: text("issue_mode").default("direct").notNull(),
  active: integer("active").default(1).notNull(),
  sortOrder: integer("sort_order").default(100).notNull(),
  category: text("category").default("").notNull(),
  purchaseLimit: integer("purchase_limit"),
  purchaseLimitDisplay: integer("purchase_limit_display").default(0).notNull(),
  deliveryVisibility: text("delivery_visibility").default("web_and_email").notNull(),
  stockDisplayMode: text("stock_display_mode").default("exact").notNull(),
  fulfillmentInputType: text("fulfillment_input_type").default("none").notNull(),
  fulfillmentInputLabel: text("fulfillment_input_label").default("").notNull(),
  fulfillmentInputHint: text("fulfillment_input_hint").default("").notNull(),
  fulfillmentInputRequired: integer("fulfillment_input_required").default(0).notNull(),
  createdAt: text("created_at").default("").notNull(),
  updatedAt: text("updated_at")
});

// ── 商品分类表 ──
export const productCategories = sqliteTable("product_categories", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  sortOrder: integer("sort_order").default(100).notNull(),
  active: integer("active").default(1).notNull(),
  createdAt: text("created_at").default("").notNull(),
  updatedAt: text("updated_at")
});

// 展示渠道只负责同一运营主体下的 URL、品牌和商品集合，不承担租户或权限隔离。
export const storefronts = sqliteTable("storefronts", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  logoUrl: text("logo_url").default("").notNull(),
  supportEmail: text("support_email").default("").notNull(),
  templateKey: text("template_key").default("catalog").notNull(),
  active: integer("active").default(1).notNull(),
  isDefault: integer("is_default").default(0).notNull(),
  sortOrder: integer("sort_order").default(100).notNull(),
  createdAt: text("created_at").default("").notNull(),
  updatedAt: text("updated_at").default("").notNull(),
});

// 商品事实和库存保持全局唯一；映射只保存渠道可见性与渠道内排序。
export const storefrontProducts = sqliteTable("storefront_products", {
  storefrontId: text("storefront_id").notNull().references(() => storefronts.id, { onDelete: "cascade" }),
  productId: text("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  visible: integer("visible").default(1).notNull(),
  sortOrder: integer("sort_order").default(100).notNull(),
  createdAt: text("created_at").default("").notNull(),
  updatedAt: text("updated_at").default("").notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.storefrontId, table.productId] }),
}));

// ── 卡密表 ──
// 业务硬约束：同一商品下 delivery_secret 必须唯一。
// 约束由 migrations/0001_init.sql 基线迁移创建部分唯一索引兜底，
// 防止服务层漏检或并发导入导致多个买家拿到同一份虚拟资料。
export const cards = sqliteTable("cards", {
  id: text("id").primaryKey(),
  productId: text("product_id").notNull(),
  batchId: text("batch_id"),
  accountLabel: text("account_label").notNull(),
  deliverySecret: text("delivery_secret").notNull(),
  deliveryNote: text("delivery_note").default("").notNull(),
  status: text("status").default("available").notNull(),
  lockedOrderId: text("locked_order_id"),
  lockExpiresAt: text("lock_expires_at"),
  issuedOrderId: text("issued_order_id"),
  issuedAt: text("issued_at"),
  disabledReason: text("disabled_reason").default("").notNull(),
  buyerEmail: text("buyer_email").default("").notNull(),
  buyerContact: text("buyer_contact").default("").notNull(),
  expiresAt: text("expires_at"),
  createdAt: text("created_at").default("").notNull()
});

// ── 卡密批次表 ──
export const cardBatches = sqliteTable("card_batches", {
  id: text("id").primaryKey(),
  productId: text("product_id").notNull(),
  name: text("name").notNull(),
  source: text("source").default("").notNull(),
  totalCount: integer("total_count").default(0).notNull(),
  createdAt: text("created_at").default("").notNull()
});

// ── 订单表 ──
export const orders = sqliteTable("orders", {
  id: text("id").primaryKey(),
  orderNo: text("order_no"),
  productId: text("product_id").notNull(),
  // 订单来源由后端写入：主页成交绑定 storefront，兑换和 Telegram 不伪造店铺归属。
  orderSource: text("order_source").default("storefront").notNull(),
  storefrontId: text("storefront_id").references(() => storefronts.id, { onDelete: "restrict" }),
  storefrontSlugSnapshot: text("storefront_slug_snapshot").default("").notNull(),
  storefrontNameSnapshot: text("storefront_name_snapshot").default("").notNull(),
  buyerContact: text("buyer_contact").notNull(),
  buyerEmail: text("buyer_email").default("").notNull(),
  quantity: integer("quantity").default(1).notNull(),
  amountCents: integer("amount_cents").default(0).notNull(),
  discountCents: integer("discount_cents").default(0).notNull(),
  currency: text("currency").default("CNY").notNull(),
  status: text("status").notNull(),
  fulfillmentMode: text("fulfillment_mode").default("card").notNull(),
  issueMode: text("issue_mode").default("direct").notNull(),
  paymentMethod: text("payment_method").default("").notNull(),
  paymentProvider: text("payment_provider").default("").notNull(),
  paymentRef: text("payment_ref").default("").notNull(),
  orderTokenHash: text("order_token_hash"),
  issuedCardId: text("issued_card_id"),
  campaignCode: text("campaign_code").default("").notNull(),
  referralCode: text("referral_code").default("").notNull(),
  couponCode: text("coupon_code").default("").notNull(),
  ipHash: text("ip_hash").default("").notNull(),
  userAgent: text("user_agent").default("").notNull(),
  createdAt: text("created_at").default("").notNull(),
  paidAt: text("paid_at"),
  issuedAt: text("issued_at"),
  expiresAt: text("expires_at"),
  deliveryJson: text("delivery_json").default("").notNull(),
  fulfillmentInputJson: text("fulfillment_input_json").default("").notNull(),
  deliveryVisibility: text("delivery_visibility").default("web_and_email").notNull()
});

// ── 订单明细表 ──
// 当前前台仍是一单一商品，但明细表承载数量、单价、折扣分摊和商品快照，
// 避免把“购买数量”硬塞进订单头，后续扩展组合商品/礼包时不用重写交易模型。
export const orderItems = sqliteTable("order_items", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull(),
  productId: text("product_id").notNull(),
  productTitle: text("product_title").default("").notNull(),
  fulfillmentMode: text("fulfillment_mode").default("card").notNull(),
  quantity: integer("quantity").default(1).notNull(),
  unitPriceCents: integer("unit_price_cents").default(0).notNull(),
  discountCents: integer("discount_cents").default(0).notNull(),
  amountCents: integer("amount_cents").default(0).notNull(),
  deliveryJson: text("delivery_json").default("").notNull(),
  createdAt: text("created_at").default("").notNull()
});

// ── 订单事件表 ──
export const orderEvents = sqliteTable("order_events", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull(),
  type: text("type").notNull(),
  message: text("message").default("").notNull(),
  metadataJson: text("metadata_json").default("{}").notNull(),
  createdAt: text("created_at").default("").notNull()
});

// ── 营销活动表 ──
export const campaigns = sqliteTable("campaigns", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  active: integer("active").default(1).notNull(),
  startsAt: text("starts_at"),
  endsAt: text("ends_at"),
  metadataJson: text("metadata_json").default("{}").notNull(),
  createdAt: text("created_at").default("").notNull()
});

// ── 推荐码表 ──
export const referralCodes = sqliteTable("referral_codes", {
  code: text("code").primaryKey(),
  ownerContact: text("owner_contact").notNull(),
  rewardType: text("reward_type").default("none").notNull(),
  rewardValue: integer("reward_value").default(0).notNull(),
  active: integer("active").default(1).notNull(),
  createdAt: text("created_at").default("").notNull()
});

// ── 推荐事件表 ──
export const referralEvents = sqliteTable("referral_events", {
  id: text("id").primaryKey(),
  referralCode: text("referral_code").notNull(),
  orderId: text("order_id").notNull(),
  buyerContact: text("buyer_contact").notNull(),
  status: text("status").default("created").notNull(),
  createdAt: text("created_at").default("").notNull()
});

// ── 优惠码表 ──
export const coupons = sqliteTable("coupons", {
  code: text("code").primaryKey(),
  productId: text("product_id").default("").notNull(),
  discountType: text("discount_type").notNull(),
  discountValue: integer("discount_value").notNull(),
  maxUses: integer("max_uses").default(0).notNull(),
  usedCount: integer("used_count").default(0).notNull(),
  active: integer("active").default(1).notNull(),
  expiresAt: text("expires_at"),
  createdAt: text("created_at").default("").notNull()
});

// ── 卡密审计日志表 ──
export const cardLogs = sqliteTable("card_logs", {
  id: text("id").primaryKey(),
  cardId: text("card_id").notNull(),
  action: text("action").notNull(),
  orderId: text("order_id"),
  operator: text("operator").default("").notNull(),
  detail: text("detail").default("").notNull(),
  createdAt: text("created_at").default("").notNull()
});

// ── 请求日志表（限流统计） ──
export const requestLogs = sqliteTable("request_logs", {
  id: text("id").primaryKey(),
  ipHash: text("ip_hash").notNull(),
  method: text("method").notNull(),
  path: text("path").notNull(),
  action: text("action").notNull(),
  statusCode: integer("status_code").notNull(),
  createdAt: text("created_at").default("").notNull()
});

// ── 幂等键表、管理员审计日志表 ──
// 已从 @usethink/cf-core/db/schema 导入，不再本地定义

// ── 邮件发送日志表 ──
export const emailLogs = sqliteTable("email_logs", {
  id: text("id").primaryKey(),
  orderId: text("order_id"),
  toEmail: text("to_email").notNull(),
  template: text("template").notNull(),
  status: text("status").default("pending").notNull(),
  provider: text("provider").default("").notNull(),
  errorMessage: text("error_message").default("").notNull(),
  createdAt: text("created_at").default("").notNull(),
  sentAt: text("sent_at")
});

// ── 系统配置表 ──
// 已从 @usethink/cf-core/db/schema 导入，不再本地定义

// ── 充值码表（预付费凭证：在站外收款后生成，用户兑换为余额） ──
// 充值码 vs 优惠码（coupons）的区别：
// - 充值码：用户先付款买码，兑换后存入 user_balances 余额，在购买时使用余额支付
// - 优惠码：商品折扣凭证，下单时直接减免金额
// 充值码是"预充值"模式，优惠码是"折扣"模式，两者互补。
export const voucherCodes = sqliteTable("voucher_codes", {
  code: text("code").primaryKey(),
  amountCents: integer("amount_cents").default(0).notNull(),
  status: text("status").default("active").notNull(), // active | used | expired | revoked
  usedByEmail: text("used_by_email").default("").notNull(),
  usedAt: text("used_at"),
  expiresAt: text("expires_at"),
  batchId: text("batch_id").default("").notNull(),
  notes: text("notes").default("").notNull(),
  createdAt: text("created_at").default("").notNull(),
});

// ── 用户余额表（充值码兑换后的余额，按邮箱聚合） ──
// 充值码兑换后余额存入此表，下单时可选余额支付。
// balance_cents 为当前可用余额，total_deposited 为累计充值总额。
export const userBalances = sqliteTable("user_balances", {
  email: text("email").primaryKey(),
  balanceCents: integer("balance_cents").default(0).notNull(),
  totalDepositedCents: integer("total_deposited_cents").default(0).notNull(),
  totalSpentCents: integer("total_spent_cents").default(0).notNull(),
  updatedAt: text("updated_at").default("").notNull(),
});

// ── 用户余额流水表 ──
// 每一次充值、消费、退款、人工调整都必须记录流水，方便个人站长排查客诉和对账。
export const balanceTransactions = sqliteTable("balance_transactions", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  type: text("type").notNull(), // voucher_redeem | recharge | order_spend | refund | adjustment
  amountCents: integer("amount_cents").notNull(),
  balanceAfterCents: integer("balance_after_cents").notNull(),
  referenceType: text("reference_type").default("").notNull(),
  referenceId: text("reference_id").default("").notNull(),
  note: text("note").default("").notNull(),
  createdAt: text("created_at").default("").notNull(),
});

// ── 在线余额充值订单 ──
// 与商品订单分表，避免充值误入库存、优惠券、限购和履约状态机。
export const balanceRechargeOrders = sqliteTable("balance_recharge_orders", {
  id: text("id").primaryKey(),
  orderNo: text("order_no").notNull().unique(),
  buyerEmail: text("buyer_email").notNull(),
  amountCents: integer("amount_cents").notNull(),
  currency: text("currency").default("CNY").notNull(),
  status: text("status").default("pending").notNull(),
  paymentProvider: text("payment_provider").notNull(),
  paymentRef: text("payment_ref").default("").notNull(),
  orderTokenHash: text("order_token_hash").notNull(),
  createdAt: text("created_at").notNull(),
  paidAt: text("paid_at"),
  expiresAt: text("expires_at").notNull(),
});

// ── 速率限制窗口表 ──
// 已从 @usethink/cf-core/db/schema 导入，不再本地定义

// ═══════════════════════════════════════════════════════════════════════════════
// drizzle-zod 自动生成的 Insert Schema
// 基于 DB 表结构自动生成，schema 与 DB 永远同步，无需手动维护两套。
// 路由层在此基础上 extend() 添加业务校验（正则、枚举、长度限制等）。
// ═══════════════════════════════════════════════════════════════════════════════

export const insertProductSchema = createInsertSchema(products);
export type InsertProduct = z.infer<typeof insertProductSchema>;

export const insertProductCategorySchema = createInsertSchema(productCategories);
export type InsertProductCategory = z.infer<typeof insertProductCategorySchema>;

export const insertCardSchema = createInsertSchema(cards);
export type InsertCard = z.infer<typeof insertCardSchema>;

export const insertCardBatchSchema = createInsertSchema(cardBatches);
export type InsertCardBatch = z.infer<typeof insertCardBatchSchema>;

export const insertOrderSchema = createInsertSchema(orders);
export type InsertOrder = z.infer<typeof insertOrderSchema>;

export const insertOrderItemSchema = createInsertSchema(orderItems);
export type InsertOrderItem = z.infer<typeof insertOrderItemSchema>;

export const insertOrderEventSchema = createInsertSchema(orderEvents);
export type InsertOrderEvent = z.infer<typeof insertOrderEventSchema>;

export const insertCampaignSchema = createInsertSchema(campaigns);
export type InsertCampaign = z.infer<typeof insertCampaignSchema>;

export const insertReferralCodeSchema = createInsertSchema(referralCodes);
export type InsertReferralCode = z.infer<typeof insertReferralCodeSchema>;

export const insertReferralEventSchema = createInsertSchema(referralEvents);
export type InsertReferralEvent = z.infer<typeof insertReferralEventSchema>;

export const insertCouponSchema = createInsertSchema(coupons);
export type InsertCoupon = z.infer<typeof insertCouponSchema>;

export const insertCardLogSchema = createInsertSchema(cardLogs);
export type InsertCardLog = z.infer<typeof insertCardLogSchema>;

export const insertRequestLogSchema = createInsertSchema(requestLogs);
export type InsertRequestLog = z.infer<typeof insertRequestLogSchema>;

export const insertIdempotencyKeySchema = createInsertSchema(idempotencyKeys);
export type InsertIdempotencyKey = z.infer<typeof insertIdempotencyKeySchema>;

export const insertAdminAuditLogSchema = createInsertSchema(adminAuditLogs);
export type InsertAdminAuditLog = z.infer<typeof insertAdminAuditLogSchema>;

export const insertEmailLogSchema = createInsertSchema(emailLogs);
export type InsertEmailLog = z.infer<typeof insertEmailLogSchema>;

export const insertSystemConfigSchema = createInsertSchema(systemConfig);
export type InsertSystemConfig = z.infer<typeof insertSystemConfigSchema>;

// ═══════════════════════════════════════════════════════════════════════════════
// 充值码 & 用户余额 ORM Insert Schema
// ═══════════════════════════════════════════════════════════════════════════════

export const insertVoucherCodeSchema = createInsertSchema(voucherCodes);
export type InsertVoucherCode = z.infer<typeof insertVoucherCodeSchema>;

export const insertUserBalanceSchema = createInsertSchema(userBalances);
export type InsertUserBalance = z.infer<typeof insertUserBalanceSchema>;

export const insertBalanceTransactionSchema = createInsertSchema(balanceTransactions);
export type InsertBalanceTransaction = z.infer<typeof insertBalanceTransactionSchema>;
