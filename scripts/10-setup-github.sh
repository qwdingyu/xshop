#!/usr/bin/env bash
# GitHub Actions 配置唯一入口。只把凭据写入 Secrets，把可公开部署元数据写入 Variables。
set -euo pipefail

if ! command -v gh >/dev/null 2>&1; then
  echo "缺少 GitHub CLI" >&2
  exit 1
fi
github_authenticated=false
for attempt in 1 2 3; do
  if gh auth status >/dev/null 2>&1; then
    github_authenticated=true
    break
  fi
  sleep 2
done
if [ "$github_authenticated" != "true" ]; then
  echo "GitHub CLI 未登录或认证检查持续失败" >&2
  exit 1
fi

REPO="${REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)}"
if [ -z "$REPO" ]; then
  echo "无法识别 GitHub 仓库，请通过 REPO=owner/repo 显式指定" >&2
  exit 1
fi

read_local_credential() {
  local name="$1" file=".credentials/${2:-$1}"
  if [ -z "${!name:-}" ] && [ -f "$file" ]; then
    printf -v "$name" '%s' "$(<"$file")"
    export "$name"
  fi
}

# 本地一键部署会把这些值保存在被 Git 忽略的 .credentials；统一入口可以安全复用它们。
for name in ADMIN_TOKEN BACKUP_ENCRYPTION_PASSPHRASE RATE_LIMIT_SALT JWT_SECRET CREDENTIALS_ENCRYPTION_KEY TURNSTILE_SECRET_KEY TURSO_URL TURSO_TOKEN; do
  read_local_credential "$name"
done
read_local_credential TURSO_DB_NAME DB_NAME

# 平台管理 Token 与数据库 Token 权限不同。旧版 Turso CLI 在“未登录”时也可能返回 0，
# 因此不能只看退出码；候选值必须是单个 Token，并通过真实平台 API JSON 响应验证。
if [ -z "${TURSO_API_TOKEN:-}" ] && command -v turso >/dev/null 2>&1; then
  turso_token_candidate="$(turso auth token 2>/dev/null || true)"
  if [[ "$turso_token_candidate" =~ ^[A-Za-z0-9._-]{20,}$ ]]; then
    turso_validation="$(curl -fsS 'https://api.turso.tech/v1/organizations' \
      -H "Authorization: Bearer ${turso_token_candidate}" 2>/dev/null || true)"
    if TURSO_VALIDATION="$turso_validation" node -e 'const value=JSON.parse(process.env.TURSO_VALIDATION); if (!Array.isArray(value)) process.exit(1)' >/dev/null 2>&1; then
      TURSO_API_TOKEN="$turso_token_candidate"
      export TURSO_API_TOKEN
    fi
  fi
fi

required_secrets=(
  ADMIN_TOKEN BACKUP_ENCRYPTION_PASSPHRASE CLOUDFLARE_API_TOKEN
  CREDENTIALS_ENCRYPTION_KEY JWT_SECRET RATE_LIMIT_SALT
  TURSO_API_TOKEN TURSO_TOKEN TURSO_URL
)
optional_secrets=(
  ALLOW_TURNSTILE_BYPASS_FOR_SMOKE SMOKE_TURNSTILE_TOKEN TURNSTILE_SECRET_KEY
)
legacy_secrets=(
  CF_AUTH_EMAIL CF_GLOBAL_API_KEY DEPLOY_MODE GROUP_NAME TURSO_LOCATION
)

set_github_secret() {
  local name="$1" value="$2"
  for attempt in 1 2 3; do
    if printf '%s' "$value" | gh secret set "$name" --repo "$REPO"; then
      return 0
    fi
    echo "GitHub Secret $name write failed (${attempt}/3); retrying..." >&2
    sleep 2
  done
  return 1
}

echo "Configuring GitHub repository: $REPO"
for name in "${required_secrets[@]}" "${optional_secrets[@]}"; do
  if [ -n "${!name:-}" ]; then
    set_github_secret "$name" "${!name}"
    echo "  secret: $name"
  fi
done

# APP_ORIGIN 是唯一公网地址；域名绑定和 smoke 都从它解析，不再维护 APP_DOMAIN/WORKERS_DEV_URL。
WORKER_NAME="${WORKER_NAME:-$(node -e 'const s=require("fs").readFileSync("wrangler.jsonc","utf8"); process.stdout.write(s.match(/"name"\s*:\s*"([^"]+)"/)?.[1] || "")')}"
DEPLOY_MODE="${DEPLOY_MODE:-workers}"
BIND_DOMAIN="${BIND_DOMAIN:-false}"

set_variable_if_present() {
  local name="$1" value="${!1:-}"
  if [ -n "$value" ]; then
    local attempt
    for attempt in 1 2 3; do
      if gh variable set "$name" --repo "$REPO" --body "$value"; then
        echo "  variable: $name"
        return 0
      fi
      echo "GitHub Variable $name write failed (${attempt}/3); retrying..." >&2
      sleep 2
    done
    return 1
  fi
}

for name in APP_ORIGIN BIND_DOMAIN DEPLOY_MODE EMAIL_FROM TURSO_DB_NAME WORKER_NAME; do
  set_variable_if_present "$name"
done

# 先写入新位置，再清理已经废弃且不再被代码消费的旧 Secret。
for name in "${legacy_secrets[@]}"; do
  gh secret delete "$name" --repo "$REPO" >/dev/null 2>&1 || true
done

existing_secrets="$(gh secret list --repo "$REPO" --json name --jq '.[].name')"
existing_variables="$(gh variable list --repo "$REPO" --json name --jq '.[].name')"

# 需要迁移值的旧 Secret 只有在新 Variable 已存在时才删除，避免首次运行造成配置空窗。
if printf '%s\n' "$existing_variables" | grep -qx TURSO_DB_NAME; then
  gh secret delete TURSO_DB_NAME --repo "$REPO" >/dev/null 2>&1 || true
fi
if printf '%s\n' "$existing_variables" | grep -qx EMAIL_FROM; then
  gh secret delete EMAIL_FROM --repo "$REPO" >/dev/null 2>&1 || true
fi
for name in APP_DOMAIN DATABASE_PROVIDER TURSO_LOCATION WORKERS_DEV_URL; do
  gh variable delete "$name" --repo "$REPO" >/dev/null 2>&1 || true
done
missing=()
for name in "${required_secrets[@]}"; do
  printf '%s\n' "$existing_secrets" | grep -qx "$name" || missing+=("secret:$name")
done
for name in APP_ORIGIN BIND_DOMAIN DEPLOY_MODE TURSO_DB_NAME WORKER_NAME; do
  printf '%s\n' "$existing_variables" | grep -qx "$name" || missing+=("variable:$name")
done

if [ "${#missing[@]}" -gt 0 ]; then
  printf 'GitHub configuration is incomplete: %s\n' "${missing[*]}" >&2
  exit 1
fi

echo "GitHub Actions configuration is complete."
