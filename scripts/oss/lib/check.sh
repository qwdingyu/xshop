#!/usr/bin/env bash
# 系统化逐项验收：输出矩阵，退出码=失败项数

PASS_N=0
FAIL_N=0
SKIP_N=0

record() {
  local st="$1"; shift
  case "$st" in
    PASS) ok "$*"; PASS_N=$((PASS_N+1)) ;;
    FAIL) fail "$*"; FAIL_N=$((FAIL_N+1)) ;;
    SKIP) skip "$*"; SKIP_N=$((SKIP_N+1)) ;;
  esac
}

check_file() {
  local rel="$1" root
  root="$(repo_root)"
  if [[ -f "$root/$rel" ]]; then
    record PASS "private 存在: $rel"
  else
    record FAIL "private 缺失: $rel"
  fi
}

oss_check_status() {
  load_config
  need_cmd git
  local root
  root="$(repo_root)"
  echo "========================================"
  echo " OSS 实施完成度检查  $(date -u +%Y-%m-%dT%H:%MZ)"
  echo " private: $root"
  echo " public:  ${XSHOP_SLUG}"
  echo "========================================"

  echo
  echo "--- A. 私有仓工件 ---"
  local f
  for f in "${OSS_REQUIRED_PRIVATE_FILES[@]}"; do
    check_file "$f"
  done
  if ls "$root"/docs/*046* >/dev/null 2>&1; then
    record PASS "private 存在 docs/*046* 操作文档"
  else
    record FAIL "private 缺失 docs/*046* 操作文档"
  fi
  if grep -Rqs '046_' "$root"/docs/*000* 2>/dev/null || grep -Rqs '开源导出' "$root"/docs/*000* 2>/dev/null; then
    record PASS "文档索引已引用 046/开源导出"
  else
    record FAIL "文档索引未引用 046/开源导出"
  fi

  echo
  echo "--- B. 私有仓 Secrets ---"
  if command -v gh >/dev/null 2>&1; then
    if gh secret list 2>/dev/null | awk 'NR>0{print $1}' | grep -qx 'OSS_SYNC_TOKEN'; then
      record PASS "private 已配置 OSS_SYNC_TOKEN（仅名）"
    else
      record FAIL "private 未配置 OSS_SYNC_TOKEN"
    fi
  else
    record SKIP "无 gh，跳过 private secret 检查"
  fi

  echo
  echo "--- C. 公开仓基线 ---"
  if ! command -v gh >/dev/null 2>&1; then
    record SKIP "无 gh，跳过公开仓检查"
  else
    local vis en
    vis="$(gh api "repos/${XSHOP_SLUG}" --jq '.visibility' 2>/dev/null || echo unknown)"
    if [[ "$vis" == "public" ]]; then
      record PASS "xshop visibility=public（预期）"
    else
      record FAIL "xshop visibility=$vis（预期 public）"
    fi

    en="$(gh api "repos/${XSHOP_SLUG}/actions/permissions" --jq '.enabled' 2>/dev/null || echo unknown)"
    if [[ "$en" == "false" ]]; then
      record PASS "xshop Actions disabled"
    else
      record FAIL "xshop Actions enabled=${en} (public repo should disable)"
    fi

    local sec_n var_n
    sec_n="$(gh secret list -R "$XSHOP_SLUG" 2>/dev/null | awk 'NR>0 && $1!="NAME"{c++} END{print c+0}')"
    var_n="$(gh variable list -R "$XSHOP_SLUG" 2>/dev/null | awk 'NR>0 && $1!="NAME"{c++} END{print c+0}')"
    if [[ "$sec_n" -eq 0 ]]; then
      record PASS "xshop Secrets 为空 ($sec_n)"
    else
      record FAIL "xshop 仍有 Secrets: $sec_n 个"
      gh secret list -R "$XSHOP_SLUG" 2>/dev/null | sed 's/^/        /' || true
    fi
    if [[ "$var_n" -eq 0 ]]; then
      record PASS "xshop Variables 为空 ($var_n)"
    else
      record FAIL "xshop 仍有 Variables: $var_n 个"
      gh variable list -R "$XSHOP_SLUG" 2>/dev/null | sed 's/^/        /' || true
    fi

    # 危险路径
    local risky
    risky="$(gh api "repos/${XSHOP_SLUG}/git/trees/${XSHOP_BRANCH}?recursive=1" \
      --jq '[.tree[].path] | map(select(test("^(docs/)|(\\.env$)|(\\.env\\.)|(^packages/)|sync-oss\\.yml"))) | join(", ")' 2>/dev/null || echo 'API_ERROR')"
    if [[ "$risky" == "API_ERROR" ]]; then
      record SKIP "无法拉取 xshop tree"
    elif [[ -z "$risky" ]]; then
      record PASS "xshop 树无 docs/.env/packages/sync-oss"
    else
      record FAIL "xshop 危险路径: $risky"
    fi
  fi

  echo
  echo "--- D. 导出规则自检（dry export） ---"
  local tmp
  tmp="$(mktemp -d)"
  if oss_export_to "$tmp/out" 2>/tmp/oss-export-check.log; then
    if [[ -d "$tmp/out/docs" ]]; then
      record FAIL "dry export 含 docs/"
    else
      record PASS "dry export 不含 docs/"
    fi
    if [[ -f "$tmp/out/.env" ]]; then
      record FAIL "dry export 含 .env"
    else
      record PASS "dry export 不含 .env"
    fi
    if [[ -f "$tmp/out/.github/workflows/sync-oss.yml" ]]; then
      record FAIL "dry export 含 sync-oss.yml（应仅 private）"
    else
      record PASS "dry export 不含 sync-oss.yml"
    fi
    if [[ -f "$tmp/out/scripts/oss/config.env" ]]; then
      record FAIL "dry export 含 config.env"
    else
      record PASS "dry export 不含 config.env"
    fi
  else
    record FAIL "dry export 失败（见 /tmp/oss-export-check.log）"
  fi
  rm -rf "$tmp"

  echo
  echo "========================================"
  echo " 汇总: PASS=$PASS_N  FAIL=$FAIL_N  SKIP=$SKIP_N"
  echo "========================================"
  return "$FAIL_N"
}