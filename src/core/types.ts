// 核心层共享类型。core/ 下的模块禁止 import 'vscode'。

/** 按行读取文本的最小接口；lineAt 返回不含换行符的行内容。 */
export interface TextSource {
  readonly lineCount: number;
  lineAt(line: number): string;
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
  minIntervalMs: number;
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
  suggestWidget: 'extend' | 'skip';
  exclude: string[];
  respectGitignore: boolean;
  dumpPrompts: boolean;
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
  minIntervalMs: 3000,
  maxTokens: 96,
  maxTokensManual: 192,
  maxLines: 12,
  temperature: 0.2,
  timeoutMs: 8000,
  prefixChars: 6000,
  suffixChars: 1500,
  headerChars: 2000,
  maxPrefixLines: 300,
  maxSuffixLines: 100,
  extraWaitMs: 500,
  useLanguageService: true,
  suggestWidget: 'extend',
  exclude: ['**/.env*', '**/*.pem', '**/*.key', '**/node_modules/**', '**/dist/**'],
  respectGitignore: true,
  dumpPrompts: false,
  skimmerEnabled: false,
  skimmerCommand: 'npx',
  skimmerArgs: ['-y', '@jokeran/frontend-code-skimmer@^0.9.0'],
  skimmerNodePath: 'node',
  skimmerMaxDocumentChars: 2_000_000,
};
