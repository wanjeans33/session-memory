---
name: session-history-system
description: 本仓库的多端会话记忆系统：手动 skill session-memory（save/read/get）采集/导入/综合各端会话，按项目存 session-history/
metadata:
  type: project
---

`claude-session-memory` 除自动同步记忆（memory-sync）外，还实现了**多端 Agent 会话历史系统**（架构见仓库 `DESIGN.md`）。

**全手动**，一个 skill `skills/session-memory/`，三个子命令（`/session-memory <子命令>`）：
- **save** → `scripts/session-history/save.*`：`-Current`（采当前会话）/ `-All`（扫 Claude CLI/Desktop + Codex）；`-Commit` 显式提交。
- **read** → `scripts/session-history/read.*`：把本项目 `session-history/` 里其它端会话注入当前端列表
  （CLI `~/.claude/projects/<enc>/<id>.jsonl` + Desktop `local_*.json` 描述符），标题前缀来源标签 `(codex)`/`(cli)`/`(desktop)`。
  Codex 为占位（非全保真）；仅同 OS。
- **get** → 跑 `repo-status` + `build-status` + 读 memory → 写 `session-history/STATUS.md`（即原 session-share）。

适配器在 `scripts/session-history/capture/`：`claude-scrape`（-Current/-All/-TranscriptPath）、`codex-scrape`、`desktop-scrape`、
`_lib`（脱敏 + git + 共享解析 `Get-ClaudeTranscriptInfo` + 写 digest + `Get-EncodedProject`）。digest schema 见 DESIGN.md §3，写进各项目 `session-history/{digests,transcripts}/`（汇聚到主工作树根）。

**已删除**：自动 SessionEnd 采集 hook、`enable-capture-here`、`SESSION_HISTORY_AUTOCOMMIT`、旧 `archive-sessions` 与 `session-sync` 技能、`session-share`（改名 session-memory）。memory-sync 的自动 hook 保留。

**状态（2026-06-23）**：Windows(.ps1) save/read/get 端到端验证通过；macOS(.sh) 依赖 jq/perl/uuidgen，**尚未本机验证**。
未做：Cloud 适配、跨 OS path-map（read 目前仅同 OS）。相关：[[ps1-utf8-bom]]。
