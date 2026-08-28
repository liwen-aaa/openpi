# OpenPI 代码分析：上手与验证

> 本文回答三件事：这项目是什么、本地怎么验证、以及**功能改动会落在哪个模块**。
> 模块依赖关系图见 [`architecture.md`](architecture.md)（按实测 import 绘制）。
> 判据台账 [`disciplines.md`](disciplines.md)（哪些承诺已被机制钉住、哪些没有）。
> 本地机制检查：`node <work-flow路径>/scripts/mech.mjs run`（见 [`mech.json`](mech.json)）。
>
> **定位**：本目录是对上游 openpi 的**只读分析**，不做工程演进、不向上游提交。
> 所有观察以「读代码 + 本地实测」为依据；不修改 `extensions/`、`tests/`、README 等上游已跟踪文件。

## 1. 这是什么

**OpenPI 不是机器人项目，是 Pi 的扩展工作台。** 它是 `@tt-a1i/openpi`（MIT，0.4.0）——
一组 Pi-native 扩展，让 Pi 具备后台终端、子代理、可恢复工作流、持续任务。它自己的定位
（AGENTS.md 原文）：**Pi-native 能力层，不是第二个 agent 操作系统**——在 Pi 现有接缝上扩展，
模型持判断、运行时持可强制的事实。

技术栈（已实测）：Bun 1.3.14（依赖与脚本）+ Biome（格式/lint）+ TypeScript 7 + Effect
（所有扩展用 Effect 管理副作用与错误通道）+ node:test 与 vitest 双测试套件。`tsconfig.json`
在根目录唯一，扩展目录**不允许**局部 tsconfig。

## 2. 扩展地图（按依赖方向读）

| 扩展 | 规模（ts 行） | 一句话职责 |
|---|---|---|
| `shared/` | 5372 | 公共层：子代理策略（child-session.ts）、配置（setup-config.ts）、终端清洗、worktree、UI 渲染件。**改任何扩展前先看它有没有用到 shared** |
| `workflows/` | 10111 | 最大块：DSL、Ledger、Graph、Replay、Artifacts。多代理工作的编排与证据链 |
| `subagents/` | 5030 | Pi-native 子代理：Backend、角色、/subagents 命令、工具面分类（child-safe/excluded） |
| `background-terminals/` | 3390 | 长进程、日志、/ps。不阻塞主 agent 的后台执行 |
| `sessions/` | 2748 | Session 搜索与切换、tasks panel |
| `goal/` | 2378 | 持续目标（跨回合推进的工作项） |
| `file-search/` | 1576 | fd/rg 与安全二进制获取 |
| `tasks/` | 1641 | 工作项（batch 化、结果投递） |
| `setup/` | 502 | /openpi-setup 单入口 + 受限配置工具 |
| `plan-mode/` | 1116 | 批准门禁（plan → 执行） |
| `git-info/` `git-read/` | 867+638 | 只读 git 元数据与内容 |
| `suggestions/` | 817 | 下一步动作的临时建议 |
| `ui-customization/` | 744 | Header/Footer/终端标题 |
| `ask-user/` | 1544 | 人工确认输入与 handoff |
| 其余（cron / context-pivot / capabilities / copy-all / file-mutation-display / model-info / post-edit / turn-time / user-input-fold / workspace-cleanup-guard） | <500 各 | 小能力：定时 prompt、定向压缩、能力发现、活动渲染等 |

扩展数：**25 个**。入口统一是每个目录的 `index.ts`；`tests/extensions/<dir>/` 镜像同名。

各扩展之间的调用与依赖方向见 [`architecture.md`](architecture.md)。一处易错点先说：`workflows`
**不**调用 `subagents` 运行时，两者各自用 Pi SDK 的 `createAgentSession()` 起子会话，只共享
`subagents/src/agent-types.ts` 的角色与模型解析。

## 3. 本地验证（实测数据，Windows）

| 命令 | 时长 | 说明 |
|---|---|---|
| `bun install --frozen-lockfile` | ~18s | 216 包 |
| `bun run typecheck` | ~1.2s | 有 Effect warnings 但 exit 0（file-search 的 globalErrorInEffectFailure 是已知噪音） |
| `bun run check` | ~1s | format + lint + typecheck 三连。**前提：工作区必须 LF**（见下） |
| `bun run test` | 15+ 分钟 | 双套件全量。日常分析循环**别跑全量**，分片：`node --test --experimental-strip-types tests/extensions/<dir>/*.test.ts`（node 套件）、`node node_modules/vitest/vitest.mjs run tests/extensions/<dir>/*.spec.ts`（vitest 套件） |
| `node <work-flow>/scripts/mech.mjs run` | <1s | 本地机制检查（判据台账 + CI 接线验证） |
| `node analysis/scripts/check-config-contract.mjs` | <1s | 本目录自建：配置契约三层检查（OP-11 的可行性质证，见第 5 节） |

**Windows 第一天必踩的坑**：仓库没有 `.gitattributes`，全局 `core.autocrlf=true` 会把工作区
检出成 CRLF，`bun run format:check` 全红。本地已修（`git config core.autocrlf false`
+ 重建 index + 重检出）。这是环境问题而非代码问题，记录在案。

**已知平台失败**：`tests/extensions/shared/setup-config.test.ts` 的「reused PID」用例在 Windows
必超时（win32 分支查不到进程启动时间）。别修它来让自己绿——详见 disciplines.md 未决节。

## 4. 改动会落在哪（读代码时的追踪路径）

分析一个功能怎么实现、或推演一处改动的影响面时，按下面的路径追：

**一个模型面向工具是怎么接入的**：
1. 归属扩展目录的 `index.ts` 里的 `pi.registerTool` 注册点；
2. `extensions/shared/child-session.ts` 的分类——每个工具必在 `CHILD_SAFE_PACKAGE_TOOL_NAMES`
   或 `CHILD_EXCLUDED_TOOL_NAMES`；drift guard 扫源码，未分类即测试红（fail-closed，OP-01）；
3. `tests/extensions/<dir>/` 下的行为测试与工具边界测试（子代理视角）。

**一个用户可选配置项的落点**：五处联动（OP-11）——`extensions/setup/`、`shared/setup-config.ts`、
`/openpi-setup` 状态输出、`SETUP.md`、`README.md`。上游无机制盯这五处；本目录
`analysis/scripts/check-config-contract.mjs` 是对该缺口的可机检近似（当前三层全绿）。

**`shared/` 里被多扩展引用的东西**：先 `grep -rln 'from "../shared/xxx' extensions` 找全消费方
（`architecture.md` 文末备有复算命令）；shared 的测试在 `tests/extensions/shared/`，
锁 / 配置 / 子代理策略都在这里，是最重的一块。

## 5. 机制层（本地分析工具，非上游内容）

- [`disciplines.md`](disciplines.md)：判据台账。已钉住的（OP-01/02/12/20/21）有测试或 CI 兜底；
  标「规约」的（OP-03/10/11/22/23/24）**接受被跳过**——这是观察结论，记录哪些承诺只写在文本里。
- [`mech.json`](mech.json) + 机制包：`append-only-ledger`（台账只增不减）+ `wired-check`（声称的命令
  存在且被 CI 调用）。跑法：`node <work-flow>/scripts/mech.mjs run`。
  注意 `mech.json` 现在位于本目录，外部运行器需显式指向该路径。
- `scripts/check-config-contract.mjs` + `tests/config-contract.test.ts`：针对 OP-11 缺口写的
  三层检查（字段表⊆实现引用／字段→文档关键词映射／README 保留入口），6 个 fixture 用例
  覆盖绿与三种红形状。跑法见第 3 节。
- 记录新判据的门槛：有被观察到的失败模式 + 写得出会红的输入。写不出就不进台账。

## 6. 已识别的缺陷与缺口（观察记录）

以下是分析过程中在上游发现的真实问题，按证据强度排序。**仅作记录，不提交上游**。

1. **Windows 功能缺口（已实测）**：`tests/extensions/shared/setup-config.test.ts` 的「reused PID」
   用例在 Windows 必超时——`queryProcessStartedAt` 的 win32 分支恒返回 `undefined`，
   意味着**死锁回收的 PID 复用防护在 Windows 从未被验证**。这是功能缺口，不只是测试问题。
2. **`.gitattributes` 缺失（已实测根因）**：`core.autocrlf=true` 环境检出即 CRLF，格式检查全红。
   一行文件（`* text=auto eol=lf`）即可根治，当前不存在。
3. **OP-11 五处一致无机制**：配置字段与文档的同步全靠人工。本目录的契约脚本证明了可机检
   （当前 13 字段三层全绿，说明尚未分叉，但无护栏）。
4. **OP-24 runtime provenance 无机制**：README 要求诊断前核对 checkout 修订与 `pi list` 来源，
   但无脚本兜底。可机检形状：`git rev-parse HEAD` + `pi list` 的 openpi 源路径 + 两者是否同修订。
5. **`as any` 分布**：`extensions/` 零处（干净），`tests/` 11 处，集中在 goal/tasks 测试读
   Effect 消息内部结构处；lint 未禁 `noExplicitAny`，靠规约维持。

## 7. 参考资料

- [`architecture.md`](architecture.md)：模块关系图（mermaid）+ 依赖边的复算命令
- `AGENTS.md`（上游自带）：设计立场 + 特性决策测试（六问）+ 仓库工作规则——**读代码前先读**
- `README.md` 599 行「仓库结构与开发」：目录说明与工具链
- `docs/design/`：上游的工作流 v2、tasks、session tasks 设计记录
- `docs/research/`：上游的 Claude Code 工作流 fanout 与 runtime contract 调研
