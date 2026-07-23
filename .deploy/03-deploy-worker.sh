#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# 03-deploy.sh — 构建 + 部署 + 冒烟测试（支持三种部署模式）
#
# 部署模式（由 .deploy-mode 文件或 DEPLOY_MODE 环境变量决定）：
#   workers  — Cloudflare Workers + Static Assets（默认）
#   pages    — Cloudflare Pages（纯静态站）
#   hybrid   — Workers + Pages 混合模式
#
# 输入：CLOUDFLARE_API_TOKEN + .credentials/ 下的所有凭证
# ═══════════════════════════════════════════════════════════════════════════════
source "$(dirname "$0")/shared.sh"

PROJECT_NAME=$(cred_load "PROJECT_NAME" 2>/dev/null || basename "$(pwd)")
WORKER_NAME="${WORKER_NAME:-${PROJECT_NAME}}"
MODE=$(detect_deploy_mode)

banner "部署 ($MODE): $PROJECT_NAME"

# ── 独立运行时的前置检查 ──────────────────────────────────────────────────────
FAIL=0
check_env CLOUDFLARE_API_TOKEN "从 https://dash.cloudflare.com/profile/api-tokens 获取" || FAIL=1
[ "$FAIL" -eq 1 ] && exit 1

if step_check "03-deploy-worker"; then
  log_ok "已完成，跳过"
  exit 0
fi

# ── 公共：构建前端（可选） ────────────────────────────────────────────────────
log_step "构建前端"

if grep -q '"build:frontend"' package.json 2>/dev/null; then
  log_info "npm run build:frontend ..."
  npm run build:frontend
  log_ok "前端构建完成"
elif grep -q '"frontend:build"' package.json 2>/dev/null; then
  log_info "npm run frontend:build ..."
  npm run frontend:build
  log_ok "前端构建完成"
elif grep -q '"build"' package.json 2>/dev/null && is_pages_mode; then
  log_info "npm run build ..."
  npm run build
  log_ok "构建完成"
else
  log_ok "无构建步骤，跳过"
fi

# ── SEO 页面生成（仅 pages 模式，且没有 build 脚本时才单独运行） ──────────────
# 如果 build 脚本存在，它应该已经包含了 SEO 生成逻辑，不再重复执行
if is_pages_mode && ! grep -q '"build"' package.json 2>/dev/null && grep -q '"generate:seo"' package.json 2>/dev/null; then
  log_step "生成 SEO 页面"
  npm run generate:seo
  log_ok "SEO 页面生成完成"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# 模式分支：Workers 部署
# ═══════════════════════════════════════════════════════════════════════════════
deploy_workers() {
  log_step "部署 Workers"

  # 加载凭证
  TURSO_URL=$(cred_load "TURSO_URL" 2>/dev/null || echo "")
  TURSO_TOKEN=$(cred_load "TURSO_TOKEN" 2>/dev/null || echo "")
  ADMIN_TOKEN=$(cred_load "ADMIN_TOKEN" 2>/dev/null || echo "")
  RATE_LIMIT_SALT=$(cred_load "RATE_LIMIT_SALT" 2>/dev/null || echo "")
  JWT_SECRET=$(cred_load "JWT_SECRET" 2>/dev/null || echo "")
  CREDENTIALS_ENCRYPTION_KEY=$(cred_load "CREDENTIALS_ENCRYPTION_KEY" 2>/dev/null || echo "")

  # APP_ORIGIN 必须在部署前确定，不能从包含日志的 wrangler 输出中截取后再回填。
  DOMAIN=$(cred_load "DOMAIN" 2>/dev/null || echo "")
  if [ -n "$DOMAIN" ]; then
    WORKER_ORIGIN="https://${DOMAIN}"
  else
    CF_ACCOUNT_ID=$(cf_get_account_id)
    WORKERS_SUBDOMAIN=$(cf_api GET "/accounts/${CF_ACCOUNT_ID}/workers/subdomain" | jq -r '.result.subdomain // empty')
    if [ -z "$WORKERS_SUBDOMAIN" ]; then
      log_error "无法读取 Cloudflare workers.dev 子域，拒绝猜测 APP_ORIGIN"
      return 1
    fi
    WORKER_ORIGIN="https://${WORKER_NAME}.${WORKERS_SUBDOMAIN}.workers.dev"
  fi

  # 生成临时 secrets 文件
  SECRETS_FILE=".deploy-secrets.env"
  umask 077
  trap ': > "$SECRETS_FILE" 2>/dev/null || true; rm -f "$SECRETS_FILE"' EXIT
  cat > "$SECRETS_FILE" <<EOF
TURSO_URL=${TURSO_URL}
TURSO_TOKEN=${TURSO_TOKEN}
ADMIN_TOKEN=${ADMIN_TOKEN}
RATE_LIMIT_SALT=${RATE_LIMIT_SALT}
EOF

  # 可选 secrets（非空才加入）
  [ -n "$JWT_SECRET" ] && echo "JWT_SECRET=${JWT_SECRET}" >> "$SECRETS_FILE"
  [ -n "$CREDENTIALS_ENCRYPTION_KEY" ] && echo "CREDENTIALS_ENCRYPTION_KEY=${CREDENTIALS_ENCRYPTION_KEY}" >> "$SECRETS_FILE"

  # 加载项目特有的 secrets（.credentials/ 下大写文件）
  for f in .credentials/[A-Z]*; do
    [ -f "$f" ] || continue
    name=$(basename "$f")
    case "$name" in
      TURSO_URL|TURSO_TOKEN|ADMIN_TOKEN|RATE_LIMIT_SALT|JWT_SECRET|CREDENTIALS_ENCRYPTION_KEY) continue ;;
      GITHUB_REPO|PROJECT_NAME|DB_NAME|WORKER_NAME|BASE_URL|DOMAIN|DEPLOY_MODE) continue ;;
      PAGES_PROJECT_NAME|TURNSTILE_SITE_KEY|TURSO_LOCATION|GROUP_NAME) continue ;;
      .deploy-progress) continue ;;
    esac
    value=$(cat "$f")
    echo "${name}=${value}" >> "$SECRETS_FILE"
  done

  log_info "npx wrangler deploy --secrets-file ..."
  DEPLOY_OUTPUT=$(CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN}" npx wrangler deploy --secrets-file="$SECRETS_FILE" --var "APP_ORIGIN:${WORKER_ORIGIN}" 2>&1)
  echo "$DEPLOY_OUTPUT"

  # 清理临时文件
  : > "$SECRETS_FILE" && rm -f "$SECRETS_FILE"
  trap - EXIT
  log_ok "Worker 已部署"

  WORKER_URL="$WORKER_ORIGIN"

  # CF API 验证
  log_info "通过 CF API 验证 Worker 部署状态..."
  CF_ACCOUNT_ID=$(curl -sS "https://api.cloudflare.com/client/v4/accounts" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" 2>/dev/null | jq -r '.result[0].id // empty')

  if [ -n "$CF_ACCOUNT_ID" ]; then
    WORKER_EXISTS=$(curl -sS "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/workers/scripts" \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" 2>/dev/null | \
      jq -r ".result[] | select(.id == \"${WORKER_NAME}\") | .id" 2>/dev/null)
    if [ "$WORKER_EXISTS" = "$WORKER_NAME" ]; then
      log_ok "CF API 确认 Worker '${WORKER_NAME}' 已在线"
    else
      log_warn "CF API 未找到 Worker '${WORKER_NAME}'（可能延迟同步）"
    fi
  fi

  DEPLOYED_WORKER_URL="$WORKER_URL"
}

# ═══════════════════════════════════════════════════════════════════════════════
# 模式分支：Pages 部署
# ═══════════════════════════════════════════════════════════════════════════════
deploy_pages() {
  log_step "部署 Pages" >&2

  PAGES_PROJECT=$(cred_load "PAGES_PROJECT_NAME" 2>/dev/null || echo "${PROJECT_NAME}")
  PAGES_DIR="${PAGES_DIR:-public}"

  pages_deploy "$PAGES_PROJECT" "$PAGES_DIR"

  # 获取 Pages URL
  PAGES_URL=$(pages_get_url "$PAGES_PROJECT")
  if [ -z "$PAGES_URL" ]; then
    PAGES_URL="${PAGES_PROJECT}.pages.dev"
    log_warn "无法获取 Pages URL，使用默认: https://$PAGES_URL" >&2
  else
    log_ok "Pages URL: https://$PAGES_URL" >&2
  fi

  DEPLOYED_PAGES_URL="https://$PAGES_URL"
}

# ═══════════════════════════════════════════════════════════════════════════════
# 按模式执行部署
# ═══════════════════════════════════════════════════════════════════════════════
BASE_URL=""
DEPLOYED_WORKER_URL=""
DEPLOYED_PAGES_URL=""

case "$MODE" in
  workers)
    deploy_workers
    BASE_URL="$DEPLOYED_WORKER_URL"
    ;;
  pages)
    deploy_pages
    BASE_URL="$DEPLOYED_PAGES_URL"
    ;;
  hybrid)
    deploy_workers
    deploy_pages
    BASE_URL="$DEPLOYED_PAGES_URL"
    ;;
  *)
    log_error "未知的部署模式: $MODE（支持 workers/pages/hybrid）"
    exit 1
    ;;
esac

# ── 冒烟测试 ─────────────────────────────────────────────────────────────────
log_step "冒烟测试"

if [ "$MODE" = "pages" ]; then
  # Pages 模式：只检查首页可访问性
  log_info "HTTP 冒烟测试 (${BASE_URL}) ..."
  HTTP_STATUS=$(curl -sS -o /tmp/smoke-index.html -w "%{http_code}" --max-time 10 \
    "${BASE_URL}/" 2>/dev/null || echo "000")

  if [ "$HTTP_STATUS" = "200" ]; then
    log_ok "首页可访问 (HTTP 200)"
    PAGE_SIZE=$(wc -c < /tmp/smoke-index.html 2>/dev/null || echo "0")
    log_info "页面大小: ${PAGE_SIZE} bytes"
  elif [ "$HTTP_STATUS" = "000" ]; then
    log_warn "HTTP 连接超时（pages.dev 在部分地区不稳定）"
  else
    log_warn "首页返回 HTTP $HTTP_STATUS"
  fi
else
  # Workers/Hybrid 模式：检查 API 健康端点
  log_info "HTTP 冒烟测试 (${BASE_URL}/api/health) ..."
  HTTP_STATUS=$(curl -sS -o /tmp/smoke-health.json -w "%{http_code}" --max-time 10 \
    "${BASE_URL}/api/health" 2>/dev/null || echo "000")

  if [ "$HTTP_STATUS" = "200" ]; then
    log_ok "健康检查通过 (HTTP 200)"
    cat /tmp/smoke-health.json 2>/dev/null | jq . 2>/dev/null || true
  elif [ "$HTTP_STATUS" = "000" ]; then
    log_warn "HTTP 连接超时（workers.dev 在部分地区不稳定）"
    log_info "如需稳定访问请绑定自定义域名: DOMAIN=\"xxx\" bash .deploy/04-bind-domain.sh"
  else
    log_warn "健康检查返回 HTTP $HTTP_STATUS"
  fi

  # 管理端冒烟
  ADMIN_TOKEN=$(cred_load "ADMIN_TOKEN" 2>/dev/null || echo "")
  if [ -n "$ADMIN_TOKEN" ]; then
    ADMIN_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 10 \
      -H "Authorization: Bearer ${ADMIN_TOKEN}" \
      "${BASE_URL}/api/admin/summary" 2>/dev/null || echo "000")
    if [ "$ADMIN_STATUS" = "200" ]; then
      log_ok "管理端认证通过 (HTTP 200)"
    elif [ "$ADMIN_STATUS" = "000" ]; then
      log_warn "管理端连接超时"
    elif [ "$ADMIN_STATUS" = "401" ]; then
      log_error "管理端认证失败 (HTTP 401)，ADMIN_TOKEN 可能不正确"
    else
      log_warn "管理端返回 HTTP $ADMIN_STATUS"
    fi
  fi
fi

# ── 保存凭证 ──────────────────────────────────────────────────────────────────
cred_save "WORKER_NAME" "$WORKER_NAME"
cred_save "BASE_URL" "$BASE_URL"
cred_save "DEPLOY_MODE" "$MODE"
step_done "03-deploy-worker"

echo ""
log_ok "✅ 部署完成 ($MODE)"
echo "  URL: $BASE_URL"
if [ "$MODE" != "pages" ]; then
  echo "  Admin: $BASE_URL/admin"
fi
exit 0
