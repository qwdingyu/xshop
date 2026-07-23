-- UP
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
