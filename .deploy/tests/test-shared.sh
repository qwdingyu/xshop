#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# test-shared.sh — shared.sh 单元测试
#
# 测试所有新增函数：
#   - detect_deploy_mode
#   - is_workers_mode / is_pages_mode / is_hybrid_mode
#   - pages_deploy (模拟测试)
#   - pages_get_url (模拟测试)
#   - 原有函数回归测试
#
# 用法: bash templates/.deploy/tests/test-shared.sh
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SHARED_SH="$(cd "$SCRIPT_DIR/.." && pwd)/shared.sh"
PASS=0
FAIL=0
TOTAL=0

# ── 测试工具函数 ──────────────────────────────────────────────────────────────
assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  TOTAL=$((TOTAL + 1))
  if [ "$expected" = "$actual" ]; then
    echo "  ✅ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $desc"
    echo "     期望: '$expected'"
    echo "     实际: '$actual'"
    FAIL=$((FAIL + 1))
  fi
}

assert_true() {
  local desc="$1"
  shift
  TOTAL=$((TOTAL + 1))
  if "$@" 2>/dev/null; then
    echo "  ✅ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $desc (返回 false)"
    FAIL=$((FAIL + 1))
  fi
}

assert_false() {
  local desc="$1"
  shift
  TOTAL=$((TOTAL + 1))
  if "$@" 2>/dev/null; then
    echo "  ❌ $desc (期望 false 但返回 true)"
    FAIL=$((FAIL + 1))
  else
    echo "  ✅ $desc"
    PASS=$((PASS + 1))
  fi
}

# ── 创建临时测试目录 ──────────────────────────────────────────────────────────
TEST_DIR=$(mktemp -d)
trap "rm -rf $TEST_DIR" EXIT

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  shared.sh 单元测试"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  测试目录: $TEST_DIR"
echo "  shared.sh: $SHARED_SH"
echo ""

# ── 加载 shared.sh（在临时目录中执行，避免影响当前目录） ──────────────────────
cd "$TEST_DIR"
source "$SHARED_SH"

# ══════════════════════════════════════════════════════════════════════════════
# 测试组 1: detect_deploy_mode
# ══════════════════════════════════════════════════════════════════════════════
echo "━━━ 测试组 1: detect_deploy_mode ━━━"

# 1.1 无 .deploy-mode 文件，无环境变量 → 默认 workers
unset DEPLOY_MODE 2>/dev/null || true
result=$(detect_deploy_mode)
assert_eq "无文件无环境变量 → workers" "workers" "$result"

# 1.2 .deploy-mode 文件内容为 workers
echo "workers" > .deploy-mode
unset DEPLOY_MODE 2>/dev/null || true
result=$(detect_deploy_mode)
assert_eq ".deploy-mode=workers → workers" "workers" "$result"

# 1.3 .deploy-mode 文件内容为 pages
echo "pages" > .deploy-mode
unset DEPLOY_MODE 2>/dev/null || true
result=$(detect_deploy_mode)
assert_eq ".deploy-mode=pages → pages" "pages" "$result"

# 1.4 .deploy-mode 文件内容为 hybrid
echo "hybrid" > .deploy-mode
unset DEPLOY_MODE 2>/dev/null || true
result=$(detect_deploy_mode)
assert_eq ".deploy-mode=hybrid → hybrid" "hybrid" "$result"

# 1.5 环境变量优先于文件
echo "workers" > .deploy-mode
DEPLOY_MODE=pages
result=$(detect_deploy_mode)
assert_eq "环境变量 pages 优先于文件 workers → pages" "pages" "$result"
unset DEPLOY_MODE

# 1.6 无效 .deploy-mode 内容 → 回退 workers
echo "invalid_mode" > .deploy-mode
unset DEPLOY_MODE 2>/dev/null || true
result=$(detect_deploy_mode 2>/dev/null)
assert_eq "无效内容 → workers (回退)" "workers" "$result"

# 1.7 .deploy-mode 含多余空白
echo "  pages  " > .deploy-mode
unset DEPLOY_MODE 2>/dev/null || true
result=$(detect_deploy_mode)
assert_eq ".deploy-mode='  pages  ' → pages (去空白)" "pages" "$result"

# 清理
rm -f .deploy-mode

# ══════════════════════════════════════════════════════════════════════════════
# 测试组 2: is_workers_mode / is_pages_mode / is_hybrid_mode
# ══════════════════════════════════════════════════════════════════════════════
echo ""
echo "━━━ 测试组 2: is_*_mode 快捷函数 ━━━"

# workers 模式
echo "workers" > .deploy-mode
assert_true "workers 模式: is_workers_mode=true" is_workers_mode
assert_false "workers 模式: is_pages_mode=false" is_pages_mode
assert_false "workers 模式: is_hybrid_mode=false" is_hybrid_mode

# pages 模式
echo "pages" > .deploy-mode
assert_false "pages 模式: is_workers_mode=false" is_workers_mode
assert_true "pages 模式: is_pages_mode=true" is_pages_mode
assert_false "pages 模式: is_hybrid_mode=false" is_hybrid_mode

# hybrid 模式
echo "hybrid" > .deploy-mode
assert_false "hybrid 模式: is_workers_mode=false" is_workers_mode
assert_false "hybrid 模式: is_pages_mode=false" is_pages_mode
assert_true "hybrid 模式: is_hybrid_mode=true" is_hybrid_mode

# 环境变量覆盖
echo "workers" > .deploy-mode
DEPLOY_MODE=hybrid
assert_true "DEPLOY_MODE=hybrid 覆盖文件 → is_hybrid_mode=true" is_hybrid_mode
unset DEPLOY_MODE

rm -f .deploy-mode

# ══════════════════════════════════════════════════════════════════════════════
# 测试组 3: cred_save / cred_load / cred_load_or_gen（回归测试）
# ══════════════════════════════════════════════════════════════════════════════
echo ""
echo "━━━ 测试组 3: cred_save / cred_load (回归) ━━━"

cred_save "TEST_KEY" "test_value_123" 2>/dev/null
result=$(cred_load "TEST_KEY" 2>/dev/null)
assert_eq "cred_save + cred_load 往返" "test_value_123" "$result"

# cred_load 不存在的 key
result=$(cred_load "NONEXISTENT_KEY" 2>/dev/null && echo "found" || echo "not_found")
assert_eq "cred_load 不存在的 key → not_found" "not_found" "$result"

# cred_load_or_gen 新建
result=$(cred_load_or_gen "GEN_KEY" "prefix" 2>/dev/null)
TOTAL=$((TOTAL + 1))
if [[ "$result" == prefix-* ]] && [ ${#result} -gt 10 ]; then
  echo "  ✅ cred_load_or_gen 生成新 token (前缀: prefix)"
  PASS=$((PASS + 1))
else
  echo "  ❌ cred_load_or_gen 生成格式不正确: '$result'"
  FAIL=$((FAIL + 1))
fi

# cred_load_or_gen 复用已有
result2=$(cred_load_or_gen "GEN_KEY" "prefix" 2>/dev/null)
assert_eq "cred_load_or_gen 复用已有 token" "$result" "$result2"

# ══════════════════════════════════════════════════════════════════════════════
# 测试组 4: step_done / step_check（回归测试）
# ══════════════════════════════════════════════════════════════════════════════
echo ""
echo "━━━ 测试组 4: step_done / step_check (回归) ━━━"

# 清除进度文件
rm -f .credentials/.deploy-progress

assert_false "step_check 不存在的步骤 → false" step_check "nonexistent-step"

step_done "test-step-1" 2>/dev/null
assert_true "step_done 后 step_check → true" step_check "test-step-1"
assert_false "step_check 其他步骤 → false" step_check "test-step-2"

step_done "test-step-2" 2>/dev/null
assert_true "多个 step_done 互不干扰" step_check "test-step-1"
assert_true "多个 step_done 互不干扰" step_check "test-step-2"

# ══════════════════════════════════════════════════════════════════════════════
# 测试组 5: gen_token / gen_hex（回归测试）
# ══════════════════════════════════════════════════════════════════════════════
echo ""
echo "━━━ 测试组 5: gen_token / gen_hex (回归) ━━━"

token=$(gen_token "myapp")
TOTAL=$((TOTAL + 1))
if [[ "$token" == myapp-* ]] && [ ${#token} -gt 20 ]; then
  echo "  ✅ gen_token 格式正确: ${token:0:20}..."
  PASS=$((PASS + 1))
else
  echo "  ❌ gen_token 格式不正确: '$token'"
  FAIL=$((FAIL + 1))
fi

hex=$(gen_hex 16)
TOTAL=$((TOTAL + 1))
if [ ${#hex} -eq 32 ] && [[ "$hex" =~ ^[0-9a-f]+$ ]]; then
  echo "  ✅ gen_hex(16) 长度正确: 32 字符"
  PASS=$((PASS + 1))
else
  echo "  ❌ gen_hex(16) 长度不正确: ${#hex} 字符 ('$hex')"
  FAIL=$((FAIL + 1))
fi

# ══════════════════════════════════════════════════════════════════════════════
# 测试组 6: pages_deploy 参数验证
# ══════════════════════════════════════════════════════════════════════════════
echo ""
echo "━━━ 测试组 6: pages_deploy 参数验证 ━━━"

# 6.1 空参数调用 → 报错
TOTAL=$((TOTAL + 1))
if pages_deploy "" 2>/dev/null; then
  echo "  ❌ pages_deploy 空参数应该失败"
  FAIL=$((FAIL + 1))
else
  echo "  ✅ pages_deploy 空参数 → 正确失败"
  PASS=$((PASS + 1))
fi

# 6.2 目录不存在 → 报错
TOTAL=$((TOTAL + 1))
if pages_deploy "test-project" "/nonexistent/dir" 2>/dev/null; then
  echo "  ❌ pages_deploy 目录不存在应该失败"
  FAIL=$((FAIL + 1))
else
  echo "  ✅ pages_deploy 目录不存在 → 正确失败"
  PASS=$((PASS + 1))
fi

# ══════════════════════════════════════════════════════════════════════════════
# 测试组 7: check_env
# ══════════════════════════════════════════════════════════════════════════════
echo ""
echo "━━━ 测试组 7: check_env ━━━"

TEST_VAR_EXISTS="hello"
assert_true "check_env 已设置的变量 → true" check_env TEST_VAR_EXISTS

unset TEST_VAR_NOT_EXISTS 2>/dev/null || true
assert_false "check_env 未设置的变量 → false" check_env TEST_VAR_NOT_EXISTS

# ══════════════════════════════════════════════════════════════════════════════
# 测试组 8: check_cmd
# ══════════════════════════════════════════════════════════════════════════════
echo ""
echo "━━━ 测试组 8: check_cmd ━━━"

assert_true "check_cmd bash (存在) → true" check_cmd bash
assert_false "check_cmd nonexistent_cmd_xyz → false" check_cmd nonexistent_cmd_xyz

# ══════════════════════════════════════════════════════════════════════════════
# 汇总
# ══════════════════════════════════════════════════════════════════════════════
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  测试结果: $PASS/$TOTAL 通过, $FAIL 失败"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo "❌ 有 $FAIL 个测试失败！"
  exit 1
else
  echo "✅ 全部 $TOTAL 个测试通过！"
  exit 0
fi
