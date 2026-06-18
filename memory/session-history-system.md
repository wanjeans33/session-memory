---
name: session-history-system
description: 本仓库的多端会话记忆系统：采集各端会话 digest 进各项目 session-history/，session-share 技能综合项目状态
metadata:
  type: project
---

`claude-session-memory` 除同步记忆外，还实现了**多端 Agent 会话历史系统**（架构见仓库 `DESIGN.md`）。

- 采集适配器在 `scripts/session-history/capture/`：`claude-session-end`（Claude CLI 的 SessionEnd hook）、
  `codex-scrape`（扫 `~/.codex/sessions/` rollout）、`desktop-scrape`（扫 `%APPDATA%\Claude\claude-code-sessions\`
  元数据，按 cliSessionId 找真 transcript，去重已被 CLI 采过的同会话）、
  `_lib`（脱敏 + git 信息 + 共享 transcript 解析 `Get-ClaudeTranscriptInfo` + 写 digest）。
- 每会话产出一条统一 digest（schema 见 DESIGN.md §3）+ 脱敏原文，写进**目标项目自己**的
  `session-history/{digests,transcripts}/`（汇聚到主工作树根）。
- `scripts/session-history/repo-status` 出分支/worktree 索引；`scripts/session-history/build-status` 按分支聚合。
- 旧的全量归档（archive-sessions）与 session-sync 技能已删除，统一由 capture 收口。
- `skills/session-share` 技能读 digests+索引+memory → 生成 `STATUS.md`（项目进度）。

**状态（2026-06-19）**：Windows(.ps1) 已端到端验证（含 Desktop 采集）；macOS(.sh) 依赖 jq/perl，**尚未验证**。
未做：Cloud 适配（云端 committed Stop hook）。相关：[[ps1-utf8-bom]]。
