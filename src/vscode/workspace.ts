import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DepsIo } from '../core/deps';
import { IgnoreResolver, type IgnoreFs } from '../core/ignore';
import type { Config } from '../core/types';

const nodeFs: IgnoreFs = {
  async readFile(p) {
    try {
      return await fs.promises.readFile(p, 'utf8');
    } catch {
      return undefined;
    }
  },
  async exists(p) {
    try {
      await fs.promises.access(p);
      return true;
    } catch {
      return false;
    }
  },
};

/** 6.1.1 发送许可判定的 VS Code 适配：同步 peek + 后台判定 + 规则文件变化时失效。 */
export class PermissionGate implements vscode.Disposable {
  private resolver: IgnoreResolver;
  private readonly watchers = new Map<string, vscode.Disposable[]>();
  private readonly inFlight = new Map<string, symbol>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private revision = 0;
  private disposed = false;

  constructor(cfg: Config) {
    this.resolver = this.create(cfg);
  }

  get version(): number {
    return this.revision;
  }

  private create(cfg: Config): IgnoreResolver {
    return new IgnoreResolver(nodeFs, {
      respectGitignore: cfg.respectGitignore,
      exclude: cfg.exclude,
      homeDir: os.homedir(),
      onRuleFile: (file) => this.watchRuleFile(file),
    });
  }

  private watchRuleFile(file: string): void {
    if (this.disposed || this.watchers.has(file)) {
      return;
    }
    // 精确监听实际规则文件，也覆盖工作区外的祖先 .gitignore 和 .git/info/exclude。
    const w = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(path.dirname(file)), path.basename(file)),
    );
    const invalidate = () => {
      this.revision++;
      this.resolver.clear();
      this.inFlight.clear();
      this.changed.fire();
    };
    this.watchers.set(file, [w, w.onDidChange(invalidate), w.onDidCreate(invalidate), w.onDidDelete(invalidate)]);
  }

  /** exclude / respectGitignore 配置变化时重建 */
  reconfigure(cfg: Config): void {
    this.resolver.clear();
    this.resolver = this.create(cfg);
    this.inFlight.clear();
    this.revision++;
  }

  private static keyOf(uri: vscode.Uri): string {
    return uri.scheme === 'file' || uri.scheme === 'vscode-remote' ? uri.fsPath : uri.toString();
  }

  /**
   * 同步判定：已有结果直接返回"是否许可"；没有结果返回 undefined（调用方按不许可处理），
   * 并在后台完成判定，下一次调用生效。
   */
  check(uri: vscode.Uri): boolean | undefined {
    const cached = this.resolver.peek(PermissionGate.keyOf(uri));
    if (cached !== undefined) {
      return !cached;
    }
    this.prime(uri);
    return undefined;
  }

  /** 相关文件在进入提示词前也使用与当前文档一致的发送许可。 */
  async permits(uri: vscode.Uri): Promise<boolean> {
    const resolver = this.resolver;
    const revision = this.revision;
    const key = PermissionGate.keyOf(uri);
    const folder = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
    const ignored = await resolver.isIgnored(key, folder);
    return !this.disposed && this.resolver === resolver && this.revision === revision && !ignored;
  }

  /** 预热：打开文档时先算好，避免第一次按键没有补全。untitled 等没有磁盘路径的文档只应用 exclude。 */
  prime(uri: vscode.Uri): void {
    const key = PermissionGate.keyOf(uri);
    if (this.disposed || this.inFlight.has(key) || this.resolver.peek(key) !== undefined) {
      return;
    }
    const task = Symbol();
    this.inFlight.set(key, task);
    const folder = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
    void this.resolver.isIgnored(key, folder).finally(() => {
      if (this.inFlight.get(key) === task) {
        this.inFlight.delete(key);
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    this.resolver.clear();
    this.inFlight.clear();
    for (const subscriptions of this.watchers.values()) {
      for (const w of subscriptions) {
        w.dispose();
      }
    }
    this.watchers.clear();
    this.changed.dispose();
  }
}

/** 文档所属项目里 vue 依赖的主版本（最近的 package.json）。 */
export class ProjectInfo implements vscode.Disposable {
  private readonly cache = new Map<string, number | null>();
  private readonly watcher: vscode.FileSystemWatcher;

  constructor() {
    this.watcher = vscode.workspace.createFileSystemWatcher('**/package.json');
    const clear = () => this.cache.clear();
    this.watcher.onDidChange(clear);
    this.watcher.onDidCreate(clear);
    this.watcher.onDidDelete(clear);
  }

  async vueMajor(docKey: string): Promise<number | undefined> {
    const uri = vscode.Uri.parse(docKey);
    if (uri.scheme !== 'file' && uri.scheme !== 'vscode-remote') {
      return undefined;
    }
    const folder = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
    let dir = path.dirname(uri.fsPath);
    for (let i = 0; i < 20; i++) {
      const hit = this.cache.get(dir);
      if (hit !== undefined) {
        return hit ?? undefined;
      }
      const major = await readVueMajor(path.join(dir, 'package.json'));
      if (major !== 'none') {
        this.cache.set(dir, major ?? null);
        return major;
      }
      if (!folder || dir === folder) {
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
    return undefined;
  }

  dispose(): void {
    this.watcher.dispose();
  }
}

/** 'none' 表示没有 package.json（继续向上找）；undefined 表示有但没有 vue 依赖。 */
async function readVueMajor(file: string): Promise<number | undefined | 'none'> {
  let text: string;
  try {
    text = await fs.promises.readFile(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'none' : undefined;
  }
  try {
    const json = JSON.parse(text) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
    const raw = json.dependencies?.vue ?? json.devDependencies?.vue ?? json.peerDependencies?.vue;
    if (!raw) {
      return undefined;
    }
    const m = /^(?:workspace:)?[~^]?(2|3)(?:\.(?:\d+|x|\*)){0,2}(?:-[\w.-]+)?(?:\+[\w.-]+)?$/i.exec(raw.trim());
    return m ? Number(m[1]) : undefined;
  } catch {
    return undefined;
  }
}

/** 缓存已解析过的真实路径，避免重复 realpath 系统调用。 */
const realpathMemo = new Map<string, string>();
async function cachedRealpath(fsPath: string): Promise<string | undefined> {
  const hit = realpathMemo.get(fsPath);
  if (hit !== undefined) {
    return hit;
  }
  try {
    const resolved = await fs.promises.realpath(fsPath);
    realpathMemo.set(fsPath, resolved);
    if (realpathMemo.size > 256) {
      realpathMemo.delete(realpathMemo.keys().next().value as string);
    }
    return resolved;
  } catch {
    return undefined;
  }
}

/** 来源依赖复核用的 IO：stat 取指纹；未保存状态取自本窗口已打开的文档（全异步，无同步阻塞）。 */
export const depsIo: DepsIo = {
  async stat(uriString) {
    const uri = vscode.Uri.parse(uriString);
    if (uri.scheme !== 'file' && uri.scheme !== 'vscode-remote') {
      return undefined;
    }
    try {
      const s = await fs.promises.stat(uri.fsPath);
      return { mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      return undefined;
    }
  },
  async isDirty(uriString) {
    const target = vscode.Uri.parse(uriString);
    for (const d of vscode.workspace.textDocuments) {
      if (d.isDirty) {
        if (d.uri.toString() === uriString) {
          return true;
        }
        if ((d.uri.scheme === 'file' || d.uri.scheme === 'vscode-remote') &&
          (target.scheme === 'file' || target.scheme === 'vscode-remote')) {
          if (d.uri.fsPath === target.fsPath) {
            return true;
          }
          const real = await cachedRealpath(d.uri.fsPath);
          if (real !== undefined && real === target.fsPath) {
            return true;
          }
        }
      }
    }
    return false;
  },
};
