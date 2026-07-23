#!/usr/bin/env bash
# 兼容 one-click 的薄封装：凭据归一化后交给仓库唯一的 GitHub 配置入口。
set -euo pipefail
source "$(dirname "$0")/shared.sh"

for name in ADMIN_TOKEN BACKUP_ENCRYPTION_PASSPHRASE RATE_LIMIT_SALT JWT_SECRET CREDENTIALS_ENCRYPTION_KEY TURNSTILE_SECRET_KEY TURSO_URL TURSO_TOKEN; do
  value="$(cred_load "$name" 2>/dev/null || true)"
  if [ -n "$value" ]; then
    printf -v "$name" '%s' "$value"
    export "$name"
  fi
done

REPO="${REPO:-$(cred_load GITHUB_REPO 2>/dev/null || true)}"
WORKER_NAME="${WORKER_NAME:-$(cred_load WORKER_NAME 2>/dev/null || true)}"
TURSO_DB_NAME="${TURSO_DB_NAME:-$(cred_load DB_NAME 2>/dev/null || true)}"
DOMAIN="$(cred_load DOMAIN 2>/dev/null || true)"
if [ -z "${APP_ORIGIN:-}" ]; then
  if [ -n "$DOMAIN" ]; then
    APP_ORIGIN="https://${DOMAIN}"
  else
    APP_ORIGIN="$(cred_load BASE_URL 2>/dev/null || true)"
  fi
fi
BIND_DOMAIN="${BIND_DOMAIN:-$(if [ -n "$DOMAIN" ]; then echo true; else echo false; fi)}"
DEPLOY_MODE="${DEPLOY_MODE:-$(detect_deploy_mode)}"
export REPO WORKER_NAME TURSO_DB_NAME APP_ORIGIN BIND_DOMAIN DEPLOY_MODE

exec bash scripts/10-setup-github.sh
