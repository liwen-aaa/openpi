#!/usr/bin/env node
/**
 * check-config-contract.mjs —— 配置契约五处一致检查（issue #… 提案 Phase 1 的可行性质证）
 *
 * 判据（对应 AGENTS.md「Package configuration contract」）：
 *   一个用户可选配置字段，必须同时存在于四类落点：
 *     ① extensions/shared/setup-config.ts    —— 字段定义（权威）
 *     ② extensions/setup/index.ts            —— 类型化写入路径（实现消费点）
 *     ③ SETUP.md  ∪  README.md               —— 文档覆盖（用户被告知怎么配）
 *     ④ /openpi-setup 无参状态输出            —— 运行时（动态，静态文本抽查，留人审）
 *
 * 三层检查：
 *   层 1（硬，零误报）字段表 ⊆ 实现引用：setup-config.ts 的每个叶子字段路径，
 *       必须出现在 setup/index.ts 的文本里。漏一个 = 新字段没接线（D-52 形状）。
 *   层 2（映射）字段 → 文档关键词：每个字段在 CONTRACT_MAP 里注册关键词，
 *       至少一个关键词命中 SETUP.md 或 README.md。关键词没命中 = 文档没告诉用户
 *       这个旋钮存在。映射是判据本体：加字段必须注册，删字段必须清注册（否则文档
 *       在说一个不存在的旋钮）。映射需要人审（语义质量，非机械可判）。
 *   层 3（保险）README 保留配置入口节：README 必须仍提到 /openpi-setup 命令，
 *       防止整节被删。
 *
 * 为什么用关键词映射而不是字段路径 grep：openpi 的文档哲学是「人话 + 示例命令」
 * （`/openpi-setup 显示大标题`），字段路径（ui.showHeader）在文档里零出现。
 * 直接 grep 路径会让当前树立即红——那不是检查，是误报。映射把「文档语义覆盖」
 * 变成可机检的近似，语义质量留给人审（见 CONTRACT_MAP 头注）。
 *
 * 用法：
 *   node scripts/check-config-contract.mjs              # 检查当前仓库
 *   node scripts/check-config-contract.mjs --root <dir> # 检查别的根
 * 纯 Node，零依赖。CLI 只是薄壳，判据全在 checkContract()（可被测试 import）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * 判据本体：字段路径 → 文档关键词。
 * 关键词取自 SETUP.md / README.md 的实际措辞（人话、示例命令、术语）。
 * 变更这条映射 = 判据变更，需维护者 review（不能由 agent 自主改，见 AGENTS.md 判据持有权）。
 *
 * 登记规则：
 *   加字段 → 必须加一行（否则层 1 先红，逼你登记）；
 *   删字段 → 必须删行（否则文档在描述一个不存在的旋钮）；
 *   文档改措辞 → 关键词全不命中 → 层 2 红 → 改关键词或补文档（两选一，不许静默）。
 */
const CONTRACT_MAP = {
  "capabilities.discovery": ["discovery", "explicit", "adaptive"],
  "suggestions.enabled": ["suggestions", "预测"],
  "workflows.concurrency": ["concurrency", "workflow", "agent"],
  "workflows.maxAgentCalls": ["agent calls", "256"],
  "ui.showHeader": ["header", "大标题"],
  "ui.customFooter": ["footer", "Footer"],
  "ui.footerStyle": ["powerline", "footerStyle"],
  "ui.footerLines": ["footerLines", "flex", "两行"],
  "ui.subagentResultDisplay": ["subagentResultDisplay", "compact"],
  "ui.bashToolDisplay": ["bashToolDisplay", "Bash"],
  "ui.fileMutationDisplay": ["fileMutationDisplay", "Write/Edit"],
  "postEdit.command": ["post-edit", "format", "postEdit"],
  "subagents.roleModels": ["roleModels", "explorer", "reviewer"],
};

const SETUP_CONFIG = "extensions/shared/setup-config.ts";
const SETUP_IMPL = "extensions/setup/index.ts";
const DOCS = ["SETUP.md", "README.md"];

/**
 * 从 DEFAULT_SETUP_CONFIG 字面量提取叶子字段路径。
 * 只扫 `export const DEFAULT_SETUP_CONFIG ... = {` 到匹配的 `};` 之间——
 * 文件其它地方（FOOTER_PRESETS、LockIdentity 等）不是配置字段，必须排除。
 * 启发式解析（不解析 TS）：跟踪 `key: {` 嵌套深度，收集带值的叶子 `key: value`。
 * 若某天出现函数值或展开（...spread），本提取会漏 → 层 1 可能漏报；发现时改这里并加测试。
 */
export function extractLeafFields(source) {
  const start = source.indexOf("export const DEFAULT_SETUP_CONFIG");
  if (start < 0) return [];
  const bodyStart = source.indexOf("{", start);
  // 数大括号到闭合
  let depth = 0;
  let end = source.length;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const block = source.slice(bodyStart + 1, end);

  const leaves = [];
  const path = [];
  // 字符流扫描：`ident:` 后跟 `{` → 容器入栈；后跟非 `{` → 叶子；`}` → 出栈。
  // 值（字符串/数字）与逗号不被匹配，自然跳过——单行对象（capabilities: { discovery: "explicit" }）
  // 与多行对象统一处理。
  const re = /([A-Za-z_$][\w$]*)\s*:|[{}]/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    if (m[0] === "{") continue; // 容器确认：key: 分支已入栈
    if (m[0] === "}") {
      path.pop();
      continue;
    }
    const n = re.exec(block); // 预读下一个 token
    if (n !== null && n[0] === "{") {
      const n2 = re.exec(block);
      // 空对象（key: {}）是叶子，不是容器——subagents.roleModels 就是
      if (n2 !== null && n2[0] === "}") {
        leaves.push([...path, m[1]].join("."));
        re.lastIndex = n2.index;
        continue;
      }
      path.push(m[1]);
      if (n2 !== null) re.lastIndex = n2.index;
    } else {
      leaves.push([...path, m[1]].join("."));
      if (n !== null) re.lastIndex = n.index; // 不吞掉下一个 token
    }
  }
  return leaves;
}

/** 层 1：字段表 ⊆ 实现引用。返回缺失引用（未接线的字段） */
function implGaps(fields, implSource) {
  return fields.filter((f) => !implSource.includes(f));
}

/** 层 2：每字段关键词在文档（SETUP ∪ README）至少命中一个。返回零命中的字段 */
function docGaps(fields, map, docsText) {
  const hits = new Map();
  for (const field of fields) {
    const keywords = map[field];
    if (keywords === undefined) {
      hits.set(
        field,
        `未在 CONTRACT_MAP 登记（加字段必须登记文档关键词，这是判据本体）`,
      );
      continue;
    }
    const hit = keywords.find((k) => docsText.some((text) => text.includes(k)));
    if (hit === undefined) {
      hits.set(
        field,
        `关键词 [${keywords.join(", ")}] 在 SETUP.md ∪ README.md 零命中（文档改措辞了，或字段从未被文档化）`,
      );
    }
  }
  return hits;
}

export function checkContract({
  root = process.cwd(),
  map = CONTRACT_MAP,
} = {}) {
  const problems = [];
  const notes = [];

  const setupConfig = join(root, SETUP_CONFIG);
  const setupImpl = join(root, SETUP_IMPL);
  if (!existsSync(setupConfig) || !existsSync(setupImpl)) {
    return {
      ok: false,
      reason: `找不到 ${SETUP_CONFIG} 或 ${SETUP_IMPL}（--root 指错了？）`,
    };
  }
  const fields = extractLeafFields(readFileSync(setupConfig, "utf-8"));
  const impl = readFileSync(setupImpl, "utf-8");

  // 层 1：实现消费点
  const gaps = implGaps(fields, impl);
  if (gaps.length > 0) {
    problems.push(
      `层1 实现消费点：字段未在 setup/index.ts 接线：${gaps.join(", ")}（D-52 形状：配置字段必须有消费点）`,
    );
  } else {
    notes.push(`层1 ✓ ${fields.length} 个叶子字段全部在 setup/index.ts 消费`);
  }

  // 层 2：文档覆盖
  const docsText = DOCS.map((f) => join(root, f))
    .filter(existsSync)
    .map((p) => readFileSync(p, "utf-8"));
  if (docsText.length === 0) {
    problems.push(
      "层2 文档：SETUP.md 与 README.md 都不存在，没有任何文档覆盖配置",
    );
  } else {
    const missing = docGaps(fields, map, docsText);
    const unregistered = [...missing].filter(([, v]) => v.startsWith("未在"));
    const uncovered = [...missing].filter(([, v]) => !v.startsWith("未在"));
    if (unregistered.length > 0) {
      problems.push(
        `层2 判据缺口：${unregistered.map(([f]) => f).join(", ")} 未在 CONTRACT_MAP 登记`,
      );
    }
    if (uncovered.length > 0) {
      problems.push(
        `层2 文档覆盖：${uncovered.map(([f, v]) => `${f}（${v}）`).join("；")}`,
      );
    }
    if (unregistered.length === 0 && uncovered.length === 0) {
      notes.push(
        `层2 ✓ ${fields.length} 个字段全部有文档关键词命中（SETUP.md ∪ README.md）`,
      );
    }
  }

  // 层 3：README 保留配置入口
  const readme = join(root, "README.md");
  if (
    !existsSync(readme) ||
    !readFileSync(readme, "utf-8").includes("/openpi-setup")
  ) {
    problems.push(
      "层3 入口：README.md 里找不到 /openpi-setup（配置入口整节被删了？）",
    );
  } else {
    notes.push("层3 ✓ README 保留 /openpi-setup 配置入口");
  }

  return {
    ok: problems.length === 0,
    fields,
    problems,
    notes,
    reason: problems.length > 0 ? problems.join("\n") : undefined,
  };
}

// ── CLI 薄壳（import 时不执行，测试可安全 import 纯函数）──────────
const isCli =
  process.argv[1] &&
  import.meta.url ===
    new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;
if (isCli) {
  const rootArg = process.argv.indexOf("--root");
  const root =
    rootArg >= 0 ? resolve(process.argv[rootArg + 1]) : process.cwd();

  const r = checkContract({ root });
  if (r.ok) {
    console.log(`✓ 配置契约（${root}）`);
    for (const n of r.notes) console.log(`  ${n}`);
    process.exit(0);
  }
  console.log(`✗ 配置契约（${root}）`);
  for (const p of r.problems) console.log(`  ${p}`);
  process.exit(1);
}
