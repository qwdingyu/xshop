-- UP
-- 前台库存展示是商品级安全策略；默认保持精确展示，敏感商品可只暴露可售状态或完全隐藏库存提示。
ALTER TABLE products ADD COLUMN stock_display_mode TEXT NOT NULL DEFAULT 'exact'
  CHECK (stock_display_mode IN ('exact', 'availability_only', 'hidden'));

-- DOWN
ALTER TABLE products DROP COLUMN stock_display_mode;
