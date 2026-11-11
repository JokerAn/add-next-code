import * as vscode from 'vscode';
import { DEFAULT_CONFIG, type Config } from '../core/types';

function num(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : def;
  return Math.min(max, Math.max(min, n));
}

/** 配置快照。任何 addNextCode.* 变化都会让 epoch 递增，从而使旧缓存与旧请求失效。 */
export class ConfigStore implements vscode.Disposable {
  private cfg: Config = { ...DEFAULT_CONFIG };
  private readonly sub: vscode.Disposable;
  private readonly listeners = new Set<(event: vscode.ConfigurationChangeEvent) => void>();

  constructor() {
    this.reload();
    this.sub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('addNextCode')) {
        this.reload();
        for (const l of this.listeners) {
          l(e);
        }
      }
    });
  }

  get(): Config {
    return this.cfg;
  }

  /** 手动让配置代次前进（Key 变化等） */
  bumpEpoch(): void {
    this.cfg = { ...this.cfg, epoch: this.cfg.epoch + 1 };
  }

  onDidChange(listener: (event: vscode.ConfigurationChangeEvent) => void): vscode.Disposable {
    this.listeners.add(listener);
    return new vscode.Disposable(() => this.listeners.delete(listener));
  }

  private reload(): void {
    const c = vscode.workspace.getConfiguration('addNextCode');
    const d = DEFAULT_CONFIG;
    const strArr = (v: unknown, def: string[]) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : def);
    const enable = c.get<Record<string, boolean>>('enable') ?? d.enableByLanguage;
    this.cfg = {
      epoch: this.cfg.epoch + 1,
      enabled: true,
      enableByLanguage: typeof enable === 'object' && enable !== null ? enable : d.enableByLanguage,
      endpoint: (c.get<string>('endpoint') ?? d.endpoint).trim() || d.endpoint,
      model: (c.get<string>('model') ?? d.model).trim() || d.model,
      triggerMode: c.get<string>('trigger.mode') === 'manual' ? 'manual' : 'auto',
      debounceMs: num(c.get('trigger.debounceMs'), d.debounceMs, 300, 5000),
      minIntervalMs: num(c.get('trigger.minIntervalMs'), d.minIntervalMs, 0, 60_000),
      maxTokens: num(c.get('request.maxTokens'), d.maxTokens, 1, 4096),
      maxTokensManual: num(c.get('request.maxTokensManual'), d.maxTokensManual, 1, 4096),
      maxLines: num(c.get('request.maxLines'), d.maxLines, 1, 200),
      temperature: num(c.get('request.temperature'), d.temperature, 0, 2),
      timeoutMs: num(c.get('request.timeoutMs'), d.timeoutMs, 1000, 60_000),
      prefixChars: num(c.get('context.prefixChars'), d.prefixChars, 200, 100_000),
      suffixChars: num(c.get('context.suffixChars'), d.suffixChars, 0, 50_000),
      headerChars: num(c.get('context.headerChars'), d.headerChars, 0, 20_000),
      maxPrefixLines: num(c.get('context.maxPrefixLines'), d.maxPrefixLines, 1, 5000),
      maxSuffixLines: num(c.get('context.maxSuffixLines'), d.maxSuffixLines, 0, 2000),
      extraWaitMs: num(c.get('context.extraWaitMs'), d.extraWaitMs, 0, 3000),
      useLanguageService: c.get<boolean>('context.useLanguageService') ?? d.useLanguageService,
      suggestWidget: c.get<string>('suggestWidget') === 'skip' ? 'skip' : 'extend',
      exclude: strArr(c.get('exclude'), d.exclude),
      respectGitignore: c.get<boolean>('respectGitignore') ?? d.respectGitignore,
      dumpPrompts: c.get<boolean>('debug.dumpPrompts') ?? d.dumpPrompts,
      skimmerEnabled: c.get<boolean>('skimmer.enabled') ?? d.skimmerEnabled,
      skimmerCommand: (c.get<string>('skimmer.command') ?? d.skimmerCommand).trim() || d.skimmerCommand,
      skimmerArgs: strArr(c.get('skimmer.args'), d.skimmerArgs),
      skimmerNodePath: (c.get<string>('skimmer.nodePath') ?? d.skimmerNodePath).trim() || d.skimmerNodePath,
      skimmerMaxDocumentChars: num(c.get('skimmer.maxDocumentChars'), d.skimmerMaxDocumentChars, 10_000, 2_000_000),
    };
  }

  dispose(): void {
    this.sub.dispose();
    this.listeners.clear();
  }
}
