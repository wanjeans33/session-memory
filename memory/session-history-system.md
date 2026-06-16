---
name: session-history-system
description: 本仓库的多端会话记忆系统：采集各端会话 digest 进各项目 session-history/，session-share 技能综合项目状态
metadata:
  type: project
---

`claude-session-memory` 除同步记忆外，还实现了**多端 Agent 会话历史系统**（架构见仓库 `DESIGN.md`）。

- 采集适配器在 `scripts/capture/`：`claude-session-end`（Claude CLI 的 SessionEnd hook）、
  `codex-scrape`（扫 `~/.codex/sessions/` 的 rollout，增量游标 `~/.claude/.codex-scrape-cursor`）、
  `_lib`（脱敏 + git 信息 + 写 digest）。
- 每会话产出一条统一 digest（schema 见 DESIGN.md §3）+ 脱敏原文，写进**目标项目自己**的
  `session-history/{digests,transcripts}/`（汇聚到主工作树根）。
- `scripts/repo-status` 出分支/worktree 索引；`scripts/build-status` 按分支聚合。
- `skills/session-share` 技能读 digests+索引+memory → 生成 `STATUS.md`（项目进度）。

**状态（2026-06-17）**：Windows(.ps1) 已端到端验证；macOS(.sh) 依赖 jq/perl，**尚未验证**。
未做：Desktop / Cloud 适配（Phase 5）。相关：[[ps1-utf8-bom]]。
