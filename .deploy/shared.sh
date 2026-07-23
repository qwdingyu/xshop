#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# shared.sh — 统一部署函数库
#
# 所有部署脚本 source 此文件获取公共函数。
# 用法: source "$(dirname "$0")/shared.sh"
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

# ── 颜色 ─────────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# ── 日志函数 ──────────────────────────────────────────────────────────────────
log_info()  { echo -e "${BLUE}[INFO]${NC}  $*"; }
log_ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }
log_step()  { echo -e "\n${BOLD}${CYAN}━━━ $* ━━━${NC}"; }

# ── 前置条件检查 ──────────────────────────────────────────────────────────────
check_cmd() {
  local cmd="$1" hint="${2:-}"
  if command -v "$cmd" &>/dev/null; then
    log_ok "$cmd ($(command -v "$cmd"))"
    return 0
  else
    log_error "$cmd 未安装${hint:+ — $hint}"
    return 1
  fi
}

check_env() {
  local name="$1" hint="${2:-}"
  local val="${!name:-}"
  if [ -n "$val" ]; then
    log_ok "$name 已设置 (${#val} 字符)"
    return 0
  else
    log_error "$name 未设置${hint:+ — $hint}"
    return 1
  fi
}

# ── 自动生成安全 Token ────────────────────────────────────────────────────────
gen_token() {
  local prefix="${1:-tok}"
  echo "${prefix}-$(openssl rand -hex 24)"
}

gen_hex() {
  local bytes="${1:-32}"
  openssl rand -hex "$bytes"
}

# ── Cloudflare API 封装 ───────────────────────────────────────────────────────
CF_API_BASE="https://api.cloudflare.com/client/v4"

cf_api() {
  local method="$1" path="$2" body="${3:-}"
  local token="${CLOUDFLARE_API_TOKEN:?缺少 CLOUDFLARE_API_TOKEN}"

  local curl_args=(
    -sS -X "$method"
    "${CF_API_BASE}${path}"
    -H "Authorization: Bearer ${token}"
    -H "Content-Type: application/json"
  )

  if [ -n "$body" ]; then
    curl_args+=(-d "$body")
  fi

  local response
  response=$(curl "${curl_args[@]}" 2>/dev/null) || {
    log_error "Cloudflare API 请求失败: $method $path"
    return 1
  }

  local success
  success=$(echo "$response" | jq -r '.success // false' 2>/dev/null)
  if [ "$success" != "true" ]; then
    local errors
    errors=$(echo "$response" | jq -r '.errors[0].message // "unknown error"' 2>/dev/null)
    log_error "Cloudflare API $method $path: $errors"
    return 1
  fi

  echo "$response"
}

# ── Cloudflare DNS API 封装 ─────────────────────────────────────────────────
# CLOUDFLARE_API_TOKEN 必须按最小权限授予目标 Zone 的 DNS Read/Edit。
cf_dns_api() {
  local method="$1" path="$2" body="${3:-}"

  local token="${CLOUDFLARE_API_TOKEN:?缺少 CLOUDFLARE_API_TOKEN}"
  local curl_args=(
    -sS -X "$method"
    "${CF_API_BASE}${path}"
    -H "Authorization: Bearer ${token}"
    -H "Content-Type: application/json"
  )

  if [ -n "$body" ]; then
    curl_args+=(-d "$body")
  fi

  local response
  response=$(curl "${curl_args[@]}" 2>/dev/null) || {
    log_error "Cloudflare DNS API 请求失败: $method $path"
    return 1
  }

  local success
  success=$(echo "$response" | jq -r '.success // false' 2>/dev/null)
  if [ "$success" != "true" ]; then
    local errors
    errors=$(echo "$response" | jq -r '.errors[0].message // "unknown error"' 2>/dev/null)
    log_error "Cloudflare DNS API $method $path: $errors"

    log_error "请确认 CLOUDFLARE_API_TOKEN 包含目标 Zone 的 DNS Read/Edit 权限"
    return 1
  fi

  echo "$response"
}

# ── 凭证预检（检查 DNS 权限是否可用） ────────────────────────────────────────
# 参数：$1 = Zone ID
# 返回：0 = DNS 可用，1 = DNS 不可用
cf_check_dns_auth() {
  local zone_id="${1:-}"
  if [ -z "$zone_id" ]; then
    log_error "cf_check_dns_auth: zone_id 不能为空"
    return 1
  fi

  local dns_resp
  dns_resp=$(cf_dns_api GET "/zones/${zone_id}/dns_records?per_page=1" 2>/dev/null) || return 1

  local dns_ok
  dns_ok=$(echo "$dns_resp" | jq -r '.success // false' 2>/dev/null)
  [ "$dns_ok" = "true" ]
}

# ── Cloudflare Account ID 自动推导 ───────────────────────────────────────────
_cf_account_id=""
cf_get_account_id() {
  if [ -n "$_cf_account_id" ]; then
    echo "$_cf_account_id"
    return
  fi
  local resp
  resp=$(cf_api GET "/accounts")
  _cf_account_id=$(echo "$resp" | jq -r '.result[0].id')
  if [ -z "$_cf_account_id" ] || [ "$_cf_account_id" = "null" ]; then
    log_error "无法获取 Cloudflare Account ID"
    return 1
  fi
  local name
  name=$(echo "$resp" | jq -r '.result[0].name')
  log_ok "Account: $name ($_cf_account_id)" >&2
  echo "$_cf_account_id"
}

# ── Turso API 封装 ────────────────────────────────────────────────────────────
TURSO_API_BASE="https://api.turso.tech/v1"

turso_api() {
  local method="$1" path="$2" body="${3:-}"
  local token="${TURSO_API_TOKEN:?缺少 TURSO_API_TOKEN}"

  local curl_args=(
    -sS -X "$method"
    "${TURSO_API_BASE}${path}"
    -H "Authorization: Bearer ${token}"
    -H "Content-Type: application/json"
  )

  if [ -n "$body" ]; then
    curl_args+=(-d "$body")
  fi

  local response
  response=$(curl "${curl_args[@]}" 2>/dev/null) || {
    log_error "Turso API 请求失败: $method $path"
    return 1
  }

  echo "$response"
}

# ── Turso 组织名自动推导 ──────────────────────────────────────────────────────
_turso_org=""
turso_get_org() {
  if [ -n "$_turso_org" ]; then
    echo "$_turso_org"
    return
  fi
  local resp
  resp=$(turso_api GET "/organizations")
  _turso_org=$(echo "$resp" | jq -r '.[0].slug // .[0].name // empty')
  if [ -z "$_turso_org" ]; then
    log_error "无法从 Turso /organizations 响应中提取组织名"
    log_error "响应内容: $(echo "$resp" | head -c 200)"
    return 1
  fi
  log_ok "Turso 组织: $_turso_org" >&2
  echo "$_turso_org"
}

# ── GitHub CLI 封装 ───────────────────────────────────────────────────────────
gh_check() {
  if ! command -v gh &>/dev/null; then
    log_error "gh CLI 未安装 — brew install gh"
    return 1
  fi
  # 重试 3 次（网络抖动容错）
  for attempt in 1 2 3; do
    if gh auth status &>/dev/null 2>&1; then
      log_ok "gh CLI 已登录 ($(gh auth status 2>&1 | head -1))"
      return 0
    fi
    if [ "$attempt" -lt 3 ]; then
      log_warn "gh auth status 失败（第 ${attempt}/3 次），2s 后重试..."
      sleep 2
    fi
  done
  log_error "gh CLI 未登录 — gh auth login"
  return 1
}

gh_set_secret() {
  local repo="$1" name="$2" value="$3"
  if timeout 30 bash -c "echo '$value' | gh secret set '$name' --repo '$repo'" 2>/dev/null; then
    log_ok "Secret: $name"
  else
    log_warn "Secret: $name 设置超时或失败（30s），稍后重试"
  fi
}

gh_set_variable() {
  local repo="$1" name="$2" value="$3"
  if timeout 30 bash -c "gh variable set '$name' --repo '$repo' --body '$value'" 2>/dev/null; then
    log_ok "Variable: $name = $value"
  else
    log_warn "Variable: $name 设置超时或失败（30s），稍后重试"
  fi
}

# ── 凭证持久化（.credentials/ 目录） ─────────────────────────────────────────
CRED_DIR=".credentials"

cred_save() {
  mkdir -p "$CRED_DIR"
  local name="$1" value="$2"
  echo "$value" > "${CRED_DIR}/${name}"
  chmod 600 "${CRED_DIR}/${name}"
  log_ok "凭证已保存: ${CRED_DIR}/${name}" >&2
}

cred_load() {
  local name="$1"
  local file="${CRED_DIR}/${name}"
  if [ -f "$file" ]; then
    cat "$file"
    return 0
  fi
  return 1
}

cred_load_or_gen() {
  local name="$1" prefix="${2:-tok}"
  local value
  if value=$(cred_load "$name") && [ -n "$value" ]; then
    echo "$value"
  else
    value=$(gen_token "$prefix")
    cred_save "$name" "$value"
    echo "$value"
  fi
}

# ── 进度跟踪 ──────────────────────────────────────────────────────────────────
STEP_FILE="${CRED_DIR}/.deploy-progress"

step_done() {
  mkdir -p "$CRED_DIR"
  echo "$1" >> "$STEP_FILE"
}

step_check() {
  [ -f "$STEP_FILE" ] && grep -qx "$1" "$STEP_FILE" 2>/dev/null
}

# ── 部署模式检测 ──────────────────────────────────────────────────────────────
# 三种模式：
#   workers  — 纯 Workers + Static Assets（默认，eshop/xtools 等）
#   pages    — 纯 Cloudflare Pages（静态站、SEO 工具站、文档站）
#   hybrid   — Workers + Pages 混合模式（vcode 模式，API 走 Worker，前端走 Pages）
#
# 检测优先级：
#   1. DEPLOY_MODE 环境变量（最高优先）
#   2. 项目根目录 .deploy-mode 文件
#   3. 默认 "workers"

detect_deploy_mode() {
  if [ -n "${DEPLOY_MODE:-}" ]; then
    echo "$DEPLOY_MODE"
    return
  fi
  if [ -f ".deploy-mode" ]; then
    local mode
    mode=$(cat .deploy-mode | tr -d '[:space:]')
    case "$mode" in
      workers|pages|hybrid) echo "$mode"; return ;;
    esac
    log_warn ".deploy-mode 文件内容无效: '$mode'，使用默认 workers" >&2
  fi
  echo "workers"
}

# 模式判断快捷函数
is_workers_mode() { [ "$(detect_deploy_mode)" = "workers" ]; }
is_pages_mode()   { [ "$(detect_deploy_mode)" = "pages" ]; }
is_hybrid_mode()  { [ "$(detect_deploy_mode)" = "hybrid" ]; }

# ── Cloudflare Pages 部署函数 ─────────────────────────────────────────────────

# 部署 Pages（带重试）
# 参数：$1 = Pages 项目名, $2 = 部署目录（默认 public）
pages_deploy() {
  if [ -z "${1:-}" ]; then
    log_error "Pages 项目名不能为空" >&2
    return 1
  fi
  local project_name="$1"
  local deploy_dir="${2:-public}"

  if [ ! -d "$deploy_dir" ]; then
    log_error "Pages 部署目录不存在: $deploy_dir" >&2
    return 1
  fi

  # 确保 Pages 项目存在（首次部署时自动创建）
  log_info "检查 Pages 项目: $project_name" >&2
  if ! CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN}" npx wrangler pages project list 2>/dev/null | grep -q "$project_name"; then
    log_info "创建 Pages 项目: $project_name" >&2
    CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN}" npx wrangler pages project create "$project_name" --production-branch main >&2 || {
      log_error "Pages 项目创建失败" >&2
      return 1
    }
  fi

  log_info "部署 Pages: $project_name (目录: $deploy_dir)" >&2

  local retries=2
  for attempt in 1 2 3; do
    if CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN}" npx wrangler pages deploy "$deploy_dir" \
      --project-name="$project_name" \
      --branch=main \
      --commit-message="deploy $(date +%Y%m%d-%H%M%S)" \
      --commit-dirty=true >&2; then
      log_ok "Pages 部署成功: $project_name" >&2
      return 0
    fi
    if [ "$attempt" -le "$retries" ]; then
      log_warn "Pages 部署失败（第 ${attempt}/3 次），5s 后重试..." >&2
      sleep 5
    fi
  done

  log_error "Pages 部署失败（3 次重试后仍失败）" >&2
  return 1
}

# 获取 Pages 项目 URL
# 参数：$1 = Pages 项目名
pages_get_url() {
  local project_name="$1"
  local account_id
  account_id=$(cf_get_account_id)
  if [ -z "$account_id" ]; then
    echo ""
    return
  fi
  local resp
  resp=$(cf_api GET "/accounts/${account_id}/pages/projects/${project_name}" 2>/dev/null || echo '{}')
  local url
  url=$(echo "$resp" | jq -r '.result.subdomain // empty' 2>/dev/null)
  echo "$url"
}

# ── 横幅 ──────────────────────────────────────────────────────────────────────
banner() {
  echo ""
  echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════════════╗${NC}"
  echo -e "${BOLD}${CYAN}║  $1${NC}"
  echo -e "${BOLD}${CYAN}╚══════════════════════════════════════════════════╝${NC}"
  echo ""
}
