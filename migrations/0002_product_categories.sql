-- ============================================================
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
