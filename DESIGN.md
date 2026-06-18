# 多端 Agent 会话记忆系统 — 设计

> 目标：让 **Codex CLI / Claude Code CLI / Claude Desktop / 云端 / local** 各端的每次会话，
> 都在**对应项目仓库**里留下一条可检索的进度记录；再由一个技能把这些记录 + 仓库的
> **分支/worktree 状态** + `memory/` 综合成一份 **Project Status**。
>
> 本仓库（`claude-session-memory`）是**基础设施 + 全局记忆**的来源：脚本与技能写在这里，
> 安装后 link 到各机器的 `~/.claude/`，运行时把记录写进**各目标项目**的 `session-history/`。

## 已定决策（2026-06-17）

1. **存储位置 = 嵌入每个目标项目仓库**。记录落在 `<project>/session-history/`，随项目一起被 git 管理。
2. **隐私 = digest + 脱敏后的原文**。提交前对 transcript 跑密钥扫描/脱敏（best-effort，见 §5）。
3. **首批范围 = Phase 0 + 1 + 3 + 4**：收口/版本化、Claude CLI 采集、session-share 技能、Codex 适配。

---

## 1. 四层架构

```
采集适配器(每端一个)  →  Normalizer(统一 digest)  →  会话账本 + 分支/worktree 索引  →  session-share 技能 → Project Status
```

| 层 | 职责 | 产物 |
|---|---|---|
| 采集 | 把"一次会话"从各端原始格式抽出来 | 原始 transcript 引用 |
| Normalizer | 统一成一条 session digest | `session-history/digests/*.json` |
| 账本 + 索引 | 按项目累积 digest；枚举分支/worktree 状态 | `digests/`、`index.json` |
| 综合技能 | digest + 索引 + memory → 人读状态 | `session-history/STATUS.md` |

---

## 2. 存储布局（在**每个目标项目**仓库内）

```
<project-root>/session-history/
├── digests/                       # 一会话一文件，append-only（天然无并发冲突）
│   └── 2026-06-17_153012-claude-18f57795.json
├── transcripts/                   # 脱敏后的原始记录（可全文检索）
│   └── 2026-06-17_153012-claude-18f57795.jsonl
├── index.json                     # 分支/worktree 状态快照（由 repo-status 生成）
└── STATUS.md                      # 人读项目状态（由 session-share 生成）
```

**写到哪个 worktree？** 统一写进**主工作树根目录**（= `git rev-parse --path-format=absolute --git-common-dir` 的父目录），
让所有分支/worktree 的会话都汇聚到一处，避免随 feature 分支删除而丢失。digest 里仍如实记录会话实际所在的
分支与 worktree 路径。

**提交策略：** 采集 hook **只写文件，默认不自动 commit**（避免在你正在干活的分支上插入意外提交）。
- 默认：文件出现在工作树里，随你下次正常 commit 带走；或由 `session-share` 技能统一 commit。
- 可选自动提交：设环境变量 `SESSION_HISTORY_AUTOCOMMIT=1` 时，采集脚本只 `git add session-history/` 后单独提交（绝不 `add -A`）。

**采集范围（开关）：** Claude CLI 采集 hook 装在哪决定它对哪些项目生效——
- **global**（默认）：写进用户级 `~/.claude/settings.json`，对**所有**项目会话生效（`install-* -CaptureScope global` / `CAPTURE_SCOPE=global`）。
- **repo**：不装全局 hook；由 `scripts/session-history/enable-capture-here.*` 把 hook 写进**单个仓库**的 `.claude/settings.local.json`（本地、不提交，含本机绝对路径）。
两者互斥（避免一次会话采两条）；切到 global 时安装脚本会清掉自己之前可能装的全局采集 hook 的重复项。

---

## 3. 统一 session digest schema

```jsonc
{
  "schema": 1,
  "id": "18f57795-3e91-4acf-88e5-a4fede8e2351",   // 原会话 id
  "tool": "claude-cli",            // claude-cli | claude-desktop | codex | cloud
  "origin": "codex_vscode",        // 细分来源（可空）：vscode / cli / desktop
  "machine": "windows-desktop",    // 主机名
  "os": "windows",                 // windows | macos | linux
  "project": "claude-session-memory",
  "cwd": "E:/Github_project/claude-session-memory/.claude/worktrees/peaceful-swartz-8d932a",
  "git": {
    "branch": "claude/peaceful-swartz-8d932a",
    "is_worktree": true,
    "worktree": ".claude/worktrees/peaceful-swartz-8d932a",
    "head": "2af4ccd",
    "dirty": true
  },
  "started_at": "2026-06-17T15:20:00Z",
  "ended_at":   "2026-06-17T15:30:12Z",
  "turns": 12,                     // 用户回合数（粗略）
  "first_prompt": "嗯我现在想明白这一个架构…",   // 截断到 ~200 字
  "summary": "",                   // 一句话；采集时留空，由技能懒生成
  "files_touched": ["scripts/memory-sync/sync.ps1", "DESIGN.md"],
  "tools_used": {"Edit": 9, "Bash": 4, "Write": 3},
  "next_steps": [],                // 可由技能填
  "transcript_ref": "session-history/transcripts/2026-06-17_153012-claude-18f57795.jsonl"
}
```

**字段来源**
- Claude CLI：transcript 每行内嵌 `cwd`/`gitBranch`/`sessionId`/`timestamp`；`files_touched` 来自 `assistant` 行
  里 `tool_use`（`Edit`/`Write`/`NotebookEdit`）的 `input.file_path`；`first_prompt` = 第一条非 meta 的 user 文本。
- Codex：首行 `session_meta.payload` 给 `id`/`cwd`/`timestamp`/`originator`；`git.*` 用 `cwd` 现算（best-effort）。
- Desktop：`local_*.json` 元数据给 `cliSessionId`/`cwd`/`branch`/`title`/`completedTurns`；按 `cliSessionId` 找到真 transcript 后复用 Claude 解析。digest 额外带 `title` 字段。

---

## 4. 各技术栈采集方式

| 端 | 原始存储 | 触发 | 采集脚本 |
|---|---|---|---|
| **Claude Code CLI** | `~/.claude/projects/<encoded>/*.jsonl` | `SessionEnd` hook（stdin 给 `transcript_path`/`cwd`/`session_id`） | `scripts/session-history/capture/claude-session-end.{ps1,sh}` |
| **Codex CLI** | `~/.codex/sessions/Y/M/D/rollout-*.jsonl` | 无 hook → `config.toml` 的 `notify`，或手动/定时 | `scripts/session-history/capture/codex-scrape.{ps1,sh}`（按 mtime 增量，游标存 `~/.claude/.codex-scrape-cursor`） |
| **Claude Desktop** | `%APPDATA%\Claude\claude-code-sessions\**\local_*.json`（元数据：cliSessionId/cwd/branch/title…）+ 真 transcript 在 `~/.claude/projects/<encoded>/<cliSessionId>.jsonl` | 无 hook → 按需 scrape | `scripts/session-history/capture/desktop-scrape.{ps1,sh}`（按 cliSessionId 找 transcript，复用 Claude 解析，用 title/branch 增强；对已被 CLI hook 采过的同会话去重；游标 `~/.claude/.desktop-scrape-cursor`） |
| **Cloud / local** | 云端 VM，克隆本仓 | committed `Stop` hook | （Phase 5，未做） |
| **iPhone** | 无本地（Remote Control 跑在宿主机） | 跟随宿主机 | 归到宿主机那台，不单独采集 |

> 不追求"跨端实时 resume"——各 OS 把项目绝对路径编码成不同文件夹名，且记录内嵌绝对路径，技术上做不到。
> 我们采集的是**可检索的进度**。

---

## 5. 脱敏（best-effort）

提交 transcript 前替换为 `[REDACTED:<label>]`，覆盖：

- 私钥块 `-----BEGIN ... PRIVATE KEY-----`
- Anthropic `sk-ant-…`、OpenAI `sk-…`、GitHub `gh[pousr]_…`、Slack `xox[baprs]-…`、AWS `AKIA…`
- JWT `eyJ…\.…\.…`
- `password=…` / `api[_-]?key=…` / `token=…` / `secret=…`（key=value 形式）
- `Authorization: Bearer …`

> 局限：脱敏不可能 100% 覆盖。这是用户已接受的取舍。**目标项目仓库务必为私有**，并在 CI 加密钥扫描兜底。

---

## 6. 分支 / worktree 状态索引

`scripts/session-history/repo-status.{ps1,sh}` 对给定仓库输出 `index.json`：

```jsonc
{
  "generated_at": "2026-06-17T...",
  "head": "2af4ccd",
  "worktrees": [
    {"path": ".", "branch": "main", "head": "2af4ccd", "dirty": false},
    {"path": ".claude/worktrees/peaceful-swartz-8d932a", "branch": "claude/peaceful-swartz-8d932a", "head": "2af4ccd", "dirty": true}
  ],
  "branches": [
    {"name": "main", "head": "2af4ccd", "ahead": 0, "behind": 0, "last_commit": "2026-06-17T..."},
    {"name": "claude/peaceful-swartz-8d932a", "ahead": 1, "behind": 0, "last_commit": "..."}
  ]
}
```

`session-share` 技能把 `digests/*.json` 按 `git.branch` 挂到对应分支，得到"每条分支/worktree 上有哪些会话、在干什么"。

---

## 7. session-share 技能（Phase 3）

`skills/session-share/SKILL.md`，流程：
1. 跑 `repo-status` 刷新 `index.json`。
2. 读全部 `digests/*.json`，按分支/worktree 分组。
3. 读 `memory/`（稳定事实）。
4. 综合出 `STATUS.md`：每条分支/worktree 当前在做什么、最近会话、未完成线索、建议下一步；
   把稳定结论沉淀回 `memory/`。
5. 可选：commit `session-history/`。

---

## 8. 路线图

- **Phase 0** 收口与版本化：skill 进仓库；建 `scripts/session-history/capture/`；install 改为 link skills + 挂 hook。
- **Phase 1** Claude CLI 采集 + 脱敏。
- **Phase 2** `repo-status` 分支/worktree 索引。
- **Phase 3** `session-share` 综合技能。
- **Phase 4** Codex 适配器。
- **Phase 5** Desktop 适配器 ✅（`desktop-scrape`）；Cloud 适配器（committed `Stop` hook）未做。
- **Phase 6** 硬化：密钥扫描 CI、跨 OS path-map、并发回归。

> 已交付：Phase 0–5（Desktop 已含；Cloud 待做）。
