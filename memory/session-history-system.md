---
name: session-history-system
description: 本仓库的多端会话记忆系统：手动 skill session-memory（save/read/get）采集/导入/综合各端会话，按项目存 session-history/
metadata:
  type: project
---

`claude-session-memory` 除自动同步记忆（memory-sync）外，还实现了**多端 Agent 会话历史系统**（架构见仓库 `DESIGN.md`）。

**实现已统一为一套 Node CLI**（`bin/session-memory.mjs` + `lib/`），三端同源，只依赖 Node ≥ 20 与 git。命令形式：`node "<repo>/bin/session-memory.mjs" <子命令>`。

**全手动**，一个 skill `skills/session-memory/`，安装时 link 到目标项目的 `.claude/skills/session-memory` 与 `.agents/skills/session-memory`；
三个子命令（Claude 用 `/session-memory <子命令>`，Codex 用 `$session-memory <子命令>`）：
- **save** → `lib/commands/save.mjs`：默认采当前会话 / `--all`（扫 Claude CLI/Desktop + Codex）；`--commit` 显式提交。
- **read** → `lib/commands/read.mjs`：把本项目 `session-history/` 里其它端会话注入当前端列表
  （CLI `~/.claude/projects/<enc>/<id>.jsonl` + Desktop `local_*.json` 描述符），标题前缀来源标签 `(codex)`/`(cli)`/`(desktop)`。
  `--list` 列候选、`--import --ids … --targets cli,desktop` 导入。Codex 为占位（非全保真）；仅同 OS。
- **get** → 跑 `repo-status` + `build-status` + 读 memory → 写 `session-history/STATUS.md`。

采集适配器在 `lib/capture/`：`claude.mjs`（`scrapeClaude` current/all/transcriptPath）、`codex.mjs`、`desktop.mjs`；
共享层在 `lib/util/`：`redact`（脱敏）+ `git`（Get-GitInfo 等价）+ `transcript`（解析 + `encodeProject` + `splitLines` 去 BOM）+ `digest`（写 digest/提交）。digest schema 见 DESIGN.md §3，写进各项目 `session-history/{digests,transcripts}/`（汇聚到主工作树根）。

**已删除**：旧的 `.ps1`/`.sh` 两套脚本（`scripts/` 整目录）、自动 SessionEnd 采集 hook、`enable-capture-here`、`SESSION_HISTORY_AUTOCOMMIT`、旧 `archive-sessions` 与 `session-sync` 技能、`session-share`（改名 session-memory）。memory-sync 的自动 hook 保留（命令改为 `node …/bin/session-memory.mjs sync`）。

**状态（2026-06-27）**：Node CLI 在 Windows 端到端验证通过（save/repo-status/build-status/read 全链路 + 单元测试）；macOS/Linux 走同一套代码与命令，待本机核对。未做：Cloud 适配、跨 OS path-map（read 目前仅同 OS）。

**多人协作（2026-07-05，第一阶段已实现）**：digest schema v2 增 `author`（`SESSION_MEMORY_AUTHOR` env → `git config user.name` → OS 用户名，`lib/util/author.mjs`），落盘按人分目录 `digests/<author>/`；sync 只提交白名单路径（不再 `add -A`）+ push 被拒自动 rebase 重试；`read --list` 带 author 列与 `--author` 过滤，导入标签 `(tool@author)`；`build-status` 每分支带 `authors`。待做（DESIGN.md Phase 9b–9d）：shared/users 布局分层、team 模式默认只存 digest + gitleaks CI、MEMORY.md 索引生成化。
