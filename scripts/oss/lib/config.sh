#!/usr/bin/env bash
# 默认配置（可被 scripts/oss/config.env 覆盖）
: "${XSHOP_OWNER:=qwdingyu}"
: "${XSHOP_REPO:=xshop}"
: "${XSHOP_BRANCH:=main}"
: "${PRIVATE_BRANCH:=main}"
: "${OSS_STRIP_SCHEDULE:=1}"
: "${OSS_EXCLUDE_PREFIXES:=docs/ packages/ .env .env.local scripts/oss/config.env}"

# 公开仓不应存在的生产类 secret 名称（harden / check 共用）
OSS_PROD_SECRET_NAMES=(
  ADMIN_TOKEN CLOUDFLARE_API_TOKEN CREDENTIALS_ENCRYPTION_KEY
  GROUP_NAME JWT_SECRET RATE_LIMIT_SALT
  TURSO_LOCATION TURSO_TOKEN TURSO_URL TURSO_API_TOKEN
  BACKUP_ENCRYPTION_PASSPHRASE TURNSTILE_SECRET_KEY
  SMOKE_TURNSTILE_TOKEN ALLOW_TURNSTILE_BYPASS_FOR_SMOKE
  CF_API_TOKEN WRANGLER_API_TOKEN
)

OSS_PROD_VAR_NAMES=(
  APP_ORIGIN WORKER_NAME BIND_DOMAIN DEPLOY_MODE
  TURSO_DB_NAME PAGES_PROJECT_NAME EMAIL_FROM
)

# 私有仓必须存在的工件
OSS_REQUIRED_PRIVATE_FILES=(
  scripts/oss/ossctl.sh
  scripts/oss/lib/common.sh
  scripts/oss/lib/check.sh
  scripts/oss/lib/export.sh
  scripts/oss/lib/push.sh
  scripts/oss/lib/harden.sh
  .github/workflows/sync-oss.yml
)

# 导出时硬排除路径匹配
oss_should_exclude() {
  local path="$1" p
  case "$path" in
    docs|docs/*|packages|packages/*|.env|.env.*|*.pem|*.key) return 0 ;;
  esac
  for p in $OSS_EXCLUDE_PREFIXES; do
    [[ "$path" == "$p"* || "$path" == "$p" ]] && return 0
  done
  # 私有同步 workflow 不导出到公开仓（避免误导他人把 token 配到 fork）
  [[ "$path" == ".github/workflows/sync-oss.yml" ]] && return 0
  [[ "$path" == "scripts/oss/config.env" ]] && return 0
  return 1
}