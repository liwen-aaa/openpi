import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  checkContract,
  extractLeafFields,
} from "../scripts/check-config-contract.mjs";

/**
 * 配置契约检查的 fixture 测试。
 *
 * 判据（脚本头有全文）：用户可选配置字段必须同时存在于
 *   ① setup-config.ts（定义）② setup/index.ts（实现消费）③ SETUP.md ∪ README.md（文档覆盖）
 * 三层检查：层1 字段表⊆实现引用（零误报）／层2 字段→文档关键词映射／层3 README 保留配置入口。
 *
 * fixture 最小化但覆盖提取器的三种形态：单行对象（capabilities）、多行对象（ui）、
 * 空对象（subagents.roleModels）——三形态各一，缺一提取器就有盲区。
 */

const SETUP_CONFIG = `export const DEFAULT_SETUP_CONFIG = {
  capabilities: { discovery: "explicit" },
  suggestions: { enabled: false },
  ui: {
    showHeader: false,
    footerStyle: "plain",
  },
  postEdit: { command: "" },
  subagents: { roleModels: {} },
};
`;

const IMPL_ALL = `// typed write tool schema（fixture 简化：字段路径出现在文本里 = 消费点）
const SCHEMA = {
  "capabilities.discovery": {},
  "suggestions.enabled": {},
  "ui.showHeader": {},
  "ui.footerStyle": {},
  "postEdit.command": {},
  "subagents.roleModels": {},
};
`;

/** 缺 postEdit.command 的接线：层 1 应当红 */
const IMPL_MISSING = IMPL_ALL.replace(`  "postEdit.command": {},\n`, "");

const SETUP_MD = `# Setup

- capabilities: discovery 默认 explicit
- suggestions 预测默认关
- header 大标题
- footerStyle 支持 powerline
- post-edit 命令
- explorer 角色模型
`;

const README_MD = `# README

配置入口用 /openpi-setup（详见 SETUP.md）。
`;

/** fixture 字段 → 文档关键词（测试用最小映射，模拟真实 CONTRACT_MAP 的判据本体） */
const MAP = {
  "capabilities.discovery": ["discovery"],
  "suggestions.enabled": ["suggestions"],
  "ui.showHeader": ["header"],
  "ui.footerStyle": ["powerline"],
  "postEdit.command": ["post-edit"],
  "subagents.roleModels": ["explorer"],
};

function makeProject(overrides: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "wf-contract-"));
  mkdirSync(join(root, "extensions", "shared"), { recursive: true });
  mkdirSync(join(root, "extensions", "setup"), { recursive: true });
  writeFileSync(
    join(root, "extensions", "shared", "setup-config.ts"),
    SETUP_CONFIG,
  );
  writeFileSync(
    join(root, "extensions", "setup", "index.ts"),
    overrides.impl ?? IMPL_ALL,
  );
  writeFileSync(join(root, "SETUP.md"), overrides.setupMd ?? SETUP_MD);
  writeFileSync(join(root, "README.md"), overrides.readmeMd ?? README_MD);
  return root;
}

test("extractLeafFields 覆盖单行/多行/空对象三种形态", () => {
  const fields = extractLeafFields(SETUP_CONFIG);
  assert.deepEqual([...fields].sort(), [
    "capabilities.discovery",
    "postEdit.command",
    "subagents.roleModels",
    "suggestions.enabled",
    "ui.footerStyle",
    "ui.showHeader",
  ]);
});

test("绿：字段表、实现、文档三方一致 → 通过", () => {
  const root = makeProject();
  try {
    const r = checkContract({ root, map: MAP });
    assert.equal(r.ok, true, r.reason ?? "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("层1：字段未在实现消费点接线 → 红（新字段漏接线的形状）", () => {
  const root = makeProject({ impl: IMPL_MISSING });
  try {
    const r = checkContract({ root, map: MAP });
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /postEdit\.command/);
    assert.match(r.reason ?? "", /setup\/index\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("层2：字段文档零命中 → 红（文档改措辞或字段从未被文档化的形状）", () => {
  const root = makeProject({
    setupMd: SETUP_MD.replace("powerline", "something-else"),
  });
  try {
    const r = checkContract({ root, map: MAP });
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /ui\.footerStyle/);
    assert.match(r.reason ?? "", /powerline/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("层2：字段未在映射登记 → 红（加字段必须登记文档关键词）", () => {
  const root = makeProject();
  try {
    const r = checkContract({ root, map: { ...MAP } });
    assert.equal(r.ok, true); // 全登记时绿
    const partial = checkContract({
      root,
      map: { "capabilities.discovery": ["discovery"] },
    });
    assert.equal(partial.ok, false);
    assert.match(partial.reason ?? "", /未在/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("层3：README 丢了配置入口 → 红（整节被删的形状）", () => {
  const root = makeProject({ readmeMd: "# README\n没有配置入口了。\n" });
  try {
    const r = checkContract({ root, map: MAP });
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /\/openpi-setup/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
