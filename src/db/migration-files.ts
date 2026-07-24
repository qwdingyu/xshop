// 此文件由 scripts/generate-migration-files.mjs 自动生成，不要手动编辑
export const MIGRATION_FILES: Record<string, string> = {
  "0001": `-- ============================================================
-- 0001 初始化基线（未上线前 squash）
-- ============================================================
-- 说明：
-- - 本文件是当前业务最终 schema 的基线迁移。
-- - 项目尚未上线，无生产历史库兼容负担，因此将原 0001~0009 补丁链压缩为一个清晰基线。
-- - 上线后不要再改写已发布迁移；新增变更应从 0002 开始追加。

-- UP
CREATE TABLE IF NOT EXISTS system_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  ip_hash TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rate_limit_windows (
  action TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (action, ip_hash, window_start)
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_id TEXT NOT NULL DEFAULT '',
  response_json TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (key, action)
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL DEFAULT '',
  tier TEXT NOT NULL DEFAULT 'free',
  enabled INTEGER NOT NULL DEFAULT 1,
  monthly_quota INTEGER NOT NULL DEFAULT 0,
  monthly_usage INTEGER NOT NULL DEFAULT 0,
  monthly_reset_at TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  sales_copy TEXT NOT NULL DEFAULT '',
  cover_url TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  price_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'CNY',
  category TEXT NOT NULL DEFAULT 'card',
  fulfillment_mode TEXT NOT NULL DEFAULT 'card',
  issue_mode TEXT NOT NULL DEFAULT 'manual',
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  purchase_limit INTEGER,
  delivery_visibility TEXT NOT NULL DEFAULT 'web_and_email',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_products_active_sort ON products(active, sort_order);
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_slug_unique ON products(slug);

CREATE TABLE IF NOT EXISTS card_batches (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  total_count INTEGER NOT NULL DEFAULT 0,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  batch_id TEXT,
  account_label TEXT NOT NULL DEFAULT '',
  delivery_secret TEXT NOT NULL DEFAULT '',
  delivery_note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'available',
  locked_order_id TEXT,
  lock_expires_at TEXT,
  issued_order_id TEXT,
  issued_at TEXT,
  disabled_reason TEXT NOT NULL DEFAULT '',
  buyer_email TEXT NOT NULL DEFAULT '',
  buyer_contact TEXT NOT NULL DEFAULT '',
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cards_product_status_runtime ON cards(product_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_cards_locked_order ON cards(locked_order_id);
CREATE INDEX IF NOT EXISTS idx_cards_issued_order ON cards(issued_order_id);
CREATE INDEX IF NOT EXISTS idx_cards_product_secret ON cards(product_id, delivery_secret);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_product_delivery_secret_unique
  ON cards(product_id, delivery_secret)
  WHERE delivery_secret IS NOT NULL AND delivery_secret <> '';

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  order_no TEXT NOT NULL UNIQUE,
  product_id TEXT NOT NULL,
  buyer_contact TEXT NOT NULL DEFAULT '',
  buyer_email TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'CNY',
  status TEXT NOT NULL DEFAULT 'pending',
  fulfillment_mode TEXT NOT NULL DEFAULT 'card',
  issue_mode TEXT NOT NULL DEFAULT 'manual',
  payment_method TEXT NOT NULL DEFAULT '',
  payment_provider TEXT NOT NULL DEFAULT '',
  payment_ref TEXT NOT NULL DEFAULT '',
  order_token_hash TEXT,
  issued_card_id TEXT,
  campaign_code TEXT NOT NULL DEFAULT '',
  referral_code TEXT NOT NULL DEFAULT '',
  coupon_code TEXT NOT NULL DEFAULT '',
  ip_hash TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  paid_at TEXT,
  issued_at TEXT,
  expires_at TEXT,
  delivery_json TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_order_no_unique ON orders(order_no);
CREATE INDEX IF NOT EXISTS idx_orders_token_hash ON orders(order_token_hash);
CREATE INDEX IF NOT EXISTS idx_orders_buyer_email ON orders(buyer_email);
CREATE INDEX IF NOT EXISTS idx_orders_payment_provider ON orders(payment_provider);
CREATE INDEX IF NOT EXISTS idx_orders_status_created_at ON orders(status, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_product_status_created_at ON orders(product_id, status, created_at);

CREATE TABLE IF NOT EXISTS order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  product_title TEXT NOT NULL DEFAULT '',
  fulfillment_mode TEXT NOT NULL DEFAULT 'card',
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price_cents INTEGER NOT NULL DEFAULT 0,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  delivery_json TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items(product_id);

CREATE TABLE IF NOT EXISTS order_events (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events(order_id);

CREATE TABLE IF NOT EXISTS campaigns (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  starts_at TEXT,
  ends_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS referral_codes (
  code TEXT PRIMARY KEY,
  owner_contact TEXT NOT NULL,
  reward_type TEXT NOT NULL DEFAULT 'none',
  reward_value INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS referral_events (
  id TEXT PRIMARY KEY,
  referral_code TEXT NOT NULL,
  order_id TEXT NOT NULL,
  buyer_contact TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_referral_events_code ON referral_events(referral_code);
CREATE INDEX IF NOT EXISTS idx_referral_events_order ON referral_events(order_id);

CREATE TABLE IF NOT EXISTS coupons (
  code TEXT PRIMARY KEY,
  product_id TEXT NOT NULL DEFAULT '',
  discount_type TEXT NOT NULL DEFAULT 'percent',
  discount_value INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER NOT NULL DEFAULT 0,
  used_count INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_coupons_product ON coupons(product_id);
CREATE INDEX IF NOT EXISTS idx_coupons_active ON coupons(active);

CREATE TABLE IF NOT EXISTS request_logs (
  id TEXT PRIMARY KEY,
  ip_hash TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  action TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_request_logs_action_time ON request_logs(action, created_at);

CREATE TABLE IF NOT EXISTS email_logs (
  id TEXT PRIMARY KEY,
  order_id TEXT,
  to_email TEXT NOT NULL,
  template TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS card_logs (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL,
  order_id TEXT,
  action TEXT NOT NULL,
  operator TEXT NOT NULL DEFAULT 'system',
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_card_logs_card ON card_logs(card_id);

CREATE TABLE IF NOT EXISTS voucher_codes (
  code TEXT PRIMARY KEY,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  used_by_email TEXT NOT NULL DEFAULT '',
  used_at TEXT,
  expires_at TEXT,
  batch_id TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_voucher_codes_status ON voucher_codes(status);
CREATE INDEX IF NOT EXISTS idx_voucher_codes_batch ON voucher_codes(batch_id);

CREATE TABLE IF NOT EXISTS user_balances (
  email TEXT PRIMARY KEY,
  balance_cents INTEGER NOT NULL DEFAULT 0,
  total_deposited_cents INTEGER NOT NULL DEFAULT 0,
  total_spent_cents INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_user_balances_updated ON user_balances(updated_at);

CREATE TABLE IF NOT EXISTS balance_transactions (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  type TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  balance_after_cents INTEGER NOT NULL,
  reference_type TEXT NOT NULL DEFAULT '',
  reference_id TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_balance_transactions_email_time ON balance_transactions(email, created_at);
CREATE INDEX IF NOT EXISTS idx_balance_transactions_reference ON balance_transactions(reference_type, reference_id);

INSERT OR IGNORE INTO system_config (key, value, updated_at) VALUES
  ('shop_name', '我的发卡商城', datetime('now')),
  ('order_expire_minutes', '30', datetime('now')),
  ('require_email', 'true', datetime('now'));

-- DOWN
DROP INDEX IF EXISTS idx_balance_transactions_reference;
DROP INDEX IF EXISTS idx_balance_transactions_email_time;
DROP INDEX IF EXISTS idx_user_balances_updated;
DROP INDEX IF EXISTS idx_voucher_codes_batch;
DROP INDEX IF EXISTS idx_voucher_codes_status;
DROP INDEX IF EXISTS idx_card_logs_card;
DROP INDEX IF EXISTS idx_request_logs_action_time;
DROP INDEX IF EXISTS idx_coupons_active;
DROP INDEX IF EXISTS idx_coupons_product;
DROP INDEX IF EXISTS idx_referral_events_order;
DROP INDEX IF EXISTS idx_referral_events_code;
DROP INDEX IF EXISTS idx_order_events_order;
DROP INDEX IF EXISTS idx_orders_product_status_created_at;
DROP INDEX IF EXISTS idx_orders_status_created_at;
DROP INDEX IF EXISTS idx_orders_payment_provider;
DROP INDEX IF EXISTS idx_orders_buyer_email;
DROP INDEX IF EXISTS idx_orders_token_hash;
DROP INDEX IF EXISTS idx_orders_order_no_unique;
DROP INDEX IF EXISTS idx_order_items_product;
DROP INDEX IF EXISTS idx_order_items_order;
DROP INDEX IF EXISTS idx_cards_product_delivery_secret_unique;
DROP INDEX IF EXISTS idx_cards_product_secret;
DROP INDEX IF EXISTS idx_cards_issued_order;
DROP INDEX IF EXISTS idx_cards_locked_order;
DROP INDEX IF EXISTS idx_cards_product_status_runtime;
DROP INDEX IF EXISTS idx_products_slug_unique;
DROP INDEX IF EXISTS idx_products_active_sort;
DROP TABLE IF EXISTS balance_transactions;
DROP TABLE IF EXISTS user_balances;
DROP TABLE IF EXISTS voucher_codes;
DROP TABLE IF EXISTS card_logs;
DROP TABLE IF EXISTS email_logs;
DROP TABLE IF EXISTS request_logs;
DROP TABLE IF EXISTS coupons;
DROP TABLE IF EXISTS referral_events;
DROP TABLE IF EXISTS referral_codes;
DROP TABLE IF EXISTS campaigns;
DROP TABLE IF EXISTS order_events;
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS cards;
DROP TABLE IF EXISTS card_batches;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS api_keys;
DROP TABLE IF EXISTS idempotency_keys;
DROP TABLE IF EXISTS rate_limit_windows;
DROP TABLE IF EXISTS admin_audit_logs;
DROP TABLE IF EXISTS system_config;
`,
  "0002": `-- ============================================================
-- 0002 商品分类配置
-- ============================================================
-- 说明：
-- - 将前台分类从“商品字段偶然聚合”提升为一等配置表。
-- - 保留 products.category 作为商品归属字段，兼容历史数据和后台表单。
-- - 首次迁移时从已有商品 category 自动回填启用分类。

-- UP
CREATE TABLE IF NOT EXISTS product_categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 100,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_categories_name_unique ON product_categories(name);
CREATE INDEX IF NOT EXISTS idx_product_categories_active_sort ON product_categories(active, sort_order, name);

INSERT OR IGNORE INTO product_categories (id, name, sort_order, active, created_at, updated_at)
SELECT
  lower(replace(replace(trim(category), ' ', '-'), '/', '-')) AS id,
  trim(category) AS name,
  100 AS sort_order,
  1 AS active,
  datetime('now') AS created_at,
  datetime('now') AS updated_at
FROM products
WHERE trim(category) <> '';

-- DOWN
DROP INDEX IF EXISTS idx_product_categories_active_sort;
DROP INDEX IF EXISTS idx_product_categories_name_unique;
DROP TABLE IF EXISTS product_categories;
`,
  "0003": `-- 商品级交付展示策略：轻量支持“仅邮件交付卡密”，不引入活动系统。
ALTER TABLE products ADD COLUMN delivery_visibility TEXT NOT NULL DEFAULT 'web_and_email';
`,
  "0004": `-- UP
-- 将交付可见性固化到订单，避免商品策略后续变更重新暴露历史卡密。
ALTER TABLE orders ADD COLUMN delivery_visibility TEXT NOT NULL DEFAULT 'web_and_email';

UPDATE orders
SET delivery_visibility = COALESCE(
  (
    SELECT CASE
      WHEN products.delivery_visibility = 'email_only' THEN 'email_only'
      ELSE 'web_and_email'
    END
    FROM products
    WHERE products.id = orders.product_id
  ),
  'web_and_email'
);

-- DOWN
ALTER TABLE orders DROP COLUMN delivery_visibility;
`,
  "0005": `-- UP
-- 定时清理按 created_at 删除历史运行数据，避免每两小时全表扫描。
CREATE INDEX IF NOT EXISTS idx_rate_limit_windows_window_start ON rate_limit_windows(window_start);
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created_at ON idempotency_keys(created_at);
CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_email_logs_created_at ON email_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_card_logs_created_at ON card_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_order_events_created_at ON order_events(created_at);
CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_created_at ON admin_audit_logs(created_at);

-- DOWN
DROP INDEX IF EXISTS idx_admin_audit_logs_created_at;
DROP INDEX IF EXISTS idx_order_events_created_at;
DROP INDEX IF EXISTS idx_card_logs_created_at;
DROP INDEX IF EXISTS idx_email_logs_created_at;
DROP INDEX IF EXISTS idx_request_logs_created_at;
DROP INDEX IF EXISTS idx_idempotency_keys_created_at;
DROP INDEX IF EXISTS idx_rate_limit_windows_window_start;
`,
  "0006": `-- UP
-- 旧缓存无法可靠还原原始请求，保留空摘要并在运行时 fail closed。
ALTER TABLE idempotency_keys ADD COLUMN request_hash TEXT NOT NULL DEFAULT '';

-- DOWN
ALTER TABLE idempotency_keys DROP COLUMN request_hash;
`,
  "0007": `-- UP
-- 日志游标按 created_at + id 稳定 seek，避免 offset 在清理期间跳过数据。
DROP INDEX IF EXISTS idx_request_logs_created_at;
DROP INDEX IF EXISTS idx_admin_audit_logs_created_at;
DROP INDEX IF EXISTS idx_email_logs_created_at;
CREATE INDEX IF NOT EXISTS idx_request_logs_cursor ON request_logs(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_cursor ON admin_audit_logs(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_email_logs_cursor ON email_logs(created_at DESC, id DESC);

-- DOWN
DROP INDEX IF EXISTS idx_email_logs_cursor;
DROP INDEX IF EXISTS idx_admin_audit_logs_cursor;
DROP INDEX IF EXISTS idx_request_logs_cursor;
CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_created_at ON admin_audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_email_logs_created_at ON email_logs(created_at);
`,
  "0008": `-- UP
-- 前台库存展示是商品级安全策略；默认保持精确展示，敏感商品可只暴露可售状态或完全隐藏库存提示。
ALTER TABLE products ADD COLUMN stock_display_mode TEXT NOT NULL DEFAULT 'exact'
  CHECK (stock_display_mode IN ('exact', 'availability_only', 'hidden'));

-- DOWN
ALTER TABLE products DROP COLUMN stock_display_mode;
`,
  "0009": `-- UP
CREATE TABLE IF NOT EXISTS balance_recharge_orders (
  id TEXT PRIMARY KEY,
  order_no TEXT NOT NULL UNIQUE,
  buyer_email TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'CNY',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'expired', 'failed')),
  payment_provider TEXT NOT NULL,
  payment_ref TEXT NOT NULL DEFAULT '',
  order_token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  paid_at TEXT,
  expires_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_balance_recharge_order_no
  ON balance_recharge_orders(order_no);
CREATE INDEX IF NOT EXISTS idx_balance_recharge_email_created
  ON balance_recharge_orders(buyer_email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_balance_recharge_status_expires
  ON balance_recharge_orders(status, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_balance_recharge_payment_ref_unique
  ON balance_recharge_orders(payment_provider, payment_ref)
  WHERE payment_ref <> '';

-- DOWN
DROP INDEX IF EXISTS idx_balance_recharge_payment_ref_unique;
DROP INDEX IF EXISTS idx_balance_recharge_status_expires;
DROP INDEX IF EXISTS idx_balance_recharge_email_created;
DROP INDEX IF EXISTS idx_balance_recharge_order_no;
DROP TABLE IF EXISTS balance_recharge_orders;
`,
  "0010": `-- UP
-- 应用层会用状态 CAS 处理并发回调；该唯一索引提供最后一道数据库约束：
-- 同一支付平台流水只能归属一笔商品订单，避免跨订单重复入账或重复履约。
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_external_payment_ref_unique
  ON orders(payment_provider, payment_ref)
  WHERE payment_ref <> ''
    AND payment_provider <> ''
    AND payment_provider NOT IN ('balance', 'free')
    AND payment_ref NOT LIKE 'last4:%';

-- DOWN
DROP INDEX IF EXISTS idx_orders_external_payment_ref_unique;
`,
  "0011": `-- UP
-- 多主页只表示同一运营主体下的展示渠道；商品、库存、支付、余额和管理员继续共享。
CREATE TABLE IF NOT EXISTS storefronts (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL,
  logo_url TEXT NOT NULL DEFAULT '',
  support_email TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 100,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (is_default = 0 OR active = 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_storefronts_single_default
  ON storefronts(is_default)
  WHERE is_default = 1;
CREATE INDEX IF NOT EXISTS idx_storefronts_active_sort
  ON storefronts(active, sort_order, name);

INSERT OR IGNORE INTO storefronts (
  id, slug, name, logo_url, support_email, active, is_default, sort_order, created_at, updated_at
)
VALUES (
  'sf_default',
  'shop',
  COALESCE(NULLIF((SELECT trim(value) FROM system_config WHERE key = 'shop_name'), ''), 'Shop'),
  '',
  COALESCE((SELECT trim(value) FROM system_config WHERE key = 'support_email'), ''),
  1,
  1,
  0,
  datetime('now'),
  datetime('now')
);

CREATE TABLE IF NOT EXISTS storefront_products (
  storefront_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  visible INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 100,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (storefront_id, product_id),
  FOREIGN KEY (storefront_id) REFERENCES storefronts(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_storefront_products_catalog
  ON storefront_products(storefront_id, visible, sort_order, product_id);
CREATE INDEX IF NOT EXISTS idx_storefront_products_product
  ON storefront_products(product_id, storefront_id);

INSERT OR IGNORE INTO storefront_products (
  storefront_id, product_id, visible, sort_order, created_at, updated_at
)
SELECT
  'sf_default', id, 1, sort_order, datetime('now'), datetime('now')
FROM products;

-- order_source 明确区分主页成交、全额优惠码兑换和 Telegram 自定义收款。
ALTER TABLE orders ADD COLUMN order_source TEXT NOT NULL DEFAULT 'storefront'
  CHECK (order_source IN ('storefront', 'coupon_redeem', 'telegram'));
ALTER TABLE orders ADD COLUMN storefront_id TEXT REFERENCES storefronts(id) ON DELETE RESTRICT;
ALTER TABLE orders ADD COLUMN storefront_slug_snapshot TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN storefront_name_snapshot TEXT NOT NULL DEFAULT '';

UPDATE orders
SET
  order_source = CASE
    WHEN product_id = 'tg_custom' THEN 'telegram'
    WHEN buyer_contact LIKE 'redeem:%' THEN 'coupon_redeem'
    ELSE 'storefront'
  END,
  storefront_id = CASE
    WHEN product_id = 'tg_custom' OR buyer_contact LIKE 'redeem:%' THEN NULL
    ELSE 'sf_default'
  END,
  storefront_slug_snapshot = CASE
    WHEN product_id = 'tg_custom' OR buyer_contact LIKE 'redeem:%' THEN ''
    ELSE 'shop'
  END,
  storefront_name_snapshot = CASE
    WHEN product_id = 'tg_custom' OR buyer_contact LIKE 'redeem:%' THEN ''
    ELSE COALESCE((SELECT name FROM storefronts WHERE id = 'sf_default'), 'Shop')
  END;

CREATE INDEX IF NOT EXISTS idx_orders_source_storefront_created
  ON orders(order_source, storefront_id, created_at DESC, id DESC);

-- DOWN
DROP INDEX IF EXISTS idx_orders_source_storefront_created;
ALTER TABLE orders DROP COLUMN storefront_name_snapshot;
ALTER TABLE orders DROP COLUMN storefront_slug_snapshot;
ALTER TABLE orders DROP COLUMN storefront_id;
ALTER TABLE orders DROP COLUMN order_source;
DROP INDEX IF EXISTS idx_storefront_products_product;
DROP INDEX IF EXISTS idx_storefront_products_catalog;
DROP TABLE IF EXISTS storefront_products;
DROP INDEX IF EXISTS idx_storefronts_active_sort;
DROP INDEX IF EXISTS idx_storefronts_single_default;
DROP TABLE IF EXISTS storefronts;
`,
  "0012": `-- UP
-- 模板只控制同一渠道商品目录的呈现密度，不允许存储组件名、CSS 或任意 HTML。
ALTER TABLE storefronts ADD COLUMN template_key TEXT NOT NULL DEFAULT 'catalog'
  CHECK (template_key IN ('catalog', 'compact'));

-- 保持 /shop 的现有图片卡片布局；已有非默认渠道采用更适合卡密/兑换码的紧凑列表。
UPDATE storefronts
SET template_key = CASE
  WHEN is_default = 1 THEN 'catalog'
  ELSE 'compact'
END;

-- DOWN
ALTER TABLE storefronts DROP COLUMN template_key;
`,
  "0013": `-- UP
-- 商品只声明一个通用履约输入，不绑定具体供应商或商品行业。
ALTER TABLE products ADD COLUMN fulfillment_input_type TEXT NOT NULL DEFAULT 'none'
  CHECK (fulfillment_input_type IN ('none', 'phone', 'qq', 'uid', 'account', 'text'));
ALTER TABLE products ADD COLUMN fulfillment_input_label TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN fulfillment_input_hint TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN fulfillment_input_required INTEGER NOT NULL DEFAULT 0
  CHECK (fulfillment_input_required IN (0, 1));

-- 订单保存下单时的独立快照，商品配置变化不会重解释历史订单。
-- 该字段包含买家提供的履约信息，只允许管理端详情读取，公共查单不得返回。
ALTER TABLE orders ADD COLUMN fulfillment_input_json TEXT NOT NULL DEFAULT '';

-- DOWN
ALTER TABLE orders DROP COLUMN fulfillment_input_json;
ALTER TABLE products DROP COLUMN fulfillment_input_required;
ALTER TABLE products DROP COLUMN fulfillment_input_hint;
ALTER TABLE products DROP COLUMN fulfillment_input_label;
ALTER TABLE products DROP COLUMN fulfillment_input_type;
`,
  "0014": `-- UP
-- 限购数量是真实下单约束；该字段只控制前台是否展示限购文案。
ALTER TABLE products ADD COLUMN purchase_limit_display INTEGER NOT NULL DEFAULT 0
  CHECK (purchase_limit_display IN (0, 1));

-- DOWN
ALTER TABLE products DROP COLUMN purchase_limit_display;
`,
  "0015": `-- UP
-- 货架对比价（划线原价）：仅用于店面促销展示，不参与下单计费。
-- NULL/0 = 未设置；有效时必须大于 price_cents（由服务层校验）。
ALTER TABLE products ADD COLUMN original_price_cents INTEGER;

-- DOWN
ALTER TABLE products DROP COLUMN original_price_cents;
`
};
