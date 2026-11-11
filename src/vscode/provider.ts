import * as vscode from 'vscode';
import type { HealthState } from '../core/backoff';
import { checkGuards } from '../core/guards';
import type { CompletionPipeline } from '../core/pipeline';
import type { CancelToken, Config, SelectedInfo } from '../core/types';
import { liveDoc } from './docWindow';
import type { KeyStore } from './secrets';
import type { PermissionGate } from './workspace';

export interface ProviderDeps {
  cfg(): Config;
  runtimeEnabled(): boolean;
  pipeline: CompletionPipeline;
  gate: PermissionGate;
  keys: KeyStore;
  health: HealthState;
}

export class FimInlineProvider implements vscode.InlineCompletionItemProvider {
  constructor(private readonly d: ProviderDeps) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const d = this.d;
    const editor = vscode.window.activeTextEditor;
    const trigger = context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke ? 'manual' : 'auto';

    const reason = checkGuards({
      cfg: d.cfg(),
      runtimeEnabled: d.runtimeEnabled(),
      languageId: document.languageId,
      scheme: document.uri.scheme,
      permitted: d.gate.check(document.uri),
      hasKey: d.keys.hasKey,
      isActiveEditorDoc: editor?.document === document,
      selectionCount: editor?.selections.length ?? 0,
      selectionEmpty: editor?.selection.isEmpty ?? false,
      cursorAtPosition: editor?.selection.active.isEqual(position) ?? false,
      trigger,
      hasSelectedCompletion: context.selectedCompletionInfo !== undefined,
      health: d.health,
    });
    if (reason) {
      return undefined;
    }

    const sci = context.selectedCompletionInfo;
    const sciInfo: SelectedInfo | undefined = sci
      ? {
          start: { line: sci.range.start.line, character: sci.range.start.character },
          end: { line: sci.range.end.line, character: sci.range.end.character },
          text: sci.text,
        }
      : undefined;

    const cancel: CancelToken = {
      get isCancellationRequested() {
        return token.isCancellationRequested;
      },
      onCancellationRequested: (listener) => token.onCancellationRequested(listener),
    };
    const permissionVersion = d.gate.version;
    const isValid = () =>
      d.runtimeEnabled() &&
      d.keys.hasKey &&
      d.gate.version === permissionVersion &&
      d.gate.check(document.uri) === true;

    const out = await d.pipeline.run({
      doc: liveDoc(document),
      position: { line: position.line, character: position.character },
      sci: sciInfo,
      trigger,
      token: cancel,
      isValid,
    });
    if (!out || token.isCancellationRequested || !isValid()) {
      return undefined;
    }
    if (sci) {
      // 官方契约：存在选中项时，候选必须使用相同 range，并以选中项文本开头
      return [new vscode.InlineCompletionItem(sci.text + out.text, sci.range)];
    }
    // 必须显式传空范围，省略 range 会替换光标处的单词
    return [new vscode.InlineCompletionItem(out.text, new vscode.Range(position, position))];
  }
}
