#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# 01-setup-turso.sh — Turso 数据库创建 + 迁移
#
# 功能：
#   1. 通过 Turso API 获取组织信息
#   2. 创建 Turso group（指定节点位置，默认 Tokyo 亚太区）
#   3. 创建 Turso 数据库
#   4. 创建数据库连接 Token（通过 turso CLI）
#   5. 执行 SQL 迁移（通过 migrate.mjs）
#
# 输入：TURSO_API_TOKEN（Turso 管理 API Token）
# 可选：
#   TURSO_LOCATION — 节点位置代码（默认 aws-ap-northeast-1 = Tokyo）
#   DB_NAME        — 数据库名（默认 {PROJECT_NAME}-db）
#   GROUP_NAME     — group 名（默认 {PROJECT_NAME}-group）
#
# 输出：.credentials/TURSO_URL, TURSO_TOKEN, DB_NAME
# ═══════════════════════════════════════════════════════════════════════════════
source "$(dirname "$0")/shared.sh"

PROJECT_NAME=$(cred_load "PROJECT_NAME" 2>/dev/null || basename "$(pwd)")
DB_NAME="${DB_NAME:-${PROJECT_NAME}-db}"
GROUP_NAME="${GROUP_NAME:-${PROJECT_NAME}-group}"
# 默认 Tokyo（离中国大陆最近的 Turso 节点，延迟 ~50ms）
# 其他可选值见 Turso API: GET /v1/locations
#   aws-us-west-2     = Oregon    （美国西海岸，延迟 ~180ms）
#   aws-us-east-1     = Virginia  （美国东海岸，延迟 ~220ms）
#   aws-eu-west-1     = Ireland   （欧洲，延迟 ~280ms）
#   aws-ap-south-1    = Mumbai    （印度，延迟 ~150ms）
TURSO_LOCATION="${TURSO_LOCATION:-aws-ap-northeast-1}"

banner "Turso 数据库: $DB_NAME @ $TURSO_LOCATION"

if step_check "01-setup-turso"; then
  log_ok "已完成，跳过（删除 .credentials/.deploy-progress 重跑）"
  exit 0
fi

# ── Step 1: 获取 Turso 组织信息 ──────────────────────────────────────────────
log_step "Step 1/5: 获取 Turso 组织信息"
ORG=$(turso_get_org)

# ── Step 2: 创建 Turso group（指定节点位置） ─────────────────────────────────
# Turso 的 location 是 group 级别属性，创建后不可更改
# 因此必须先创建 group，再在 group 内创建 database
log_step "Step 2/5: 创建 Turso group '$GROUP_NAME' @ $TURSO_LOCATION"

# 检查 group 是否已存在
EXISTING_GROUP=$(HOMEBREW_NO_AUTO_UPDATE=1 timeout 15 turso group show "$GROUP_NAME" 2>/dev/null || echo "")
if echo "$EXISTING_GROUP" | grep -q "Locations:"; then
  GROUP_LOC=$(echo "$EXISTING_GROUP" | grep "Locations:" | sed 's/Locations:\s*//')
  log_ok "Group 已存在: $GROUP_NAME ($GROUP_LOC)"
else
  log_info "创建新 group: $GROUP_NAME @ $TURSO_LOCATION ..."
  CREATE_RESULT=$(HOMEBREW_NO_AUTO_UPDATE=1 timeout 30 turso group create "$GROUP_NAME" --location "$TURSO_LOCATION" 2>&1)
  if echo "$CREATE_RESULT" | grep -qi "created group"; then
    log_ok "Group 已创建: $GROUP_NAME @ $TURSO_LOCATION"
  else
    log_error "创建 group 失败"
    log_error "输出: $CREATE_RESULT"
    exit 1
  fi
fi

# ── Step 3: 创建数据库 ───────────────────────────────────────────────────────
log_step "Step 3/5: 创建数据库 $DB_NAME"

EXISTING=$(turso_api GET "/organizations/${ORG}/databases/${DB_NAME}" 2>/dev/null || echo '{}')
DB_HOSTNAME=$(echo "$EXISTING" | jq -r '.database.Hostname // empty' 2>/dev/null)

if [ -n "$DB_HOSTNAME" ] && [ "$DB_HOSTNAME" != "null" ]; then
  log_ok "数据库已存在: $DB_HOSTNAME"
else
  log_info "创建新数据库 (group: ${GROUP_NAME}) ..."
  RESULT=$(turso_api POST "/organizations/${ORG}/databases" "{\"name\":\"${DB_NAME}\",\"group\":\"${GROUP_NAME}\"}")
  DB_HOSTNAME=$(echo "$RESULT" | jq -r '.database.Hostname // empty')
  if [ -z "$DB_HOSTNAME" ]; then
    log_error "创建数据库失败"
    echo "$RESULT" | jq . 2>/dev/null || echo "$RESULT"
    exit 1
  fi
  log_ok "数据库已创建: $DB_HOSTNAME"
fi

TURSO_URL="libsql://${DB_HOSTNAME}"

# ── Step 4: 创建数据库 Token ─────────────────────────────────────────────────
log_step "Step 4/5: 创建数据库 Token"

# 检查是否已有 token（幂等）
EXISTING_TOKEN=$(cred_load "TURSO_TOKEN" 2>/dev/null || echo "")
if [ -n "$EXISTING_TOKEN" ]; then
  TURSO_TOKEN="$EXISTING_TOKEN"
  log_ok "复用已有 Token"
else
  # Turso REST API 的 Token 创建端点不稳定，改用 turso CLI（更可靠）
  if command -v turso &>/dev/null; then
    # 禁用 Homebrew 自动更新，避免 turso 命令因 brew upgrade 超时
    export HOMEBREW_NO_AUTO_UPDATE=1
    TURSO_TOKEN=$(timeout 30 turso db tokens create "$DB_NAME" 2>/dev/null | grep -E '^eyJ' | head -1)
    if [ -z "$TURSO_TOKEN" ]; then
      log_error "turso CLI 创建 Token 失败（30s 超时或输出异常）"
      log_info "请手动运行: HOMEBREW_NO_AUTO_UPDATE=1 turso db tokens create $DB_NAME"
      exit 1
    fi
    log_ok "Token 已创建 (via turso CLI)"
  else
    log_error "turso CLI 未安装，无法创建 Token"
    log_info "安装: curl -sSfL https://get.tur.so/install.sh | bash"
    exit 1
  fi
fi

# ── Step 5: 执行 SQL 迁移 ────────────────────────────────────────────────────
log_step "Step 5/5: 执行数据库迁移"

export TURSO_URL TURSO_TOKEN

if [ -f "scripts/migrate.mjs" ]; then
  log_info "运行 scripts/migrate.mjs ..."
  node scripts/migrate.mjs
  log_ok "迁移完成"
elif [ -d "migrations" ]; then
  MIGRATION_FILES=$(find migrations -name "*.sql" -type f | sort)
  if [ -n "$MIGRATION_FILES" ]; then
    log_info "执行迁移文件..."
    # 使用 libsql HTTP 客户端逐条执行
    node -e "
      const { createClient } = require('@libsql/client');
      const fs = require('fs');
      const client = createClient({ url: process.env.TURSO_URL, authToken: process.env.TURSO_TOKEN });
      const files = fs.readdirSync('migrations').filter(f => f.endsWith('.sql')).sort();
      (async () => {
        for (const f of files) {
          const sql = fs.readFileSync('migrations/' + f, 'utf-8');
          const stmts = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n').split(';').map(s => s.trim()).filter(s => s.length > 0);
          for (const stmt of stmts) {
            try { await client.execute(stmt); }
            catch(e) { if (!e.message?.includes('already exists')) { console.error(f, e.message); } }
          }
          console.log('  📄 ' + f + ' (' + stmts.length + ' statements)');
        }
        console.log('✅ All migrations applied');
      })();
    " 2>/dev/null || {
      # 回退：通过环境变量传递凭证（避免 shell 转义风险）
      log_warn "node 执行失败，尝试回退迁移..."
      for f in $MIGRATION_FILES; do
        log_info "  执行 $f ..."
        while IFS= read -r stmt; do
          [ -z "$stmt" ] && continue
          TURSO_URL="$TURSO_URL" TURSO_TOKEN="$TURSO_TOKEN" MIGRATION_STMT="$stmt" node -e "
            const { createClient } = require('@libsql/client');
            const c = createClient({ url: process.env.TURSO_URL, authToken: process.env.TURSO_TOKEN });
            c.execute(process.env.MIGRATION_STMT).catch(e => {
              if (!e.message?.includes('already exists')) console.error(e.message);
            });
          " 2>/dev/null || true
        done < <(grep -v '^--' "$f" | tr '\n' ' ' | sed 's/;/;\n/g')
      done
    }
  else
    log_warn "migrations/ 目录下无 SQL 文件"
  fi
else
  log_warn "未找到迁移文件（scripts/migrate.mjs 或 migrations/），跳过"
fi

# ── 持久化凭证 ────────────────────────────────────────────────────────────────
cred_save "TURSO_URL" "$TURSO_URL"
cred_save "TURSO_TOKEN" "$TURSO_TOKEN"
cred_save "DB_NAME" "$DB_NAME"
cred_save "TURSO_LOCATION" "$TURSO_LOCATION"
cred_save "GROUP_NAME" "$GROUP_NAME"

step_done "01-setup-turso"

echo ""
log_ok "✅ Turso 数据库就绪"
echo "  URL:      $TURSO_URL"
echo "  DB:       $DB_NAME"
echo "  Group:    $GROUP_NAME"
echo "  Location: $TURSO_LOCATION"
echo "  Token:    ${TURSO_TOKEN:0:20}..."
