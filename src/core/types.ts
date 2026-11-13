// 核心层共享类型。core/ 下的模块禁止 import 'vscode'。

/** 按行读取文本的最小接口；lineAt 返回不含换行符的行内容。 */
export interface TextSource {
  readonly lineCount: number;
  lineAt(line: number): string;
  /** 可选：宿主可直接提供全文（如 VS Code document.getText()），避免逐行拼接。 */
  getText?(maxChars?: number): string;
}

export interface Position {
  line: number;
  character: number;
}

/** 对应 vscode.SelectedCompletionInfo；range 仅记录起止位置。 */
export interface SelectedInfo {
  start: Position;
  end: Position;
  text: string;
}

export interface CancelToken {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

export type Framework = 'vue2' | 'vue3' | 'react' | 'node' | 'generic';

export type Region = 'template' | 'script' | 'style' | 'other';

/** 头部里的一条成员（来自语言服务或 Skimmer）。 */
export interface Member {
  kind: string;
  name: string;
  signature?: string;
}

/** 来源依赖的文件指纹（6.3）。 */
export interface SourceDep {
  uri: string;
  mtimeMs: number;
  size: number;
}

export interface RelatedItem {
  kind?: 'component' | 'hook' | 'module' | 'store';
  name: string;
  file: string;
  interface: Member[];
  dep?: SourceDep;
  /** 静态绑定链中间文件（如 barrel）的指纹。 */
  deps?: SourceDep[];
}

/** 一段未提交的改动；来自其他文件时带上该文件的指纹 */
export interface ChangeItem {
  text: string;
  dep?: SourceDep;
}

export interface Header {
  text: string;
  deps: SourceDep[];
}

export const EMPTY_HEADER: Header = Object.freeze({ text: '', deps: [] as SourceDep[] }) as Header;

export type TriggerKind = 'auto' | 'manual';

export interface Config {
  /** 配置代次：任何会影响请求内容或缓存有效性的配置变化时递增。 */
  epoch: number;
  enabled: boolean;
  enableByLanguage: Record<string, boolean>;
  endpoint: string;
  model: string;
  triggerMode: 'auto' | 'manual';
  debounceMs: number;
  /** 高确定性位置（注释/代码块回车、点号等）自动缩短防抖 */
  adaptiveDebounce: boolean;
  minIntervalMs: number;
  /** 空行策略：smart 按位置限制范围；strict 仅在注释或代码块开头之后自动触发；always 不做限制。 */
  blankLine: 'smart' | 'strict' | 'always';
  maxTokens: number;
  maxTokensManual: number;
  maxLines: number;
  temperature: number;
  timeoutMs: number;
  prefixChars: number;
  suffixChars: number;
  headerChars: number;
  maxPrefixLines: number;
  maxSuffixLines: number;
  extraWaitMs: number;
  useLanguageService: boolean;
  /** 文件内用法索引：按光标前的表达式从整份文件里找候选名字 */
  fileUsage: boolean;
  /** 同文件相关片段：按光标附近的标识符从窗口之外取相关代码 */
  fileSnippets: boolean;
  /** 未提交改动：把与光标处相关的 git diff 改动块放进提示词 */
  gitDiff: boolean;
  /** 已打开文档：把其他已打开同工作区文档里强相关的片段放进提示词 */
  openTabs: boolean;
  /**
   * 连续几次请求沿用同一份头部（让服务端缓存命中）。
   * intent：只在同一段意图注释之下；block：另外在同一个代码块内（没有意图注释时以包着光标的块开头行为准）；off：不沿用。
   * 意图变了、手动触发、超过 5 分钟或 60 行、光标后面要补候选名字时，都重新收集。
   */
  reuseHeader: 'off' | 'intent' | 'block';
  /** 实验：最相关的参照代码放到光标上方而不是提示词顶部 */
  nearCursorReference: boolean;
  /** 实例成员校验：off 不校验；retry 发现编造的成员时按草稿重新检索并重发一次；strict 另外不展示仍含编造成员的行 */
  verifyMembers: 'off' | 'retry' | 'strict';
  suggestWidget: 'extend' | 'skip';
  exclude: string[];
  respectGitignore: boolean;
  dumpPrompts: boolean;
  /** 调试：把模型原始输出与最终展示的文本写入日志（含源码片段） */
  dumpCompletions: boolean;
  skimmerEnabled: boolean;
  skimmerCommand: string;
  skimmerArgs: string[];
  skimmerNodePath: string;
  skimmerMaxDocumentChars: number;
}

export const DEFAULT_CONFIG: Config = {
  epoch: 0,
  enabled: true,
  enableByLanguage: { '*': true, plaintext: false, markdown: false, scminput: false },
  endpoint: 'https://api.deepseek.com/beta/completions',
  model: 'deepseek-flash',
  triggerMode: 'auto',
  debounceMs: 1000,
  adaptiveDebounce: true,
  minIntervalMs: 3000,
  blankLine: 'smart',
  maxTokens: 96,
  maxTokensManual: 192,
  maxLines: 12,
  temperature: 0,
  timeoutMs: 8000,
  prefixChars: 6000,
  suffixChars: 1500,
  headerChars: 6000,
  maxPrefixLines: 300,
  maxSuffixLines: 100,
  extraWaitMs: 500,
  useLanguageService: true,
  fileUsage: true,
  fileSnippets: true,
  gitDiff: true,
  openTabs: true,
  reuseHeader: 'block',
  nearCursorReference: false,
  verifyMembers: 'strict',
  suggestWidget: 'extend',
  exclude: ['**/.env*', '**/*.pem', '**/*.key', '**/node_modules/**', '**/dist/**'],
  respectGitignore: true,
  dumpPrompts: false,
  dumpCompletions: false,
  skimmerEnabled: false,
  skimmerCommand: 'npx',
  skimmerArgs: ['-y', '@jokeran/frontend-code-skimmer@^0.9.0'],
  skimmerNodePath: 'node',
  skimmerMaxDocumentChars: 2_000_000,
};
