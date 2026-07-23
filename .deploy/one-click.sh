#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# one-click.sh — 一键部署入口（编排所有步骤，支持三种部署模式）
#
# ╔═══════════════════════════════════════════════════════════════════════╗
# ║  用法：                                                               ║
# ║                                                                       ║
# ║  # Workers 模式（默认，适合 API/商城/工具站）                           ║
# ║  CLOUDFLARE_API_TOKEN="cfat_xxx" \                                    ║
# ║  TURSO_API_TOKEN="turso_xxx" \                                        ║
# ║  bash one-click.sh                                                    ║
# ║                                                                       ║
# ║  # Pages 模式（适合 SEO 工具站/文档站/博客/落地页）                      ║
# ║  CLOUDFLARE_API_TOKEN="cfat_xxx" \                                    ║
# ║  DEPLOY_MODE=pages \                                                  ║
# ║  bash one-click.sh                                                    ║
# ║                                                                       ║
# ║  # Hybrid 模式（Workers + Pages，适合 API + 前端分离）                  ║
# ║  CLOUDFLARE_API_TOKEN="cfat_xxx" \                                    ║
# ║  TURSO_API_TOKEN="turso_xxx" \                                        ║
# ║  DEPLOY_MODE=hybrid \                                                 ║
# ║  bash one-click.sh                                                    ║
# ║                                                                       ║
# ║  可选环境变量：                                                        ║
# ║    DEPLOY_MODE   — workers(默认) / pages / hybrid                      ║
# ║    PROJECT_NAME  — 项目名（默认当前目录名）                             ║
# ║    DOMAIN        — 自定义域名（跳过则用 workers.dev / pages.dev）       ║
# ║    SKIP_DOMAIN   — 设为 true 跳过域名绑定                              ║
# ║    SKIP_TURNSTILE — 设为 true 跳过 Turnstile 配置                     ║
# ║    SKIP_GITHUB   — 设为 true 跳过 GitHub Actions 配置                  ║
# ║    ONLY          — 只运行指定步骤（逗号分隔，如 "01,03"）               ║
# ╚═══════════════════════════════════════════════════════════════════════╝
# ═══════════════════════════════════════════════════════════════════════════════
source "$(dirname "$0")/shared.sh"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_NAME="${PROJECT_NAME:-$(basename "$(pwd)")}"
MODE=$(detect_deploy_mode)

# ── should_run_check：检查某步骤是否在待运行列表中 ───────────────────────────
should_run_check() {
  local steps_csv="$1"
  if [ -n "${ONLY:-}" ]; then
    for s in $(echo "$steps_csv" | tr ',' ' '); do
      echo ",$ONLY," | grep -q ",$s," && return 0
    done
    return 1
  fi
  for s in $(echo "$steps_csv" | tr ',' ' '); do
    case "$s" in
      00|03) return 0 ;;
      01|02) [ "$MODE" != "pages" ] && return 0 ;;
      04) [ "${SKIP_DOMAIN:-false}" != "true" ] && return 0 ;;
      05) [ "${SKIP_TURNSTILE:-false}" != "true" ] && [ "$MODE" != "pages" ] && return 0 ;;
      06) [ "${SKIP_GITHUB:-false}" != "true" ] && return 0 ;;
    esac
  done
  return 1
}

# ── 入口环境变量预检 ─────────────────────────────────────────────────────────
log_step "入口预检：环境变量"
FAIL=0
check_env CLOUDFLARE_API_TOKEN "从 https://dash.cloudflare.com/profile/api-tokens 获取" || FAIL=1
if [ "$MODE" != "pages" ]; then
  if should_run_check "01"; then
    check_env TURSO_API_TOKEN "从 https://turso.tech/app/tokens 获取" || FAIL=1
  fi
fi
if should_run_check "00,06"; then
  gh_check || FAIL=1
fi
if [ "$FAIL" -eq 1 ]; then
  log_error "环境变量预检失败，请设置缺失的变量后重试"
  exit 1
fi
log_ok "环境变量预检通过"

banner "🚀 一键部署: $PROJECT_NAME [$MODE]"

echo -e "${BOLD}部署模式：${CYAN}${MODE}${NC}"
case "$MODE" in
  workers) echo "  → Cloudflare Workers + Static Assets（API + 前端一体化）" ;;
  pages)   echo "  → Cloudflare Pages（纯静态站，SEO 工具站/文档站/博客）" ;;
  hybrid)  echo "  → Workers + Pages 混合（API 走 Worker，前端走 Pages）" ;;
esac
echo ""

echo -e "${BOLD}部署流程：${NC}"
echo "  00. 项目初始化（Git + GitHub 仓库）"
[ "$MODE" != "pages" ] && echo "  01. Turso 数据库（创建 + 迁移）  [节点: ${TURSO_LOCATION:-aws-ap-northeast-1}]"
[ "$MODE" != "pages" ] && echo "  02. Secrets 生成（ADMIN_TOKEN 等）"
echo "  03. 部署（构建 + 部署 + 冒烟测试）  [模式: $MODE]"
[ "${SKIP_DOMAIN:-false}" != "true" ] && echo "  04. 域名绑定（DNS + SSL）"
[ "${SKIP_TURNSTILE:-false}" != "true" ] && [ "$MODE" != "pages" ] && echo "  05. Turnstile（人机验证 Widget）"
[ "${SKIP_GITHUB:-false}" != "true" ] && echo "  06. GitHub Actions（CI/CD 流水线）"
echo ""

# ── 步骤选择 ──────────────────────────────────────────────────────────────────
STEPS="00"
[ "$MODE" != "pages" ] && STEPS="${STEPS},01,02"
STEPS="${STEPS},03"
[ "${SKIP_DOMAIN:-false}" != "true" ] && STEPS="${STEPS},04"
[ "${SKIP_TURNSTILE:-false}" != "true" ] && [ "$MODE" != "pages" ] && STEPS="${STEPS},05"
[ "${SKIP_GITHUB:-false}" != "true" ] && STEPS="${STEPS},06"

if [ -n "${ONLY:-}" ]; then
  STEPS="$ONLY"
fi

should_run() {
  echo ",$STEPS," | grep -q ",$1,"
}

# ── 执行 ──────────────────────────────────────────────────────────────────────
START_TIME=$(date +%s)

if should_run "00"; then
  bash "${SCRIPT_DIR}/00-init-project.sh" || { log_error "Step 00 失败"; exit 1; }
fi

if should_run "01" && [ "$MODE" != "pages" ]; then
  bash "${SCRIPT_DIR}/01-setup-turso.sh" || { log_error "Step 01 失败"; exit 1; }
fi

if should_run "02" && [ "$MODE" != "pages" ]; then
  bash "${SCRIPT_DIR}/02-setup-secrets.sh" || { log_error "Step 02 失败"; exit 1; }
fi

if should_run "03"; then
  bash "${SCRIPT_DIR}/03-deploy-worker.sh" || { log_error "Step 03 失败"; exit 1; }
fi

if should_run "04" && [ "${SKIP_DOMAIN:-false}" != "true" ]; then
  if [ -n "${DOMAIN:-}" ]; then
    bash "${SCRIPT_DIR}/04-bind-domain.sh" || log_warn "Step 04 失败（域名绑定可稍后执行）"
  else
    log_warn "未设置 DOMAIN，跳过域名绑定"
    log_info "稍后可运行: DOMAIN=\"xxx\" bash ${SCRIPT_DIR}/04-bind-domain.sh"
  fi
fi

if should_run "05" && [ "${SKIP_TURNSTILE:-false}" != "true" ] && [ "$MODE" != "pages" ]; then
  bash "${SCRIPT_DIR}/05-setup-turnstile.sh" || log_warn "Step 05 失败（Turnstile 可稍后配置）"
fi

if should_run "06" && [ "${SKIP_GITHUB:-false}" != "true" ]; then
  bash "${SCRIPT_DIR}/06-setup-github.sh" || log_warn "Step 06 失败（GitHub Actions 可稍后配置）"
fi

# ── 总结 ──────────────────────────────────────────────────────────────────────
END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

DOMAIN_VAL=$(cred_load "DOMAIN" 2>/dev/null || echo "")
BASE_URL=$(cred_load "BASE_URL" 2>/dev/null || echo "")
GITHUB_REPO=$(cred_load "GITHUB_REPO" 2>/dev/null || echo "")
ADMIN_TOKEN=$(cred_load "ADMIN_TOKEN" 2>/dev/null || echo "")

echo ""
echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${GREEN}║  ✅ 部署完成！  (${ELAPSED}s)  [${MODE}]${NC}"
echo -e "${BOLD}${GREEN}╚══════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${BOLD}项目信息：${NC}"
echo "  项目名:   $PROJECT_NAME"
echo "  模式:     $MODE"
[ -n "$GITHUB_REPO" ] && echo "  GitHub:   https://github.com/$GITHUB_REPO"
[ -n "$BASE_URL" ] && echo "  访问地址: $BASE_URL"
[ -n "$DOMAIN_VAL" ] && echo "  域名:     https://$DOMAIN_VAL"
[ "$MODE" != "pages" ] && echo "  Admin:    ${BASE_URL:-https://${PROJECT_NAME}.workers.dev}/admin"
[ -n "$ADMIN_TOKEN" ] && [ "$MODE" != "pages" ] && echo "  Token:    ${ADMIN_TOKEN:0:12}..."
echo ""
echo -e "${BOLD}凭证位置：${NC} .credentials/"
echo -e "${BOLD}重新部署：${NC} bash ${SCRIPT_DIR}/one-click.sh"
echo -e "${BOLD}单步重跑：${NC} ONLY=03 bash ${SCRIPT_DIR}/one-click.sh"
echo ""
