#!/usr/bin/env bash
# 加固公开 xshop：关 Actions、删生产 Secrets/Vars

oss_harden_xshop() {
  need_cmd gh
  log "加固公开仓 ${XSHOP_SLUG}"

  # 关闭 Actions
  if gh api -X PUT "repos/${XSHOP_SLUG}/actions/permissions" -f enabled=false >/dev/null 2>&1; then
    ok "Actions disabled"
  else
    # 兼容 JSON body
    echo '{"enabled":false}' | gh api -X PUT "repos/${XSHOP_SLUG}/actions/permissions" --input - >/dev/null 2>&1 \
      && ok "Actions disabled" \
      || fail "无法关闭 Actions（检查 gh 权限）"
  fi

  local s v
  for s in "${OSS_PROD_SECRET_NAMES[@]}"; do
    if gh secret delete "$s" -R "$XSHOP_SLUG" >/dev/null 2>&1; then
      ok "deleted secret $s"
    fi
  done
  # 再扫一遍现有 secrets 全部删除（公开仓不应有任何 secret）
  while IFS=$'\t' read -r name _; do
    [[ -z "${name:-}" || "$name" == "NAME" ]] && continue
    gh secret delete "$name" -R "$XSHOP_SLUG" >/dev/null 2>&1 && ok "deleted secret $name" || true
  done < <(gh secret list -R "$XSHOP_SLUG" 2>/dev/null || true)

  for v in "${OSS_PROD_VAR_NAMES[@]}"; do
    gh variable delete "$v" -R "$XSHOP_SLUG" >/dev/null 2>&1 && ok "deleted var $v" || true
  done
  while IFS=$'\t' read -r name _; do
    [[ -z "${name:-}" || "$name" == "NAME" ]] && continue
    gh variable delete "$name" -R "$XSHOP_SLUG" >/dev/null 2>&1 && ok "deleted var $name" || true
  done < <(gh variable list -R "$XSHOP_SLUG" 2>/dev/null || true)

  log "harden 结束"
}