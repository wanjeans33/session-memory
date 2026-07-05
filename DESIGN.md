# 多端 Agent 会话记忆系统 — 设计

> 目标：让 **Codex CLI / Claude Code CLI / Claude Desktop / 云端 / local** 各端的每次会话，
> 都在**对应项目仓库**里留下一条可检索的进度记录；再由一个技能把这些记录 + 仓库的
> **分支/worktree 状态** + `memory/` 综合成一份 **Project Status**。
>
> 本仓库（`claude-session-memory`）是**基础设施 + 全局记忆**的来源：Node CLI 与技能源码写在这里。
> 全局只安装记忆 import 与 memory-sync hook；`session-memory` skill 则 link 到**对应目标项目仓库**的
> `.claude/skills/` / `.agents/skills/`，运行时把记录写进该目标项目的 `session-history/`。
>
> **实现**：全部为 Node.js（`bin/session-memory.mjs` + `lib/`），一套代码覆盖 Windows / macOS / Linux，
> 只依赖 Node ≥ 20 与 git（不再有 `.ps1`/`.sh` 两套）。

## 已定决策（2026-06-17）

1. **存储位置 = 嵌入每个目标项目仓库**。记录落在 `<project>/session-history/`，随项目一起被 git 管理。
2. **隐私 = digest + 脱敏后的原文**。提交前对 transcript 跑密钥扫描/脱敏（best-effort，见 §5）。

## 已定决策（2026-07-05，多人协作第一阶段）

7. **身份层**：每条 digest 记录 `author`（解析顺序：`SESSION_MEMORY_AUTHOR` 环境变量 →
   `git config user.name` → OS 用户名，规范化为 kebab handle，见 `lib/util/author.mjs`）。
8. **digest schema 升为 2**：新增 `author` 字段；落盘按人分目录
   `digests/<author>/`、`transcripts/<author>/`（并发写互不接触；旧扁平布局仍可读）。
9. **sync 并发安全**：memory-sync 不再 `git add -A`，只提交白名单路径
   （`CLAUDE.md`、`AGENTS.md`、`memory/`、`settings/`、`shared/`、`users/`、`sessions/`）；
   push 被拒时自动 `pull --rebase` 重试（至多 3 次）。
10. **read/get 多人化**：`read --list` 递归扫描并输出 `author` 列，支持 `--author <handle>` 过滤；
    导入标题标签带来源人 `(codex@alice) …`；`build-status` 每分支输出 `authors` 汇总。
11. **skills-only 安装**：`install --skills-only` 只把 skill 链接进目标项目（开启该项目的会话共享），
    不做记忆 junction / CLAUDE.md import / settings / hooks——协作者 clone **公开仓库**即可用，
    不会有任何个人数据被自动 push。CLI 从完整 clone 里运行时自动把该 clone 作为 repo-dir
    （无需先 `init` 或 `--repo-dir`）。

## 已定决策（2026-06-23，交互改为手动命令）
3. **取消一切自动触发**：删除 SessionEnd 采集 hook、删除 skill 的 description 自动触发。
4. **统一为一个手动 skill `session-memory`，三个子命令**：`save`（存会话，问全部/仅当前）、`read`（把其它端会话导入当前端 CLI+Desktop 列表、标题打来源标签）、`get`（综合 STATUS.md，即原 session-share）。
5. **保留 memory-sync 自动**（CLAUDE.md/memory 的 SessionStart 拉取 / SessionEnd 推送 hook 不变）。
6. **skill 安装位置 = 项目本地**：Claude 用 `<project>/.claude/skills/session-memory`，Codex 用 `<project>/.agents/skills/session-memory`，都 link 回本仓库 `skills/session-memory`；不再安装到 `~/.claude/skills` 或 `~/.agents/skills`。

---

## 1. 四层架构

```
采集适配器(每端一个)  →  Normalizer(统一 digest)  →  会话账本 + 分支/worktree 索引  →  session-memory 技能(get) → Project Status
```

> 入口是**手动** skill `session-memory`：`save`（采集，调用下述适配器）、`read`（把账本里其它端会话注入当前端列表）、`get`（综合状态）。无自动 hook。

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
├── digests/                       # 一会话一文件，append-only；按 author 分目录（并发/多人无冲突）
│   └── <author>/
│       └── 2026-06-17_153012-claude-18f57795.json
├── transcripts/                   # 脱敏后的原始记录（可全文检索），同样按 author 分目录
│   └── <author>/
│       └── 2026-06-17_153012-claude-18f57795.jsonl
├── index.json                     # 分支/worktree 状态快照（由 repo-status 生成）
└── STATUS.md                      # 人读项目状态（由 get 生成）
```

**写到哪个 worktree？** 统一写进**主工作树根目录**（= `git rev-parse --path-format=absolute --git-common-dir` 的父目录），
让所有分支/worktree 的会话都汇聚到一处，避免随 feature 分支删除而丢失。digest 里仍如实记录会话实际所在的
分支与 worktree 路径。

**提交策略：** `save` **只写文件，默认不自动 commit**（避免在你正在干活的分支上插入意外提交）。
- 默认：文件出现在工作树里，随你下次正常 commit 带走，或 `get` 时统一 commit。
- 显式提交：`save --commit` 只 `git add session-history/` 后单独提交（绝不 `add -A`）。取代了旧的 `SESSION_HISTORY_AUTOCOMMIT` 环境开关。

**采集触发：** 全手动，无 hook。默认 `save` 采当前会话、`save --all` 扫本机所有端（Claude CLI/Desktop + Codex）。
（旧的"全局/按 repo 采集 hook"与 `enable-capture-here` 已移除。）

---

## 3. 统一 session digest schema

```jsonc
{
  "schema": 2,
  "id": "18f57795-3e91-4acf-88e5-a4fede8e2351",   // 原会话 id
  "tool": "claude-cli",            // claude-cli | claude-desktop | codex | cloud
  "origin": "codex_vscode",        // 细分来源（可空）：vscode / cli / desktop
  "author": "alice",               // 谁存的（v2 新增；决定 digests/<author>/ 落盘位置）
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
  "files_touched": ["lib/commands/sync.mjs", "DESIGN.md"],
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

全部由 `save` 手动驱动（默认 `save` 只采当前会话；`save --all` 调用下面三个适配器全扫）。

| 端 | 原始存储 | 采集模块（由 save 调用） |
|---|---|---|
| **Claude Code CLI / Desktop** | `~/.claude/projects/<encoded>/*.jsonl`（Desktop 也走内置 CLI 写这里） | `lib/capture/claude.mjs`：`scrapeClaude({current})`（cwd 对应项目里最新一条）/ `{all}`（扫全部） |
| **Codex CLI** | `~/.codex/sessions/Y/M/D/rollout-*.jsonl` | `lib/capture/codex.mjs`（按 mtime 增量，游标 `~/.claude/.codex-scrape-cursor`，单位毫秒；旧 .NET ticks 视为过期重扫） |
| **Claude Desktop（元数据增强）** | `%APPDATA%\Claude\claude-code-sessions\**\local_*.json`（macOS：`~/Library/Application Support/Claude/…`）+ 真 transcript 同上 | `lib/capture/desktop.mjs`（按 cliSessionId 找 transcript，复用解析，用 title/branch 增强、去重；游标 `~/.claude/.desktop-scrape-cursor`） |
| **Cloud / iPhone** | 云端 VM / 无本地 | 未做（Cloud）/ 归宿主机 |

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

`lib/commands/repo-status.mjs`（CLI：`repo-status`）对给定仓库输出 `index.json`：

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

`get` 把 `digests/*.json` 按 `git.branch` 挂到对应分支，得到"每条分支/worktree 上有哪些会话、在干什么"。

---

## 7. skill `session-memory`（手动入口）

`skills/session-memory/SKILL.md` 是源码；安装时 link 到目标项目的 `.claude/skills/session-memory` 与 `.agents/skills/session-memory`。
description 写成"仅显式调用"以**不自动触发**。三个子命令：

- **save**：问"全部/仅当前"→ `session-memory save [--all] [--commit]`。
- **read**：把账本里其它端会话注入当前端列表（见 §7.1）。
- **get**：① 跑 `repo-status` 刷 `index.json`；② `build-status` 按分支聚合；③ 读 `memory/`；④ 综合写 `STATUS.md`。

> 所有命令统一为 `node "<repo>/bin/session-memory.mjs" <子命令>`，三端一致。

### 7.1 read — 跨端导入（`lib/commands/read.mjs`，CLI：`read`）
- `--list`：列本项目 `session-history/` 候选（base、tool、machine、title）。
- `--import --ids … --targets cli,desktop`：
  - **Claude 来源**（claude-cli/claude-desktop）：transcript 已是 Claude jsonl → 复制成 `~/.claude/projects/<encode(cwd)>/<新uuid>.jsonl`，首条 user 消息前缀来源标签 `(cli)`/`(desktop)`。
  - **Codex 来源**：rollout 非 Claude 格式 → 生成最小占位 jsonl（first_prompt + 指向脱敏原文的说明），标签 `(codex)`。
  - **CLI 目标**：上面的 jsonl 即可被 `claude --resume` 列出。
  - **Desktop 目标**：在 `%APPDATA%\Claude\claude-code-sessions\<acct>\<wksp>\local_<uuid>.json` 造描述符（`title` 可控、带标签；`cliSessionId` 指向上面 jsonl）；`<acct>/<wksp>` 从现存任一 `local_*.json` 反查。
- **限制**：仅同 OS 导入（cwd 绝对路径/项目编码因 OS 而异，跨 OS 待 path-map）；Codex 为占位非全保真；无现存 Desktop 描述符则跳过 Desktop 目标。

---

## 8. 路线图

- **Phase 0** 收口与版本化：skill 进仓库；建采集适配器层；install 改为 repo-local skill link + 挂 memory-sync hook。
- **Phase 1** Claude CLI 采集 + 脱敏。
- **Phase 2** `repo-status` 分支/worktree 索引。
- **Phase 3** `session-share` 综合技能。
- **Phase 4** Codex 适配器。
- **Phase 5** Desktop 适配器 ✅（`desktop`）；Cloud 适配器（committed `Stop` hook）未做。
- **Phase 6** 硬化：密钥扫描 CI、跨 OS path-map、并发回归。
- **Phase 7** ✅ 交互重构：取消自动触发；统一手动 skill `session-memory`（save/read/get）；新增 read 跨端导入。
- **Phase 8** ✅ 实现重写：`.ps1`/`.sh` 全部移植为一套 Node CLI（`bin/session-memory.mjs` + `lib/`），三端同源；install/sync/采集/索引均原生 Node，去除 jq / PowerShell / bash 依赖。
- **Phase 9** 多人协作。第一阶段 ✅（2026-07-05）：author 身份层 + digest schema v2 +
  `digests/<author>/` 命名空间；sync 白名单提交 + push 重试；read/get 带 author。后续待做：
  - **9b 布局分层**：记忆仓库改为 `shared/`（团队规则/事实，PR 修改）+ `users/<handle>/`
    （个人 CLAUDE.md/memory，只有本人自动同步）+ `sessions/<project>/<handle>/`（集中会话账本，
    feature 分支上的会话对团队即时可见）；install 增加 `--user`，import 双行
    （shared + users/<me>），memory junction 指向 `users/<me>/memory/`。
  - **9c 团队隐私默认值**：`session-memory.config.json`（`mode: personal|team`）；team 模式下
    `save` 默认只存 digest（`--with-transcript` 才存原文）；模板自带 gitleaks CI workflow。
  - **9d MEMORY.md 去冲突**：索引由 CLI 扫 frontmatter 生成（或 `.gitattributes merge=union` 兜底）。

> 已交付：Phase 0–5 + 7 + 8 + 9 第一阶段（Desktop 已含；Cloud、跨 OS path-map、9b–9d 待做）。
