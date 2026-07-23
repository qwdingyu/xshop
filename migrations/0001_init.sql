-- ============================================================
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
