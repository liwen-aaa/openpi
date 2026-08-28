# 实施方案：#185 transcript 配对 O(n²) → O(n)

> 本文件是**分析产物**，供你决定是否上手；不修改上游。
> 认领状态核验：#185 `state: open`、无 assignee、0 评论、无 PR 引用（核验于本轮）。**动手前请重新核验。**
> 范围自限：只做 issue 的**配对扫描**这一半，不碰 viewport 惰性渲染那一半（理由见第六节）。

## 一、问题形状（已核实）

`extensions/shared/agent-transcript.ts`，三处协同构成 O(n²)：

**主循环逐条目调 `itemContext`**（第 394-396 行）

```ts
for (let index = 0; index < document.items.length; index++) {
  const item = document.items[index];
  const context = itemContext(document.items, index, liveIds);   // ← 每条目一次
  const key = `${width}|${context.token}`;
  const cached = cacheable ? this.itemCache.get(item)?.get(key) : undefined;
```

**`itemContext` 内部两个线性扫描**（第 323-355 行）

- `hasEarlierToolCall`（第 247-264 行）：从当前位置**往前**扫，找是否存在同 `toolId` 的 toolCall
- `findResult`（第 359-371 行）：从当前位置**往后**扫，找首个同 `toolId` 的 toolResult

n 个条目 × 每个最坏 O(n) 扫描 = O(n²)。

### 为什么现有缓存挡不住

这是本方案的核心论据。第 396 行先算 `context`，第 397 行才用 `context.token` 拼 cache key，
第 398 行才查 `itemCache`。**`itemContext` 在缓存命中判断之前无条件执行**——
所以即使每个条目的渲染结果都已缓存，这部分 O(n²) 扫描每帧照付。

`itemCache` 是 `WeakMap<AgentTranscriptItem, Map<string, string[]>>`，缓存的是**渲染出的行**，
不是 context。这个设计本身没问题（注释解释了为何需要 context 参与 cache key：
邻居状态变化时旧 glyph 不能存活），只是把扫描留在了缓存之外。

## 二、调用频率（决定收益是否真实）

`AgentTranscriptRenderer.render` 的两个调用点：

- `shared/agent-session-page.ts:230` — 组件每帧渲染路径
- `workflows/transcript.ts:136`

而 `subagents/src/ui/takeover.ts:445` 有 `setInterval(() => tui.requestRender(), SPINNER_INTERVAL_MS)`
（120ms），`ps.ts` 与 `file-mutation-display` 另有 1000ms 的 ticker。

即**打开 subagent/workflow transcript 面板时，render 以约 8 帧/秒持续触发**。
5000 条目下单次扫描 15.2ms（实测，见下），折合每秒约 120ms 纯扫描开销。

同时注意 `agent-session-page.ts:230-235` 的顺序——先 `render()` 得到全部行，再
`this.viewport.reconcile(transcript.length, ...)`。这正是 issue 标题"在 viewport 裁剪前扫描完整历史"
的字面含义：裁剪需要 `rowCount`，而 `rowCount` 只能由全量渲染得出。

## 三、改法：一次前向遍历建两个索引

在 `render` 内、主循环**之前**建索引，然后把 `itemContext` 改为接收索引而非全量 transcript。

```ts
interface PairingIndex {
  /** toolId → 首个 toolCall 所在 index。复刻 hasEarlierToolCall 的"存在更早 call"语义。 */
  readonly firstCallAt: ReadonlyMap<string, number>;
  /** toolId → 升序排列的 toolResult index 列表。复刻 findResult 的"首个更晚 result"语义。 */
  readonly resultsById: ReadonlyMap<string, readonly number[]>;
}

function buildPairingIndex(
  transcript: ReadonlyArray<AgentTranscriptItem>,
): PairingIndex {
  const firstCallAt = new Map<string, number>();
  const resultsById = new Map<string, number[]>();
  for (let index = 0; index < transcript.length; index++) {
    const item = transcript[index]!;
    if (item.kind === "assistant") {
      for (const part of item.parts) {
        if (part.type !== "toolCall") continue;
        if (!firstCallAt.has(part.toolId)) firstCallAt.set(part.toolId, index);
      }
    } else if (item.kind === "toolResult") {
      const list = resultsById.get(item.toolId);
      if (list) list.push(index);
      else resultsById.set(item.toolId, [index]);
    }
  }
  return { firstCallAt, resultsById };
}
```

两处替换，语义必须逐字对应：

| 原实现 | 索引版本 | 等价性要点 |
|---|---|---|
| `hasEarlierToolCall(t, i, id)` | `firstCallAt.get(id) !== undefined && firstCallAt.get(id)! < i` | 原函数只判断"是否存在"，故只需**首个** call 位置；首个都不早于 i，则没有更早的 |
| `findResult(t, i, id)` | `resultsById.get(id)` 中首个 `> i` 的 index | 原函数返回**首个**匹配，故列表升序后取首个 `> callIndex` 即等价 |

因为遍历时 index 单调递增，`resultsById` 的列表天然升序，无需排序。

**注意不要用 `Map<string, number>` 存"首个 result"**——那会丢失"同一 toolId 多次出现"的情形：
一个 toolId 在 transcript 中可能有多个 result（重试、流式重复），
`findResult` 是相对于 `callIndex` 找**其后**的首个，不是全局首个。这是最容易写错的地方。

## 四、语义等价与性能（本地实测）

复刻两版算法形状（不引入上游代码），构造含 **toolId 重复、缺 result、isError、live 覆盖**
的输入，逐条目比对输出 token：

```
=== 语义等价性 ===
n= 30 dupIds=false 等价: ✓      n= 30 dupIds=true 等价: ✓
n=120 dupIds=false 等价: ✓      n=120 dupIds=true 等价: ✓
n=400 dupIds=false 等价: ✓      n=400 dupIds=true 等价: ✓

=== 性能 ===
n= 500   current    0.2ms   indexed  0.08ms   ~2×
n=2000   current    2.4ms   indexed  0.24ms   ~10×
n=5000   current   15.2ms   indexed  0.65ms   ~23×
```

**诚实评估**：绝对值不大（5000 条目 15ms）。收益来自它在 8 帧/秒的渲染路径上、
且缓存挡不住。这不是"修一个卡死的 bug"，是"消除一条与历史长度成平方关系的每帧开销"。
提 PR 时应当如实这样陈述，不要夸大成用户可感知的卡顿修复——除非你能在真实长 transcript 上
测出可感知差异（那需要先在真实 Pi 里跑一个长 subagent 会话）。

## 五、测试策略（这是本方案的重点）

`extensions/shared/agent-transcript.ts` **目前没有任何测试文件**
（`tests/extensions/shared/` 下只有 `transcript-viewport.test.ts`，测的是另一个模块）。

所以顺序必须是：**先补基线测试证明当前行为，再重构，最后证明行为不变。**
直接重构一个无测试覆盖的 482 行渲染模块，即使逻辑对也很难让维护者放心 merge。

新建 `tests/extensions/shared/agent-transcript.test.ts`，用 `node:test` + `assert/strict`
（仓库 108 个 `.test.ts` vs 1 个 `.spec.ts`，主套件是 node:test）。建议用例：

1. **配对基线**：toolCall 后跟 toolResult → `paired` 为真；孤立 toolResult → 为假
2. **toolId 重复**：同 toolId 出现两组 call/result，断言各自配到**其后**的那个 result
3. **缺 result**：call 无对应 result → phase `pending`
4. **isError**：result 带 `isError: true` → phase `error`
5. **live 覆盖**：`liveTools` 含该 toolId → phase `live`，且不查 result
6. **缓存不串味**：同一 item 在邻居状态变化后重新渲染，输出随之变化（守住 `context.token` 的作用）

前 5 条可以通过 `AgentTranscriptRenderer.render` 的输出行间接断言，也可以考虑把
`buildPairingIndex` 导出后直接单测（更干净，但增加了模块公开面——建议先问维护者偏好，
或者只导出给测试用并在注释里说明意图，仓库已有 `__setWorkflowTestAgentSessionFactory`
这类"测试专用 seam 且命名自证"的先例，见 `workflows/index.ts:492`）。

## 六、明确不做的部分

issue #185 标题含两件事，本方案只做第一件：

| 部分 | 做? | 理由 |
|---|---|---|
| 配对扫描 O(n²)→O(n) | ✅ | 纯函数、语义可证等价、可单测 |
| viewport 裁剪前全量渲染 | ❌ | 需要 viewport 感知的惰性渲染，改动 `followingEnd` 滚动契约语义（`transcript-viewport.ts:10-13` 的注释明确它复刻 Pi 的 ScrollView follow-to-end 合同）。风险与收益都需上游判断 |

PR 描述里应当**显式说明只覆盖一半**，并说明另一半为何单独处理——
这符合仓库 AGENTS.md 的"smallest scoped change"要求，也避免维护者以为 issue 可以直接关闭。

## 七、动手清单

```bash
# 0. 认领状态复核（必做，会变）
curl -s "https://api.github.com/repos/tt-a1i/openpi/issues/185/comments"
curl -s "https://api.github.com/repos/tt-a1i/openpi/pulls?state=open&per_page=100"

# 1. 环境（Windows 先做这步，否则 format:check 全红）
git config core.autocrlf false
bun install --frozen-lockfile
bun run check                       # ~1s

# 2. 先补基线测试，此时应全绿（证明测试描述的是现状行为）
node --test --experimental-strip-types tests/extensions/shared/agent-transcript.test.ts

# 3. 重构后再跑，仍应全绿（证明行为不变）
node --test --experimental-strip-types tests/extensions/shared/agent-transcript.test.ts

# 4. 相邻模块回归（transcript 被 subagents/workflows 共用）
node --test --experimental-strip-types tests/extensions/shared/*.test.ts
node --test --experimental-strip-types tests/extensions/subagents/*.test.ts
node --test --experimental-strip-types tests/extensions/workflows/*.test.ts

# 5. 仓库门禁
bun run check
```

先在 issue 下发一条认领评论（说明方向请维护者确认），再动手——
#184 的 testikun 就是这个流程，可以照抄那个格式。

## 八、如何复算本文结论

```bash
# 缓存命中判断在 itemContext 之后（本方案的核心论据）
sed -n '394,400p' extensions/shared/agent-transcript.ts

# 两个线性扫描
sed -n '247,264p' extensions/shared/agent-transcript.ts    # hasEarlierToolCall
sed -n '359,371p' extensions/shared/agent-transcript.ts    # findResult

# 渲染在 reconcile 之前
sed -n '228,236p' extensions/shared/agent-session-page.ts

# 8 帧/秒的来源
grep -n 'SPINNER_INTERVAL_MS' extensions/subagents/src/ui/takeover.ts extensions/shared/spinner.ts

# 无测试覆盖
ls tests/extensions/shared/ | grep -i transcript
```
