-- UP
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
