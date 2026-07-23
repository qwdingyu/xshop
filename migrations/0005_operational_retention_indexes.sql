-- UP
-- 定时清理按 created_at 删除历史运行数据，避免每两小时全表扫描。
CREATE INDEX IF NOT EXISTS idx_rate_limit_windows_window_start ON rate_limit_windows(window_start);
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created_at ON idempotency_keys(created_at);
CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_email_logs_created_at ON email_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_card_logs_created_at ON card_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_order_events_created_at ON order_events(created_at);
CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_created_at ON admin_audit_logs(created_at);

-- DOWN
DROP INDEX IF EXISTS idx_admin_audit_logs_created_at;
DROP INDEX IF EXISTS idx_order_events_created_at;
DROP INDEX IF EXISTS idx_card_logs_created_at;
DROP INDEX IF EXISTS idx_email_logs_created_at;
DROP INDEX IF EXISTS idx_request_logs_created_at;
DROP INDEX IF EXISTS idx_idempotency_keys_created_at;
DROP INDEX IF EXISTS idx_rate_limit_windows_window_start;
