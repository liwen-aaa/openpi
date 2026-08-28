# 纪律（disciplines）

> 本文件是**判据集合**，不是说明文档。每条给出：判据（怎么判断违反了）＋ 落点（在哪被强制）。
> 落点为「规约」= 只写在文本里（AGENTS.md / 本文），**接受它会被跳过**（D-02）；落点为路径 / 命令 = 有机制。
>
> 源：本文件从仓库自带的 [`AGENTS.md`](../AGENTS.md) 提炼 —— 它写的是设计立场与承诺，
> 本文把其中**能写出红场景**的部分变成判据，并如实标注哪些已经被机制钉住、哪些还没有。
> **只增不改**：旧条目正文不动，修订另起一条并标注取代关系。编号严格递增（OP-xx）。
>
> 两条机制本地可跑（来自 work-flow 机制包）：
> - `append-only-ledger`：本文件条目只增不减（`node scripts/mech.mjs run`）
> - `wired-check`：下表中声称的 `bun run x` 必须存在且被 CI 每轮调用

## 一、边界与安全

| id | 纪律 | 判据 | 落点 |
|---|---|---|---|
| OP-01 | **每个模型面向工具必须分类** | 任何 `pi.registerTool` 注册的工具不在 `CHILD_EXCLUDED_TOOL_NAMES` 也不在 `CHILD_SAFE_PACKAGE_TOOL_NAMES` = 违反；factory 注册的工具同样必须分类 | `tests/extensions/shared/child-session.test.ts`（fail-closed drift guard，源码扫描，接线前就抓） |
| OP-02 | **子代理能力是 fail-closed 交集** | 子代理工具面 ≠ 父工具面 ∩ 分类白名单；子代理不静默扩大父权限 | `tests/extensions/shared/child-session.test.ts` + `extensions/shared/child-session.ts` |
| OP-03 | **不把模型判断搬进状态机** | 用固定编排 / 关键词路由替代模型判断，而正确性并不要求它 = 违反（AGENTS.md 原文立场） | 规约（评审时人查） |

## 二、配置契约

| id | 纪律 | 判据 | 落点 |
|---|---|---|---|
| OP-10 | **用户可选配置单入口** | 存在 `/openpi-setup` 之外的扩展专属配置命令 = 违反（`/my-pi-setup` 仅作兼容别名） | 规约（评审时人查） |
| OP-11 | **配置变更五处一致** | 新增用户可选模型 / 功能 / 权限 / 主题偏好，而 `extensions/setup/`、`extensions/shared/setup-config.ts`、`/openpi-setup` 状态输出、`SETUP.md`、`README.md` 五处不同步 = 违反 | **规约（当前无机制——风险点，见下）** |
| OP-12 | **Pi host 包保持 peer、不捆绑** | `@earendil-works/pi-ai` / `pi-coding-agent` / `pi-tui` / `typebox` 出现在 dependencies（而非 peerDependencies + devDependencies）= 违反 | `tests/extensions/setup/package-contract.test.ts` |
| OP-13 | **安装必须副作用安全** | 无配置时做模型调用、硬编码 provider/model 默认值、激活非 opt-in 的贵行为 = 违反 | `tests/extensions/setup/package-contract.test.ts` + 规约 |

## 三、仓库纪律

| id | 纪律 | 判据 | 落点 |
|---|---|---|---|
| OP-20 | **验证命令存在且每轮自动跑** | AGENTS.md 声称的 `bun run check` / `bun run test` 不存在于 package.json，或不被 CI / prepublishOnly 调用 = 违反 | `.github/workflows/ci.yml`（每轮）+ `scripts/prepare-effect-tsgo.mjs` + 本地 `node scripts/mech.mjs run`（wired-check） |
| OP-21 | **测试双套件非空** | node:test（`.test.ts`）或 vitest（`.spec.ts`）任一套件为空 = 违反 | `scripts/run-tests.mjs`（两套必须非空，否则抛错） |
| OP-22 | **`as any` 是最后手段** | extensions/ 里出现 `as any` = 违反；tests/ 里出现须有说明（读 Effect 内部结构场景） | 规约（lint 未禁 noExplicitAny）；现状：extensions/ 0 处 ✓，tests/ 11 处（goal/tasks 测试读消息内部结构） |
| OP-23 | **不 `git clean -fdx`** | 用 clean 清理未跟踪文件 = 违反（本地基准运行 / 日志可能是唯一副本） | 规约（AGENTS.md 原文） |
| OP-24 | **诊断前证明运行时来源** | 诊断已安装行为 / provider 兼容性 / 手动 pi 冒烟前，未核对 checkout 修订号与 `pi list` 报告的源码 = 违反 | 规约（无机制——建议做成 skill 或检查脚本，见下） |

## 待迁移 / 未决

- **OP-11 五处一致的机制化**：候选方案是给 `extensions/setup/` 加一个「配置字段 ↔ 文档出现次数」的消费点检查（同 D-52 形状）。当前**无观察到的失败模式**（无证据表明五处已分叉），按 D-40 第①问先留规约。若接受成为贡献项，机制落点进 `tests/extensions/setup/`。
- **OP-24 runtime provenance 的机制化**：候选是一个 `scripts/provenance.mjs`（打印 `git rev-parse HEAD` + `pi list` 的 openpi 源路径 + 两者是否同修订）。
- **平台缺口（本地实测 2026-08-26）**：`tests/extensions/shared/setup-config.test.ts` 的「reused PID」用例在 Windows 上必超时——`queryProcessStartedAt` 的 win32 分支恒 `undefined`，死锁回收的 PID 复用防护在 Windows **从未被验证**。修法三选一：① 该用例 `skip` + 注明 Windows 缺口并开 issue；② Windows 实现进程启动时间查询（PowerShell `Get-Process`）；③ 改判据（进程存活改用别的可判定信号）。这是真实的功能缺口，不只是测试问题。
- **环境缺口（本地实测 2026-08-26）**：仓库无 `.gitattributes`，`core.autocrlf=true` 的环境会把工作区检出成 CRLF，`bun run format:check` 全红。修法：提交 `.gitattributes`（`* text=auto eol=lf`）——对上游是正向贡献，能让 Windows 贡献者第一天不踩墙。
- **本地测试时长**：全量双套件 15+ 分钟（setup-config 单文件 14s，锁类用例每个 5-6s）。日常循环建议分片（`node --test tests/extensions/<dir>`），不要每次全量。
