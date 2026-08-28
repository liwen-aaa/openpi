# PR 草稿：#185 transcript 配对索引化 + ingestion 索引（两提交）

> 分支 `perf/issue-185-transcript-pairing`，两个提交：
> - `d2f8463` perf(tui): index transcript tool pairing
> - `e2ae452` perf(tui): carry transcript pairing index on the document

## 分支状态（开 PR 前核验）

```bash
git log --oneline -2
# e2ae452 perf(tui): carry transcript pairing index on the document
# d2f8463 perf(tui): index transcript tool pairing
git status --short --branch   # 干净，tracking fork
bun run check                 # exit 0
```

## PR 标题

```
perf(tui): index transcript tool pairing
```

（仓库用 squash merge，PR 标题会变成合并后的 commit 名；d2f8463 的标题即最终形态。）

## PR 描述（按仓库 .github/PULL_REQUEST_TEMPLATE.md 五节填写）

### Problem

`AgentTranscriptRenderer.render` runs for every item and pays two costs that
grow with full history on a path that repaints while a child streams
(`subagents/src/ui/takeover.ts` drives `tui.requestRender()` on
`SPINNER_INTERVAL_MS`):

1. **Quadratic pairing search.** `itemContext` ran two linear neighbour scans
   per item — `hasEarlierToolCall` walks backwards, `findResult` walks forwards —
   and ran **before** the render cache was consulted (context is computed, then
   `context.token` forms the cache key, then `itemCache` is queried). With
   parallel tool calls whose results land separately, the per-item scans make
   pairing O(n²) in transcript length.
2. **Index rebuilt per frame.** Even after indexing, the index was rebuilt from
   the full history on every `render` call, so repaint ticks still scanned the
   whole transcript.

Refs #185. This PR addresses both; the remaining half of #185 (viewport-aware
rendering) is tracked separately and deliberately left out (see Impact).

### Value

- Removes a quadratic worst case on the child transcript view: 5,000-item
  deferred-result transcript drops from ~41 ms to ~2 ms per frame (18.7×).
- Makes the pairing index an ingestion-time artifact instead of a per-frame
  scan, so an open takeover view pays O(1) per tick rather than O(n).
- Subagent document projection measured ~360× faster at n=2000 (0.0725 ms →
  0.0002 ms) and no longer scales with transcript length.

Bounded internal change; no user-visible behaviour change.

### Approach

Two commits.

**Commit 1 — `d2f8463`:** precompute both lookups in one forward pass, then have
`itemContext` read the index instead of scanning:

- `firstCallAt: Map<toolId, index>` — a result only needs to know whether *any*
  call precedes it, so the earliest call is sufficient: if that one is not
  earlier, none is.
- `resultsById: Map<toolId, number[]>` — ascending result indices per tool id.

Design note: `resultsById` keeps a **list**, not a single index, because
`findResult` returns the first result *after* a given call, not the first
result overall. A tool id can appear more than once (retries, repeated streaming
ids); collapsing to one index would mispair. The list is ascending by
construction, so no sort is needed.

**Commit 2 — `e2ae452`:** move the index to ingestion time.

- `AgentTranscriptDocument` gains an optional `pairing` field; `render` reads it
  and only falls back to building it for callers that omit it (tests, benches).
- `WorkflowTranscriptAdapter` already returns a stable document while the
  transcript is unchanged, so the cached document now carries a matching index —
  no per-frame rebuild on the Workflow path.
- `SubagentSnapshot` gains a monotonic `transcriptVersion` bumped on every
  mutation (the only mutation point is `appendTranscript`); the subagent
  document projection caches items + pairing keyed on snapshot identity +
  version via a `WeakMap`, so an open takeover view pays O(1) per tick. The
  dynamic half (`liveTools` / `liveAssistant` / `queued`) is still assembled
  fresh each call.

Pairing semantics are preserved exactly: results pair only with *earlier*
calls, calls pair only with *later* results, `liveTools` overrides result
lookup, and `context.token` still discriminates cache entries.

### Validation

Environment: Windows x64, Node 24.16.0, bun 1.3.14, branched from `fcbc5e5`.

**Gate**

```
bun run check      # pass (biome format, biome lint, tsc --noEmit; exit 0)
```

**New tests** — `tests/extensions/shared/agent-transcript.test.ts`, 8 cases,
all passing. This module had no test file before, so the suite was written
against **unmodified** code first and confirmed green there, then re-run after
the refactor. They cover: paired suppression, orphan result, pending,
out-of-order result-before-call, isError, duplicate tool id pairing with the
result *after* the call, `liveTools` override, and cache discrimination via
`context.token`.

Because a baseline test that cannot fail is worthless, the suite was
mutation-checked against the original implementation:

| Injected fault | Cases caught |
| --- | --- |
| `findResult` start `callIndex + 1` → `0` | 2 |
| `hasEarlierToolCall` reverse scan → full forward scan | 2 |
| `if (paired) return []` short-circuit removed | 1 |
| `context.token` forced constant | 1 |

**Cache correctness** — 4 targeted cases: same version reuses the pairing
object; version change rebuilds; dynamic half (liveTools) is fresh each call;
distinct snapshots never share a pairing (`WeakMap` identity isolation).

**Regression** — compared against a baseline recorded on this branch point
*before* the change:

| Suite | Before | After |
| --- | --- | --- |
| `tests/extensions/shared` | 105 pass / 2 fail | 113 pass / 2 fail |
| `tests/extensions/subagents` | 127 pass / 6 fail | 127 pass / 6 fail |
| `tests/extensions/workflows` | 234 pass / 10 fail | 234 pass / 10 fail |

`+8` in shared is this PR's new cases. The 18 pre-existing failures are
identical before and after; they are Windows environment failures on this
machine (e.g. `worktree.test.ts` concurrent-children isolation, and a
path-separator expectation `src\a.ts` vs `src/a.ts` in
`subagents/transcript.test.ts`), not introduced here. I could not verify on
Linux; CI should be authoritative.

**Benchmark** — 5 consecutive repaints with the item cache already warm, so the
measurement isolates the scan cost the cache does not cover:

`deferred` (all calls, then all results):

| Items | Before | After |
| ---: | ---: | ---: |
| 500 | 0.68 ms | 0.38 ms |
| 2,000 | 7.56 ms | 0.80 ms |
| 5,000 | 41.23 ms | 2.21 ms (18.7×) |

Subagent document construction (transcript unchanged):

| Items | Before (per-call rebuild) | After (cache hit) |
| ---: | ---: | ---: |
| 128 | 0.0112 ms | 0.0002 ms |
| 512 | 0.0480 ms | 0.0001 ms |
| 2,000 | 0.0725 ms | 0.0002 ms |

**Stated honestly: this is a trade, not a free win.** When every result sits
directly after its call, the old `findResult` hits on its first iteration and
there is no quadratic term to remove, so the added index construction can cost
more than it saves at small sizes. The change pays off when results are
deferred relative to their calls, and the worst case it removes is unbounded
while the overhead it adds is linear.

Not run: manual smoke in a reloaded Pi TUI against a long real child
transcript. The change is behaviour-preserving by construction and covered by
the new tests, but I have not visually confirmed a long streaming session.

### Impact

- **User-visible behaviour** — None intended. Rendering output is unchanged;
  the new tests pin the observable pairing behaviour.
- **Model-visible context/tools** — None. No tool registered, renamed, or
  reclassified; `CHILD_SAFE_PACKAGE_TOOL_NAMES` / `CHILD_EXCLUDED_TOOL_NAMES`
  untouched.
- **Runtime/lifecycle** — None. No timers, subprocesses, sessions, or
  cancellation paths involved. `transcriptVersion` is a pure counter on an
  internal mutable snapshot, invisible to Pi.
- **Persisted config/data** — None.
- **Compatibility/risk** — Low and contained. `pairing` is optional on the
  document (fallback preserves behaviour for direct constructors); the two
  index functions are private to `agent-transcript.ts`; `transcriptVersion` is
  additive on an internal type. Residual risk is a pairing-semantics mismatch,
  which the duplicate-tool-id and out-of-order cases target.
- **Scope left out** — #185 also describes viewport clipping after full render
  (`render()` must produce every row before `TranscriptViewport.reconcile` can
  clamp, since it needs `rowCount`). Fixing that needs viewport-aware lazy
  rendering, which changes the `followingEnd` scroll contract documented in
  `transcript-viewport.ts`. Left out deliberately; **#185 should stay open**.

---

## 开 PR 步骤

浏览器打开（base = 上游 main，head = 你的 fork 分支）：

```
https://github.com/tt-a1i/openpi/compare/main...liwen-aaa:perf/issue-185-transcript-pairing?expand=1
```

检查 compare 页显示 "2 commits ahead" 后：

1. 标题粘贴上面那行
2. 描述粘贴五节
3. **保持 `Refs #185`，不要改成 `Fixes #185`**（只解决一半，merge 时不应自动关 issue）
4. 若模板要求勾选 checklist，逐项对照 Validation 节

开完把 PR 链接贴回这里，我帮你核对 compare 是否正确（base/head 方向、commit 数）。
