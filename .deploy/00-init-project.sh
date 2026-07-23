#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# 00-init-project.sh — 项目初始化
#
# 功能：
#   1. 检查前置条件（node, npm, gh, jq, openssl）
#   2. 初始化 Git 仓库（如未初始化）
#   3. 创建 GitHub 仓库（私有）
#   4. 推送到 GitHub
#
# 输入：
#   PROJECT_NAME — 项目名（默认取当前目录名）
#   GITHUB_REPO  — GitHub 仓库（默认 {gh用户}/{PROJECT_NAME}）
# ═══════════════════════════════════════════════════════════════════════════════
source "$(dirname "$0")/shared.sh"

PROJECT_NAME="${PROJECT_NAME:-$(basename "$(pwd)")}"
MODE=$(detect_deploy_mode)
banner "项目初始化: $PROJECT_NAME [$MODE]"

if step_check "00-init-project"; then
  log_ok "已完成，跳过（删除 .credentials/.deploy-progress 重跑）"
  exit 0
fi

# ── Step 1: 检查前置条件 ─────────────────────────────────────────────────────
log_step "Step 1/4: 检查前置条件"

FAIL=0
check_cmd node "brew install node" || FAIL=1
check_cmd npm || FAIL=1
check_cmd jq "brew install jq" || FAIL=1
check_cmd openssl || FAIL=1
check_cmd curl || FAIL=1
check_cmd git || FAIL=1
gh_check || FAIL=1

if [ "$FAIL" -eq 1 ]; then
  log_error "前置条件不满足，请先安装缺失的工具"
  exit 1
fi

# ── Step 2: 检查必需的环境变量 ────────────────────────────────────────────────
log_step "Step 2/4: 检查环境变量"

FAIL=0
check_env CLOUDFLARE_API_TOKEN "从 https://dash.cloudflare.com/profile/api-tokens 获取" || FAIL=1
if [ "$MODE" != "pages" ]; then
  check_env TURSO_API_TOKEN "从 https://turso.tech/app/tokens 获取" || FAIL=1
else
  log_ok "TURSO_API_TOKEN (pages 模式跳过)"
fi

if [ "$FAIL" -eq 1 ]; then
  echo ""
  echo "用法:"
  echo "  CLOUDFLARE_API_TOKEN=\"cfat_xxx\" TURSO_API_TOKEN=\"turso_xxx\" bash one-click.sh"
  exit 1
fi

# ── Step 3: 安装依赖 ─────────────────────────────────────────────────────────
log_step "Step 3/4: 安装项目依赖"

if [ -f "package.json" ]; then
  if [ ! -d "node_modules" ]; then
    log_info "npm ci ..."
    npm ci --silent 2>/dev/null || npm install --silent
    log_ok "依赖安装完成"
  else
    log_ok "node_modules 已存在，跳过"
  fi
else
  log_warn "未找到 package.json，跳过依赖安装"
fi

# ── Step 4: Git + GitHub ──────────────────────────────────────────────────────
log_step "Step 4/4: 初始化 Git 仓库并推送到 GitHub"

# 确保 .gitignore 包含凭证目录
if [ -f ".gitignore" ]; then
  for pattern in ".credentials/" ".env.local" ".dev.vars" "node_modules/" ".wrangler/"; do
    if ! grep -qx "$pattern" .gitignore 2>/dev/null; then
      echo "$pattern" >> .gitignore
    fi
  done
fi

# Git init
if [ ! -d ".git" ]; then
  git init -b main
  log_ok "Git 仓库已初始化"
else
  log_ok "Git 仓库已存在"
fi

# GitHub 仓库
GH_USER=$(gh api user -q '.login' 2>/dev/null)
GITHUB_REPO="${GITHUB_REPO:-${GH_USER}/${PROJECT_NAME}}"

log_info "GitHub 仓库: $GITHUB_REPO"

# 检查仓库是否存在
if gh repo view "$GITHUB_REPO" &>/dev/null 2>&1; then
  log_ok "GitHub 仓库已存在"
else
  log_info "创建 GitHub 私有仓库..."
  gh repo create "$GITHUB_REPO" --private --source=. --push 2>/dev/null || {
    # 如果 --push 失败，先创建再推送
    gh repo create "$GITHUB_REPO" --private --source=. 2>/dev/null
  }
  log_ok "GitHub 仓库已创建"
fi

# 确保 remote 正确
git remote remove origin 2>/dev/null || true
git remote add origin "https://github.com/${GITHUB_REPO}.git"

# 提交并推送
git add -A
if git diff --cached --quiet 2>/dev/null; then
  log_ok "无变更需要提交"
else
  git commit -m "chore: 初始化项目 (cf-core 模板)"
  log_ok "代码已提交"
fi

git push -u origin main 2>/dev/null || git push -u origin master 2>/dev/null || {
  log_warn "推送失败，请手动执行: git push -u origin main"
}
log_ok "代码已推送到 GitHub"

# 保存仓库信息
cred_save "GITHUB_REPO" "$GITHUB_REPO"
cred_save "PROJECT_NAME" "$PROJECT_NAME"

step_done "00-init-project"

echo ""
log_ok "✅ 项目初始化完成"
echo "  项目名: $PROJECT_NAME"
echo "  GitHub: https://github.com/$GITHUB_REPO"
