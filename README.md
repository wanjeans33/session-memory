# claude-session-memory

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![platform](https://img.shields.io/badge/Windows-%E2%9C%85%20tested-success)
![platform](https://img.shields.io/badge/macOS%20%2F%20Linux-Node-blue)
![node](https://img.shields.io/badge/Node.js-%E2%89%A520-339933)

**中文** · [English](README.en.md)

跨 **Mac / Windows / iPhone** 同步 Claude Code 的「记忆」：规则与偏好（`CLAUDE.md`）、累积的
记忆事实（`memory/`）。此外还把各端会话沉淀成**按项目的进度记录**（`session-history/`，见「多端会话历史」）。

核心思路：**用一个 git 仓库作为唯一可信源**，通过软链接 / 目录联接（junction）让 Claude Code
**就地**读写这些文件；git 负责跨机同步。这也是唯一能覆盖到 iPhone 的方式（见下文）。

> 🟢 **全部逻辑用 Node.js 实现（一套代码覆盖 Windows / macOS / Linux）**，只依赖 **Node ≥ 20** 与 **git**。
> 不再需要 PowerShell、bash 或 jq——安装、记忆同步、会话采集都走同一个 CLI（`bin/session-memory.mjs`）。

> 🧩 **这是一个公开「模板仓库」。** 别直接往这个公开仓库存你的个人记忆。
> 正确用法：点 **Use this template**（或 fork）生成**你自己的仓库并设为 Private**，再 clone 下来
> 运行安装脚本——你的记忆会同步到**你那个私有仓库**，而不是这里。详见下方「快速开始」。
>
> ⚠️ **存放你个人记忆的那个仓库必须私有。** 安装后 memory-sync 钩子会把 `CLAUDE.md` / `memory/`
> 的个人事实**自动 commit + push** 到它。`.gitignore` 已排除 `.credentials.json` 等凭据——**绝不要**提交任何令牌/密钥。

## 平台支持

| 平台 | 状态 | 说明 |
|---|---|---|
| Windows | ✅ 已端到端验证 | Node ≥ 20 + git；目录联接用 junction（免管理员） |
| macOS / Linux | ✅ 同一套 Node 代码 | Node ≥ 20 + git；用符号链接。无需 jq / bash |
| iPhone | ✅ 云端/远程 | 见下方「iPhone」一节 |

---

## 同步内容一览

| 数据 | 可移植？ | 说明 |
|---|---|---|
| `CLAUDE.md`（规则/偏好） | ✅ | 各机器 `~/.claude/CLAUDE.md` 通过 `@import` 引用 |
| `memory/`（MEMORY.md + 事实文件） | ✅ | 软链接/junction 到本仓库 |
| `settings/settings.shared.json` | ⚠️ | 精选、可移植的设置，合并进本机 settings.json |
| `session-history/`（各项目内） | ⚠️ | 按项目的会话 digest + 脱敏原文，进**目标项目**仓库，非本仓库 |
| 凭据 `.credentials.json` | ❌ | 永不同步 |

### 为什么不做跨系统 resume
每个操作系统把项目绝对路径编码成不同文件夹名（`E:\proj` → `E--proj` vs `/Users/x/proj`），
且记录内嵌绝对路径，所以同一段对话在另一台机器/系统上无法被 Claude Code 识别为可继续会话。
因此我们不追求"实时 resume"，而是把每次会话沉淀成**可检索的进度 digest**（见「多端会话历史」）。

---

## 快速开始

### 0. 从模板创建你自己的**私有**仓库
在 GitHub 上点本仓库的 **Use this template → Create a new repository**，**Visibility 选 Private**
（或 fork 后在 Settings 改成私有）。命名随意。

> 为什么必须私有：安装后 memory-sync 钩子会把你的 `CLAUDE.md` / `memory/` 个人事实
> **自动 commit + push** 到这个仓库。它必须是你私有的，**绝不能**是这个公开模板。
>
> 不想用 GitHub 模板？也可以从零开始：本地 `git init` 后 `gh repo create <名字> --private --source . --push`。

安装入口在三端完全一致——`node bin/session-memory.mjs install`（创建链接 + import + 合并 settings/hooks）。
`session-memory` skill 会安装到你运行命令时所在的目标项目；也可以用 `--project-dir <目标项目路径>` 显式指定。

### 1. 第一台机器（Windows）
```powershell
git clone <你的私有仓库地址> <本地路径>\claude-session-memory
cd <本地路径>\claude-session-memory
node bin/session-memory.mjs install --project-dir <目标项目路径>
```

### 2. 其它机器（macOS / Linux）
```bash
git clone <你的私有仓库地址> ~/Github_project/claude-session-memory
cd ~/Github_project/claude-session-memory
node bin/session-memory.mjs install --project-dir <目标项目路径>
```

### 可选：通过 npm CLI 安装

公开的 npm CLI 只负责安装和维护流程，**不会**发布或上传你的个人记忆。你的记忆仍保存在自己的私有 Git 仓库中。

首次在新机器安装（默认 clone 到 macOS/Linux 的 `~/.local/share/session-memory`，或 Windows 的
`%LOCALAPPDATA%\session-memory`）：

```bash
npx @wanjeans/session-memory init --repo-url <你的私有仓库地址>
```

已有本地 clone 时，不要再 clone 一份，改用：

```bash
npx @wanjeans/session-memory install --repo-dir <本地仓库路径>
```

如果你是在目标项目里打开的会话，可以直接在那个项目目录运行；skill 会装进当前项目。若在别处运行，则显式传入目标项目：

```bash
npx @wanjeans/session-memory install --repo-dir <本地仓库路径> --project-dir <目标项目路径>
```

常用维护命令：

```bash
npx @wanjeans/session-memory doctor
npx @wanjeans/session-memory update
```

所有会修改本机的命令都支持 `--dry-run` 预览；`init` 也可用 `--dir <路径>` 覆盖默认 clone 目录。

`install` 做了什么（三端一致、幂等、可重复运行）：
1. 把 `~/.claude/projects/<编码项目名>/memory` 链接到本仓库 `memory/`（Windows 用 junction，其它用符号链接）；
2. 在 `~/.claude/CLAUDE.md` 写入一行 `@<仓库>/CLAUDE.md` 引用全局规则；
3. 把 `settings/settings.shared.json` 合并进 `~/.claude/settings.json`（修改前自动备份为 `.bak`）；
4. 链接 `skills/` 下技能到目标项目的 `.claude/skills/` 与 `.agents/skills/`（含 `session-memory`），默认目标项目是当前工作目录；**不会**把 skill 安装到 Claude/Codex 全局 skill 目录；
5. 安装 **memory-sync** hooks：**SessionStart** 拉取、**SessionEnd** 提交推送【记忆仓库】（hook 命令即 `node …/bin/session-memory.mjs sync`）。
   （会话采集**不装 hook**——改为手动 `/session-memory save`；install 还会清理历史装过的采集 hook 与旧的 `.ps1/.sh` 同步 hook。）

---

## 日常使用
- 记忆同步**无需手动操作**：开会话时自动 `git pull`，结束时自动 `commit` + `push` 记忆仓库。
- 会话历史是**手动**的：先在当前目标项目里安装 skill；Claude 中运行 `/session-memory save|read|get`，Codex 中运行 `$session-memory save|read|get`。
- 记忆与规则的写入会随 `memory/`、`CLAUDE.md` 一起被提交。
- 手动兜底（同步记忆仓库，任何时候都能跑，三端一致）：
  - `node bin/session-memory.mjs sync`（仅拉取：加 `--pull-only`）
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
├── settings/settings.shared.json
├── skills/
│   └── session-memory/       # 手动 skill 源码：save / read / get 三个子命令
├── bin/session-memory.mjs    # CLI 入口（所有命令的统一入口）
└── lib/                      # Node 实现（一套代码覆盖三端）
    ├── main.mjs              #   命令分发
    ├── args.mjs / paths.mjs  #   参数解析 / 跨平台路径
    ├── commands/             #   install · sync · save · read · repo-status · build-status
    ├── capture/              #   采集适配器：claude · codex · desktop
    └── util/                 #   git · redact · transcript · digest · run
```

CLI 命令一览（详见 `node bin/session-memory.mjs --help`）：

| 命令 | 作用 |
|---|---|
| `init` / `install` / `update` / `doctor` | 安装与维护（克隆、接入、升级、自检） |
| `sync [--pull-only]` | ① 记忆同步：拉取 /（提交 + 推送）记忆仓库（hook 调用） |
| `save [--all] [--commit]` | ② 会话采集：当前 / 全部端会话入 `session-history/` |
| `read --list \| --import --ids …` | ② 跨端导入到当前端列表（CLI + Desktop） |
| `repo-status` / `build-status` | ② 分支/worktree 索引 + 按分支聚合（供 `get` 消费） |

> 两个子系统：**① 记忆同步**（CLAUDE.md + memory，跨机共享稳定规则/事实，**自动**）与
> **② 会话历史**（按项目沉淀进度，**手动** `/session-memory`）。各自独立。

---

## 多端会话历史（session-history）

除了同步「记忆」，本仓库还提供一套**把各端 Agent 会话沉淀成项目进度**的系统（设计见 [DESIGN.md](DESIGN.md)）。
**全手动**，一个 skill `session-memory`，三个子命令（先安装到目标项目的 `.claude/skills/` 或 `.agents/skills/`，再在目标项目里用 `/session-memory <子命令>` 或 `$session-memory <子命令>`）：

- **`/session-memory save`** — 把会话存进**该项目** `session-history/`（digest + 脱敏原文）。会问你：
  保存**全部**端的新会话（扫 Claude CLI/Desktop + Codex）还是只存**当前**这个会话。
- **`/session-memory read`** — 把 `session-history/` 里**其它端**的会话导入**当前端**列表：
  CLI（`claude --resume` 可见）+ Desktop（sidebar），标题前缀来源标签如 `(codex) …`。可选特定或全部。
- **`/session-memory get`** — 综合 `session-history/` + 分支/worktree 索引 + `memory/`，生成 `STATUS.md`：
  哪条分支在做什么、最近会话、未完成线索、下一步。

底层实现：`lib/commands/{save,read,repo-status,build-status}.mjs` + `lib/capture/{claude,codex,desktop}.mjs`。
也可直接命令行跑（如 `node bin/session-memory.mjs save --all`、`… read --list`）。

> **无自动 hook**：采集只在你运行 `save` 时发生（决定取消了一切自动触发）。记忆同步（memory-sync）仍是自动的。

> **隐私**：原文为 **best-effort 脱敏**（密钥/令牌→`[REDACTED:*]`）。`session-history/` 会进**目标项目**仓库，
> 务必保证该仓库私有，并在 CI 加密钥扫描兜底。脱敏不可能 100% 覆盖。
>
> **平台**：实现为纯 Node（一套代码覆盖三端），只依赖 Node ≥ 20 与 git。Windows 已端到端验证；
> macOS/Linux 走同一套代码与同样的命令，首次运行仍建议核对输出。

## 安全
- **只用私有仓库。** `.gitignore` 排除 `.credentials.json`、`*.key`、`*.pem`、`*.token` 等。
- 自检（应输出为空）：
  ```bash
  git log --all --full-history -- '**/.credentials.json'
  ```
