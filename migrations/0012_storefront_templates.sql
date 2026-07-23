-- UP
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
