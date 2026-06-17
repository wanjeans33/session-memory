---
name: session-share
description: 综合一个项目的会话历史(session-history/) + 分支/worktree 状态 + memory，生成「项目进度(Project Status)」。当用户问"这个项目做到哪了 / 哪条分支在干什么 / 各 session 都做了什么 / 同步项目进度 / 生成项目状态"时使用。
---

# session-share — 把会话历史 + 分支状态 + 记忆，综合成项目进度

读取**当前项目** `session-history/` 里各端（Claude CLI / Codex / Desktop / Cloud）沉淀的会话
digest，结合仓库的**分支 / worktree 状态**与 `memory/`，产出一份人读的 `STATUS.md`：
**哪条分支/worktree 在做什么、最近哪些会话碰过、未完成线索、建议下一步。**

> 数据怎么进来的：各端的采集 hook（见仓库 `scripts/capture/`）在会话结束时把 digest 写进
> `session-history/digests/`，脱敏原文写进 `session-history/transcripts/`。本技能只**消费**这些数据。

## 步骤

1. **定位项目**：在目标项目仓库内运行（worktree 也可，脚本会自动汇聚到主工作树根）。

2. **刷新分支/worktree 索引**：
   - Windows：`powershell -NoProfile -ExecutionPolicy Bypass -File "<repo>/scripts/repo-status.ps1"`
   - macOS/Linux：`bash "<repo>/scripts/repo-status.sh"`
   生成 `session-history/index.json`。

3. **取汇聚数据**（按分支分组、含每会话关键字段，避免逐个读 digest）：
   - Windows：`powershell -NoProfile -ExecutionPolicy Bypass -File "<repo>/scripts/build-status.ps1" [-Days N]`
   - macOS/Linux：`bash "<repo>/scripts/build-status.sh" [N]`
   stdout 是紧凑 JSON：`{ index, branches:[{branch, session_count, sessions:[…]}] }`。

4. **读 `memory/MEMORY.md`**（及相关事实文件）拿稳定背景。

5. **综合 `STATUS.md`** 写到 `session-history/STATUS.md`，结构建议：
   - 顶部：仓库名、生成时间、HEAD、活跃 worktree 列表。
   - 每条**分支/worktree** 一节：在做什么（综合 digest 的 first_prompt/summary/files）、
     最近会话（时间·工具·改了哪些文件）、ahead/behind、**未完成线索 / 建议下一步**。
   - 末尾：跨分支的整体观察（重复工作、可合并项、停滞分支）。
   - digest 里 `summary` 为空时，由你依据 `first_prompt` + `files` + `next_steps` 归纳一句话。

6. **可选**：把稳定结论沉淀进 `memory/`（项目级事实）；若用户要，`git add session-history/` 后单独提交。

## 注意

- 跨端/跨机：同一项目可能有 Windows/Mac、Claude/Codex 的多条 digest，按 `tool` + `machine` 区分。
- 隐私：`transcripts/` 已 best-effort 脱敏；若要引用原文片段，注意不要把 `[REDACTED:*]` 当真实值。
- 没有 `session-history/` 时：说明该项目尚未接入采集 hook，引导去跑仓库的安装脚本。
