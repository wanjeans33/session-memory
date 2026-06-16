# claude-session-memory

跨 **Mac / Windows / iPhone** 同步 Claude Code 的「记忆」：规则与偏好（`CLAUDE.md`）、累积的
记忆事实（`memory/`）、以及作为归档的历史会话记录（`sessions/`）。

核心思路：**用一个私有 git 仓库作为唯一可信源**，通过软链接 / 目录联接（junction）让 Claude Code
**就地**读写这些文件；git 负责跨机同步。这也是唯一能覆盖到 iPhone 的方式（见下文）。

> ⚠️ **必须使用私有仓库。** `.gitignore` 已排除 `.credentials.json` 等凭据——**绝不要**提交任何令牌/密钥。

---

## 同步内容一览

| 数据 | 可移植？ | 说明 |
|---|---|---|
| `CLAUDE.md`（规则/偏好） | ✅ | 各机器 `~/.claude/CLAUDE.md` 通过 `@import` 引用 |
| `memory/`（MEMORY.md + 事实文件） | ✅ | 软链接/junction 到本仓库 |
| `settings/settings.shared.json` | ⚠️ | 精选、可移植的设置，合并进本机 settings.json |
| `sessions/`（`*.jsonl`） | ⚠️ | **仅作归档/检索**，跨系统**无法自动 `--resume`**（见下） |
| 凭据 `.credentials.json` | ❌ | 永不同步 |

### 为什么会话记录不能跨系统 resume
每个操作系统会把项目绝对路径编码成不同的文件夹名（`E:\proj` → `E--proj` vs `/Users/x/proj`），
且记录内部嵌入了绝对路径。所以同一段对话在另一台机器/系统上无法被 Claude Code 识别为可继续的会话。
我们只把它们当作**可搜索的历史归档**保存在 `sessions/<os>/` 下。

---

## 安装

### 1. 第一台机器（Windows，源机器）
```powershell
cd E:\Github_project\claude-session-memory
git init
git add -A
git commit -m "init"
# 创建私有 GitHub 仓库并推送（用 gh，或在网页建好后 git remote add）
gh repo create claude-session-memory --private --source . --push
# 接入 Claude Code（创建 junction + import + 合并 settings/hooks）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-windows.ps1
```

### 2. 其它机器（macOS）
```bash
git clone <你的私有仓库地址> ~/Github_project/claude-session-memory
cd ~/Github_project/claude-session-memory
bash scripts/install-mac.sh        # 需要 jq 才能自动合并 settings/hooks：brew install jq
```

安装脚本做了什么（两端一致、幂等、可重复运行）：
1. 把 `~/.claude/projects/<编码项目名>/memory` 链接到本仓库 `memory/`；
2. 在 `~/.claude/CLAUDE.md` 写入一行 `@<仓库>/CLAUDE.md` 引用全局规则；
3. 把 `settings/settings.shared.json` 合并进 `~/.claude/settings.json`（修改前自动备份为 `.bak`）；
4. 安装 hooks：**SessionStart** 拉取最新、**SessionEnd** 归档会话并提交推送。

---

## 日常使用
- 平时**无需手动操作**：开会话时自动 `git pull`，结束时自动归档 + `commit` + `push`。
- 记忆与规则的写入会随 `memory/`、`CLAUDE.md` 一起被提交。
- 手动兜底（任何时候都能跑）：
  - Windows：`powershell -File scripts\sync.ps1`
  - macOS：`bash scripts/sync.sh`
- 让记忆对**所有项目**生效：`~/.claude/CLAUDE.md` 的 import 已实现全局加载（其中又 import 了
  `memory/MEMORY.md`）。

---

## iPhone

iPhone 上**没有本地 Claude Code**，两条可用路径：

1. **Remote Control（远程控制）** —— 在 Claude iOS App 里接管运行于你 Mac/Windows 上的会话。
   计算发生在那台已同步的机器上，所以**自动使用其本地（已同步）记忆**，手机端无需任何配置。
2. **云端网页**（claude.ai/code）—— 会话跑在 Anthropic 云端 VM，会**克隆这个私有仓库**并读取
   提交的 `CLAUDE.md` 和 `memory/`。把最有用、最稳定的事实放进 `CLAUDE.md` / `memory/MEMORY.md`，
   云端会话启动即加载（`MEMORY.md` 仅自动加载前 ~200 行 / 25KB，更深的事实文件按需读取）。
   云端 VM **看不到**你本地的 `~/.claude`。

---

## 目录结构
```
.
├── CLAUDE.md                 # 全局规则/偏好（被同步）
├── DESIGN.md                 # 多端会话记忆系统的架构与 digest schema
├── memory/                   # 文件式记忆：MEMORY.md 索引 + 每条事实一个文件
├── sessions/{windows,mac}/   # 旧：全局会话归档（只读/检索）
├── settings/settings.shared.json
├── skills/                   # 被同步的技能：session-sync（备份）、session-share（项目状态）
└── scripts/
    ├── install-* / sync.* / archive-*     # 记忆仓库的安装与同步
    ├── capture/               # 采集适配器：claude-session-end / codex-scrape / _lib
    ├── repo-status.*          # 枚举分支/worktree -> session-history/index.json
    └── build-status.*         # 汇聚 digests 按分支分组（供 session-share 消费）
```

---

## 多端会话历史（session-history）

除了同步「记忆」，本仓库还提供一套**把各端 Agent 会话沉淀成项目进度**的系统（设计见 [DESIGN.md](DESIGN.md)）：

- **采集**：每次会话结束，hook 把该会话抽成一条 **digest**（分支/worktree/commit、改了哪些文件、
  首条 prompt、工具统计）+ **脱敏后的原文**，写进**该项目自己**的 `session-history/` 目录。
  - Claude Code CLI：`SessionEnd` hook → `scripts/capture/claude-session-end.*`（安装脚本自动挂上）。
  - Codex CLI：无 hook，跑 `scripts/capture/codex-scrape.*` 增量扫 `~/.codex/sessions/`（手动 / 定时 / `config.toml` 的 notify）。
- **综合**：`session-share` 技能读 `session-history/` + 分支/worktree 索引 + `memory/`，
  生成 `STATUS.md`：哪条分支在做什么、最近哪些会话碰过、未完成线索、建议下一步。
  - 直接问 Claude：「这个项目做到哪了 / 各分支在干什么 / 生成项目状态」。

> **隐私**：原文为 **best-effort 脱敏**（密钥/令牌→`[REDACTED:*]`）。`session-history/` 会进**目标项目**仓库，
> 务必保证该仓库私有，并在 CI 加密钥扫描兜底。脱敏不可能 100% 覆盖。
>
> **平台**：Windows（`.ps1`）已在本机端到端验证。**macOS/Linux 的 `.sh` 版本依赖 `jq`/`perl`，
> 尚未在本机验证**——首次在 Mac 上运行请核对输出。

## 安全
- **只用私有仓库。** `.gitignore` 排除 `.credentials.json`、`*.key`、`*.pem`、`*.token` 等。
- 自检（应输出为空）：
  ```bash
  git log --all --full-history -- '**/.credentials.json'
  ```
