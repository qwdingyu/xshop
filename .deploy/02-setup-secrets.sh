#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# 02-setup-secrets.sh — 自动生成所有项目 Secrets
#
# 功能：
#   自动生成并持久化以下 Secrets（如已存在则复用）：
#   - ADMIN_TOKEN         — 管理后台 Token
#   - RATE_LIMIT_SALT     — IP 哈希盐值
#   - JWT_SECRET          — Telegram 管理员一次性登录 JWT 签名密钥
#   - CREDENTIALS_ENCRYPTION_KEY — AES-256 加密密钥（后台敏感配置需要）
#   - BACKUP_ENCRYPTION_PASSPHRASE — GitHub Artifact 数据库备份加密口令
#
# 所有凭证保存到 .credentials/ 目录，后续由 06-setup-github.sh 推送到 GitHub
# ═══════════════════════════════════════════════════════════════════════════════
source "$(dirname "$0")/shared.sh"

banner "生成项目 Secrets"

if step_check "02-setup-secrets"; then
  log_ok "已完成，跳过"
  exit 0
fi

log_step "自动生成 Secrets（已有则复用）"

# ── ADMIN_TOKEN ───────────────────────────────────────────────────────────────
ADMIN_TOKEN=$(cred_load_or_gen "ADMIN_TOKEN" "admin")
log_ok "ADMIN_TOKEN: ${ADMIN_TOKEN:0:12}..."

# ── RATE_LIMIT_SALT ───────────────────────────────────────────────────────────
RATE_LIMIT_SALT=$(cred_load_or_gen "RATE_LIMIT_SALT" "salt")
log_ok "RATE_LIMIT_SALT: ${RATE_LIMIT_SALT:0:12}..."

# ── JWT_SECRET（独立于数据库和 Bot Token） ───────────────────────────────────
JWT_SECRET=$(cred_load_or_gen "JWT_SECRET" "jwt")
log_ok "JWT_SECRET: ${JWT_SECRET:0:12}..."

# ── CREDENTIALS_ENCRYPTION_KEY（64 字符 hex = 256 bit AES） ──────────────────
EXISTING_KEY=$(cred_load "CREDENTIALS_ENCRYPTION_KEY" 2>/dev/null || echo "")
if [ -n "$EXISTING_KEY" ]; then
  CREDENTIALS_ENCRYPTION_KEY="$EXISTING_KEY"
  log_ok "CREDENTIALS_ENCRYPTION_KEY: 复用已有"
else
  CREDENTIALS_ENCRYPTION_KEY=$(gen_hex 32)
  cred_save "CREDENTIALS_ENCRYPTION_KEY" "$CREDENTIALS_ENCRYPTION_KEY"
  log_ok "CREDENTIALS_ENCRYPTION_KEY: 已生成 (64 hex)"
fi

# ── BACKUP_ENCRYPTION_PASSPHRASE（独立于数据库访问凭据） ────────────────────
BACKUP_ENCRYPTION_PASSPHRASE=$(cred_load_or_gen "BACKUP_ENCRYPTION_PASSPHRASE" "backup")
log_ok "BACKUP_ENCRYPTION_PASSPHRASE: 已就绪"

# ── 汇总 ──────────────────────────────────────────────────────────────────────
echo ""
log_ok "✅ Secrets 已生成并保存到 .credentials/"
echo "  后续由 06-setup-github.sh 推送到 GitHub Actions Secrets"
echo "  由 03-deploy-worker.sh 推送到 Cloudflare Workers Secrets"

step_done "02-setup-secrets"
