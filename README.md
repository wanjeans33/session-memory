# claude-session-memory

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![platform](https://img.shields.io/badge/Windows-%E2%9C%85%20tested-success)
![platform](https://img.shields.io/badge/macOS%20%2F%20Linux-Node-blue)
![node](https://img.shields.io/badge/Node.js-%E2%89%A520-339933)

**中文** · [English](README.en.md)

把 Claude Code / Codex 的「会话进度」和「记忆」变成 git 里可同步、可共享的资产。两种用法，按需选择：

| 用法 | 解决什么 | 怎么装 | 需要什么仓库 |
|---|---|---|---|
| **A. 项目会话共享**（团队/多端） | 每次会话沉淀成进度记录，同事和其它端随时接上上下文 | clone 本仓库 → 给目标项目装 skill（一条命令） | 直接用本公开仓库即可 |
| **B. 个人记忆同步**（多机自动） | `CLAUDE.md` 规则 + `memory/` 事实跨 Mac / Windows / iPhone 自动同步 | 从模板建**私有**仓库 → 完整安装 | 必须自己的**私有**仓库 |

> 🟢 全部逻辑为一套 Node CLI（`bin/session-memory.mjs`），Windows / macOS / Linux 同源，
> 只依赖 **Node ≥ 20** 与 **git**。无需 PowerShell / bash / jq。

---

## 用法 A：给项目开启会话共享（最快上手）

直接 clone 本公开仓库即可——skills-only 安装**不会**把你的任何个人数据写进这个 clone：

```bash
git clone https://github.com/wanjeans33/session-memory
cd session-memory
node bin/session-memory.mjs install --skills-only --project-dir <目标项目路径>
```

这会把 `session-memory` skill 链接进目标项目的 `.claude/skills/` 与 `.agents/skills/`。
之后在**目标项目**里开新会话，Claude 用 `/session-memory <子命令>`，Codex 用 `$session-memory <子命令>`：

- **`save`** — 把会话存进该项目的 `session-history/`（digest + 脱敏原文）。会问你存**全部**端的新会话
  （扫 Claude CLI/Desktop + Codex）还是只存**当前**这个；`--commit` 可顺手提交。
- **`read`** — 把 `session-history/` 里**其他人/其它端**的会话导入**当前端**列表
  （CLI `claude --resume` 可见 + Desktop sidebar），标题带来源标签如 `(codex@alice) …`。
- **`get`** — 综合 digest + 分支/worktree 索引 + `memory/`，生成 `STATUS.md`：
  谁在哪条分支做什么、最近会话、未完成线索、下一步。

`session-history/` 随**目标项目**的 git 仓库走：成员正常 push / pull 项目代码，会话进度就同步了。

**多人协作要点**（设计详见 [DESIGN.md](DESIGN.md)）：

- 每条记录带 `author`（默认取 `git config user.name`，环境变量 `SESSION_MEMORY_AUTHOR` 可覆盖），
  按人落盘到 `session-history/digests/<author>/`——多人并发写入**互不冲突**；
- `read --list` 输出 author 列，可 `--author <handle>` 过滤；
- `get` 每条分支带 `authors` 汇总，STATUS.md 直接回答"谁在干什么"。

> ⚠️ **隐私**：`save` 的原文只做 **best-effort 脱敏**（密钥/令牌 → `[REDACTED:*]`），不可能 100% 覆盖，
> 且对项目协作者可读。**目标项目仓库务必私有**，建议在 CI 加密钥扫描（如 gitleaks）兜底。

### 为什么是「进度记录」而不是跨系统 resume
各 OS 把项目绝对路径编码成不同目录名（`E:\proj` → `E--proj` vs `/Users/x/proj`），且记录内嵌绝对路径，
同一段对话在另一台机器上无法被识别为可继续会话。所以我们沉淀**可检索的 digest**，用 `read`/`get` 接上上下文
（`read` 导入目前仅限同 OS）。

---

## 用法 B：个人记忆跨设备自动同步

### 0. 从模板创建你自己的**私有**仓库
点本仓库的 **Use this template → Create a new repository**，**Visibility 选 Private**。

> ⚠️ **为什么必须私有**：完整安装后，memory-sync 钩子会把你的 `CLAUDE.md` / `memory/` 个人事实
> **自动 commit + push** 到这个仓库。绝不能是公开仓库，更不能是本模板。
> 不想用模板也可以从零建：`git init` 后 `gh repo create <名字> --private --source . --push`。

### 1. 每台机器上安装

```bash
git clone <你的私有仓库地址> ~/claude-session-memory   # Windows 路径随意
cd ~/claude-session-memory
node bin/session-memory.mjs install --project-dir <目标项目路径>
```

`install` 做了什么（三端一致、幂等、可重复运行）：

1. 把 `~/.claude/projects/<编码项目名>/memory` 链接到本仓库 `memory/`（Windows 用 junction 免管理员，其它用符号链接）；
2. 在 `~/.claude/CLAUDE.md` 写入 `@<仓库>/CLAUDE.md` import，全局规则对所有项目生效；
3. 把 `settings/settings.shared.json` 合并进 `~/.claude/settings.json`（先备份 `.bak`）；
4. 同用法 A：把 skills 链接进目标项目（`--skills-only` 即只做这一步）；
5. 安装 **memory-sync** hooks：SessionStart 自动拉取、SessionEnd 自动提交推送记忆仓库。
   同步只提交白名单路径（绝不 `git add -A`），push 冲突自动 rebase 重试。

### 可选：npm CLI

公开的 npm CLI 只负责安装/维护流程，**不会**上传你的个人记忆：

```bash
npx @wanjeans/session-memory init --repo-url <你的私有仓库地址>   # 首次：clone + 安装
npx @wanjeans/session-memory install --repo-dir <本地仓库路径>     # 已有 clone
npx @wanjeans/session-memory doctor                               # 自检
npx @wanjeans/session-memory update                               # 升级
```

所有改动本机的命令都支持 `--dry-run` 预览。

### 日常使用
- 记忆同步**零操作**：开会话自动 `git pull`，结束自动 `commit + push`。
- 手动兜底：`node bin/session-memory.mjs sync`（仅拉取加 `--pull-only`）。
- 会话历史仍是**手动**的（见用法 A 的 save / read / get）。

### iPhone
iPhone 上没有本地 Claude Code，两条路径：

1. **Remote Control** —— Claude iOS App 接管你 Mac/Windows 上的会话，自动使用那台机器已同步的记忆。
2. **云端**（claude.ai/code）—— 云端 VM 克隆你的私有仓库并读取 `CLAUDE.md` 和 `memory/`。
   注意 `MEMORY.md` 仅自动加载前 ~200 行 / 25KB；云端看不到你本地的 `~/.claude`。

---

## 同步内容一览

| 数据 | 去哪 | 说明 |
|---|---|---|
| `CLAUDE.md`（规则/偏好） | 记忆仓库（用法 B） | 各机器经 `@import` 引用 |
| `memory/`（MEMORY.md + 事实文件） | 记忆仓库（用法 B） | 软链接/junction 就地读写 |
| `settings/settings.shared.json` | 记忆仓库（用法 B） | 精选可移植设置，合并进本机 |
| `session-history/`（digest + 脱敏原文） | **目标项目**仓库（用法 A） | 按项目、按 author 落盘 |
| 凭据 `.credentials.json` 等 | ❌ 永不同步 | `.gitignore` 排除 |

## 目录结构与 CLI

```
.
├── CLAUDE.md                 # 全局规则/偏好（用法 B 被同步）
├── DESIGN.md                 # 架构与 digest schema
├── memory/                   # 文件式记忆：MEMORY.md 索引 + 每条事实一个文件
├── settings/settings.shared.json
├── skills/session-memory/    # 手动 skill：save / read / get
├── bin/session-memory.mjs    # CLI 入口
└── lib/                      # Node 实现（commands / capture / util）
```

| 命令 | 作用 |
|---|---|
| `install [--skills-only] [--project-dir …]` | 安装（skills-only = 只给项目装 skill） |
| `init` / `update` / `doctor` | clone 接入 / 升级 / 自检 |
| `sync [--pull-only]` | 记忆同步（hook 自动调用） |
| `save [--all] [--commit]` | 会话采集入 `session-history/` |
| `read --list [--author …] \| --import --ids …` | 列出 / 导入其他人与其它端的会话 |
| `repo-status` / `build-status` | 分支索引 + 按分支聚合（供 `get` 消费） |

完整参数见 `node bin/session-memory.mjs --help`。

## 平台支持

| 平台 | 状态 |
|---|---|
| Windows | ✅ 端到端验证（junction 免管理员） |
| macOS / Linux | ✅ 同一套 Node 代码（符号链接） |
| iPhone | ✅ 经 Remote Control / 云端（见用法 B） |

## 安全
- 存个人记忆（用法 B）与团队会话（用法 A 的目标项目）的仓库**都必须私有**。
- `.gitignore` 排除 `.credentials.json`、`*.key`、`*.pem`、`*.token` 等；**绝不要**提交令牌/密钥。
- 自检（应输出为空）：
  ```bash
  git log --all --full-history -- '**/.credentials.json'
  ```
