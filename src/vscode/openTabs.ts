import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import type { ContextSource, SourceContext, SourceResult } from '../core/collector';
import { languageEnabled } from '../core/guards';
import { selectOpenTabSnippets, type OpenTabCandidate } from '../core/openTabs';
import { queryOf } from '../core/snippets';
import { vscodeSource } from './docWindow';
import type { PermissionGate } from './workspace';

const MAX_CANDIDATE_DOCS = 8;

export interface OpenTabsDeps {
  enabled(): boolean;
  gate: PermissionGate;
  recentDocs(): Iterable<string>;
}

/**
 * 已打开文档上下文来源：提取本窗口其他已打开、同工作区、通过发送许可且已保存的文档中的相关片段。
 * 补齐 `git diff HEAD` 看不到未跟踪新文件（untracked）与未修改参照文件的短板。
 */
export class OpenTabsSource implements ContextSource {
  readonly name = 'opentabs';

  constructor(private readonly d: OpenTabsDeps) {}

  async collect(ctx: SourceContext, deadlineAt: number): Promise<SourceResult | undefined> {
    if (!this.d.enabled() || Date.now() >= deadlineAt) {
      return undefined;
    }
    const currentUri = vscode.Uri.parse(ctx.docKey);
    if (currentUri.scheme !== 'file' && currentUri.scheme !== 'vscode-remote') {
      return undefined;
    }
    const currentFolder = vscode.workspace.getWorkspaceFolder(currentUri);
    if (!currentFolder) {
      return undefined;
    }

    const recentSet = new Set(this.d.recentDocs());
    // 优先检查最近编辑过的文档，再补充其余打开的文档
    const docs = [...vscode.workspace.textDocuments].filter((doc) => {
      if (doc.uri.toString() === ctx.docKey || doc.isDirty) {
        return false;
      }
      if (doc.uri.scheme !== 'file' && doc.uri.scheme !== 'vscode-remote') {
        return false;
      }
      if (!languageEnabled(ctx.cfg, doc.languageId)) {
        return false;
      }
      const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
      return folder !== undefined && folder.uri.toString() === currentFolder.uri.toString();
    });
    if (docs.length === 0) {
      return undefined;
    }

    docs.sort((a, b) => {
      const ra = recentSet.has(a.uri.toString()) ? 1 : 0;
      const rb = recentSet.has(b.uri.toString()) ? 1 : 0;
      return rb - ra;
    });

    const candidates: OpenTabCandidate[] = [];
    for (const doc of docs.slice(0, MAX_CANDIDATE_DOCS)) {
      if (Date.now() >= deadlineAt) {
        break;
      }
      if (!(await this.d.gate.permits(doc.uri))) {
        continue;
      }
      try {
        const stat = await fs.stat(doc.uri.fsPath);
        candidates.push({
          uri: doc.uri.toString(),
          label: vscode.workspace.asRelativePath(doc.uri, false),
          source: vscodeSource(doc),
          dep: { uri: doc.uri.toString(), mtimeMs: stat.mtimeMs, size: stat.size },
          recent: recentSet.has(doc.uri.toString()),
        });
      } catch {
        // 磁盘不存在或无法读取时跳过
      }
    }
    if (candidates.length === 0 || Date.now() >= deadlineAt) {
      return undefined;
    }

    const query = ctx.query ?? queryOf(ctx.source, ctx.line, ctx.hint);
    const picked = selectOpenTabSnippets(candidates, query);
    if (picked.length === 0) {
      return undefined;
    }
    return { openTabs: picked, status: `${picked.length}/${candidates.length}` };
  }
}
