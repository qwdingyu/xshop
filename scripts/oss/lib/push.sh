#!/usr/bin/env bash
# 增量提交到 xshop（基于现有历史叠加新 commit，而非孤儿提交）

oss_push_xshop() {
  local src="${1:-}"
  local work tmp token url
  local source_sha
  need_cmd git

  if [[ -z "$src" || ! -d "$src" ]]; then
    die "push 需要导出目录"
  fi

  token="${OSS_SYNC_TOKEN:-}"
  if [[ -z "$token" ]]; then
    info "未设置 OSS_SYNC_TOKEN，尝试使用当前 gh/git 凭据"
  fi

  # 构建 clone/push URL
  if [[ -n "$token" ]]; then
    url="https://x-access-token:${token}@github.com/${XSHOP_SLUG}.git"
  else
    url="https://github.com/${XSHOP_SLUG}.git"
  fi

  # 获取源 commit SHA（CI 中为 GITHUB_SHA，本地为 git rev-parse HEAD）
  source_sha="${GITHUB_SHA:-}"
  if [[ -z "$source_sha" ]]; then
    source_sha="$(git -C "$(repo_root)" rev-parse --short HEAD 2>/dev/null || echo "unknown")"
  else
    # GITHUB_SHA 是完整 SHA，截取短格式
    source_sha="${source_sha:0:7}"
  fi

  tmp="$(mktemp -d)"
  work="$tmp/xshop-clone"

  # 尝试克隆 xshop 当前状态（增量提交）
  # 捕获 stderr 以区分"仓库不存在"（首次同步）和"网络/认证错误"
  local clone_output
  clone_output="$(git clone --depth=1 --branch "$XSHOP_BRANCH" "$url" "$work" 2>&1)" && {
    log "克隆成功，基于现有历史增量提交（${XSHOP_SLUG}:${XSHOP_BRANCH}）"
  } || {
    if echo "$clone_output" | grep -qiE "not found|repository not found|could not read from remote"; then
      # 仓库不存在或为空：首次同步，创建孤儿提交
      log "仓库为空或不存在，创建首次提交"
      mkdir -p "$work"
      git -C "$work" init
      git -C "$work" checkout -b "$XSHOP_BRANCH"
    else
      # 其他错误（网络、认证等）：中止
      die "克隆失败: ${clone_output}"
    fi
  }

  # 配置 git 身份
  git -C "$work" config user.email "noreply@users.noreply.github.com"
  git -C "$work" config user.name "cf-shop-oss-sync"

  # 清除所有已跟踪文件（保留 .git 目录），准备接收新导出树
  # 先用 git rm 从索引和工作树中删除已跟踪文件，再用 find 清理残留
  git -C "$work" rm -r --quiet --ignore-unmatch . 2>/dev/null || true
  find "$work" -mindepth 1 -not -path '*/\.git/*' -not -name '.git' -delete 2>/dev/null || true

  # 复制新导出树
  cp -R "$src"/. "$work"/

  # 添加并提交
  git -C "$work" add -A
  local commit_msg
  commit_msg="oss: sync from cf-shop@${source_sha} ($(date -u +%Y-%m-%dT%H:%MZ))"
  local commit_output
  commit_output="$(git -C "$work" commit -m "$commit_msg" 2>&1)" && {
    # 新 commit 已创建，推送
    git -C "$work" remote add origin "$url" 2>/dev/null || git -C "$work" remote set-url origin "$url"
    log "push ${XSHOP_SLUG}:${XSHOP_BRANCH}"
    git -C "$work" push origin "HEAD:${XSHOP_BRANCH}"
    local commit_count
    commit_count="$(git -C "$work" rev-list --count HEAD 2>/dev/null || echo "?")"
    log "push 完成（累计 ${commit_count} 个 commit）"
  } || {
    # 提交失败：可能是"nothing to commit"（树未变化），也可能是其他错误
    if echo "$commit_output" | grep -qi "nothing to commit"; then
      log "导出树与 xshop 当前状态一致，跳过推送"
    else
      die "提交失败: ${commit_output}"
    fi
  }

  rm -rf "$tmp"
}