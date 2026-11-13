import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ContextSource, SourceContext, SourceResult } from '../core/collector';
import { depsValid } from '../core/deps';
import { SkimmerClient } from '../core/skimmer/client';
import type { Config, Framework, RelatedItem, SourceDep } from '../core/types';
import type { SkimmerQueryRecord } from '../core/metrics';
import { depsIo, type PermissionGate } from './workspace';

function relative(root: string, file: string): string | undefined {
  const rel = path.relative(root, file);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return undefined;
  }
  return rel.replace(/\\/g, '/');
}

function uriAt(base: vscode.Uri, file: string): vscode.Uri {
  const local = vscode.Uri.file(file);
  return base.scheme === 'vscode-remote' ? base.with({ path: local.path }) : local;
}

export interface SkimmerSourceDeps {
  cfg(): Config;
  cacheDir: string;
  gate: PermissionGate;
  status(text: string): void;
  log(text: string): void;
  onIndexChanged(): void;
  onQuery?(record: SkimmerQueryRecord): void;
}

const WARM_LANGUAGES = new Set(['vue', 'javascript', 'typescript', 'javascriptreact', 'typescriptreact']);

/** 只在通过防抖后的 collector 内调用，基础模式不依赖这个来源。 */
export class SkimmerSource implements ContextSource, vscode.Disposable {
  readonly name = 'skimmer';
  private readonly client: SkimmerClient;
  private readonly warmed = new Set<string>();
  private warmTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly d: SkimmerSourceDeps) {
    this.client = new SkimmerClient({
      options: () => {
        const cfg = d.cfg();
        return {
          enabled: cfg.skimmerEnabled, command: cfg.skimmerCommand,
          args: cfg.skimmerArgs, nodePath: cfg.skimmerNodePath, cacheDir: d.cacheDir,
        };
      },
      status: d.status, log: d.log, onIndexChanged: d.onIndexChanged,
      onQuery: d.onQuery,
    });
  }

  restart(): Promise<void> {
    this.warmed.clear();
    if (this.warmTimer) {
      clearTimeout(this.warmTimer);
      this.warmTimer = undefined;
    }
    return this.client.restart();
  }

  /**
   * 空闲预热：当用户启用了 Skimmer 并打开/切换到受支持的源文件时，延迟 1.5s 在后台静默启动并预热首份摘要。
   * 解决首次敲 `this.` 等不完整语法时握手慢且尚无可用旧摘要的问题；不计入补全查询统计。
   */
  scheduleWarmup(document: vscode.TextDocument | undefined): void {
    if (this.warmTimer) {
      clearTimeout(this.warmTimer);
      this.warmTimer = undefined;
    }
    const cfg = this.d.cfg();
    if (!cfg.skimmerEnabled || !document || !WARM_LANGUAGES.has(document.languageId)) {
      return;
    }
    if (document.uri.scheme !== 'file' && document.uri.scheme !== 'vscode-remote') {
      return;
    }
    const docKey = document.uri.toString();
    if (this.warmed.has(docKey)) {
      return;
    }
    const timer = setTimeout(() => {
      this.warmTimer = undefined;
      void this.warmup(document).catch(() => undefined);
    }, 1500);
    timer.unref?.();
    this.warmTimer = timer;
  }

  private async warmup(document: vscode.TextDocument): Promise<void> {
    const cfg = this.d.cfg();
    if (!cfg.skimmerEnabled || document.isClosed) {
      return;
    }
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder || !(await this.d.gate.permits(document.uri))) {
      return;
    }
    const project = await fs.realpath(folder.uri.fsPath).catch(() => undefined);
    const canonical = await fs.realpath(document.uri.fsPath).catch(() => undefined);
    if (!project || !canonical || !relative(project, canonical)) {
      return;
    }
    if (!(await this.client.waitUntilReady?.()) && !this.client.ready) {
      return;
    }
    const text = typeof document.getText === 'function' ? document.getText() : '';
    if (!text || text.length > cfg.skimmerMaxDocumentChars) {
      return;
    }
    this.warmed.add(document.uri.toString());
    if (this.warmed.size > 32) {
      this.warmed.delete(this.warmed.keys().next().value as string);
    }
    await this.client.query({
      protocol: 1,
      project_path: project,
      file_path: canonical,
      document: { text },
      cursor: { line: 0, character: 0 },
      identifiers: [],
      dirty_files: [],
      max_items: 1,
      budget_chars: cfg.headerChars,
      deadline_ms: 2000,
    }, Date.now() + 2000, { silent: true });
  }

  async collect(ctx: SourceContext, deadlineAt: number): Promise<SourceResult | undefined> {
    const cfg = this.d.cfg();
    if (!cfg.skimmerEnabled || Date.now() >= deadlineAt) {
      return undefined;
    }
    const uri = vscode.Uri.parse(ctx.docKey);
    if (uri.scheme !== 'file' && uri.scheme !== 'vscode-remote') {
      return undefined;
    }
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
      return undefined;
    }
    this.client.ensureStarted();
    if (!this.client.ready) {
      return { status: 'starting' };
    }
    // Node 侧运行在 workspace extension host；remote 的 fsPath 是该主机实际路径。
    const project = await fs.realpath(folder.uri.fsPath).catch(() => undefined);
    if (!project || Date.now() >= deadlineAt || !(await this.d.gate.permits(uri))) {
      return undefined;
    }
    const file = uri.fsPath;
    const canonical = await fs.realpath(file).catch(async () => {
      const parent = await fs.realpath(path.dirname(file)).catch(() => undefined);
      return parent ? path.join(parent, path.basename(file)) : undefined;
    });
    if (!canonical || !relative(project, canonical) || Date.now() >= deadlineAt) {
      return undefined;
    }
    const document = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === ctx.docKey);
    if (!document || document.version !== ctx.version) {
      return undefined;
    }
    // 优先使用快速全文快照（长度超预算时提前中止）
    let docText: string;
    if (ctx.source.getText) {
      const full = ctx.source.getText(cfg.skimmerMaxDocumentChars + 1);
      if (full.length > cfg.skimmerMaxDocumentChars) {
        this.d.status('仅基础模式：当前文件超过 Skimmer 快照预算');
        return { status: 'document-too-large' };
      }
      docText = full;
    } else {
      const lines: string[] = [];
      let chars = 0;
      for (let line = 0; line < ctx.source.lineCount; line++) {
        const text = ctx.source.lineAt(line);
        chars += text.length + (line > 0 ? 1 : 0);
        if (chars > cfg.skimmerMaxDocumentChars) {
          this.d.status('仅基础模式：当前文件超过 Skimmer 快照预算');
          return { status: 'document-too-large' };
        }
        lines.push(text);
      }
      docText = lines.join('\n');
    }
    const dirty: string[] = [];
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.isDirty && doc !== document && (doc.uri.scheme === 'file' || doc.uri.scheme === 'vscode-remote')) {
        const dirtyPath = await fs.realpath(doc.uri.fsPath).catch(() => doc.uri.fsPath);
        const rel = relative(project, dirtyPath);
        if (rel) {
          dirty.push(rel);
        }
      }
    }
    const data = await this.client.query({
      protocol: 1, project_path: project, file_path: canonical,
      ...(ctx.projectVueMajor ? { vue_major: ctx.projectVueMajor } : {}),
      document: { text: docText },
      cursor: { line: ctx.line, character: ctx.character },
      identifiers: ctx.identifiers.slice(0, 20), dirty_files: dirty,
      max_items: 8, budget_chars: cfg.headerChars,
      deadline_ms: Math.max(1, deadlineAt - Date.now()),
    }, deadlineAt);
    if (!data || document.version !== ctx.version || Date.now() >= deadlineAt) {
      return undefined;
    }
    const related: RelatedItem[] = [];
    for (const item of data.index.state === 'locked' ? [] : data.related) {
      if (Date.now() >= deadlineAt) {
        break;
      }
      const main = await this.sourceDep(project, item.file, item.fingerprint, folder.uri);
      if (!main) {
        continue;
      }
      const deps: SourceDep[] = [];
      let valid = true;
      for (const dependency of item.dependencies ?? []) {
        const dep = await this.sourceDep(project, dependency.file, dependency.fingerprint, folder.uri);
        if (!dep) {
          valid = false;
          break;
        }
        deps.push(dep);
      }
      if (valid && await depsValid([main, ...deps], depsIo)) {
        related.push({
          kind: item.kind, name: item.name, file: item.file, interface: item.interface, dep: main, deps,
        });
      }
    }
    const framework: Framework | undefined = data.framework === 'js' || data.framework === 'ts'
      ? (ctx.framework === 'react' ? 'react' : 'node')
      : data.framework === 'unknown' ? undefined : data.framework;
    return {
      members: data.self?.members ?? [], related, framework,
      status: data.index.state === 'locked' ? 'locked' : data.overlay.state === 'ready' ? 'ok' : data.overlay.state,
    };
  }

  private async sourceDep(
    project: string,
    file: string,
    fingerprint: { mtimeMs: number; size: number },
    folder: vscode.Uri,
  ): Promise<SourceDep | undefined> {
    if (path.isAbsolute(file)) {
      return undefined;
    }
    const absolute = path.resolve(project, file);
    if (!relative(project, absolute)) {
      return undefined;
    }
    const actual = await fs.realpath(absolute).catch(() => undefined);
    if (!actual || !relative(project, actual)) {
      return undefined;
    }
    // 使用实际路径和别名路径各检查一次，避免符号链接绕过项目排除规则。
    const uri = uriAt(folder, actual);
    const projectAlias = uriAt(folder, path.resolve(folder.fsPath, file));
    if (!(await this.d.gate.permits(projectAlias)) || !(await this.d.gate.permits(uri))) {
      return undefined;
    }
    return { uri: uri.toString(), ...fingerprint };
  }

  dispose(): Promise<void> {
    if (this.warmTimer) {
      clearTimeout(this.warmTimer);
      this.warmTimer = undefined;
    }
    return this.client.dispose();
  }
}
