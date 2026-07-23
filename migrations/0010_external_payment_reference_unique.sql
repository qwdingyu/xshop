-- UP
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
