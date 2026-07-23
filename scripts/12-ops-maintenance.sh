#!/usr/bin/env bash
set -euo pipefail

# cf-shop Turso 运维脚本。
#
# 核心边界：
# - 完整备份使用 Turso 平台级 db export，输出 SQLite 快照，不在 Worker 请求中拼接逻辑 SQL。
# - 备份包含卡密、邮箱和加密配置，离开本机前必须再次加密。
# - 数据库连接 Token（TURSO_TOKEN）不能替代平台 API Token（TURSO_API_TOKEN）。
#
# backup-remote 必需：
# - TURSO_API_TOKEN：Turso Platform API Token，CLI 通过环境变量读取。
# - TURSO_DB_NAME：Turso 数据库名称，不是 libsql:// URL。
# - TURSO_URL / TURSO_TOKEN：数据库连接凭据，用于导出后按官方要求同步最新帧。
# - BACKUP_ENCRYPTION_PASSPHRASE：至少 20 字符，用于加密备份归档。
#
# 其它操作：
# - rotate-admin-token 需要 CLOUDFLARE_API_TOKEN。
# - cleanup-idempotency-keys 需要 TURSO_URL / TURSO_TOKEN。

WORKER_NAME="${ESHOP_WORKER_NAME:-cf-shop}"
BACKUP_DIR="${BACKUP_DIR:-backups}"
ACTION="${1:-}"
STAMP="$(date -u +%Y%m%d_%H%M%S)"
TEMP_BACKUP_FILES=()

cleanup_temp_backup_files() {
  if [[ ${#TEMP_BACKUP_FILES[@]} -gt 0 ]]; then
    rm -f -- "${TEMP_BACKUP_FILES[@]}"
  fi
}

trap cleanup_temp_backup_files EXIT INT TERM

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "缺少命令：$1" >&2
    exit 1
  fi
}

require_value() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "缺少环境变量：${name}" >&2
    exit 1
  fi
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1"
  else
    shasum -a 256 "$1"
  fi
}

backup_remote() {
  require_command turso
  require_command node
  require_command sqlite3
  require_command tar
  require_command openssl
  require_value TURSO_API_TOKEN
  require_value TURSO_DB_NAME
  require_value TURSO_URL
  require_value TURSO_TOKEN
  require_value BACKUP_ENCRYPTION_PASSPHRASE

  if [[ ${#BACKUP_ENCRYPTION_PASSPHRASE} -lt 20 ]]; then
    echo "BACKUP_ENCRYPTION_PASSPHRASE 至少需要 20 个字符" >&2
    exit 1
  fi
  if [[ ! "${TURSO_DB_NAME}" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "TURSO_DB_NAME 只能包含字母、数字、点、下划线和连字符" >&2
    exit 1
  fi

  mkdir -p "${BACKUP_DIR}"
  umask 077

  local base="turso_${TURSO_DB_NAME}_${STAMP}"
  local snapshot="${BACKUP_DIR}/${base}.db"
  local wal="${snapshot}-wal"
  local metadata="${snapshot}-info"
  local shm="${snapshot}-shm"
  local journal="${snapshot}-journal"
  local manifest="${BACKUP_DIR}/${base}.manifest.txt"
  local archive="${BACKUP_DIR}/${base}.tar.gz"
  local encrypted="${archive}.enc"
  TEMP_BACKUP_FILES=("${snapshot}" "${wal}" "${metadata}" "${shm}" "${journal}" "${manifest}" "${archive}")

  echo "开始导出 Turso 平台快照：${TURSO_DB_NAME}"
  local platform_database_url
  platform_database_url="$(turso db show "${TURSO_DB_NAME}" --url)"
  if [[ -z "${platform_database_url}" ]]; then
    echo "无法读取 Turso 数据库 URL：${TURSO_DB_NAME}" >&2
    exit 1
  fi
  turso db export "${TURSO_DB_NAME}" --output-file "${snapshot}" --with-metadata --overwrite

  # Turso 官方说明 db export 可能不含最新提交；保留导出 metadata 后用嵌入式副本再拉取一次最新帧。
  TURSO_EXPECTED_URL="${platform_database_url}" node scripts/sync-turso-backup.mjs "${snapshot}"

  # 关闭同步客户端后合并 WAL。最终归档必须是单一 SQLite 文件，否则 --from-file 恢复会漏掉 WAL 中的数据。
  local checkpoint
  checkpoint="$(sqlite3 "${snapshot}" "PRAGMA wal_checkpoint(TRUNCATE);")"
  if [[ "${checkpoint%%|*}" != "0" ]] || [[ -s "${wal}" ]]; then
    echo "SQLite WAL 合并失败：${checkpoint}" >&2
    exit 1
  fi
  rm -f -- "${wal}" "${metadata}" "${shm}" "${journal}"

  local integrity
  integrity="$(sqlite3 "${snapshot}" "PRAGMA integrity_check;")"
  if [[ "${integrity}" != "ok" ]]; then
    echo "SQLite 完整性检查失败：${integrity}" >&2
    exit 1
  fi

  local table_count
  # sqlite_master 兼容 macOS 自带的 SQLite 3.32；语义与新版 sqlite_schema 别名相同。
  table_count="$(sqlite3 "${snapshot}" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';")"
  if [[ ! "${table_count}" =~ ^[0-9]+$ ]] || [[ "${table_count}" -lt 1 ]]; then
    echo "导出快照不包含业务表，拒绝生成空备份" >&2
    exit 1
  fi

  local migration_version
  migration_version="$(sqlite3 "${snapshot}" "SELECT COALESCE(MAX(version), 'unknown') FROM schema_migrations;" 2>/dev/null || printf 'unknown')"
  local snapshot_sha
  snapshot_sha="$(sha256_file "${snapshot}" | awk '{print $1}')"
  {
    echo "created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "database=${TURSO_DB_NAME}"
    echo "integrity_check=${integrity}"
    echo "table_count=${table_count}"
    echo "migration_version=${migration_version}"
    echo "snapshot_sha256=${snapshot_sha}"
  } > "${manifest}"

  local archive_files=("$(basename "${snapshot}")" "$(basename "${manifest}")")
  tar -czf "${archive}" -C "${BACKUP_DIR}" "${archive_files[@]}"

  # OpenSSL enc 不把口令放到命令行参数中；GitHub Actions 日志不会泄露 secret。
  openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 -md sha256 -in "${archive}" -out "${encrypted}" -pass env:BACKUP_ENCRYPTION_PASSPHRASE
  local encrypted_name
  encrypted_name="$(basename "${encrypted}")"
  (
    cd "${BACKUP_DIR}"
    sha256_file "${encrypted_name}" > "${encrypted_name}.sha256"
  )

  rm -f -- "${snapshot}" "${wal}" "${metadata}" "${shm}" "${journal}" "${manifest}" "${archive}"
  TEMP_BACKUP_FILES=()

  echo "加密备份完成：${encrypted}"
  echo "校验文件：${encrypted}.sha256"
  echo "注意：Turso Free 的 PITR 当前覆盖最近 24 小时；离线导出仍必须定期做恢复演练。"
}

require_cloudflare_token() {
  require_value CLOUDFLARE_API_TOKEN
}

rotate_admin_token() {
  require_cloudflare_token
  local token="${ADMIN_TOKEN:-}"
  if [[ -z "${token}" ]]; then
    token="$(openssl rand -hex 32)"
  fi
  echo "开始轮换 ${WORKER_NAME} 的 ADMIN_TOKEN secret"
  printf '%s' "${token}" | npx wrangler secret put ADMIN_TOKEN --name "${WORKER_NAME}"
  echo "ADMIN_TOKEN 已轮换。请立即保存下面的新 token 到密码管理器，后续不会再显示："
  echo "${token}"
}

cleanup_idempotency_keys() {
  require_command node
  require_value TURSO_URL
  require_value TURSO_TOKEN
  echo "清理 30 天前的幂等键记录（Turso）..."
  node scripts/turso-exec.mjs execute "DELETE FROM idempotency_keys WHERE created_at < datetime('now', '-30 days')"
  echo "清理完成。"
}

case "${ACTION}" in
  backup-remote)
    backup_remote
    ;;
  rotate-admin-token)
    rotate_admin_token
    ;;
  cleanup-idempotency-keys)
    cleanup_idempotency_keys
    ;;
  *)
    cat >&2 <<'USAGE'
用法：
  bash scripts/12-ops-maintenance.sh backup-remote
  bash scripts/12-ops-maintenance.sh rotate-admin-token
  bash scripts/12-ops-maintenance.sh cleanup-idempotency-keys

示例：
  TURSO_API_TOKEN="<platform-token>" \
  TURSO_DB_NAME="<database-name>" \
  TURSO_URL="<libsql-url>" \
  TURSO_TOKEN="<db-token>" \
  BACKUP_ENCRYPTION_PASSPHRASE="<strong-passphrase>" \
  bash scripts/12-ops-maintenance.sh backup-remote

  CLOUDFLARE_API_TOKEN="<token>" bash scripts/12-ops-maintenance.sh rotate-admin-token
  TURSO_URL="<url>" TURSO_TOKEN="<db-token>" bash scripts/12-ops-maintenance.sh cleanup-idempotency-keys
USAGE
    exit 1
    ;;
esac
