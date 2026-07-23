#!/usr/bin/env bash
set -euo pipefail

oss_root() {
  local here
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  echo "$here"
}

repo_root() {
  git -C "$(oss_root)/../.." rev-parse --show-toplevel 2>/dev/null \
    || git rev-parse --show-toplevel
}

log()  { printf '[oss] %s\n' "$*"; }
ok()   { printf '[PASS] %s\n' "$*"; }
fail() { printf '[FAIL] %s\n' "$*"; }
skip() { printf '[SKIP] %s\n' "$*"; }
info() { printf '[INFO] %s\n' "$*"; }

die() { printf '[ERR] %s\n' "$*" >&2; exit 1; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "缺少命令: $1"
}

load_config() {
  local root cfg
  root="$(oss_root)"
  # shellcheck disable=SC1091
  source "$root/lib/config.sh"
  cfg="$root/config.env"
  if [[ -f "$cfg" ]]; then
    # shellcheck disable=SC1090
    set -a; source "$cfg"; set +a
  fi
  XSHOP_OWNER="${XSHOP_OWNER:-qwdingyu}"
  XSHOP_REPO="${XSHOP_REPO:-xshop}"
  XSHOP_BRANCH="${XSHOP_BRANCH:-main}"
  PRIVATE_BRANCH="${PRIVATE_BRANCH:-main}"
  XSHOP_SLUG="${XSHOP_OWNER}/${XSHOP_REPO}"
  OSS_STRIP_SCHEDULE="${OSS_STRIP_SCHEDULE:-1}"
  OSS_FORCE_PUSH="${OSS_FORCE_PUSH:-1}"
  OSS_EXCLUDE_PREFIXES="${OSS_EXCLUDE_PREFIXES:-docs/ packages/ .env .env.local scripts/oss/config.env}"
}