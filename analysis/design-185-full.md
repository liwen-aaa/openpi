# 设计草案：#185 完整方案（B 方案）

> 目标：让 child transcript 的渲染成本与 **viewport 高度**相关，而非与 **transcript 长度**相关。
> 现状代码已读透：`agent-session-page.ts`、`workflows/transcript.ts`、`shared/agent-transcript.ts`、`shared/transcript-viewport.ts`。
> 本文件是分析产物，不修改上游。实现前的接口草案，先对齐再动代码。

## 一、决定性事实（读代码得出，不是推测）

### 1. `render()` 输出紧凑行数组，行与 item 不一一对应

`shared/agent-transcript.ts:464-468`：

```ts
if (lines.length > 0) {
  out.push(...lines);   // 空行直接丢弃
}
```

一个 `toolResult` 配对成功时 `renderToolResultItem` 返回 `[]`（第 236 行 `if (paired) return []`），
即 **item 存在但产生 0 行**。所以：

- `render` 返回的 `string[]` 是**紧凑行流**，行号与 item 的 index 无关
- "第 N 行"无法直接映射到"第 M 个 item"——**先算 item 高度再按行定位**这条路，对当前输出模型不成立

### 2. 窗口裁剪发生在渲染之后，对成本零帮助

`shared/agent-session-page.ts:229-235`：

```ts
const transcript = this.renderer.render(state.document, width, this.theme, { now });
this.rowCount = transcript.length;
this.viewportSize = transcriptCapacity;
this.viewport.reconcile(transcript.length, transcriptCapacity);
```

`render()` 全量渲染，**然后** `transcript.slice(scrollTop, scrollTop+capacity)` 才切窗口（第 237-239 行）。
切片是 O(viewport)，但渲染是 O(全部)——切片的收益是显示，不是性能。

### 3. `rowCount` 循环依赖

`TranscriptViewport.reconcile(rowCount, ...)` 需要行数；行数只能由全量渲染得出。
**viewport 需要行数才能定位，渲染需要 viewport 才能只渲染窗口——这是循环依赖。**
必须打破：要么渲染两次（不可接受），要么用可增量计算的"逻辑高度"替代实际行数。

### 4. document 的 identity 缓存已存在，但被浪费

`workflows/transcript.ts:91-112`：`WorkflowTranscriptAdapter.document()` 在 transcript 未变时
**返回同一个 document 对象引用**。这本来意味着"索引只建一次"，但我的 `buildPairingIndex` 在
`render()` 内部每帧重建，把这个缓存机会浪费了。

### 5. tool id 有稳定性问题（增量索引的前置阻塞）

`workflows/transcript.ts:47`：

```ts
const toolId = entry.toolCallId ?? `workflow-tool-${index}`;
```

缺 `toolCallId` 时按 `index` 合成 id。compaction 改变 index 基准后，同一逻辑调用会得到不同 id。
**增量索引会把它们当成两个不同调用**——这是 ingestion 增量化的前置阻塞，必须先解决。

## 二、方案核心：把"每帧全量"拆成"ingestion 一次 + 每帧增量"

### 结构

```
ingestion（transcript 变化时）          render（每帧）
──────────────────────────             ──────────────────────────
1. document 增量更新 items              1. viewport 已知道 scrollTop/高度
2. pairing index 增量更新                2. 只对 [可见窗口 + overscan] 的 items 渲染
3. finalized row cache 增量更新          3. 输出直接可拼接（无需 slice）
```

### 三处联动的接口变化

#### A. `AgentTranscriptDocument` 携带索引（ingestion 持有）

```ts
interface AgentTranscriptDocument {
  readonly items: ReadonlyArray<AgentTranscriptItem>;
  /** 新增：ingestion 时一次性构建/增量更新的配对索引 */
  readonly pairing?: PairingIndex;
  readonly cwd?: string;
  readonly toolRenderer?: AgentToolRenderer;
  // ... 其余不变
}
```

- `buildWorkflowTranscriptDocument` 构建 items 时**同时**构建 `pairing`
- `WorkflowTranscriptAdapter` 的 identity 缓存因此让索引**天然只建一次**
- `render()` 直接用 `document.pairing`，**不再每帧 `buildPairingIndex`**
- 这同时满足"ingestion 增量索引，不在 render 搜索历史"——render 从 O(n) 配对降为 O(1) 查表

#### B. `render()` 接受 viewport 窗口参数（viewport 决定渲染范围）

```ts
render(
  document: AgentTranscriptDocument,
  width: number,
  theme: Theme,
  options?: {
    readonly now?: number;
    /** 新增：只渲染这个窗口（logical item 区间） */
    readonly window?: { readonly startItem: number; readonly endItem: number };
  },
)
```

调用方 `agent-session-page.ts` 传入窗口，`render` 只遍历 `[startItem, endItem)` 的 items。

#### C. `AgentTranscriptRenderer` 持有递增行号状态（打破 rowCount 循环依赖）

```ts
class AgentTranscriptRenderer {
  /** 新增：每个 item 渲染后的行数（ingestion 增量维护） */
  private itemHeights: number[] = [];
  /** 新增：前缀和——item i 的起始行号 */
  private lineOffsets: number[] = [0];
}
```

**这是打破循环依赖的关键**：既然行与 item 不一一对应（事实 1），就不能按行定位 item；
改为**按 item 定位**——维护每个 item 占多少行（前缀和），viewport 的 `scrollTop`（行号）
经前缀和二分找到对应 item 区间，只渲染该区间。

### 三处联动后的流程

```
ingestion（transcript 变化）
  buildWorkflowTranscriptDocument：
    items 增量 push
    pairing 增量更新（new call → firstCallAt/resultsById）
    itemHeights 暂不更新（渲染才知道行数）← 待决，见风险 2

render（每帧）
  adapter.document() 返回同一 document（identity 缓存命中）
  viewport 已知 scrollTop
  lineOffsets（前缀和）二分 → [startItem, endItem)
  renderer.render(document, width, theme, { window: {startItem, endItem} })
  → 只渲染窗口内 items，行数就地累加，更新 lineOffsets
  → 返回的紧凑行数组直接可显示（无需 slice）
```

## 三、四个语义要求如何保证（设计层面）

| 语义 | 设计保证 |
|---|---|
| late result | result 到达时 ingestion 更新 `resultsById`，下次 render 的 call 即配对成功；view 窗口里的 call 可能此刻显示 pending，但**只要滚动到它或它在 overscan 内**，下一帧就正确。窗口外的不渲染，天然无 stale 问题 |
| legacy missing call id | **前置修复**：`workflow-tool-${index}` 改为**不依赖 index** 的 id。方案：`workflow-tool-${name}-${递增计数器}`（name 稳定的前提下），或由调用方传入真实 call id。修复后增量索引的 key 才稳定 |
| compaction | compaction 缩短 items，`pairing` 与 `itemHeights` 必须同步截断。设计上：document 重建时**整体重建**（compaction 是罕见事件，重建成本可接受），只有**追加**走增量 |
| parallel calls | 一条 assistant 的多个 toolCall 共享一个 item（`appendAssistantPart` 合并 parts）。`pairing.firstCallAt` 以 **item index** 记，天然兼容——一个 item 里多个 call 不影响"该 item 是否在某个 result 之前" |

## 四、benchmark 设计（对齐你的规格）

```
任务集：32 / 128 / 512 items
形状  ：顺序（call 紧跟 result）、64-way separated（64 call 一批，64 result 一批）
测量  ：一次冷 render + 连续 100 次 repaint
断言  ：
  1. 每帧成本随 items 增长应显著慢于线性（最好常数）
  2. 每帧成本随 viewport 高度增长（说明只渲染窗口）
  3. 冷 render 成本（ingestion）仍随 items 线性，但只发生一次
```

关键对比：改动前每帧 O(全部 items)，改动后每帧 O(viewport + overscan)。

## 五、风险与待决

1. **itemHeights 何时更新**（最大风险）
   行数由宽度决定，而宽度是 render 时才知道的。所以 `lineOffsets` 不能纯在 ingestion 维护，
   必须 render 时更新。这使"窗口渲染 + 行号"耦合：**渲染窗口 A 后，A 之前 item 的行数已知，
   A 之后未知**。若 viewport 滚动到 B，需要先知道 B 之前的行数——若 B 之前从未渲染过，无法定位。
   
   **候选解法**：view 窗口 = [scrollTop - overscan, scrollTop + capacity + overscan]，滚动时
   从当前已知行号处向前增量渲染补齐（滚动是连续的，通常只需补少量）。这是虚拟列表的标准做法，
   但需要 `TranscriptViewport` 与 `AgentTranscriptRenderer` 的滚动联动，复杂度显著上升。
   
   **简化替代**：只做"窗口渲染"而不做"行号增量"——viewport 改为按 **item 区间**滚动
   （item 粒度滚动，而非行粒度）。滚动单位从"行"变为"item"，牺牲行级滚动精度，
   换掉整块行号定位复杂度。**需要维护者决定接受哪种**。

2. **`workflow-tool-${index}` 的修复范围**（已核实）
   - **仅 workflows 侧受影响**。`workflows/transcript.ts:47` 在缺 `toolCallId` 时合成 id。
   - subagents 侧 `subagents/src/ui/transcript.ts:11` 直接用 `snap.transcript` 作为 items，
     `toolId` 来自 Pi 事件流（`manager.ts:474` 的 `event.toolId`），是真实值，无合成。
   - subagents 的 `TranscriptItem` 结构与 shared 完全一致，**P0 修复只改 workflows 一处**。

3. **overscan 大小**
   窗口上下各多少 item。太大浪费，太小滚动时闪烁。需实测调。

4. **窗口渲染与 `liveTools` 的交互**
   `liveTools` 是 document 级字段，窗口外的 live tool 是否仍要渲染状态指示？
   当前实现在 `render` 尾部统一处理 `liveTools`——窗口化后需决定 live 指示是否全量渲染。

## 六、分步实施（每个 PR 独立可合并）

| 步骤 | 内容 | 单独合并的价值 |
|---|---|---|
| P0 | 前置：修复 `workflow-tool-${index}` id 稳定性 + 单测 | 独立正确性修复，无风险 |
| P1 | document 携带 `pairing`，render 改读 `document.pairing` 不再自建 | 独立性能收益（去掉每帧 O(n) 索引构建），当前 d2f8463 的改法正好退化到这一步 |
| P2 | `render` 接受 `window` 参数 + 调用方传入 | 独立接口变更，行为不变 |
| P3 | item 粒度滚动（简化替代）或行号增量（完整方案） | 需要维护者先定风险 1 |
| P4 | benchmark 脚本 + 验证 | 每步都跑 |

**P0→P1 是必然的，P2→P3 是核心，P4 贯穿。**
P1 本身就让"每帧成本"从 O(n)（当前）降为 O(1) 查表——即便不做窗口渲染，
也比现在的状态好；P2/P3 才是真正实现"与 viewport 相关"。

### 已核实的补充事实

- **两条路径共用 `AgentSessionPage`**：subagents `takeover.ts:410` 与 workflows 都走它，
  窗口渲染改造对两者同时生效。
- **subagents 的 items 直接引用 `snap.transcript`**：无 document 重建，追加即更新，
  ingestion 增量索引对它是天然匹配；workflows 的 `WorkflowTranscriptAdapter`
  则靠 identity 缓存达成同样效果。
- **紧凑行数组是窗口渲染的最大障碍**（事实 1）：行号与 item 不一一对应，
  直接按行定位不可能；P3 必须选 item 粒度滚动或行号增量两者之一。

## 七、下一步

1. 先确认风险 2：查 subagents 侧是否也合成 tool id（影响 P0 范围）
2. 你定风险 1：item 粒度滚动（简化）还是行号增量（完整）
3. 定完就按 P0 开始动代码
