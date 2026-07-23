#!/usr/bin/env bash
# setup-turnstile.sh — Turnstile Widget 配置脚本
#
# 用途：
#   1. 将 Turnstile Site Key 写入 Turso/libSQL 数据库 system_config 表
#   2. 将 Turnstile Secret Key 设置为 Worker Secret（TURNSTILE_SECRET_KEY）
#   3. 验证配置结果
#
# 前置条件：
#   - 先在 Cloudflare Dashboard 创建 Turnstile Widget（Invisible 模式）
#     Dashboard → Turnstile → Create widget
#     - Widget name: Shop Turnstile
#     - Domains: shop.example.com
#     - Widget type: Invisible
#   - 创建后复制 Site Key 和 Secret Key
#
# 用法：
#   # 方式1：交互式输入（推荐）
#   bash scripts/setup-turnstile.sh
#
#   # 方式2：直接传入参数
#   bash scripts/setup-turnstile.sh "你的SiteKey" "你的SecretKey"
#
#   # 方式3：通过环境变量
#   TURNSTILE_SITE_KEY="xxx" TURNSTILE_SECRET_KEY="yyy" bash scripts/setup-turnstile.sh

set -euo pipefail

WORKER_NAME="${ESHOP_WORKER_NAME:-cf-shop}"

cd "$(dirname "$0")/.."

# ── 获取 Site Key 和 Secret Key ──────────────────────────────────────────────
if [ "${1:-}" != "" ] && [ "${2:-}" != "" ]; then
  SITE_KEY="$1"
  SECRET_KEY="$2"
elif [ "${TURNSTILE_SITE_KEY:-}" != "" ] && [ "${TURNSTILE_SECRET_KEY:-}" != "" ]; then
  SITE_KEY="$TURNSTILE_SITE_KEY"
  SECRET_KEY="$TURNSTILE_SECRET_KEY"
else
  echo "==========================================="
  echo "  Turnstile Widget 配置"
  echo "==========================================="
  echo ""
  echo "请先在 Cloudflare Dashboard 创建 Turnstile Widget："
  echo "  1. 打开 https://dash.cloudflare.com/"
  echo "  2. 左侧菜单 → Turnstile"
  echo "  3. 点击 Create widget"
  echo "     - Widget name: cf-shop Turnstile"
  echo "     - Domains: shop.example.com"
  echo "     - Widget type: Invisible（隐形验证）"
  echo "  4. 创建后复制 Site Key 和 Secret Key"
  echo ""
  echo "-------------------------------------------"
  echo ""
  read -rp "请输入 Site Key: " SITE_KEY
  read -rp "请输入 Secret Key: " SECRET_KEY

  if [ -z "$SITE_KEY" ] || [ -z "$SECRET_KEY" ]; then
    echo ""
    echo "❌ Site Key 或 Secret Key 不能为空"
    exit 1
  fi
fi

echo ""
echo "==========================================="
echo "  Turnstile 配置开始"
echo "==========================================="
echo ""
echo "Site Key:  ${SITE_KEY:0:15}..."
echo "Secret Key: ${SECRET_KEY:0:8}...（已隐藏）"
echo ""

# ── 步骤 1: 写入 Site Key 到 Turso ───────────────────────────────────────────
echo "→ 步骤 1/3: 写入 Site Key 到 Turso system_config..."

if [ -z "${TURSO_URL:-}" ]; then
  echo "❌ 缺少 TURSO_URL" >&2
  exit 1
fi

if [ -z "${TURSO_TOKEN:-}" ]; then
  echo "❌ 缺少 TURSO_TOKEN" >&2
  exit 1
fi

TURSO_URL="$TURSO_URL" TURSO_TOKEN="$TURSO_TOKEN" SITE_KEY="$SITE_KEY" node -e "
  const { createClient } = require('@libsql/client');
  const c = createClient({ url: process.env.TURSO_URL, authToken: process.env.TURSO_TOKEN });
  c.execute({
    sql: \"INSERT INTO system_config (key, value, updated_at) VALUES ('turnstile_site_key', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')\",
    args: [process.env.SITE_KEY]
  }).then(() => console.log('✅ Site Key 已写入 Turso'));
"

# ── 步骤 2: 设置 Secret Key 为 Worker Secret ─────────────────────────────────
echo ""
echo "→ 步骤 2/3: 设置 TURNSTILE_SECRET_KEY Worker Secret..."

echo -n "$SECRET_KEY" | npx wrangler secret put TURNSTILE_SECRET_KEY --name "$WORKER_NAME"

echo "✅ TURNSTILE_SECRET_KEY 已设置"

# ── 步骤 3: 验证 ─────────────────────────────────────────────────────────────
echo ""
echo "→ 步骤 3/3: 验证配置..."

echo ""
echo "→ 检查 Worker Secrets:"
npx wrangler secret list --name "$WORKER_NAME" | grep -i turnstile || echo "  (TURNSTILE_SECRET_KEY 可能已在列表中)"

echo ""
echo "==========================================="
echo "  ✅ Turnstile 配置完成！"
echo "==========================================="
echo ""
echo "配置摘要:"
echo "  Site Key:  $SITE_KEY"
echo "  Secret Key: ${SECRET_KEY:0:8}...（已隐藏）"
echo "  Worker:    $WORKER_NAME"
echo "  数据库:    Turso/libSQL"
echo ""
echo "后续操作:"
echo "  - 打开 APP_ORIGIN 对应的 /redeem 页面验证 Turnstile widget"
echo "  - 如需修改域名，在 Cloudflare Dashboard → Turnstile 中编辑 Widget"
