-- UP
-- 限购数量是真实下单约束；该字段只控制前台是否展示限购文案。
ALTER TABLE products ADD COLUMN purchase_limit_display INTEGER NOT NULL DEFAULT 0
  CHECK (purchase_limit_display IN (0, 1));

-- DOWN
ALTER TABLE products DROP COLUMN purchase_limit_display;
