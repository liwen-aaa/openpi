# 分模块优化机会（未认领部分）

> 本文件是**只读分析**，不修改上游、不提交上游。每条给出：位置（file:line）＋ 观察到的形状 ＋ 为什么是问题 ＋ 可行方向。
> **认领过滤**：已被 PR 或 issue 评论认领的条目不在本文分析范围内，仅在第零节列出以避免重复劳动。
> 认领状态核验于 GitHub API（open PR 的引用/分支名 + issue assignee + 评论）。**认领状态会变，动手前请重新核验。**
> 核验基线：当前 checkout（`git status` 干净，仅 `analysis/` 未跟踪）。

## 零、已认领：不在本文分析范围

| issue | 认领方 | 内容 |
|---|---|---|
| #188 | **PR #210**（Sun-GLiang） | `model-info` 每次 refresh 全量扫 branch → 增量聚合 |
| #189 | 评论认领（6iKUN6，2026-08-27） | settled strip 仍每 120ms/500ms 请求全局重绘 |
| #184 | 评论认领（testikun，2026-08-26，含实现方向） | replay journal 反复完整序列化（O(n²)） |
| #71 / #110 | assignee somewan820（#71 另有 PR #208） | Workflow 终态持久化与 artifact 原子性 |
| #153 / #158 / #171 / #132 / #72 | PR #209 / #203 / #205 / #139 / #149 | setup episode、post-edit、stalled turn、wait 别名、终端清洗 |

这五个 perf 条目里已有三个被认领（#184、#188、#189），且都是最容易定位的那几个。
剩余四个 perf issue（#182、#183、#185、#187）无评论、无 assignee、无 PR 引用。

## 规模分布（判断优先级的基数）

| 扩展 | 行数 | 占比 |
|---|---:|---:|
| `workflows/` | 10111 | 24.7% |
| `shared/` | 5372 | 13.1% |
| `subagents/` | 5030 | 12.3% |
| `background-terminals/` | 3390 | 8.3% |
| `sessions/` | 2748 | 6.7% |
| `goal/` | 2378 | 5.8% |
| 其余 19 个扩展 | 11827 | 28.9% |
| **合计** | **40856** | 100% |

---

## 一、`sessions`：git stats 无界 subprocess fan-out —— #187（空缺）

`extensions/sessions/git-stats.ts:213-222`

```ts
return Promise.all(sessions.map((session) => loadOne(session, ...)))
```

`loadOne` 内部走 `execFile`（第 102 行）。`Promise.all` 对 session 列表**无并发上限**地铺开，
session 多时会同时 fork 出等量 git 进程。第 208-212 行按 `latestByCwd` 去重已收敛了一层，
但去重后的基数仍然无界——一个用过很多项目目录的用户，`/sessions` 会一次性 fork 出几十个 git。

Windows 上进程创建成本显著高于 Linux，这里更敏感。

**方向**：固定并发闸（4–8）的 worker pool。`signal: AbortSignal` 已在 `loadOne` 签名里，
取消路径可直接复用，不需要新增取消机制。

**为什么这条值得优先**：四个空缺 perf 条目里，它是唯一**用户可直接感知**（`/sessions` 打开变慢）
且改动完全局部的；不触碰 TUI 渲染管线，也不涉及 workflows 的待决重构。

---

## 二、`shared`：transcript 在裁剪前扫全历史 —— #185（空缺）

两处叠加，`extensions/shared/agent-transcript.ts` + `transcript-viewport.ts`：

**2.1 逐条目线性回扫配对**（`agent-transcript.ts:247-264`）

```ts
function hasEarlierToolCall(transcript, resultIndex, toolId) {
  for (let index = resultIndex - 1; index >= 0; index--) { ... }
}
```

对每个 toolResult 从其位置往前扫，最坏 O(n²)。长 child transcript 上，每次渲染都重做这个配对。

**2.2 必须先渲染全部行才能裁剪**（`transcript-viewport.ts:18-24`）

```ts
reconcile(rowCount, viewportSize) { ... }
```

`reconcile` 的入参是 `rowCount`——行数只能由"把所有条目渲染成行"得出。
于是 viewport 裁剪发生在全量渲染**之后**，视口再小也要付全量渲染成本。

**方向**：2.1 用一次前向遍历建 `toolId → 是否已出现 toolCall` 的 Set，把 O(n²) 降到 O(n)；
2.2 需要 viewport 感知的惰性渲染（只渲染 `scrollTop` 附近窗口），改动面比 2.1 大得多。
**建议只做 2.1**：纯函数、可单测、无 UI 行为变化。2.2 涉及滚动契约（`followingEnd` 语义），
风险与收益都需要上游判断。

---

## 三、`workflows`：child 启动 hydrate 全部 foreign artifacts —— #183（空缺）

`grep -n "hydrate\|readdir\|foreign" extensions/workflows/artifacts.ts` 未命中这些关键词，
说明 issue 描述的行为在当前代码里不是这个命名，或已随重构改变位置。

**如实标注：这条我没有验证到对应实现。** 需要先读 `artifacts.ts`（298 行）与 child 启动路径
才能确认形状。在验证之前不给方向建议。

---

## 四、`subagents`：#182 描述与代码不吻合（空缺，但存疑）

issue 标题是"retained child 持续运行每 5 秒 Git polling"。实测：

```bash
grep -rn "setInterval" extensions --include=*.ts | grep -v test   # 全仓清单
grep -rn "gitStatus|isDirty|worktreeStatus|refreshGit|pollGit" extensions/subagents
```

全仓 `setInterval` 共 19 处，无一在 subagents 的 git 路径上；`shared/worktree.ts` 只导出
5 个 async 函数（`resolveGitCommonDir`、`createWorktree`、`reclaimWorktree`、`worktreeCommitCount`、
`worktreeSlug`），没有轮询循环。

**结论：没找到 5 秒 git polling 的实现。** 可能已被修复但 issue 未关，或描述指向别处。
**这条在动手前必须先与维护者确认**，否则可能修一个不存在的问题。

---

## 五、根因模式：两个可复用的不变量

把已认领与未认领的条目并列看，它们不是独立 bug，而是两条缺失的不变量。
**这一节的价值不在于修某一条，而在于给出可以钉住整类问题的判据**——正好契合
AGENTS.md 的 "runtime owns enforceable facts" 立场。

**模式 A：在裁剪/退出条件之前做全量工作。**
#184（丢弃前全量序列化）、#188（节流后仍全量遍历）、#185（裁剪前扫全历史）、#179、#183 同形。
不变量：*先算边界，再做工作*。

**模式 B：终态资源没有停止其周期性活动。**
#189（settled 仍重绘）、#182（若成立）同形。
不变量：*资源进入终态时，其所有计时器、轮询和订阅必须一并收敛*。

模式 B 已经有正确的参照实现——`workflows/index.ts:459-481` 的 `syncWorkflowSpinner`
就带 `if (!isRunning())` 清 timer。缺的只是把它推广到 widget 侧。

模式 A 目前没有共享工具承载：`shared/result-budget.ts` 是父上下文 token 预算分配
（`ParentContextUsage` / `ResultBudgetPolicy`），关注点是给多个结果分配字节配额，
不是"先算边界再做工作"的遍历纪律，不能直接复用。

**这是本文认为最有价值的方向**：三个最好定位的 perf 条目已被认领，逐个修剩下的边际收益递减；
把模式 A/B 写成测试可断言的不变量，才能阻止同形问题继续产生。

---

## 六、跨模块工程债 —— #73（空缺）

实测两处跨扩展内部 import，都不是公开 shared seam：

- `workflows/index.ts:76` → `../subagents/src/agent-types.ts`
  （`loadAgentTypes`、`resolveAgentModel`、`selectSubagentModel`、`roleModelForAgentType`）
- `git-read/index.ts:25` → `../file-search/src/output.ts`（`formatCapturedOutput`）；
  `git-read/src/process.ts:12,16` → `../../file-search/src/output.ts`（`CapturedOutput` 类型）
  与 `../../file-search/src/process.ts`

#73 的判断成立（任一 extension 内部重构都可能破坏另一个）。
`agent-types.ts` 被两条执行路径共用，属于天然的 shared 内容；`file-search` 的 output/process
是"捕获与有界输出"纪律，同样是共享关注点。**方向**：提到 `shared/`，或定义小的公开模块接口。

---

## 七、不建议现在动

| 条目 | 理由 |
|---|---|
| `workflows/index.ts` 2405 行拆分 | #127（废弃 Acceptance Ledger）、#159/#160（抽共享 admission/delivery 合同）一旦落地，职责边界本身会变。先拆会白做。 |
| `shared/setup-config.ts` 1014 行 / 13 消费方 | 配置单点是正确设计。风险在 OP-11 五处一致无机制守护，本目录 `scripts/check-config-contract.mjs` 已是可机检近似（13 字段三层全绿）。 |
| #185 的 2.2 惰性渲染 | 涉及滚动契约语义，需上游判断。 |

---

## 八、优先级（仅未认领且已验证条目）

| 优先 | 条目 | 理由 |
|---|---|---|
| 1 | 二、2.1 配对 O(n²)→O(n) | 纯函数、可单测、缓存挡不住所以收益真实、有现成测试可参照 |
| 2 | 五、模式 A/B 不变量化 | 边际收益最高，但需要先有 1 的实践验证 |
| 3 | 六、#73 跨扩展 import | 静默腐蚀风险，非性能；改动面中等 |
| — | 一、#187 | **已修复**（并发闸+测试俱在），只能建议关题 |
| — | 三、#183 / 四、#182 | **先验证形状再谈优化**；#182 可能不存在 |

## 九、如何复算

```bash
# 认领状态（会变，动手前必查）
curl -s "https://api.github.com/repos/tt-a1i/openpi/pulls?state=open&per_page=100"
curl -s "https://api.github.com/repos/tt-a1i/openpi/issues/187/comments"

# 一、#187
sed -n '200,225p' extensions/sessions/git-stats.ts

# 二、#185
sed -n '247,264p' extensions/shared/agent-transcript.ts
cat extensions/shared/transcript-viewport.ts

# 模式 B 的正确参照实现
sed -n '459,481p' extensions/workflows/index.ts

# 六、#73
grep -rn 'from "../subagents' extensions/workflows/*.ts
grep -rn 'file-search' extensions/git-read/index.ts extensions/git-read/src/process.ts
```
