#!/usr/bin/env bash
set -euo pipefail

# cf-shop · RESEND_API_KEY 配置脚本
#
# 用法：
#   bash scripts/11-setup-resend.sh [--overwrite]
#
# 功能：
#   交互式设置 RESEND_API_KEY 到 Cloudflare Workers secret。
#   默认行为：仅当 secret 不存在时才写入（安全护栏）。
#   传递 --overwrite 可强制覆盖已有值。
#
# 前置要求：
#   - 已登录 Cloudflare：npx wrangler login
#   - 已安装依赖：npm install
#   - 在项目根目录执行（scripts/../wrangler.jsonc 能找到）

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

OVERWRITE=false
if [[ "${1:-}" == "--overwrite" ]]; then
  OVERWRITE=true
fi
WORKER_NAME="${ESHOP_WORKER_NAME:-cf-shop}"

# 检测是否已配置 secret
check_secret() {
  npx wrangler secret list --name "$WORKER_NAME" 2>/dev/null | grep -q "RESEND_API_KEY"
}

echo "───────────────────────────────────"
echo " cf-shop · RESEND_API_KEY 配置 (${WORKER_NAME})"
echo "───────────────────────────────────"

if check_secret && [[ "$OVERWRITE" == "false" ]]; then
  echo "RESEND_API_KEY 已存在（不覆盖）。"
  echo "如需强制覆盖，请加 --overwrite 参数："
  echo "  bash scripts/11-setup-resend.sh --overwrite"
  exit 0
fi

echo ""
echo "请登录 https://resend.com/settings/api-keys 获取 API Key"
echo ""
read -rp "粘贴 RESEND_API_KEY（输入时不可见）: " API_KEY

if [[ -z "$API_KEY" ]]; then
  echo "错误：API Key 不能为空。" >&2
  exit 1
fi

echo "$API_KEY" | npx wrangler secret put RESEND_API_KEY --name "$WORKER_NAME"

echo ""
echo "✅ RESEND_API_KEY 配置完成！"
echo "提示：如果部署后发邮件失败，可执行冒烟测试验证："
echo "  ADMIN_TOKEN=<your_token> npm run smoke:admin -- --test test-email"
