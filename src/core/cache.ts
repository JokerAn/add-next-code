// 6.3 缓存与续显。命中必须能证明"当时发给模型的上下文，与现在等价"。
import type { SourceDep } from './types';

export interface CacheEntry {
  docKey: string;
  modelKey: string;
  windowStartLine: number;
  windowStartChar: number;
  anchorLine: number;
  prefix: string;
  suffix: string;
  completion: string;
  deps: SourceDep[];
  createdAt: number;
}

export interface CacheOptions {
  maxEntries: number;
  maxChars: number;
  ttlMs: number;
  maxCompletionChars: number;
  perDocLookups: number;
  now?: () => number;
}

export const DEFAULT_CACHE_OPTIONS: CacheOptions = {
  maxEntries: 64,
  maxChars: 2_000_000,
  ttlMs: 120_000,
  maxCompletionChars: 8 * 1024,
  perDocLookups: 8,
};

export interface LookupQuery {
  docKey: string;
  modelKey: string;
  /** 当前后文窗口 */
  suffix: string;
  /** 当前（虚拟）光标所在行 */
  cursorLine: number;
  /** 从指定起点读取到虚拟光标的前文，最多读取 maxChars 个字符。 */
  readPrefix(startLine: number, startChar: number, maxChars?: number): string;
}

export interface CacheHit {
  entry: CacheEntry;
  /** 应当展示的剩余文本 */
  text: string;
  /** true 表示续显（用户已敲入了预测的一部分） */
  remainder: boolean;
}

function size(e: CacheEntry): number {
  return e.prefix.length + e.suffix.length + e.completion.length;
}

export class CompletionCache {
  private readonly opts: CacheOptions;
  private readonly now: () => number;
  /** Map 的插入顺序即 LRU 顺序：最久未用的在最前 */
  private readonly entries = new Set<CacheEntry>();
  private chars = 0;

  constructor(opts: Partial<CacheOptions> = {}) {
    this.opts = { ...DEFAULT_CACHE_OPTIONS, ...opts };
    this.now = this.opts.now ?? Date.now;
  }

  get length(): number {
    return this.entries.size;
  }

  get totalChars(): number {
    return this.chars;
  }

  entriesOf(docKey: string): CacheEntry[] {
    const out: CacheEntry[] = [];
    for (const e of this.entries) {
      if (e.docKey === docKey) {
        out.push(e);
      }
    }
    return out;
  }

  lookup(q: LookupQuery): CacheHit | undefined {
    const now = this.now();
    // 最近使用的在后：反向取该文档最近的若干条
    const candidates = this.entriesOf(q.docKey).reverse().slice(0, this.opts.perDocLookups);
    for (const e of candidates) {
      if (now - e.createdAt > this.opts.ttlMs) {
        this.drop(e);
        continue;
      }
      if (
        e.modelKey !== q.modelKey ||
        q.cursorLine < e.windowStartLine ||
        q.cursorLine > e.anchorLine + newlineCount(e.completion)
      ) {
        continue;
      }
      if (q.suffix !== e.suffix) {
        continue;
      }
      // 达到这个上限就已不可能有剩余预测，无需继续读取。
      const p = q.readPrefix(e.windowStartLine, e.windowStartChar, e.prefix.length + e.completion.length);
      if (!p.startsWith(e.prefix)) {
        continue;
      }
      const typed = p.slice(e.prefix.length);
      if (typed.length >= e.completion.length || !e.completion.startsWith(typed)) {
        continue;
      }
      // 触碰：移到最近使用
      this.entries.delete(e);
      this.entries.add(e);
      return { entry: e, text: e.completion.slice(typed.length), remainder: typed.length > 0 };
    }
    return undefined;
  }

  put(entry: Omit<CacheEntry, 'createdAt'>): boolean {
    if (entry.completion.length === 0 || entry.completion.length > this.opts.maxCompletionChars) {
      return false;
    }
    const full: CacheEntry = { ...entry, createdAt: this.now() };
    if (size(full) > this.opts.maxChars) {
      return false;
    }
    // 同一位置的旧条目由新条目取代
    for (const e of this.entriesOf(full.docKey)) {
      if (e.modelKey === full.modelKey && e.prefix === full.prefix && e.suffix === full.suffix) {
        this.drop(e);
      }
    }
    this.entries.add(full);
    this.chars += size(full);
    while (this.entries.size > this.opts.maxEntries || this.chars > this.opts.maxChars) {
      const oldest = this.entries.values().next().value;
      if (!oldest) {
        break;
      }
      this.drop(oldest);
    }
    return true;
  }

  drop(entry: CacheEntry): void {
    if (this.entries.delete(entry)) {
      this.chars -= size(entry);
    }
  }

  dropDoc(docKey: string): void {
    for (const e of this.entriesOf(docKey)) {
      this.drop(e);
    }
  }

  clear(): void {
    this.entries.clear();
    this.chars = 0;
  }
}

/**
 * onDidChangeTextDocument 的条目筛选：只看改动起始行，不读文本。
 * 改动落在 [windowStartLine, anchorLine + 预测行数] 之外的，窗口比较看不到，直接丢弃条目。
 */
export function dropEntriesAffectedByChange(cache: CompletionCache, docKey: string, changeStartLines: number[]): number {
  let dropped = 0;
  for (const e of cache.entriesOf(docKey)) {
    const lo = e.windowStartLine;
    const hi = e.anchorLine + newlineCount(e.completion);
    if (changeStartLines.some((l) => l < lo || l > hi)) {
      cache.drop(e);
      dropped++;
    }
  }
  return dropped;
}

export function newlineCount(text: string): number {
  let n = 0;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) {
    n++;
  }
  return n;
}
