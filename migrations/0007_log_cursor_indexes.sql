-- UP
-- 日志游标按 created_at + id 稳定 seek，避免 offset 在清理期间跳过数据。
DROP INDEX IF EXISTS idx_request_logs_created_at;
DROP INDEX IF EXISTS idx_admin_audit_logs_created_at;
DROP INDEX IF EXISTS idx_email_logs_created_at;
CREATE INDEX IF NOT EXISTS idx_request_logs_cursor ON request_logs(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_cursor ON admin_audit_logs(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_email_logs_cursor ON email_logs(created_at DESC, id DESC);

-- DOWN
DROP INDEX IF EXISTS idx_email_logs_cursor;
DROP INDEX IF EXISTS idx_admin_audit_logs_cursor;
DROP INDEX IF EXISTS idx_request_logs_cursor;
CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_created_at ON admin_audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_email_logs_created_at ON email_logs(created_at);
