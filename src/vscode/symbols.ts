import * as vscode from 'vscode';
import type { ContextSource, SourceContext, SourceResult } from '../core/collector';
import { extractMembers, type SymbolNode } from '../core/symbols';

interface Cached {
  version: number;
  tree: SymbolNode[];
}

interface Pending {
  promise: Promise<void>;
}

function convert(sym: vscode.DocumentSymbol | vscode.SymbolInformation): SymbolNode {
  const kind = sym.kind === vscode.SymbolKind.Function ? 'function'
    : sym.kind === vscode.SymbolKind.Variable ? 'variable' : 'other';
  if ('children' in sym) {
    return {
      name: sym.name,
      startLine: sym.range.start.line,
      endLine: sym.range.end.line,
      startCharacter: sym.range.start.character,
      endCharacter: sym.range.end.character,
      children: sym.children.map(convert),
      kind,
    };
  }
  return {
    name: sym.name,
    startLine: sym.location.range.start.line,
    endLine: sym.location.range.end.line,
    startCharacter: sym.location.range.start.character,
    endCharacter: sym.location.range.end.character,
    children: [],
    kind,
  };
}

/**
 * 7.2 语言服务符号来源：只调用 vscode.executeDocumentSymbolProvider。
 * 缓存按 URI + 版本；同一文档最多一个在途请求；不等它超过上下文截止时间，落后时用旧缓存的名称。
 */
export class SymbolSource implements ContextSource {
  readonly name = 'symbols';
  private readonly cache = new Map<string, Cached>();
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly useLanguageService: () => boolean) {}

  clearDoc(uri: string): void {
    this.cache.delete(uri);
    this.pending.delete(uri);
  }

  async collect(ctx: SourceContext, deadlineAt: number): Promise<SourceResult | undefined> {
    if (!this.useLanguageService()) {
      return undefined;
    }
    const key = ctx.docKey;
    const cached = this.cache.get(key);
    if (!cached || cached.version !== ctx.version) {
      let p = this.pending.get(key);
      if (!p) {
        const task: Pending = { promise: Promise.resolve() };
        task.promise = this.fetch(key, ctx.version, task).finally(() => {
          if (this.pending.get(key) === task) {
            this.pending.delete(key);
          }
        });
        p = task;
        this.pending.set(key, p);
      }
      const wait = Math.max(0, deadlineAt - Date.now());
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([p.promise, new Promise<void>((r) => { timer = setTimeout(r, wait); })]);
      } finally {
        clearTimeout(timer);
      }
    }
    const latest = this.cache.get(key);
    if (!latest) {
      return undefined;
    }
    if (ctx.framework === 'vue3' && latest.version !== ctx.version) {
      return undefined;
    }
    // 版本落后的缓存只取名称（extractMembers 的输出不含行号），但光标所在符号链用的是当前行号，
    // 版本落后时行号可能已偏移，所以落后时退回无光标的提取。
    const members = extractMembers(latest.tree, ctx.framework, latest.version === ctx.version ? ctx.line : -1, ctx.character, ctx.sfcBlocks);
    return members.length > 0 ? { members } : undefined;
  }

  private async fetch(key: string, version: number, task: Pending): Promise<void> {
    try {
      const result = await vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation>>(
        'vscode.executeDocumentSymbolProvider',
        vscode.Uri.parse(key),
      );
      const document = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === key);
      if (Array.isArray(result) && this.pending.get(key) === task && document?.version === version) {
        this.cache.set(key, { version, tree: result.map(convert) });
        // 有界：最多保留 16 个文档
        if (this.cache.size > 16) {
          const first = this.cache.keys().next().value;
          if (first !== undefined) {
            this.cache.delete(first);
          }
        }
      }
    } catch {
      // 语言服务不可用或抛错：本次没有符号，不影响补全
    }
  }
}
