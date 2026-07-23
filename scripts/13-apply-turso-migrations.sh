#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────────────
#  apply-turso-migrations.sh
#
#  用途：通过项目迁移执行器将 migrations/*.sql 应用到 Turso 远程数据库。
#
#  环境变量：
#  - TURSO_URL      — Turso 数据库 URL（必需）
#  - TURSO_TOKEN — Turso 认证 Token（必需）
#  - 迁移文件由 scripts/migrate.mjs 解析，只执行 UP 段并记录 schema_migrations。
#
#  用法：
#    TURSO_URL="libsql://xxx.turso.io" TURSO_TOKEN="eyJ..." bash scripts/13-apply-turso-migrations.sh
#    # 或通过 npm script：
#    npm run db:migrate:turso
# ──────────────────────────────────────────────────────

if [[ -z "${TURSO_URL:-}" ]]; then
  echo "❌ 缺少 TURSO_URL 环境变量" >&2
  echo "用法：TURSO_URL=\"libsql://xxx.turso.io\" TURSO_TOKEN=\"eyJ...\" bash scripts/13-apply-turso-migrations.sh" >&2
  exit 1
fi

if [[ -z "${TURSO_TOKEN:-}" ]]; then
  echo "❌ 缺少 TURSO_TOKEN 环境变量" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# 迁移文件同时包含 UP/DOWN 段，且需要 schema_migrations 记录执行状态。
# 不要把完整 SQL 文件直接重定向给 turso db shell，否则会执行 DOWN 段。
exec node scripts/migrate.mjs "$@"
