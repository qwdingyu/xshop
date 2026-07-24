-- UP
-- 货架对比价（划线原价）：仅用于店面促销展示，不参与下单计费。
-- NULL/0 = 未设置；有效时必须大于 price_cents（由服务层校验）。
ALTER TABLE products ADD COLUMN original_price_cents INTEGER;

-- DOWN
ALTER TABLE products DROP COLUMN original_price_cents;
