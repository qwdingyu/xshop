#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$ROOT/lib/common.sh"
# shellcheck disable=SC1091
source "$ROOT/lib/config.sh"
# shellcheck disable=SC1091
source "$ROOT/lib/export.sh"
# shellcheck disable=SC1091
source "$ROOT/lib/push.sh"
# shellcheck disable=SC1091
source "$ROOT/lib/harden.sh"
# shellcheck disable=SC1091
source "$ROOT/lib/check.sh"

usage() {
  cat <<'U'
用法: ./scripts/oss/ossctl.sh <command>

  check     逐项检查实施完成度（PASS/FAIL 矩阵）
  harden    加固公开 xshop（关 Actions、清 Secrets/Vars）
  export    脱敏导出到 /tmp/cf-shop-oss-export（不 push）
  push      将最近 export 或指定目录 orphan force-push 到 xshop
  sync      export + push
  all       harden → check → sync → check

环境:
  OSS_SYNC_TOKEN   推送到 xshop 的 PAT（CI 与本地可选）
  scripts/oss/config.env  可选本地配置
U
}

main() {
  load_config
  local cmd="${1:-}"
  case "$cmd" in
    check)
      oss_check_status
      ;;
    harden)
      oss_harden_xshop
      ;;
    export)
      local out="${2:-/tmp/cf-shop-oss-export}"
      oss_export_to "$out"
      log "导出目录: $out"
      ;;
    push)
      local src="${2:-/tmp/cf-shop-oss-export}"
      oss_push_xshop "$src"
      ;;
    sync)
      local out="/tmp/cf-shop-oss-export-$$"
      oss_export_to "$out"
      oss_push_xshop "$out"
      rm -rf "$out"
      ;;
    all)
      oss_harden_xshop || true
      oss_check_status || true
      local out="/tmp/cf-shop-oss-export-$$"
      oss_export_to "$out"
      oss_push_xshop "$out"
      rm -rf "$out"
      oss_check_status
      ;;
    -h|--help|help|"")
      usage
      ;;
    *)
      usage
      die "未知命令: $cmd"
      ;;
  esac
}

main "$@"