# session-memory

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![node](https://img.shields.io/badge/Node.js-%E2%89%A520-339933)

**中文** · [English](README.en.md)

把 Claude Code、Claude Desktop 和 Codex 的项目会话放进 Git，并在别的客户端或设备继续。

schema 4 只做三件事：

1. 把原生 transcript 归一化为 canonical events；
2. 用稳定的 `logical_id` 表示同一段对话，用不可变 revision 表示每次变化；
3. `read` 把某个 revision 写回目标客户端，并嵌入一个小型 marker。

同一语义内容的 hash 已存在于当前项目历史时，`save` 是 no-op。`read` 后没有继续对话，再
`save` 也不会重复写入。只有出现新的真实用户内容，才会在原 `logical_id` 下新增 revision。

`$session-memory save` / `/session-memory save` 这类纯控制轮及其工具、确认输出不算会话内容；同一
条消息里若还有真实任务，则真实任务仍会保存。

要求：Node.js 20+、Git。所有项目命令都以当前 checkout 的
`git rev-parse --show-toplevel` 为根；linked worktree 使用自己的分支和 `session-history/`。

## 安装

只启用项目会话能力：

```bash
git clone https://github.com/wanjeans33/session-memory
cd session-memory
node bin/session-memory.mjs install --skills-only --project-dir <目标项目>
```

这会链接：

- Claude Code：`/session-memory save|read|get`
- Codex：`$session-memory save|read|get`

也可从目标项目直接运行：

```bash
node "<session-memory仓库>/bin/session-memory.mjs" <command>
```

## 最短工作流

设备 A 保存并发布当前会话：

```bash
node "<repo>/bin/session-memory.mjs" save --publish
```

设备 B 用正常 Git 流程更新项目，再列出和导入：

```bash
git pull
node "<repo>/bin/session-memory.mjs" read --list --scope team
node "<repo>/bin/session-memory.mjs" read --import --ids <logical-id> --targets codex --scope team
```

在导入的原生 session 中继续对话，再运行 `save`。marker 会让新 revision 回到原来的
`logical_id`，不会另起一条逻辑会话。

`read` 不会自动 pull、stash、rebase 或丢弃工作树修改。

## save

```bash
node "<repo>/bin/session-memory.mjs" save --current
node "<repo>/bin/session-memory.mjs" save --all
node "<repo>/bin/session-memory.mjs" save --current --codex-session-id <native-id>
```

- 默认保存当前 checkout 中的当前 session。
- 若运行时提供 `CODEX_THREAD_ID` / `CODEX_SESSION_ID`，必须精确匹配；显式 native ID 不存在或
  属于其他 checkout 时直接失败，不回退到另一条 session。
- `save --all` 扫描所有受支持客户端，但只保存 cwd 属于当前 checkout 的 session。
- canonical content hash 已存在于当前项目历史：0 个新 revision。
- schema-4 marker 指向的 revision/hash 可在当前项目历史验证，且 hash 与当前内容相同：0 个新 revision。
- 内容延续某个已存 revision：写入一个不可变子 revision。
- 内容不延续任何已存 revision：停止并要求先 `read` 正确分支，不猜父节点。

`save` 只写本地；`--commit` 只提交 `session-history/`；`--publish` 再 push 当前分支。三种结果
分别报告。`save --all` 不与 `--commit` / `--publish` 组合。

## read

```bash
node "<repo>/bin/session-memory.mjs" read --list --scope mine
node "<repo>/bin/session-memory.mjs" read --list --scope team
node "<repo>/bin/session-memory.mjs" read --import --all --targets claude-code,codex --scope team
```

`read` 靠 schema-4 marker 或已存 revision 的 `(tool, native_session_id)` 识别原生文件，不维护项目侧 replica/binding/checkpoint。
无 marker 的旧副本仅在恰好匹配一条 legacy 会话时识别；0 或多条匹配会警告并忽略，随后可新建带 marker 的副本，绝不按位置猜测。

每个目标的 upsert 规则：

- 不存在：创建原生 session，并嵌入 schema-4 marker；
- 已是目标 revision 或 canonical content hash 相同：跳过；
- 当前内容恰好是任一已存 revision：视为 clean，保留 native ID 原地更新；
- 当前内容不属于任何已存 revision：视为未保存 continuation，阻止覆盖；
- 有多个 head：阻止自动选择，必须对一个 `logical_id` 使用 `--revision <revision-id>`。

不存在强制复制选项；重复导入不会通过额外副本解决侧边栏排序或分页。

`read --list` 返回逻辑 ID、选择的 revision、owner、来源、head、冲突状态和当前原生 ID。`--pending`
只表示当前 Codex native store 没有匹配项，不等于导入失败。客户端侧边栏可能只显示最近子集，需按
输出的 native ID 验证。

没有 5 条或其他内部上限。11 条不同且无冲突的逻辑会话经过
`save --all → read --list --scope team → read --import --all` 后仍应是 11 条；任何过滤、缺失或冲突
都必须明确报告。

## 数据模型

```text
session-history/
└── v4/sessions/<logical-id>/
    ├── events/<revision-id>.jsonl
    └── revisions/<revision-id>.json
```

- `logical_id`：项目内稳定的对话身份。新原生会话由 canonical client + native ID 确定；导入后
  由 marker 跨客户端延续。
- events：不可变的 `user_message`、`assistant_message`、`tool_call`、`tool_result`。
- revision metadata：父 revision、不可变 owner、作者/角色/设备/来源、event 数和 content hash。
- head：由 parent 引用推导，没有可变的 `latest` 文件。

项目中不再写 `project.json`、`replicas/`、checkpoint 或 `imported_line_count`。schema-4 marker 只携带
逻辑/版本/内容身份及来源元数据，原生文件仍由各客户端拥有。

## 身份、范围与冲突

建议为多人/多设备配置：

```bash
node "<repo>/bin/session-memory.mjs" save \
  --author alice --actor alice --device alice-laptop --role developer
```

对应环境变量为 `SESSION_MEMORY_AUTHOR`、`SESSION_MEMORY_ACTOR_ID`、
`SESSION_MEMORY_DEVICE_ID`、`SESSION_MEMORY_ROLE`。handle 会做 NFKC、转小写，支持 Unicode
字母/数字和 `._-`；纯 emoji/标点的显式值会失败。

`mine` 按不可变 owner 过滤，`team` 选择仓库中全部会话；legacy 没有 actor 时，`mine` / `--owner`
回退比较 owner 名称。它们不是权限控制。来源筛选另有 `--source-author`、`--source-role`。两台设备
从同一 revision 各自继续会形成两个 head，不会自动拼接或覆盖；导入时用 `--revision` 明确选一个。

## 兼容与安全

- schema 1/2/3 只读兼容；schema 4 是唯一新写格式。v3 与 v4 revision 合并为同一 DAG，首次 v4
  continuation 可 parent 到 v3，其他旧 head 不会被隐藏。旧文件不删除、不原地改写。
- canonical events 和 revision metadata 会提交到项目仓库；内容仅做 best-effort 脱敏，敏感项目
  应使用私有仓库和 secret scanning。
- ledger 与 native store 写入都检查 realpath、拒绝路径穿越和 symlink/junction 逃逸，并通过同目录
  临时文件 + rename 原子替换。Codex SQLite 不会被修改。
- 写操作使用按 checkout realpath 区分的进程锁；异常退出留下 stale lock 时，先确认无 writer，
  再删除错误消息给出的精确锁文件。
- 扫描只忽略不存在的目录（`ENOENT`）；权限、`ENOTDIR` 和其他 I/O 错误会失败，不能把 11 条
  悄悄报告成 5 条。

## 其他命令

| 命令 | 用途 |
|---|---|
| `repo-status` | 写入分支/worktree 索引 |
| `build-status [--days N]` | 按逻辑会话输出项目状态 |
| `get` skill 流程 | 生成 `session-history/STATUS.md` |
| `doctor` / `update` | 检查或更新安装 |

完整参数：`node bin/session-memory.mjs --help`。个人 `CLAUDE.md` / `memory/` 同步是独立的可选模式；
不使用 `--skills-only` 的完整安装才会启用它。
