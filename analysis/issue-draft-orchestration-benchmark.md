# [Proposal] Close the orchestration evidence gap: a pre-registered fan-out benchmark for Subagent and Workflow

## Summary

OpenPI's capability-tax question is settled: #19 → #20 → #197 form a clean evidence chain proving the *cost* side is under control. Zero-residency tool surface, first-request payload byte-identical to Bare Pi, and #197's 15/15 vs 10/15 with −45.2% tokens.

The *benefit* side of the largest subsystem is still unmeasured. `extensions/workflows/` is 10,111 lines — **24.7%** of all extension code (40,856 lines total) — and the three execution paths together are 45.4%. No benchmark round to date has observed a single Workflow or Subagent invocation contributing to a scored result.

This is not a new observation. It is **already listed as a next step in two separate rounds**, five days apart, and has not yet converted into a protocol:

- #46 (2026-08-21), next step 5: *"下一轮应扩大任务集，并预注册会自然触发 Subagent/Workflow 的多文件任务，将能力采用率、质量与成本分开报告。"*
- #197 (2026-08-26), evidence boundary 3: *"没有测出编排能力收益。explicit 运行没有采用 Subagent/Workflow，因此这轮主要验证的是 OpenPI 安装后的普通编码表现和低干扰属性，而不是多 Agent 在复杂工程任务上的增益。"*

This proposal asks for one specific thing: **promote that recurring next-step into a pre-registered, falsifiable benchmark protocol with a written decision rule, before further investment in orchestration surface area.**

Scope guardrail up front: this proposes **no new runtime feature, no DSL change, and no orchestration redesign**. It proposes a measurement protocol and a decision rule.

---

## Motivation

### The asymmetry

The project has been rigorous about disproving its own assumptions on the cost axis. #19 is a public self-reversal: 7 "compact entry" tools were assumed cheap, DeepSeek measurement said otherwise (3.23× wall time, 2.49× tokens, 12/16 → 5/16 pass), and the design was changed rather than the copy.

That same rigor has not yet been applied to the benefit axis. The current evidence state:

| Axis | Status | Evidence |
| --- | --- | --- |
| Does OpenPI impose a capability tax? | **Answered: no** | #20 (first-request payload aligned), #197 (−45.2% tokens, −27.7% wall) |
| Does `adaptive` pay off today? | **Answered: no, kept opt-in** | #197 (+149.2% tokens, 2/15 gateway calls, no stable gain) |
| Does orchestration (Subagent/Workflow) pay off? | **Unmeasured** | #197 evidence boundary 3; #46 next step 5 |

The third row is the one carrying 24.7% of the codebase.

### Why this matters more than a normal "add a benchmark" request

Three consequences follow from leaving it unmeasured:

1. **Design decisions on orchestration currently have no empirical referee.** #127 proposes deprecating the Acceptance Ledger; #74 proposes flipping the Workflow default to release the parent turn; #159/#160 propose extracting shared admission and delivery contracts; #90 notes that at scale "Agent 数量扩大只增加成本，未增加 Report Agent 真正看到的证据覆盖". Each is a well-argued judgement call. None can currently be validated against a scored outcome, because no scored task exercises the path.

2. **The strongest published result was obtained without the subsystem.** #197's explicit arm made zero `openpi_load_tools` / Subagent / Workflow calls. That is exactly the right way to prove low interference, and the issue is careful to say so. But it means the headline number cannot be cited as evidence that orchestration works — and there is currently no number that can.

3. **Perf debt is accumulating against unproven value.** Seven open structural performance issues sit in the orchestration and TUI paths — #182, #183, #184, #185, #187, #188, #189 (settled strips still requesting global redraws, full-history scans before viewport clipping, unbounded subprocess fan-out, near-quadratic journal serialization). Paying that down is clearly correct if the subsystem earns its place, and is misallocated effort if it does not. The measurement should precede the paydown.

---

## Current state (verified)

Read at the current tree; line counts via `find extensions -name '*.ts' | xargs wc -l`.

```
extensions/workflows/          10,111 lines   24.7% of extension code
extensions/subagents/           5,030 lines
extensions/background-terminals/ 3,390 lines
                               ------
three execution paths          18,531 lines   45.4%
```

Within `workflows/`, the machinery that exists specifically to make multi-agent runs trustworthy:

```
replay-safety.ts     588      invocation-ledger.ts  368
serialization.ts     470      artifacts.ts          298
sandbox.ts           412      acceptance.ts         298
                             handoff.ts            290
```

Every one of these is a correctness mechanism for a code path that no scored benchmark has yet exercised.

Existing benchmark coverage, by task shape:

| Round | Tasks | Shape | Orchestration observed |
| --- | --- | --- | --- |
| #22 | 12 | Aider polyglot, single-file | none reported |
| #46 | 54 cells | ARM64 source-build derived | none; next step 5 requests fan-out tasks |
| #197 | 15 | 4× Exercism-class + 1 policy probe | **explicitly zero** |

All three are dominated by self-contained, single-file, single-language exercises. These are the correct instrument for detecting capability tax, and structurally incapable of detecting fan-out benefit: a task that one agent can finish in a few turns has no parallel research to isolate, no context to quarantine, and no multi-stage dependency to sequence.

---

## Proposal

### 1. Pre-register the task class before running anything

Following the pre-registration discipline the project already applies to A/B balancing and frozen revisions, commit the task set and the hypothesis **before** collecting data, so the result cannot be reinterpreted after the fact.

Candidate task shapes that structurally require what orchestration claims to provide:

| Task shape | What it forces | Claimed mechanism under test |
| --- | --- | --- |
| Audit N independent modules, synthesize one report | parallel read-only fan-out + aggregation | `pipeline()`, handoff refs, Report agent |
| Cross-module diagnosis in a repo too large for one context | context isolation | Subagent independent context |
| Multi-stage: scan → verify → synthesize with per-item gating | staged dependency, not just parallelism | `pipeline()` vs `parallel()` barrier |
| Parallel independent implementations that each touch files | write isolation | `isolation: "worktree"` |
| Long-running build/watch while analysis proceeds | non-blocking long process | Background Terminal |

Each row should map to at least 3 tasks with hidden programmatic verifiers, consistent with the existing benchmark standard (real starter repos, independent verifier, no model self-report).

### 2. Report adoption and benefit as separate metrics

#46's next-step already specifies this: *"将能力采用率、质量与成本分开报告"*. Made concrete:

- **Adoption rate**: fraction of cells where the model invoked orchestration at all. If near zero on tasks *designed* to need it, the finding is about discovery/prompting, not about orchestration value — and that is itself a publishable, actionable result.
- **Conditional benefit**: among cells that did adopt, quality/token/wall/cost vs the Bare Pi pairing.
- **Unconditional benefit**: whole-arm comparison, so adoption failures are not hidden by conditioning.

Reporting only the third number would repeat the current ambiguity; reporting only the second would let a low-adoption round masquerade as a win.

### 3. Write the decision rule in advance

The part that makes this a decision instrument rather than another data point. Proposed shape, exact thresholds to be set by maintainer:

- **If** orchestration shows material benefit on its designed task class → the 24.7% is earned; prioritize #182–#189 paydown and proceed with #159/#160 contract extraction.
- **If** adoption is high but benefit is flat or negative → the mechanisms are not the bottleneck; #127-style contraction becomes the primary direction, and #90's aggregation bias moves to the front.
- **If** adoption stays near zero even on tasks designed to need it → the gap is capability discovery, not orchestration; #19/#20's discovery work is unfinished and orchestration surface should freeze until discovery is solved.

All three branches are actionable. That is the test of a well-posed experiment.

---

## Non-goals

- Not proposing removal, deprecation, or redesign of Workflow or Subagent. This proposal deliberately takes no position on their value — that is the question being measured.
- Not proposing a new DSL primitive, runtime feature, or orchestration policy.
- Not proposing a public leaderboard submission. Consistent with #197's stated boundary, results stay controlled local product experiments.
- Not asking to block unrelated work. Bug fixes, docs, and the #181 Harness-v2 tracker proceed independently.
- Not duplicating #164 or #168. Those propose paired benchmarks for *specific new capabilities* (Eval Kernel, on-demand DAP); this one measures the orchestration surface that already ships.

---

## Risks and counterarguments

**"Orchestration is for cases benchmarks can't capture."** Plausible, and if so it should be stated explicitly as a scope decision, because it changes what the 24.7% is justified by — maintainer judgement rather than measured outcome. Either resolution is fine; the current implicit state is what this issue targets.

**"Building fan-out tasks with hidden verifiers is expensive."** True, and it is the main cost of this proposal. Mitigation: start with one task shape (parallel audit + synthesis is the cheapest to verify — N independent findings, deterministic aggregate check) and treat it as a pilot before committing to all five shapes.

**"Sample size will be too small for significance."** #197 already handles this honestly — 5 non-tied pairs, sign test p=0.0625, reported as directional rather than significant. The same standard applies here; a strong directional signal on designed tasks is sufficient to route the decision, and the decision rule above is deliberately coarse enough to survive small samples.

**"This delays feature work."** The pilot is one task shape and one paired campaign. Against it: the seven open perf issues represent substantially more engineering effort, currently queued against an unmeasured subsystem.

---

## Acceptance criteria

- [ ] Task class and hypothesis pre-registered (committed) before data collection.
- [ ] At least one task shape from the table implemented with a hidden programmatic verifier and a real starter repo.
- [ ] Paired campaign run under the existing protocol standard: frozen Pi + OpenPI revision, content SHA-256, AB/BA counterbalancing, fresh process and session dir per cell, per-cell deadline.
- [ ] Adoption rate, conditional benefit, and unconditional benefit reported as three separate numbers.
- [ ] Decision rule stated with thresholds before results are interpreted; the branch taken is recorded.
- [ ] Evidence-boundary section written to the standard of #197 (task scale, sample size, model/thinking coverage, sampling randomness, what the result cannot support).
- [ ] Outcome linked from #46 and #197 so the recurring next-step is visibly closed.

---

## References

- #19 — capability-tax self-reversal; 7 entry tools disproven by DeepSeek measurement
- #20 — convergence to zero residency; first-request payload aligned with Bare Pi
- #197 — best round to date; explicit arm made **zero** orchestration calls (evidence boundary 3)
- #46 — next step 5 already requests pre-registered fan-out tasks (2026-08-21)
- #90 — at scale, more agents may add cost without adding evidence coverage in the Report agent
- #127 / #74 / #159 / #160 — orchestration design decisions currently lacking an empirical referee
- #182, #183, #184, #185, #187, #188, #189 — seven open structural perf issues in the orchestration/TUI paths
