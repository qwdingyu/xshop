#!/usr/bin/env bash
# orphan 单提交 force-push 到 xshop

oss_push_xshop() {
  local src="${1:-}"
  local work tmp token url
  need_cmd git
  need_cmd gh

  if [[ -z "$src" || ! -d "$src" ]]; then
    die "push 需要导出目录"
  fi

  token="${OSS_SYNC_TOKEN:-}"
  if [[ -z "$token" ]]; then
    # 尝试从 gh 登录推送（本地）
    info "未设置 OSS_SYNC_TOKEN，尝试使用当前 gh/git 凭据"
  fi

  tmp="$(mktemp -d)"
  work="$tmp/xshop-orphan"
  mkdir -p "$work"
  # 复制导出树
  cp -R "$src"/. "$work"/
  git -C "$work" init
  git -C "$work" checkout -b "$XSHOP_BRANCH"
  git -C "$work" config user.email "noreply@users.noreply.github.com"
  git -C "$work" config user.name "cf-shop-oss-sync"
  git -C "$work" add -A
  git -C "$work" commit -m "chore: scrubbed snapshot from private cf-shop ($(date -u +%Y-%m-%dT%H:%MZ))"

  if [[ -n "$token" ]]; then
    url="https://x-access-token:${token}@github.com/${XSHOP_SLUG}.git"
  else
    url="https://github.com/${XSHOP_SLUG}.git"
  fi
  git -C "$work" remote add origin "$url"

  if [[ "$OSS_FORCE_PUSH" == "1" ]]; then
    log "force-push orphan → ${XSHOP_SLUG}:${XSHOP_BRANCH}"
    git -C "$work" push -f origin "HEAD:${XSHOP_BRANCH}"
  else
    die "OSS_FORCE_PUSH!=1，拒绝 push"
  fi
  rm -rf "$tmp"
  log "push 完成"
}