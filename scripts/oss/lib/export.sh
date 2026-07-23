#!/usr/bin/env bash
# 从 private HEAD 导出脱敏树到目录
# 用法: oss_export_to <outdir>

oss_export_to() {
  local outdir="$1"
  local root ref
  need_cmd git
  root="$(repo_root)"
  ref="${OSS_EXPORT_REF:-HEAD}"
  rm -rf "${outdir}"
  mkdir -p "${outdir}"

  log "export ${ref} -> ${outdir} (exclude docs/packages/secrets)"
  local path
  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    if oss_should_exclude "$path"; then
      continue
    fi
    # 仅跟踪文件
    if git -C "$root" cat-file -e "${ref}:${path}" 2>/dev/null; then
      mkdir -p "${outdir}/$(dirname "$path")"
      git -C "$root" show "${ref}:${path}" > "${outdir}/${path}"
    fi
  done < <(git -C "$root" ls-tree -r --name-only "$ref")

  # 剥离 schedule
  if [[ "${OSS_STRIP_SCHEDULE}" == "1" ]]; then
    local f
    while IFS= read -r -d '' f; do
      if grep -qE '^[[:space:]]*schedule:' "$f" 2>/dev/null; then
        python3 - "$f" <<'PY'
import re, sys
p = sys.argv[1]
text = open(p, encoding='utf-8').read()
lines = text.splitlines(True)
out, skip, base = [], False, None
for i, line in enumerate(lines):
    if re.match(r'^(\s*)schedule:\s*$', line):
        skip = True
        base = len(re.match(r'^(\s*)', line).group(1))
        continue
    if skip:
        m = re.match(r'^(\s*)', line)
        ind = len(m.group(1)) if m else 0
        if line.strip() == '' or ind > base:
            continue
        skip = False
    out.append(line)
open(p, 'w', encoding='utf-8').writelines(out)
print('stripped schedule:', p)
PY
      fi
    done < <(find "${outdir}/.github/workflows" -type f \( -name '*.yml' -o -name '*.yaml' \) -print0 2>/dev/null || true)
  fi

  # 基础 scrub：内部邮箱
  if command -v python3 >/dev/null 2>&1; then
    python3 - "${outdir}" <<'PY'
import os, sys
root = sys.argv[1]
repls = [
    ("xshop contributors <noreply@users.noreply.github.com>", "xshop contributors <noreply@users.noreply.github.com>"),
    ("noreply@users.noreply.github.com", "noreply@users.noreply.github.com"),
]
for dp, _, files in os.walk(root):
    for fn in files:
        path = os.path.join(dp, fn)
        try:
            data = open(path, 'rb').read()
        except Exception:
            continue
        if b'\0' in data[:2048]:
            continue
        try:
            text = data.decode('utf-8')
        except Exception:
            continue
        orig = text
        for a, b in repls:
            text = text.replace(a, b)
        if text != orig:
            open(path, 'w', encoding='utf-8').write(text)
PY
  fi

  # 安全门：导出树不得含 docs/
  if [[ -d "${outdir}/docs" ]]; then
    die "export result contains docs/, aborted"
  fi
  if [[ -f "${outdir}/.env" ]]; then
    die "export result contains .env, aborted"
  fi
  local fcount
  fcount="$(find "${outdir}" -type f | wc -l | tr -d ' ')"
  log "export complete: ${fcount} files"
}