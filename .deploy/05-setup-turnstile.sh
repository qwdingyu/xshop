#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# 05-setup-turnstile.sh — Cloudflare Turnstile Widget 自动创建
#
# 功能：
#   1. 通过 Cloudflare API 创建 Turnstile Widget
#   2. 将 Site Key 写入数据库 system_config
#   3. 将 Secret Key 设置为 Worker Secret
#
# 输入：CLOUDFLARE_API_TOKEN + .credentials/ 下的 TURSO_URL/TOKEN
# ═══════════════════════════════════════════════════════════════════════════════
source "$(dirname "$0")/shared.sh"

# ── 独立运行时的前置检查 ──────────────────────────────────────────────────────
FAIL=0
check_env CLOUDFLARE_API_TOKEN "从 https://dash.cloudflare.com/profile/api-tokens 获取" || FAIL=1
[ "$FAIL" -eq 1 ] && exit 1

PROJECT_NAME=$(cred_load "PROJECT_NAME" 2>/dev/null || basename "$(pwd)")
WORKER_NAME=$(cred_load "WORKER_NAME" 2>/dev/null || echo "$PROJECT_NAME")
DOMAIN=$(cred_load "DOMAIN" 2>/dev/null || echo "${WORKER_NAME}.workers.dev")

WIDGET_NAME="${PROJECT_NAME} Turnstile Widget"
WIDGET_DOMAINS="[\"${DOMAIN}\",\"localhost\",\"127.0.0.1\"]"

banner "Turnstile Widget: $WIDGET_NAME"

if step_check "05-setup-turnstile"; then
  log_ok "已完成，跳过"
  exit 0
fi

# ── Step 1: 获取 Account ID ──────────────────────────────────────────────────
log_step "Step 1/3: 获取 Account ID"
ACCOUNT_ID=$(cf_get_account_id)

# ── Step 2: 创建 Turnstile Widget ────────────────────────────────────────────
log_step "Step 2/3: 创建 Turnstile Widget"

# 检查是否已有同名 Widget
EXISTING=$(cf_api GET "/accounts/${ACCOUNT_ID}/challenges/widgets" 2>/dev/null || echo '{"result":[]}')
EXISTING_SITEKEY=$(echo "$EXISTING" | jq -r ".result[] | select(.name==\"${WIDGET_NAME}\") | .sitekey" 2>/dev/null | head -1)

if [ -n "$EXISTING_SITEKEY" ] && [ "$EXISTING_SITEKEY" != "null" ]; then
  SITE_KEY="$EXISTING_SITEKEY"
  SECRET_KEY=$(echo "$EXISTING" | jq -r ".result[] | select(.name==\"${WIDGET_NAME}\") | .secret" 2>/dev/null | head -1)
  log_ok "Widget 已存在，复用 Site Key: $SITE_KEY"

  # ── 检查现有 Widget 的域名白名单，追加缺失的自定义域名 ──
  # 场景：首次创建时只配置 workers.dev，后来绑定 shop.example.com 后
  # 再次运行此脚本时，需要把新域名加入白名单，否则 Turnstile 110200 错误
  log_step "检查域名白名单..."
  EXISTING_DOMAINS=$(echo "$EXISTING" | jq -r ".result[] | select(.name==\"${WIDGET_NAME}\") | .domains[]" 2>/dev/null)
  MISSING_DOMAIN=""
  for expected in $DOMAIN localhost 127.0.0.1; do
    if ! echo "$EXISTING_DOMAINS" | grep -qx "$expected"; then
      MISSING_DOMAIN="$expected"
      break
    fi
  done

  if [ -n "$MISSING_DOMAIN" ]; then
    log_warn "域名 $MISSING_DOMAIN 不在白名单中，正在更新..."
    # 合并现有域名 + 预期域名，去重后更新
    ALL_DOMAINS=$(echo "$EXISTING_DOMAINS" | cat - <(echo "$DOMAIN"; echo "127.0.0.1"; echo "localhost") | sort -u | jq -R -s -c 'split("\n") | map(select(length > 0))')
    UPDATE_RESULT=$(cf_api PUT "/accounts/${ACCOUNT_ID}/challenges/widgets/${SITE_KEY}" \
      "{\"name\":\"${WIDGET_NAME}\",\"domains\":${ALL_DOMAINS}}" 2>/dev/null)
    if echo "$UPDATE_RESULT" | jq -e '.success == true' >/dev/null 2>&1; then
      log_ok "域名白名单已更新: $(echo "$ALL_DOMAINS" | jq -r '. | join(", ")')"
    else
      log_warn "域名白名单更新失败，请在 Cloudflare Dashboard 手动更新"
    fi
  else
    log_ok "域名白名单已包含全部预期域名"
  fi
else
  # 创建新 Widget
  RESULT=$(cf_api POST "/accounts/${ACCOUNT_ID}/challenges/widgets" \
    "{\"name\":\"${WIDGET_NAME}\",\"domains\":${WIDGET_DOMAINS},\"mode\":\"non-interactive\"}")

  SITE_KEY=$(echo "$RESULT" | jq -r '.result.sitekey // empty')
  SECRET_KEY=$(echo "$RESULT" | jq -r '.result.secret // empty')

  if [ -z "$SITE_KEY" ]; then
    log_error "创建 Widget 失败"
    echo "$RESULT" | jq .
    exit 1
  fi
  log_ok "Widget 已创建"
fi

log_info "Site Key: $SITE_KEY"
log_info "Secret:   ${SECRET_KEY:0:15}..."

# ── Step 3: 写入数据库 + Worker Secret ────────────────────────────────────────
log_step "Step 3/3: 配置 Site Key 和 Secret Key"

TURSO_URL=$(cred_load "TURSO_URL" 2>/dev/null || echo "")
TURSO_TOKEN=$(cred_load "TURSO_TOKEN" 2>/dev/null || echo "")

# 写入 system_config
if [ -n "$TURSO_URL" ]; then
  log_info "写入 turnstile_site_key 到数据库..."
  TURSO_URL="$TURSO_URL" TURSO_TOKEN="$TURSO_TOKEN" SITE_KEY_VAL="$SITE_KEY" node -e "
    const { createClient } = require('@libsql/client');
    const c = createClient({ url: process.env.TURSO_URL, authToken: process.env.TURSO_TOKEN });
    c.execute({
      sql: \"INSERT INTO system_config (key, value, updated_at) VALUES ('turnstile_site_key', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')\",
      args: [process.env.SITE_KEY_VAL]
    }).then(() => console.log('  ✅ Site Key 已写入'));
  " 2>/dev/null || log_warn "写入 system_config 失败（表可能不存在，稍后手动配置）"
else
  log_warn "TURSO_URL 未配置，跳过数据库写入"
fi

# 设置 Worker Secret
log_info "设置 TURNSTILE_SECRET_KEY Worker Secret..."
echo "$SECRET_KEY" | CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN}" npx wrangler secret put TURNSTILE_SECRET_KEY --name "$WORKER_NAME" 2>/dev/null || {
  log_warn "wrangler secret put 失败，将在下次 deploy 时通过 --secrets-file 设置"
}

cred_save "TURNSTILE_SITE_KEY" "$SITE_KEY"
cred_save "TURNSTILE_SECRET_KEY" "$SECRET_KEY"
step_done "05-setup-turnstile"

echo ""
log_ok "✅ Turnstile 配置完成"
echo "  Site Key:   $SITE_KEY"
echo "  Secret Key: ${SECRET_KEY:0:15}..."
