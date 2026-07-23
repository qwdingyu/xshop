-- 商品级交付展示策略：轻量支持“仅邮件交付卡密”，不引入活动系统。
ALTER TABLE products ADD COLUMN delivery_visibility TEXT NOT NULL DEFAULT 'web_and_email';
