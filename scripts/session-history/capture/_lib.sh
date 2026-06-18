#!/usr/bin/env bash
# 共享库（bash）：脱敏、git 信息、写 digest。依赖：jq、perl（macOS 自带）。
# ⚠️ 未在 Windows 开发机验证（无 bash/jq）。在 macOS/Linux 首次运行请核对输出。

# 逐行 best-effort 脱敏（见 DESIGN.md §5）：stdin -> stdout
redact() {
  perl -pe '
    s/-----BEGIN[^-]*PRIVATE KEY-----.*?-----END[^-]*PRIVATE KEY-----/[REDACTED:private-key]/g;
    s/sk-ant-[A-Za-z0-9_-]{20,}/[REDACTED:anthropic-key]/g;
    s/sk-(?:proj-)?[A-Za-z0-9_-]{20,}/[REDACTED:openai-key]/g;
    s/gh[pousr]_[A-Za-z0-9]{30,}/[REDACTED:github-token]/g;
    s/xox[baprs]-[A-Za-z0-9-]{10,}/[REDACTED:slack-token]/g;
    s/AKIA[0-9A-Z]{16}/[REDACTED:aws-key]/g;
    s/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/[REDACTED:jwt]/g;
    s/(authorization"?\s*[:=]\s*"?\s*bearer\s+)[A-Za-z0-9._-]+/$1[REDACTED:bearer]/gi;
    s/((?:password|passwd|api[_-]?key|secret|access[_-]?token|token)"?\s*[:=]\s*"?)[^"\s,}]{6,}/$1[REDACTED]/gi;
  '
}
redact_str() { printf '%s' "$1" | redact; }

# 设置全局：GIT_BRANCH GIT_HEAD GIT_DIRTY GIT_IS_WORKTREE GIT_WORKTREE GIT_MAIN_ROOT
git_info() {
  local cwd="$1"
  GIT_BRANCH=""; GIT_HEAD=""; GIT_DIRTY=false; GIT_IS_WORKTREE=false; GIT_WORKTREE=""; GIT_MAIN_ROOT=""
  [ -n "$cwd" ] && [ -d "$cwd" ] || return 1
  local top; top=$(git -C "$cwd" rev-parse --path-format=absolute --show-toplevel 2>/dev/null) || return 1
  [ -n "$top" ] || return 1
  local common; common=$(git -C "$cwd" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
  GIT_MAIN_ROOT=$(cd "$(dirname "$common")" && pwd)
  [ "$top" != "$GIT_MAIN_ROOT" ] && GIT_IS_WORKTREE=true
  [ "$GIT_IS_WORKTREE" = true ] && GIT_WORKTREE="${top#"$GIT_MAIN_ROOT"/}"
  GIT_BRANCH=$(git -C "$cwd" rev-parse --abbrev-ref HEAD 2>/dev/null)
  GIT_HEAD=$(git -C "$cwd" rev-parse --short HEAD 2>/dev/null)
  [ -n "$(git -C "$cwd" status --porcelain 2>/dev/null)" ] && GIT_DIRTY=true
  return 0
}

os_name() {
  case "$(uname -s)" in Darwin) echo macos;; Linux) echo linux;; *) echo unknown;; esac
}

# $1=base 文件名（无扩展名） $2=digest JSON 字符串 $3=脱敏 transcript 文件(可空) $4=项目根
write_digest() {
  local base="$1" digest_json="$2" redacted_file="$3" root="$4"
  [ -n "$root" ] || { echo "write_digest: root required" >&2; return 1; }
  local hist="$root/session-history"
  mkdir -p "$hist/digests"
  if [ -n "$redacted_file" ] && [ -f "$redacted_file" ]; then
    mkdir -p "$hist/transcripts"
    cp "$redacted_file" "$hist/transcripts/$base.jsonl"
  fi
  printf '%s\n' "$digest_json" > "$hist/digests/$base.json"
  if [ "${SESSION_HISTORY_AUTOCOMMIT:-}" = "1" ]; then
    git -C "$root" add -- session-history 2>/dev/null || true
    if [ -n "$(git -C "$root" status --porcelain -- session-history 2>/dev/null)" ]; then
      git -C "$root" commit -q -m "chore(session-history): $base" -- session-history 2>/dev/null || true
    fi
  fi
  echo "$hist/digests/$base.json"
}

# 由 ended_at + tool + id 生成 base 文件名
digest_base() {
  local ended="$1" tool="$2" id="$3"
  local stamp idc
  stamp=$(date -u -d "$ended" "+%Y-%m-%d_%H%M%S" 2>/dev/null || date -u -j -f "%Y-%m-%dT%H:%M:%S" "${ended%%.*}" "+%Y-%m-%d_%H%M%S" 2>/dev/null || echo unknown)
  idc=$(printf '%s' "$id" | tr -cd 'A-Za-z0-9' | cut -c1-8)
  echo "${stamp}-${tool}-${idc}"
}
