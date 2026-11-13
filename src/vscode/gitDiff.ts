import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ContextSource, SourceContext, SourceResult } from '../core/collector';
import { parseUnifiedDiff, pickDiffHunks, rankDiffHunks, renderDiffHunk, type DiffHunk } from '../core/gitDiff';
import { queryOf } from '../core/snippets';
import type { ChangeItem, SourceDep } from '../core/types';
import type { PermissionGate } from './workspace';

const TTL_MS = 30_000;
const MAX_DIFF_BYTES = 2_000_000;
/** 只对排名靠前的这些改动块做发送许可与未保存检查 */
const MAX_INSPECT = 24;

/** 任何失败（没有 git、不是仓库、没有提交、输出超限、超时）都返回 undefined。不经过 shell。 */
function git(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      'git',
      // 仓库配置里的 fsmonitor、外部 diff 与 textconv 都可能执行命令，这里一律关掉
      ['--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', ...args],
      { cwd, maxBuffer: MAX_DIFF_BYTES, timeout: 4000, windowsHide: true },
      (error, stdout) => resolve(error ? undefined : stdout),
    );
  });
}

interface Entry {
  at: number;
  hunks: DiffHunk[];
  /** 整份 diff 取不到（通常是太大）时，只取了这一个文件 */
  only?: string;
}

export interface GitDiffDeps {
  enabled(): boolean;
  gate: PermissionGate;
  /** 本次会话里编辑过的文档（uri 字符串） */
  recentDocs(): Iterable<string>;
}

/**
 * 未提交改动来源：`git diff HEAD` 的结果按仓库缓存 30 秒，保存文件时失效；同一仓库最多一个在途的 git 进程。
 * 不等它超过上下文截止时间，落后时本次没有改动块，结果留给下一次。
 */
export class GitDiffSource implements ContextSource {
  readonly name = 'gitdiff';
  private readonly roots = new Map<string, Promise<string | undefined>>();
  private readonly cache = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<void>>();

  constructor(private readonly d: GitDiffDeps) {}

  /** 保存文件或配置变化后调用 */
  invalidate(): void {
    this.cache.clear();
  }

  async collect(ctx: SourceContext): Promise<SourceResult | undefined> {
    const uri = vscode.Uri.parse(ctx.docKey);
    if (!this.d.enabled() || uri.scheme !== 'file' || !vscode.workspace.isTrusted) {
      return undefined;
    }
    const file = await fs.promises.realpath(uri.fsPath).catch(() => uri.fsPath);
    const root = await this.rootOf(path.dirname(file));
    if (!root) {
      return undefined;
    }
    const relative = (target: string) => path.relative(root, target).split(path.sep).join('/');
    const currentFile = relative(file);
    const hunks = await this.hunksOf(root, currentFile);
    if (hunks.length === 0) {
      return undefined;
    }
    const recentFiles = new Set<string>();
    for (const key of this.d.recentDocs()) {
      const recent = vscode.Uri.parse(key);
      if (recent.scheme === 'file') {
        recentFiles.add(relative(recent.fsPath));
      }
    }
    let windowLines = 0;
    for (let i = ctx.windowText.indexOf('\n'); i >= 0; i = ctx.windowText.indexOf('\n', i + 1)) {
      windowLines++;
    }
    const ranked = rankDiffHunks({
      hunks, query: ctx.query ?? queryOf(ctx.source, ctx.line, ctx.hint), currentFile,
      windowStart: ctx.windowStartLine, windowEnd: ctx.windowStartLine + windowLines, recentFiles,
    });
    // 其他文件的改动进入提示词前，使用与当前文档一致的发送许可；有未保存修改的文件磁盘内容已过期，不用
    const states = new Map<string, SourceDep | null | false>();
    const usable: DiffHunk[] = [];
    for (const hunk of ranked.slice(0, MAX_INSPECT)) {
      let state = states.get(hunk.file);
      if (state === undefined) {
        state = hunk.file === currentFile ? null : await this.inspect(path.join(root, hunk.file));
        states.set(hunk.file, state);
      }
      if (state !== false) {
        usable.push(hunk);
      }
    }
    const picked = pickDiffHunks(usable);
    if (picked.length === 0) {
      return undefined;
    }
    const changes: ChangeItem[] = picked.map((hunk) => {
      const dep = states.get(hunk.file);
      return { text: renderDiffHunk(hunk), ...(dep ? { dep } : {}) };
    });
    return { changes, status: `${picked.length}/${hunks.length}` };
  }

  private async inspect(file: string): Promise<SourceDep | false> {
    const uri = vscode.Uri.file(file);
    if (vscode.workspace.textDocuments.some((doc) => doc.isDirty && doc.uri.fsPath === uri.fsPath)) {
      return false;
    }
    try {
      if (!(await this.d.gate.permits(uri))) {
        return false;
      }
      const stat = await fs.promises.stat(file);
      return { uri: uri.toString(), mtimeMs: stat.mtimeMs, size: stat.size };
    } catch {
      return false;
    }
  }

  private rootOf(dir: string): Promise<string | undefined> {
    let root = this.roots.get(dir);
    if (!root) {
      root = git(dir, ['rev-parse', '--show-toplevel']).then((out) => out?.trim() || undefined);
      this.roots.set(dir, root);
      if (this.roots.size > 64) {
        this.roots.delete(this.roots.keys().next().value as string);
      }
    }
    return root;
  }

  private async hunksOf(root: string, currentFile: string): Promise<DiffHunk[]> {
    const fresh = () => {
      const entry = this.cache.get(root);
      return entry && Date.now() - entry.at < TTL_MS && (entry.only === undefined || entry.only === currentFile)
        ? entry : undefined;
    };
    if (!fresh()) {
      let task = this.pending.get(root);
      if (!task) {
        task = this.fetch(root, currentFile).finally(() => this.pending.delete(root));
        this.pending.set(root, task);
      }
      await task;
    }
    return fresh()?.hunks ?? [];
  }

  private async fetch(root: string, currentFile: string): Promise<void> {
    const args = ['diff', 'HEAD', '-U2', '--no-color', '--no-ext-diff', '--no-textconv', '--'];
    const all = await git(root, args);
    if (all !== undefined) {
      this.cache.set(root, { at: Date.now(), hunks: parseUnifiedDiff(all) });
      return;
    }
    // 整份取不到（多半是改动太多超过上限）：退回只看当前文件
    const own = await git(root, [...args, currentFile]);
    this.cache.set(root, { at: Date.now(), hunks: own === undefined ? [] : parseUnifiedDiff(own), only: currentFile });
  }
}
