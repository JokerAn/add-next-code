import { build } from 'esbuild';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionGate } from '../../src/vscode/workspace';

class Disposable {
  constructor(private readonly cleanup = () => {}) {}
  dispose(): void {
    this.cleanup();
  }
}

class Emitter<T = void> {
  private readonly listeners = new Set<(value: T) => void>();
  readonly event = (listener: (value: T) => void) => {
    this.listeners.add(listener);
    return new Disposable(() => { this.listeners.delete(listener); });
  };
  fire(value: T): void {
    for (const listener of this.listeners) {
      listener(value);
    }
  }
  dispose(): void {
    this.listeners.clear();
  }
}

class Uri {
  readonly scheme: string;
  readonly fsPath: string;
  constructor(private readonly value: string) {
    this.scheme = new URL(value).protocol.slice(0, -1);
    this.fsPath = fileURLToPath(value);
  }
  toString(): string {
    return this.value;
  }
  static parse(value: string): Uri {
    return new Uri(value);
  }
  static file(value: string): Uri {
    return new Uri(pathToFileURL(value).toString());
  }
  static joinPath(base: Uri, ...parts: string[]): Uri {
    return Uri.file(path.join(base.fsPath, ...parts));
  }
}

class Position {
  constructor(readonly line: number, readonly character: number) {}
  isEqual(other: Position): boolean {
    return this.line === other.line && this.character === other.character;
  }
}

class Range {
  constructor(readonly start: Position, readonly end: Position) {}
}

class RelativePattern {
  constructor(readonly baseUri: Uri, readonly pattern: string) {}
}

class Watcher {
  readonly change = new Emitter<Uri>();
  readonly create = new Emitter<Uri>();
  readonly delete = new Emitter<Uri>();
  readonly onDidChange = this.change.event;
  readonly onDidCreate = this.create.event;
  readonly onDidDelete = this.delete.event;
  constructor(readonly pattern: RelativePattern | string) {}
  dispose(): void {
    this.change.dispose();
    this.create.dispose();
    this.delete.dispose();
  }
}

type Api = Pick<typeof import('../../src/extension'), 'activate' | 'deactivate'> & {
  PermissionGate: typeof import('../../src/vscode/workspace').PermissionGate;
  SkimmerSource: typeof import('../../src/vscode/skimmer').SkimmerSource;
};

let bundled = '';
let root: string;
let dispose: () => Promise<void>;
let provider: import('vscode').InlineCompletionItemProvider;
let gate: PermissionGate;
let invoke: (name: string) => Promise<unknown>;
let watchers: Watcher[];
const position = new Position(0, 10);
const token = { isCancellationRequested: false, onCancellationRequested: () => new Disposable() };
let doc: import('vscode').TextDocument;
let configChanged: Emitter<import('vscode').ConfigurationChangeEvent>;
let skimmer: import('../../src/vscode/skimmer').SkimmerSource;

beforeAll(async () => {
  // 实际装配入口仅将 vscode 替换为测试宿主；不生成构建产物。
  const result = await build({
    stdin: {
      contents: "export { activate, deactivate } from './src/extension'; export { PermissionGate } from './src/vscode/workspace'; export { SkimmerSource } from './src/vscode/skimmer';",
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  });
  bundled = result.outputFiles[0]!.text;
});

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'add-next-code-boundaries-'));
  await mkdir(path.join(root, '.git/info'), { recursive: true });
  await mkdir(path.join(root, 'app'), { recursive: true });
  await writeFile(path.join(root, '.git/info/exclude'), '');
  watchers = [];
  configChanged = new Emitter();
  const commands = new Map<string, () => unknown>();
  const configuration = {
    'trigger.debounceMs': 300,
    'trigger.minIntervalMs': 0,
    'context.useLanguageService': false,
    // 这组用例用假时钟验证装配边界，不启动真实的 git 进程
    'context.gitDiff': false,
    exclude: [],
  };
  const subscriptions: Array<{ dispose(): void }> = [];
  const text = 'const x = ';
  doc = {
    uri: Uri.file(path.join(root, 'app/private.js')),
    languageId: 'javascript',
    version: 1,
    lineCount: 1,
    lineAt: () => ({ text }),
  } as unknown as import('vscode').TextDocument;
  const mock = {
    Disposable, EventEmitter: Emitter, Uri, Position, Range, RelativePattern,
    InlineCompletionItem: class {
      constructor(readonly insertText: string, readonly range: Range) {}
    },
    InlineCompletionTriggerKind: { Invoke: 0, Automatic: 1 },
    StatusBarAlignment: { Right: 2 },
    workspace: {
      textDocuments: [doc],
      getWorkspaceFolder: () => ({ uri: Uri.file(path.join(root, 'app')) }),
      asRelativePath: () => 'private.js',
      getConfiguration: () => ({ get: (key: string) => configuration[key as keyof typeof configuration] }),
      createFileSystemWatcher: (pattern: RelativePattern | string) => {
        const w = new Watcher(pattern);
        watchers.push(w);
        return w;
      },
      onDidChangeConfiguration: configChanged.event,
      onDidChangeTextDocument: new Emitter().event,
      onDidCloseTextDocument: new Emitter().event,
      onDidSaveTextDocument: new Emitter().event,
      isTrusted: true,
      onDidOpenTextDocument: new Emitter().event,
    },
    window: {
      activeTextEditor: { document: doc, selections: [{}], selection: { isEmpty: true, active: position } },
      createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
      createStatusBarItem: () => ({ show() {}, dispose() {} }),
      showInformationMessage: async () => undefined,
      showErrorMessage: async () => undefined,
      showWarningMessage: async () => undefined,
    },
    commands: {
      registerCommand: (name: string, callback: () => unknown) => {
        commands.set(name, callback);
        return new Disposable();
      },
    },
    languages: {
      registerInlineCompletionItemProvider: (_selector: unknown, p: typeof provider) => {
        provider = p;
        return new Disposable();
      },
    },
  };
  const module = { exports: {} as Api };
  const require = createRequire(import.meta.url);
  new Function('require', 'module', 'exports', bundled)(
    (name: string) => name === 'vscode' ? mock : require(name), module, module.exports,
  );
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    'data: {"choices":[{"text":"compute()","finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } },
  )));
  await module.exports.activate({
    subscriptions,
    globalStorageUri: Uri.file(path.join(root, 'storage')),
    secrets: { get: async () => 'fake-test-key', onDidChange: new Emitter().event },
    globalState: { get: () => true, update: async () => undefined },
  } as unknown as import('vscode').ExtensionContext);
  gate = subscriptions.find((s) => s instanceof module.exports.PermissionGate) as PermissionGate;
  skimmer = subscriptions.find((s) => s instanceof module.exports.SkimmerSource) as typeof skimmer;
  invoke = async (name) => commands.get(name)?.();
  dispose = async () => {
    await module.exports.deactivate();
    await Promise.all(subscriptions.map((subscription) => subscription.dispose()));
  };
  await vi.waitFor(() => { expect(gate.check(doc.uri)).toBe(true); });
  vi.useFakeTimers();
});

afterEach(async () => {
  await dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

function run(triggerKind = 1) {
  return provider.provideInlineCompletionItems(
    doc,
    position as unknown as import('vscode').Position,
    { triggerKind, selectedCompletionInfo: undefined },
    token,
  );
}

function emitRule(file: string): void {
  const w = watchers.find((w) => typeof w.pattern !== 'string' &&
    path.join(w.pattern.baseUri.fsPath, w.pattern.pattern) === file);
  expect(w, `没有监听规则文件 ${file}`).toBeDefined();
  w!.change.fire(Uri.file(file));
}

describe('VS Code 装配边界', () => {
  it('endpoint 和 Skimmer 执行设置只允许用户机器级配置', async () => {
    const manifest = JSON.parse(await readFile(path.join(process.cwd(), 'package.json'), 'utf8'));
    for (const name of ['endpoint', 'skimmer.enabled', 'skimmer.command', 'skimmer.args', 'skimmer.nodePath']) {
      expect(manifest.contributes.configuration.properties[`addNextCode.${name}`].scope, name).toBe('machine');
    }
    expect(manifest.contributes.configuration.properties['addNextCode.skimmer.args'].default)
      .toEqual(['-y', '@jokeran/frontend-code-skimmer@^0.9.0']);
  });

  it('仅 skimmer 设置变化重启子进程，普通补全设置只使缓存失效', async () => {
    const restart = vi.spyOn(skimmer, 'restart').mockResolvedValue();
    configChanged.fire({ affectsConfiguration: (key: string) => ['addNextCode', 'addNextCode.model'].includes(key) } as import('vscode').ConfigurationChangeEvent);
    expect(restart).not.toHaveBeenCalled();
    configChanged.fire({ affectsConfiguration: (key: string) => ['addNextCode', 'addNextCode.skimmer'].includes(key) } as import('vscode').ConfigurationChangeEvent);
    expect(restart).toHaveBeenCalledOnce();
  });

  it('关闭实际命令后，防抖中的调用不发送、不返回候选', async () => {
    const pending = run();
    await invoke('addNextCode.toggle');
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('关闭实际命令会中止在途请求，不依赖 VS Code 取消 token', async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url: unknown, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        signal!.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    }));
    const pending = run(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    await invoke('addNextCode.toggle');
    expect(signal?.aborted).toBe(true);
    expect(await pending).toBeUndefined();
  });

  it.each(['.git/info/exclude', '.gitignore'])('更新祖先规则 %s 后，不沿用旧发送许可', async (relative) => {
    const file = path.join(root, relative);
    await writeFile(file, 'private.js\n');
    emitRule(file);
    expect(gate.check(doc.uri)).toBeUndefined();
    await vi.waitFor(() => { expect(gate.check(doc.uri)).toBe(false); });
    expect(await run(0)).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('规则变化使已经通过入口守卫的防抖调用失效', async () => {
    const pending = run();
    const file = path.join(root, '.git/info/exclude');
    await writeFile(file, 'private.js\n');
    emitRule(file);
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
});
