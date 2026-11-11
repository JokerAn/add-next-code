// 6.1.1 发送许可判定：被排除或被项目忽略规则匹配的文件，任何内容都不离开本机。
// 语义对齐 git：逐级规则文件（更深优先）、父目录被忽略则子路径无法取回、祖先目录的 .gitignore、.git/info/exclude。
import ignore, { type Ignore } from 'ignore';

export interface IgnoreFs {
  /** 读文本文件；不存在或不可读返回 undefined */
  readFile(absPath: string): Promise<string | undefined>;
  /** 路径是否存在（文件或目录均可，用于识别 .git） */
  exists(absPath: string): Promise<boolean>;
}

export interface IgnoreOptions {
  respectGitignore: boolean;
  exclude: string[];
  /** 每个实际参与判定的规则文件（包括尚不存在的文件），供宿主监听规则变化。 */
  onRuleFile?(absPath: string): void;
  /** 家目录：git 根恰好是家目录时不采用（dotfiles 仓库常见 `*`），避免整个项目被误判为忽略 */
  homeDir?: string;
}

const MAX_ANCESTOR_DEPTH = 12;

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

function dirname(p: string): string {
  const s = toPosix(p).replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  if (i < 0) {
    return s;
  }
  if (i === 0) {
    return '/';
  }
  // Windows 盘符根："C:/x" → "C:/"
  if (/^[A-Za-z]:$/.test(s.slice(0, i))) {
    return s.slice(0, i + 1);
  }
  return s.slice(0, i);
}

function join(a: string, b: string): string {
  const base = toPosix(a).replace(/\/+$/, '');
  return `${base}/${b}`;
}

/** 返回 abs 相对 root 的 posix 路径；不在 root 之内返回 undefined。 */
export function relativeTo(root: string, abs: string): string | undefined {
  const r = toPosix(root).replace(/\/+$/, '');
  const a = toPosix(abs);
  if (a === r) {
    return '';
  }
  if (a.startsWith(r + '/')) {
    return a.slice(r.length + 1);
  }
  return undefined;
}

function hasEffectiveRule(content: string): boolean {
  return content.split(/\r?\n/).some((line) => {
    const t = line.trim();
    return t !== '' && !t.startsWith('#');
  });
}

export class IgnoreResolver {
  private readonly fs: IgnoreFs;
  private readonly opts: IgnoreOptions;
  private excludeMatcher: Ignore;
  private readonly ruleCache = new Map<string, Ignore | null>();
  private readonly gitRootCache = new Map<string, string | null>();
  private readonly resultCache = new Map<string, boolean>();
  private generation = 0;

  constructor(fs: IgnoreFs, opts: IgnoreOptions) {
    this.fs = fs;
    this.opts = opts;
    this.excludeMatcher = ignore().add(opts.exclude);
  }

  /** 规则文件或配置变化时调用 */
  clear(): void {
    this.generation++;
    this.ruleCache.clear();
    this.gitRootCache.clear();
    this.resultCache.clear();
  }

  /** 已有缓存结果则同步返回；否则 undefined（调用方按"不许可"处理并触发后台判定） */
  peek(absPath: string): boolean | undefined {
    return this.resultCache.get(toPosix(absPath));
  }

  /**
   * 文件是否被排除/忽略。folderRoot 为文件所在的工作区文件夹；不属于任何文件夹时为 undefined，只应用 exclude。
   * 任何异常按"被忽略"处理（宁可不发）。
   */
  async isIgnored(absPath: string, folderRoot: string | undefined): Promise<boolean> {
    const generation = this.generation;
    const key = toPosix(absPath);
    const cached = this.resultCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    let result: boolean;
    try {
      result = await this.compute(key, folderRoot ? toPosix(folderRoot) : undefined);
    } catch {
      result = true;
    }
    // 读规则期间可能发生失效；旧判定不得重新写回允许发送的缓存。
    if (generation !== this.generation) {
      return true;
    }
    this.resultCache.set(key, result);
    return result;
  }

  private async compute(abs: string, folderRoot: string | undefined): Promise<boolean> {
    // exclude：相对工作区文件夹匹配；文件夹之外按完整路径（去掉盘符与前导斜杠）匹配
    let excludeRel: string;
    if (folderRoot) {
      excludeRel = relativeTo(folderRoot, abs) ?? abs.replace(/^[A-Za-z]:/, '').replace(/^\/+/, '');
    } else {
      excludeRel = abs.replace(/^[A-Za-z]:/, '').replace(/^\/+/, '');
    }
    if (this.excludeMatcher.ignores(excludeRel)) {
      return true;
    }
    if (!this.opts.respectGitignore || !folderRoot) {
      return false;
    }

    const gitRoot = (await this.findGitRoot(folderRoot)) ?? folderRoot;
    const rel = relativeTo(gitRoot, abs);
    if (rel === undefined || rel === '') {
      return false;
    }
    const segments = rel.split('/');
    for (let k = 1; k <= segments.length; k++) {
      const p = segments.slice(0, k).join('/');
      const isDir = k < segments.length;
      if (await this.testPath(gitRoot, p, isDir)) {
        return true;
      }
    }
    return false;
  }

  /** 单个路径（目录或文件）按 git 优先级是否被忽略：更深的 .gitignore 优先，.git/info/exclude 最后。 */
  private async testPath(gitRoot: string, relPath: string, isDir: boolean): Promise<boolean> {
    const segs = relPath.split('/');
    const parentSegs = segs.slice(0, -1);
    for (let depth = parentSegs.length; depth >= 0; depth--) {
      const dirRel = parentSegs.slice(0, depth).join('/');
      const dirAbs = dirRel ? join(gitRoot, dirRel) : toPosix(gitRoot);
      const matcher = await this.loadRules(join(dirAbs, '.gitignore'));
      if (!matcher) {
        continue;
      }
      const local = dirRel ? relPath.slice(dirRel.length + 1) : relPath;
      const res = matcher.test(isDir ? `${local}/` : local);
      if (res.ignored) {
        return true;
      }
      if (res.unignored) {
        return false;
      }
    }
    const info = await this.loadRules(join(gitRoot, '.git/info/exclude'));
    if (info) {
      const res = info.test(isDir ? `${relPath}/` : relPath);
      if (res.ignored) {
        return true;
      }
    }
    return false;
  }

  private async loadRules(absFile: string): Promise<Ignore | null> {
    this.opts.onRuleFile?.(absFile);
    const generation = this.generation;
    const cached = this.ruleCache.get(absFile);
    if (cached !== undefined) {
      return cached;
    }
    const content = await this.fs.readFile(absFile);
    let matcher: Ignore | null = null;
    if (content !== undefined && hasEffectiveRule(content)) {
      try {
        matcher = ignore().add(content);
      } catch {
        matcher = null;
      }
    }
    if (generation === this.generation) {
      this.ruleCache.set(absFile, matcher);
    }
    return matcher;
  }

  /** 从 folderRoot 向上最多 12 层找 .git；找到家目录或文件系统根时不采用。 */
  private async findGitRoot(folderRoot: string): Promise<string | null> {
    const generation = this.generation;
    const cached = this.gitRootCache.get(folderRoot);
    if (cached !== undefined) {
      return cached;
    }
    let found: string | null = null;
    let dir = folderRoot;
    for (let i = 0; i <= MAX_ANCESTOR_DEPTH; i++) {
      if (await this.fs.exists(join(dir, '.git'))) {
        found = dir;
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
    if (found) {
      const home = this.opts.homeDir ? toPosix(this.opts.homeDir).replace(/\/+$/, '') : undefined;
      if ((home && found === home) || dirname(found) === found) {
        found = null;
      }
    }
    if (generation === this.generation) {
      this.gitRootCache.set(folderRoot, found);
    }
    return found;
  }
}
