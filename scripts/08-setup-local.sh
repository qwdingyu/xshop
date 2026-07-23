#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# eshop 本地一键部署脚本
#
# 用途：
#   从裸仓库到完整部署到 Cloudflare Workers + Turso/libSQL，全程自动化。
#   包含：安装依赖 → 前端构建 → 结构检查 → Turso 迁移 → 部署 → 域名绑定 → smoke
#
# 环境变量：
#   - CLOUDFLARE_API_TOKEN — 必须，Cloudflare API Token
#   - TURSO_URL             — 必须，Turso 数据库 URL
#   - TURSO_TOKEN           — 必须，Turso 认证 Token
#   - ADMIN_TOKEN          — 可选，管理后台 Token（不设置则自动生成）
#   - ESHOP_WORKER_NAME    — 可选，默认 cf-shop
#   - ESHOP_D1_DATABASE    — 可选，仅 DATABASE_PROVIDER=d1 时使用
#   - APP_ORIGIN          — 必须，实际可访问的 HTTPS 根地址
#   - ESHOP_CUSTOM_DOMAIN  — 可选；绑定域名时默认从 APP_ORIGIN 提取
#   - ESHOP_SEED_REMOTE    — 可选，默认 true（首次部署）/ false（后续部署）
#   - ESHOP_BIND_DOMAIN    — 可选，设为 true 则绑定自定义域名
#
# 使用：
#   # 首次完整部署
#   CLOUDFLARE_API_TOKEN="xxx" bash scripts/08-setup-local.sh
#
#   # 后续部署（不重复 seed，绑定域名）
#   CLOUDFLARE_API_TOKEN="xxx" ESHOP_SEED_REMOTE=false ESHOP_BIND_DOMAIN=true bash scripts/08-setup-local.sh
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

echo "=========================================="
echo "  eshop 本地一键部署"
echo "=========================================="
echo ""

# ── 检查前置条件 ─────────────────────────────────────────────────────────────
echo "── 检查前置条件 ──"

check_cmd() {
  if command -v "$1" &>/dev/null; then
    echo "  ✅ $1 ($( "$1" --version 2>&1 | head -1 ))"
  else
    echo "  ❌ $1 未安装"
    return 1
  fi
}

FAIL=0
check_cmd node || FAIL=1
check_cmd npm || FAIL=1

if ! npx --version &>/dev/null; then
  echo "  ❌ npx 不可用"
  FAIL=1
fi

if [ "$FAIL" -eq 1 ]; then
  echo ""
  echo "❌ 前置条件不满足，请先安装缺失的工具"
  exit 1
fi

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo ""
  echo "❌ 缺少 CLOUDFLARE_API_TOKEN"
  echo "用法: CLOUDFLARE_API_TOKEN=\"<token>\" bash scripts/08-setup-local.sh"
  exit 1
fi

echo "  ✅ CLOUDFLARE_API_TOKEN 已设置"

if [ -z "${TURSO_URL:-}" ]; then
  echo ""
  echo "❌ 缺少 TURSO_URL"
  echo "用法: CLOUDFLARE_API_TOKEN=\"<token>\" TURSO_URL=\"libsql://xxx.turso.io\" TURSO_TOKEN=\"<token>\" bash scripts/08-setup-local.sh"
  exit 1
fi

if [ -z "${TURSO_TOKEN:-}" ]; then
  echo ""
  echo "❌ 缺少 TURSO_TOKEN"
  echo "用法: CLOUDFLARE_API_TOKEN=\"<token>\" TURSO_URL=\"libsql://xxx.turso.io\" TURSO_TOKEN=\"<token>\" bash scripts/08-setup-local.sh"
  exit 1
fi

echo "  ✅ TURSO_URL 已设置"

# ── 生成或读取 ADMIN_TOKEN ───────────────────────────────────────────────────
if [ -z "${ADMIN_TOKEN:-}" ]; then
  ADMIN_TOKEN="eshop-$(openssl rand -hex 16)"
  mkdir -p .credentials
  chmod 700 .credentials
  printf '%s' "$ADMIN_TOKEN" > .credentials/ADMIN_TOKEN
  chmod 600 .credentials/ADMIN_TOKEN
  echo ""
  echo "未设置 ADMIN_TOKEN，已生成并保存到 .credentials/ADMIN_TOKEN"
fi

export ADMIN_TOKEN

# ── 安装依赖 ─────────────────────────────────────────────────────────────────
echo ""
echo "── 安装依赖 ──"

if [ ! -d "node_modules" ]; then
  echo "  → npm run deps:ci（跳过 Playwright 浏览器下载）..."
  npm run deps:ci
  echo "  ✅ 依赖安装完成"
else
  echo "  ⊘ node_modules 已存在，跳过安装"
fi

# ── 结构检查 ─────────────────────────────────────────────────────────────────
echo ""
echo "── 前端构建与结构检查 ──"
npm run frontend:build
npm run check
echo "  ✅ 结构检查通过"

# ── 完整部署（deploy-full.mjs 内部会设置 secrets）─────────────────────────────
echo ""
echo "── 完整部署 ──"

export ESHOP_WORKER_NAME="${ESHOP_WORKER_NAME:-cf-shop}"
export ESHOP_D1_DATABASE="${ESHOP_D1_DATABASE:-eshop-db}"
export ESHOP_SEED_REMOTE="${ESHOP_SEED_REMOTE:-true}"
export ESHOP_BIND_DOMAIN="${ESHOP_BIND_DOMAIN:-false}"
export DATABASE_PROVIDER="${DATABASE_PROVIDER:-turso}"
export RESET_TURSO="${RESET_TURSO:-true}"

if [ -z "${APP_ORIGIN:-}" ]; then
  echo "缺少 APP_ORIGIN；请传入实际部署根地址，脚本不会猜测 Cloudflare 账户子域" >&2
  exit 1
fi
node -e 'const u = new URL(process.env.APP_ORIGIN); if (u.protocol !== "https:" || u.pathname !== "/") throw new Error("APP_ORIGIN 必须是 HTTPS 根地址")'
export BASE_URL="$APP_ORIGIN"
export ESHOP_CUSTOM_DOMAIN="${ESHOP_CUSTOM_DOMAIN:-$(node -e 'process.stdout.write(new URL(process.env.APP_ORIGIN).hostname)')}"

echo "  配置:"
echo "    Worker:     $ESHOP_WORKER_NAME"
echo "    Database:   $DATABASE_PROVIDER"
echo "    Domain:     $ESHOP_CUSTOM_DOMAIN"
echo "    Seed:       $ESHOP_SEED_REMOTE"
echo "    BindDomain: $ESHOP_BIND_DOMAIN"
echo "    ResetTurso: $RESET_TURSO"
echo ""

node scripts/02-deploy-full.mjs

# ── 配置 GitHub Actions（如果 gh 可用）────────────────────────────────────────
echo ""
echo "── GitHub Actions 配置 ──"

if command -v gh &>/dev/null && gh auth status &>/dev/null 2>&1; then
  echo "  → 自动配置 GitHub Actions Secrets ..."
  bash scripts/10-setup-github.sh
  echo "  ✅ GitHub Actions 已配置"
else
  echo "  ⊘ gh CLI 未登录，跳过 GitHub Actions 配置"
  echo "  如需配置，运行: bash scripts/10-setup-github.sh"
fi

# ── 总结 ─────────────────────────────────────────────────────────────────────
echo ""
echo "=========================================="
echo "  ✅ 部署完成！"
echo "=========================================="
echo ""
echo "访问地址："
echo "  前台: ${APP_ORIGIN}"
echo "  后台: ${APP_ORIGIN}/admin"
echo ""
echo "管理 Token 保存在 .credentials/ADMIN_TOKEN"
echo ""
echo "常用命令："
echo "  本地开发:  npm run dev"
echo "  查看日志:  npx wrangler tail"
echo "  重新部署:  npm run deploy"
echo "  数据库备份: TURSO_API_TOKEN=<platform-token> TURSO_DB_NAME=<name> TURSO_URL=<url> TURSO_TOKEN=<db-token> BACKUP_ENCRYPTION_PASSPHRASE=<passphrase> bash scripts/12-ops-maintenance.sh backup-remote"
