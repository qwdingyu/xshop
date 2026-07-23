#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# 22-cleanup-business-data.sh
#
# 用途：
# - 安全清空 cf-shop 业务数据，保留系统配置与审计能力。
# - 支持 Turso/libSQL 和 D1 双引擎。
# - 提供 preview（只读）和 cleanup（删除）两个子命令。
#
# 环境变量：
# - DATABASE_PROVIDER：数据库引擎 "turso"（默认）或 "d1"
# - TURSO_URL：Turso 数据库 URL（DATABASE_PROVIDER=turso 时必需）
# - TURSO_TOKEN：Turso 认证 Token（DATABASE_PROVIDER=turso 时必需）
# - CLOUDFLARE_API_TOKEN：D1 export 和 secret 写入时必需
# - ESHOP_D1_DATABASE：D1 数据库名，默认 eshop-db
# - ESHOP_WORKER_NAME：Worker 名称，默认 cf-shop
#
# 用法：
#   bash scripts/22-cleanup-business-data.sh preview
#   bash scripts/22-cleanup-business-data.sh cleanup
#   DATABASE_PROVIDER=turso TURSO_URL="..." TURSO_TOKEN="..." bash scripts/22-cleanup-business-data.sh preview
#   DATABASE_PROVIDER=d1 CLOUDFLARE_API_TOKEN="..." bash scripts/22-cleanup-business-data.sh cleanup
#
# 安全边界：
# - preview 模式仅做只读查询，不会修改数据。
# - cleanup 会要求输入当前数据库名称进行二次确认。
# - 所有业务表按外键依赖顺序级联清空，并包裹在单个事务内。
# - 删除后自动验证所有清理表是否为空。
# - 会同步清理 rate_limit_windows / idempotency_keys 等瞬态运行状态，避免清库后被旧幂等响应或限流窗口污染。
# - 不会触碰 system_config / product_categories / api_keys / schema_migrations。
# - 会清除旧 admin_audit_logs，并写回一条 clear_business_data 清理凭证。
# ============================================================

DB_PROVIDER="${DATABASE_PROVIDER:-turso}"
DB_NAME="${ESHOP_D1_DATABASE:-eshop-db}"
WORKER_NAME="${ESHOP_WORKER_NAME:-cf-shop}"
ACTION="${1:-}"
STAMP="$(date +%Y%m%d_%H%M%S)"

case "$DB_PROVIDER" in
  turso|d1)
    ;;
  *)
    echo "❌ DATABASE_PROVIDER 仅支持 turso 或 d1，当前值：${DB_PROVIDER}" >&2
    exit 1
    ;;
esac

# 优先从本地凭证文件读取 Turso 配置，减少环境变量泄漏与手工配置成本
if [[ -f ".credentials/TURSO_URL" ]]; then
  TURSO_URL="$(cat .credentials/TURSO_URL)"
fi
if [[ -f ".credentials/TURSO_TOKEN" ]]; then
  TURSO_TOKEN="$(cat .credentials/TURSO_TOKEN)"
fi

# 待清空的业务/瞬态表（含访问日志、邮件日志、限流窗口、幂等键等）
BUSINESS_TABLES=(
  order_items
  order_events
  referral_events
  balance_transactions
  balance_recharge_orders
  card_logs
  orders
  cards
  user_balances
  voucher_codes
  campaigns
  referral_codes
  coupons
  card_batches
  products
  request_logs
  email_logs
  rate_limit_windows
  idempotency_keys
  admin_audit_logs
)

# 严格按删除顺序定义（先子表、再父表、最后核心表）
DELETE_ORDER=(
  order_items
  order_events
  referral_events
  balance_transactions
  balance_recharge_orders
  card_logs
  orders
  cards
  user_balances
  voucher_codes
  campaigns
  referral_codes
  coupons
  card_batches
  products
  request_logs
  email_logs
  rate_limit_windows
  idempotency_keys
  admin_audit_logs
)

# 明确保留的表（脚本不会清空）
RESERVED_TABLES=(
  system_config
  product_categories
  api_keys
  schema_migrations
)

KNOWN_TABLES=(
  "${BUSINESS_TABLES[@]}"
  "${RESERVED_TABLES[@]}"
)

is_known_table() {
  local table="$1"
  for known in "${KNOWN_TABLES[@]}"; do
    if [[ "$known" == "$table" ]]; then
      return 0
    fi
  done
  return 1
}

validate_table_name() {
  local table="$1"
  if [[ ! "$table" =~ ^[a-z_][a-z0-9_]*$ ]] || ! is_known_table "$table"; then
    error "非法或未知表名：${table}"
    exit 1
  fi
}

require_cloudflare_token() {
  if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
    echo "❌ 缺少 CLOUDFLARE_API_TOKEN" >&2
    exit 1
  fi
}

require_turso_vars() {
  if [[ -z "${TURSO_URL:-}" ]]; then
    echo "❌ DATABASE_PROVIDER=turso 但缺少 TURSO_URL" >&2
    exit 1
  fi
  if [[ -z "${TURSO_TOKEN:-}" ]]; then
    echo "❌ DATABASE_PROVIDER=turso 但缺少 TURSO_TOKEN" >&2
    exit 1
  fi
}

info() {
  echo "ℹ️  $*"
}

warn() {
  echo "⚠️  $*" >&2
}

error() {
  echo "❌ $*" >&2
}

# 执行单条 SQL（通过临时文件传递，避免参数注入）
execute_sql() {
  local sql="$1"
  local tmp
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' RETURN
  printf '%s\n' "$sql" > "$tmp"

  if [[ "$DB_PROVIDER" == "turso" ]]; then
    require_turso_vars
    TURSO_URL="$TURSO_URL" TURSO_TOKEN="$TURSO_TOKEN" node scripts/turso-exec.mjs execute "$(cat "$tmp")"
  else
    require_cloudflare_token
    npx wrangler d1 execute "$DB_NAME" \
      --remote \
      --yes \
      --command="$(cat "$tmp")"
  fi

  rm -f "$tmp"
  trap - RETURN
}

# 在单个数据库 session 中执行多条 SQL（保证事务原子性）
execute_sql_transaction() {
  local tmp
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' RETURN
  printf '%s\n' "$@" > "$tmp"

  if [[ "$DB_PROVIDER" == "turso" ]]; then
    require_turso_vars
    # Turso/libSQL HTTP 接口不支持跨多条 execute 调用的显式事务；
    # 这里改为使用单次 batch 执行全部删除，依赖 @libsql/client 的原子 batch 语义。
    TURSO_URL="$TURSO_URL" TURSO_TOKEN="$TURSO_TOKEN" node scripts/turso-exec.mjs batch "$(cat "$tmp")"
  else
    require_cloudflare_token
    local combined
    combined="$(cat "$tmp" | tr '\n' ' ')"
    npx wrangler d1 execute "$DB_NAME" \
      --remote \
      --yes \
      --command="$combined"
  fi

  rm -f "$tmp"
  trap - RETURN
}

# 查询单表行数
query_count() {
  local table="$1"
  validate_table_name "$table"

  if [[ "$DB_PROVIDER" == "turso" ]]; then
    require_turso_vars
    TURSO_URL="$TURSO_URL" TURSO_TOKEN="$TURSO_TOKEN" node scripts/turso-exec.mjs count "$table"
  else
    require_cloudflare_token
    local sql="SELECT COUNT(*) AS cnt FROM ${table};"
    local tmp
    tmp="$(mktemp)"
    printf '%s\n' "$sql" > "$tmp"
    local count
    count="$(npx wrangler d1 execute "$DB_NAME" \
      --remote \
      --yes \
      --command="$(cat "$tmp")" \
      | awk '/\|/{print $2}' | head -n1)"
    rm -f "$tmp"
    echo "${count:-0}"
  fi
}

preview() {
  info "数据库引擎：${DB_PROVIDER}"
  if [[ "$DB_PROVIDER" == "turso" ]]; then
    info "Turso URL：${TURSO_URL}"
  else
    info "D1 数据库：${DB_NAME}"
  fi
  echo ""

  info "待清空的业务表（共 ${#BUSINESS_TABLES[@]} 张）："
  for table in "${DELETE_ORDER[@]}"; do
    local count
    count="$(query_count "$table")"
    printf "  %-20s %s 行\n" "$table" "$count"
  done
  echo ""

  info "将保留的系统/配置表（共 ${#RESERVED_TABLES[@]} 张）："
  for table in "${RESERVED_TABLES[@]}"; do
    printf "  %s\n" "$table"
  done
  echo ""

  # 检查 product_categories 中是否存在孤立的分类（不再关联任何商品）
  info "检查 product_categories 孤立分类（清理后仍保留）："
  local isolated_count
  if [[ "$DB_PROVIDER" == "turso" ]]; then
    isolated_count="$(TURSO_URL="$TURSO_URL" TURSO_TOKEN="$TURSO_TOKEN" node scripts/turso-exec.mjs scalar "SELECT COUNT(*) AS cnt FROM product_categories WHERE name NOT IN (SELECT DISTINCT category FROM products WHERE trim(category) <> '');")"
  else
    isolated_count="$(execute_sql "SELECT COUNT(*) AS cnt FROM product_categories WHERE name NOT IN (SELECT DISTINCT category FROM products WHERE trim(category) <> '');" | awk '/\|/{print $2}' | head -n1)"
  fi
  echo "  孤立分类数量：${isolated_count:-0}"
  if [[ "${isolated_count:-0}" -gt 0 ]]; then
    warn "清理后将存在 ${isolated_count} 个孤立分类，如需清理请手动处理。"
  fi
  echo ""

  info "确认无误后，执行："
  info "  bash scripts/22-cleanup-business-data.sh cleanup"
}

cleanup() {
  # 二次确认：要求用户输入数据库标识
  local db_label
  if [[ "$DB_PROVIDER" == "turso" ]]; then
    require_turso_vars
    db_label="${TURSO_URL}"
  else
    require_cloudflare_token
    db_label="D1(${DB_NAME})"
  fi

  echo "⚠️  即将清空以下业务表（共 ${#BUSINESS_TABLES[@]} 张）："
  for table in "${DELETE_ORDER[@]}"; do
    echo "  - ${table}"
  done
  echo ""
  echo "⚠️  以下系统/配置表将保留："
  for table in "${RESERVED_TABLES[@]}"; do
    echo "  - ${table}"
  done
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "【二次确认】为防误删，请完整输入当前数据库标识后回车："
  echo "  数据库标识：${db_label}"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  read -r confirm_input
  if [[ "$confirm_input" != "$db_label" ]]; then
    echo "❌ 输入不匹配，已取消操作。"
    exit 1
  fi

  info "开始清空业务数据（单个事务）..."

  # 构建事务 SQL（所有语句在单个 session 中执行，保证原子性）
  local -a transaction_sqls=()
  local audit_id
  local audit_created_at
  audit_id="$(uuidgen 2>/dev/null || date +%s%N)"
  audit_created_at="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  if [[ "$DB_PROVIDER" != "turso" ]]; then
    transaction_sqls+=("BEGIN TRANSACTION;")
  fi
  for table in "${DELETE_ORDER[@]}"; do
    transaction_sqls+=("DELETE FROM ${table};")
  done
  transaction_sqls+=("INSERT INTO admin_audit_logs (id, action, target_type, target_id, metadata_json, ip_hash, created_at) VALUES ('${audit_id}', 'clear_business_data', 'database', 'business_data', '{\"source\":\"scripts/22-cleanup-business-data.sh\",\"reservedTables\":[\"system_config\",\"product_categories\",\"api_keys\",\"schema_migrations\"]}', '', '${audit_created_at}');")
  if [[ "$DB_PROVIDER" != "turso" ]]; then
    transaction_sqls+=("COMMIT;")
  fi

  execute_sql_transaction "${transaction_sqls[@]}"

  info "事务已提交，开始验证..."

  # 验证所有业务表是否为空
  local all_empty=true
  for table in "${DELETE_ORDER[@]}"; do
    local count
    count="$(query_count "$table")"
    if [[ "$table" == "admin_audit_logs" ]]; then
      if [[ "$count" != "1" ]]; then
        warn "表 ${table} 应仅保留 1 条清理凭证，当前仍有 ${count} 行"
        all_empty=false
      fi
      continue
    fi
    if [[ "$count" != "0" ]]; then
      warn "表 ${table} 仍有 ${count} 行数据"
      all_empty=false
    fi
  done

  echo ""
  if $all_empty; then
    echo "✅ 验证通过：业务/瞬态表已清空，旧管理员审计已替换为 1 条清理凭证，系统配置完整保留。"
  else
    echo "❌ 验证失败：部分业务表未清空，请检查错误日志并手动处理。"
    exit 1
  fi
}

case "$ACTION" in
  preview)
    preview
    ;;
  cleanup)
    cleanup
    ;;
  help|-h|--help)
    cat >&2 <<'USAGE'
用法：
  bash scripts/22-cleanup-business-data.sh preview
  bash scripts/22-cleanup-business-data.sh cleanup

引擎切换（通过 DATABASE_PROVIDER 环境变量）：
  DATABASE_PROVIDER=turso （默认）使用 Turso/libSQL 引擎（需同时设置 TURSO_URL 和 TURSO_TOKEN）
  DATABASE_PROVIDER=d1    使用 D1 引擎（需设置 CLOUDFLARE_API_TOKEN）

示例：
  TURSO_URL="<url>" TURSO_TOKEN="<token>" bash scripts/22-cleanup-business-data.sh preview
  DATABASE_PROVIDER=d1 CLOUDFLARE_API_TOKEN="<token>" bash scripts/22-cleanup-business-data.sh cleanup
USAGE
    exit 0
    ;;
  *)
    error "未知子命令：${ACTION}"
    echo "" >&2
    cat >&2 <<'USAGE'
用法：
  bash scripts/22-cleanup-business-data.sh preview
  bash scripts/22-cleanup-business-data.sh cleanup
USAGE
    exit 1
    ;;
esac
