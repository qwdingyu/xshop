#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# 04-bind-domain.sh — 域名绑定 + DNS + SSL
#
# 功能：
#   1. Workers 模式：通过 Workers Custom Domain API 绑定域名
#   2. Pages 模式：添加 Pages 自定义域名 + 创建 Zone DNS CNAME 记录
#   3. 自动推导 Account ID / Zone ID
#   4. 等待 HTTPS 证书签发
#
# 输入：
#   CLOUDFLARE_API_TOKEN  — 必填（Pages/Workers 部署用）
#   DOMAIN                — 要绑定的域名（如 shop.example.com）
#   WORKER_NAME           — Worker/Pages 项目名称（默认从 .credentials 读取）
#
# CLOUDFLARE_API_TOKEN 需要 Workers/Pages 权限，以及目标 Zone 的 DNS Read/Edit。
# ═══════════════════════════════════════════════════════════════════════════════
source "$(dirname "$0")/shared.sh"

# ── 独立运行时的前置检查 ──────────────────────────────────────────────────────
FAIL=0
check_env CLOUDFLARE_API_TOKEN "从 https://dash.cloudflare.com/profile/api-tokens 获取" || FAIL=1
[ "$FAIL" -eq 1 ] && exit 1

WORKER_NAME=$(cred_load "WORKER_NAME" 2>/dev/null || echo "")
DOMAIN="${DOMAIN:-}"

if [ -z "$DOMAIN" ]; then
  echo "用法: DOMAIN=\"shop.example.com\" bash 04-bind-domain.sh"
  echo ""
  echo "请输入要绑定的域名:"
  read -rp "域名: " DOMAIN
fi

if [ -z "$DOMAIN" ]; then
  log_error "域名不能为空"
  exit 1
fi

if [ -z "$WORKER_NAME" ]; then
  log_error "WORKER_NAME 未找到，请先运行 03-deploy-worker.sh"
  exit 1
fi

banner "域名绑定: $DOMAIN → $WORKER_NAME"

if step_check "04-bind-domain-${DOMAIN}"; then
  log_ok "已完成，跳过"
  exit 0
fi

# ── Step 1: 获取 Account ID ──────────────────────────────────────────────────
log_step "Step 1/5: 获取 Cloudflare Account ID"
ACCOUNT_ID=$(cf_get_account_id)

# ── Step 2: 推导 Zone ID ─────────────────────────────────────────────────────
log_step "Step 2/5: 推导 Zone ID"

# 从域名提取 zone name（取最后两段）
ZONE_NAME=$(echo "$DOMAIN" | awk -F. '{print $(NF-1)"."$NF}')
log_info "Zone name: $ZONE_NAME"

ZONE_RESP=$(cf_api GET "/zones?name=${ZONE_NAME}")
ZONE_ID=$(echo "$ZONE_RESP" | jq -r '.result[0].id // empty')

if [ -z "$ZONE_ID" ]; then
  log_error "未找到 Zone: $ZONE_NAME"
  log_info "请确认域名 $DOMAIN 已托管在 Cloudflare"
  exit 1
fi
log_ok "Zone ID: $ZONE_ID"

# ── Step 3: 验证 DNS 权限 ────────────────────────────────────────────────────
log_step "Step 3/5: 验证 DNS 权限"

if cf_check_dns_auth "$ZONE_ID"; then
  log_ok "DNS 权限验证通过（使用 API Token）"
else
  log_error "DNS 权限验证失败！"
  log_error "当前凭证无法管理 Zone '$ZONE_NAME' 的 DNS 记录"
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  解决方案：为 CLOUDFLARE_API_TOKEN 增加目标 Zone 的 DNS Read/Edit 权限"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  echo "  打开 https://dash.cloudflare.com/profile/api-tokens 创建最小权限 API Token"
  echo ""
  exit 1
fi

# ── Step 4: 根据部署模式绑定域名 ─────────────────────────────────────────────
MODE=$(detect_deploy_mode)
DNS_NAME=$(echo "$DOMAIN" | sed "s/\\.${ZONE_NAME}$//")

if [ "$MODE" = "pages" ]; then
  # ── Pages 模式 ──
  log_step "Step 4/5: 绑定 Pages 自定义域名 + 创建 DNS 记录"

  # 4a. 添加域名到 Pages 项目
  PAGES_DOMAINS=$(cf_api GET "/accounts/${ACCOUNT_ID}/pages/projects/${WORKER_NAME}/domains" 2>/dev/null || echo '{"result":[]}')
  PAGES_DOMAIN_ID=$(echo "$PAGES_DOMAINS" | jq -r ".result[] | select(.name==\"${DOMAIN}\") | .id" 2>/dev/null)

  if [ -n "$PAGES_DOMAIN_ID" ] && [ "$PAGES_DOMAIN_ID" != "null" ]; then
    log_ok "Pages 域名已注册 ($PAGES_DOMAIN_ID)"
  else
    log_info "添加域名到 Pages 项目..."
    ADD_RESP=$(cf_api POST "/accounts/${ACCOUNT_ID}/pages/projects/${WORKER_NAME}/domains" \
      "{\"name\":\"${DOMAIN}\"}")
    PAGES_DOMAIN_ID=$(echo "$ADD_RESP" | jq -r '.result.id // empty')
    if [ -z "$PAGES_DOMAIN_ID" ]; then
      log_error "添加 Pages 域名失败: $(echo "$ADD_RESP" | jq -r '.errors[0].message // "unknown"')"
      exit 1
    fi
    log_ok "Pages 域名注册成功: $PAGES_DOMAIN_ID"
  fi

  # 4b. 创建 Zone DNS CNAME 记录（指向 <project>.pages.dev）
  PAGES_SUBDOMAIN="${WORKER_NAME}.pages.dev"
  log_info "检查 DNS CNAME 记录: ${DNS_NAME}.${ZONE_NAME} → ${PAGES_SUBDOMAIN}"

  # 检查是否已有 CNAME 记录（使用 cf_dns_api，不是 cf_api！）
  EXISTING_DNS=$(cf_dns_api GET "/zones/${ZONE_ID}/dns_records?type=CNAME&name=${DOMAIN}")
  EXISTING_DNS_ID=$(echo "$EXISTING_DNS" | jq -r '.result[0].id // empty' 2>/dev/null)

  if [ -n "$EXISTING_DNS_ID" ]; then
    EXISTING_CONTENT=$(echo "$EXISTING_DNS" | jq -r '.result[0].content // empty')
    if [ "$EXISTING_CONTENT" = "$PAGES_SUBDOMAIN" ]; then
      log_ok "DNS CNAME 记录已存在且正确: ${DOMAIN} → ${PAGES_SUBDOMAIN}"
    else
      log_info "更新现有 CNAME 记录..."
      cf_dns_api PUT "/zones/${ZONE_ID}/dns_records/${EXISTING_DNS_ID}" \
        "{\"type\":\"CNAME\",\"name\":\"${DNS_NAME}\",\"content\":\"${PAGES_SUBDOMAIN}\",\"proxied\":false,\"ttl\":1}" > /dev/null
      log_ok "DNS CNAME 记录已更新"
    fi
  else
    # 检查是否有冲突的 A/AAAA 记录，如有则删除
    CONFLICT_A=$(cf_dns_api GET "/zones/${ZONE_ID}/dns_records?type=A&name=${DOMAIN}" 2>/dev/null || echo '{"result":[]}')
    CONFLICT_A_ID=$(echo "$CONFLICT_A" | jq -r '.result[0].id // empty' 2>/dev/null)
    if [ -n "$CONFLICT_A_ID" ]; then
      log_info "删除冲突的 A 记录..."
      cf_dns_api DELETE "/zones/${ZONE_ID}/dns_records/${CONFLICT_A_ID}" > /dev/null 2>&1
    fi

    log_info "创建 DNS CNAME 记录: ${DNS_NAME} → ${PAGES_SUBDOMAIN} (DNS only)"
    DNS_CREATE_RESP=$(cf_dns_api POST "/zones/${ZONE_ID}/dns_records" \
      "{\"type\":\"CNAME\",\"name\":\"${DNS_NAME}\",\"content\":\"${PAGES_SUBDOMAIN}\",\"proxied\":false,\"ttl\":1}")
    DNS_RECORD_ID=$(echo "$DNS_CREATE_RESP" | jq -r '.result.id // empty')
    if [ -z "$DNS_RECORD_ID" ]; then
      log_error "创建 DNS 记录失败: $(echo "$DNS_CREATE_RESP" | jq -r '.errors[0].message // "unknown"')"
      exit 1
    fi
    log_ok "DNS CNAME 记录创建成功: $DNS_RECORD_ID"
  fi

  log_ok "Pages 域名绑定完成: $DOMAIN → $WORKER_NAME"

else
  # ── Workers 模式 ──
  log_step "Step 4/5: 绑定 Workers Custom Domain"

  # 检查是否已绑定
  EXISTING=$(cf_api GET "/accounts/${ACCOUNT_ID}/workers/domains" 2>/dev/null || echo '{"result":[]}')
  EXISTING_ID=$(echo "$EXISTING" | jq -r ".result[] | select(.hostname==\"${DOMAIN}\") | .id" 2>/dev/null)

  if [ -n "$EXISTING_ID" ] && [ "$EXISTING_ID" != "null" ]; then
    log_ok "域名已绑定 ($EXISTING_ID)，更新绑定..."
    cf_api PUT "/accounts/${ACCOUNT_ID}/workers/domains/${EXISTING_ID}" \
      "{\"service\":\"${WORKER_NAME}\",\"environment\":\"production\"}" > /dev/null
  else
    log_info "创建新绑定..."
    BIND_RESP=$(cf_api POST "/accounts/${ACCOUNT_ID}/workers/domains" \
      "{\"service\":\"${WORKER_NAME}\",\"hostname\":\"${DOMAIN}\",\"zone_id\":\"${ZONE_ID}\",\"environment\":\"production\"}")
    BIND_ID=$(echo "$BIND_RESP" | jq -r '.result.id // empty')
    if [ -z "$BIND_ID" ]; then
      log_error "Workers 域名绑定失败: $(echo "$BIND_RESP" | jq -r '.errors[0].message // "unknown"')"
      exit 1
    fi
  fi
  log_ok "Workers 域名绑定成功: $DOMAIN → $WORKER_NAME"
fi

# ── Step 5: 等待 HTTPS 可用 ──────────────────────────────────────────────────
log_step "Step 5/5: 等待 HTTPS 证书签发 + DNS 传播"

# 根据部署模式选择健康检查路径
if [ "$MODE" = "pages" ]; then
  HEALTH_PATH="/"
else
  HEALTH_PATH="/api/health"
fi

log_info "轮询 https://${DOMAIN}${HEALTH_PATH} ..."
HTTPS_OK=0
for i in $(seq 1 36); do
  STATUS=$(curl -sS -o /dev/null -w "%{http_code}" "https://${DOMAIN}${HEALTH_PATH}" 2>/dev/null || echo "000")
  if [ "$STATUS" = "200" ] || [ "$STATUS" = "301" ] || [ "$STATUS" = "302" ] || [ "$STATUS" = "304" ]; then
    log_ok "HTTPS 已就绪 (HTTP $STATUS, 第 ${i} 次检查)"
    HTTPS_OK=1
    break
  fi
  if [ "$STATUS" = "502" ] || [ "$STATUS" = "503" ] || [ "$STATUS" = "521" ] || [ "$STATUS" = "522" ] || [ "$STATUS" = "000" ]; then
    echo -n "  ⏳ 第 ${i}/36 次: HTTP $STATUS (等待 DNS/SSL), 5s..."
    sleep 5
    echo ""
  else
    # 其他状态码（如 403/404）说明 DNS+SSL 已就绪，只是路径问题
    log_ok "DNS + SSL 已就绪 (HTTP $STATUS, 第 ${i} 次检查)"
    HTTPS_OK=1
    break
  fi
done

if [ "$HTTPS_OK" -eq 0 ]; then
  log_warn "HTTPS 在 180 秒内未就绪，DNS/SSL 可能需要更长时间传播"
  log_info "请稍后验证: curl -I https://${DOMAIN}/"
fi

cred_save "DOMAIN" "$DOMAIN"
cred_save "BASE_URL" "https://${DOMAIN}"
step_done "04-bind-domain-${DOMAIN}"

echo ""
log_ok "✅ 域名绑定完成"
echo "  URL: https://${DOMAIN}"
[ "$MODE" != "pages" ] && echo "  Admin: https://${DOMAIN}/admin"
echo ""
log_info "验证: curl -I https://${DOMAIN}/"
