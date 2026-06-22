---
name: session-memory
description: 手动会话记忆命令，含 save / read / get 三个子命令。仅当用户【显式】输入 `/session-memory save|read|get`（或明确说"运行 session-memory 的 save/read/get"）时才使用；不要因为用户随口问进度、提到保存会话等就自动触发——这是一个手动命令，不自动运行。
---

# session-memory — 手动会话记忆命令（save / read / get）

**仅手动触发。** 用户显式调用 `/session-memory <子命令>` 时，按下面对应流程执行。
不要自动触发；若用户只是闲聊式提到进度/记忆，提示他们可运行 `/session-memory get` 等，但不要自己跑。

底层脚本在仓库 `scripts/session-history/`（Windows 用 `.ps1`，macOS/Linux 用 `.sh`）。
先确定本仓库路径 `<repo>`（即 claude-session-memory 的安装路径）。

---

## save — 保存会话到本项目 session-history/

1. **先问用户范围**：「保存**全部**端的新会话，还是只保存**当前**这个会话？」
2. 按回答执行（在目标项目目录下）：
   - 仅当前：`powershell -NoProfile -ExecutionPolicy Bypass -File "<repo>/scripts/session-history/save.ps1" -Current`
   - 全部：`… save.ps1 -All`（扫 Claude CLI/Desktop + Codex）
   - macOS/Linux：`bash "<repo>/scripts/session-history/save.sh" [--all]`
3. 想顺带提交：加 `-Commit`（mac `--commit`），仅 `-Current` 有意义。
4. 把脚本输出（写入了哪些 digest）转述给用户。

## read — 把其它端的会话导入当前端列表

1. **列候选**：`… read.ps1 -List`（mac `read.sh --list`）→ 得到 JSON 数组（base、tool、machine、title）。
2. 把候选**呈现给用户**，问他要导入**哪些**（可全部）。注意标出每条的来源端（tool）。
3. **导入**：`… read.ps1 -Import -Ids <base1,base2,…> -Targets cli,desktop`
   （mac `read.sh --import --ids … --targets cli,desktop`）。
   - 导入后：CLI 端 `claude --resume` 可见该会话；Desktop 端 sidebar 出现，标题前缀来源标签如 `(codex) …`。
   - **限制**：仅同 OS 导入；Codex 来源是占位会话（含摘要 + 指向脱敏原文），非全保真；
     Desktop 注入需机器上已有任一 `local_*.json` 以反查账号目录，否则自动跳过 Desktop。
4. 转述导入结果（写了哪些文件、哪些目标）。

## get — 综合项目状态（STATUS.md）

1. 刷新分支/worktree 索引：`… repo-status.ps1`（mac `repo-status.sh`）。
2. 取聚合数据：`… build-status.ps1 [-Days N]`（mac `build-status.sh [N]`）→ 按分支分组的紧凑 JSON。
3. 读 `memory/MEMORY.md`（及相关事实文件）。
4. 综合写出 `session-history/STATUS.md`：每条分支/worktree 在做什么、最近会话（时间·工具·改了哪些文件）、
   ahead/behind、未完成线索/下一步；末尾跨分支观察。digest 的 `summary` 为空时由你据 first_prompt+files+next_steps 归纳一句。

## 注意
- 隐私：`transcripts/` 已 best-effort 脱敏；引用原文时勿把 `[REDACTED:*]` 当真值。
- 没有 `session-history/` 时：说明该项目尚未 save 过，引导先 `/session-memory save`。
- 跨端/跨机：同一项目可能有 Windows/Mac、Claude/Codex 的多条 digest，按 `tool` + `machine` 区分。
