import assert from "node:assert/strict";
import test from "node:test";

import { AgentTranscriptRenderer } from "../../extensions/shared/agent-transcript.ts";
import type {
  AgentTranscriptDocument,
  AgentTranscriptItem,
} from "../../extensions/shared/agent-transcript.ts";

/**
 * #185 配对扫描重构的**基线测试**。
 *
 * 目的：在把 `itemContext` 的两个线性扫描（`hasEarlierToolCall` 往前扫、
 * `findResult` 往后扫）替换成一次前向遍历建立的索引之前，先把当前可观察行为钉住。
 * 重构后这些断言必须逐条仍绿——它们描述的是现状，不是期望的新行为。
 *
 * 断言依据的可观察信号（由 probe 实测得出）：
 *   - `renderToolResultItem` 在 `paired === true` 时 `return []`，即配对成功的
 *     toolResult **不单独渲染**；所以「是否配对」表现为输出行数差异。
 *   - toolCall 的 phase 表现为动词：完成 → "Read"，pending → "Reading"（带 spinner），
 *     错误结果 → "Failed"。
 *
 * 注意：`itemContext` / `hasEarlierToolCall` / `findResult` 都是模块私有，
 * 因此只能经 `AgentTranscriptRenderer.render` 间接断言。这也是重构必须保持
 * 输出等价的原因——公开面没有暴露配对结果本身。
 *
 * 变异验证（已实测）：把 `findResult` 的起点从 `callIndex + 1` 改成 `0`，
 * 或把 `hasEarlierToolCall` 的方向改成全量正扫，下面的「乱序」与「重复 toolId」
 * 用例会失败。即这套断言不是恒绿的。
 */

/** 最小 Theme stub：所有着色函数恒等返回，让断言只看结构不看 ANSI。 */
const theme = new Proxy(
  {},
  {
    get: (_target, prop) =>
      prop === "fg"
        ? (_color: string, text: string) => text
        : (text: string) => text,
  },
) as never;

const call = (toolId: string, name = "read"): AgentTranscriptItem => ({
  kind: "assistant",
  parts: [
    {
      type: "toolCall",
      toolId,
      name,
      argsPreview: toolId,
    } as never,
  ],
});

const result = (
  toolId: string,
  isError = false,
  name = "read",
): AgentTranscriptItem => ({
  kind: "toolResult",
  toolId,
  name,
  isError,
  outputPreview: `out-${toolId}`,
});

/** 每次用新 renderer，避免 itemCache 跨用例串味。 */
const render = (items: AgentTranscriptItem[], width = 60) =>
  new AgentTranscriptRenderer().render(
    { items } satisfies AgentTranscriptDocument,
    width,
    theme,
  );

const joined = (items: AgentTranscriptItem[]) => render(items).join("\n");

/** 完成态动词，与 pending 的 "Reading" 区分。 */
const COMPLETED = /Read(?!ing)/;

test("配对成功的 toolResult 被抑制，不产生独立行", () => {
  const withPair = render([call("a"), result("a")]);
  const callOnly = render([call("a")]);

  // 配对后 result 返回 []，所以总行数与「只有 call」一致。
  assert.equal(
    withPair.length,
    callOnly.length,
    "paired result must not add rows",
  );
  // 且 call 从 pending 变为完成态。
  assert.match(joined([call("a"), result("a")]), COMPLETED);
  assert.doesNotMatch(joined([call("a"), result("a")]), /Reading/);
});

test("孤立 toolResult（无更早 toolCall）仍然渲染", () => {
  const orphan = render([result("zzz")]);
  assert.ok(orphan.length > 0, "orphan result must render");
  assert.match(orphan.join("\n"), COMPLETED);
});

test("只有 toolCall 时为 pending 态", () => {
  assert.match(joined([call("b")]), /Reading/);
});

test("乱序：result 在 call 之前时不算配对，两条都渲染", () => {
  // hasEarlierToolCall 只往前扫，此时 result 之前没有 call → paired=false。
  // findResult 只往后扫，call 之后没有 result → pending。
  const out = joined([result("c"), call("c")]);
  assert.match(out, COMPLETED, "unpaired result still renders");
  assert.match(out, /Reading/, "later call stays pending");
});

test("isError 的配对结果与成功结果区分渲染", () => {
  const ok = joined([call("d"), result("d", false)]);
  const bad = joined([call("e"), result("e", true)]);
  assert.notEqual(ok, bad, "error phase must differ from ok phase");
});

test("同一 toolId 重复出现时，call 配到其后的首个 result 而非全局首个", () => {
  // 索引化最容易写错的边界：findResult 找的是 callIndex **之后**的首个 result。
  // 输入刻意把一个 error result 放在 call 之前、ok result 放在 call 之后：
  //   正确语义 → call 配到其后的 ok → 完成态
  //   退化为全局首个 → 配到前面的 error → 错误态
  // 用 Map<toolId, 单个 index> 实现会在这里失真。
  const out = joined([result("dup", true), call("dup"), result("dup", false)]);

  // 前置的孤立 error result 自身仍渲染（它之前没有 call）。
  assert.match(out, /Failed/, "leading orphan error result still renders");
  // 关键断言：call 必须取其后的成功结果，而不是前面那个 error。
  assert.match(out, COMPLETED, "call must pair with the result AFTER it");
  assert.doesNotMatch(out, /Reading/, "call must not stay pending");
});

test("live toolId 覆盖 result 查找，phase 为 live", () => {
  const items = [call("f"), result("f")];
  const live = new AgentTranscriptRenderer().render(
    {
      items,
      liveTools: [{ toolId: "f", name: "read" }],
    } satisfies AgentTranscriptDocument,
    60,
    theme,
  );
  const settled = render(items);
  assert.notEqual(
    live.join("\n"),
    settled.join("\n"),
    "live phase must differ from settled phase",
  );
});

test("邻居状态变化会改变输出（context.token 参与缓存键）", () => {
  // 同一个 item 对象在两种邻居上下文里渲染，结果必须不同；
  // 否则说明缓存键没有携带 context，重构时会退化成 stale glyph。
  const shared = call("g");
  const renderer = new AgentTranscriptRenderer();

  const pending = renderer
    .render({ items: [shared] } satisfies AgentTranscriptDocument, 60, theme)
    .join("\n");
  const completed = renderer
    .render(
      { items: [shared, result("g")] } satisfies AgentTranscriptDocument,
      60,
      theme,
    )
    .join("\n");

  assert.match(pending, /Reading/);
  assert.match(completed, COMPLETED);
  assert.notEqual(pending, completed, "cache must not serve a stale phase");
});
