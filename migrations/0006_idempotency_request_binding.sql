-- UP
-- 旧缓存无法可靠还原原始请求，保留空摘要并在运行时 fail closed。
ALTER TABLE idempotency_keys ADD COLUMN request_hash TEXT NOT NULL DEFAULT '';

-- DOWN
ALTER TABLE idempotency_keys DROP COLUMN request_hash;
