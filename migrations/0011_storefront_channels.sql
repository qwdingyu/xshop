-- UP
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
