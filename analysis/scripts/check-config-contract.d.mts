/**
 * check-config-contract.mjs 的类型声明（tsc 对 .mjs import 需要同名 .d.mts）。
 * 实现与判据在 .mjs 文件里，这里是它的对外类型面。
 */
export interface ContractCheckResult {
  ok: boolean;
  /** 提取到的叶子字段路径 */
  fields?: string[];
  /** 红：逐条问题 */
  problems?: string[];
  /** 绿：逐条说明 */
  notes?: string[];
  reason?: string;
}

export function extractLeafFields(source: string): string[];

export function checkContract(options?: {
  root?: string;
  map?: Record<string, readonly string[]>;
}): ContractCheckResult;
