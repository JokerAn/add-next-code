import * as vscode from 'vscode';
import type { LiveDoc } from '../core/pipeline';
import type { Position, TextSource } from '../core/types';

export function vscodeSource(document: vscode.TextDocument): TextSource {
  return {
    get lineCount() {
      return document.lineCount;
    },
    lineAt(line: number) {
      if (line < 0 || line >= document.lineCount) {
        return '';
      }
      return document.lineAt(line).text;
    },
  };
}

/** 活文档：版本与光标每次都从编辑器重新读取。 */
export function liveDoc(document: vscode.TextDocument): LiveDoc {
  const source = vscodeSource(document);
  return {
    key: document.uri.toString(),
    languageId: document.languageId,
    fileLabel: vscode.workspace.asRelativePath(document.uri, false),
    source,
    version: () => document.version,
    cursorIsAt: (p: Position) => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || ed.document !== document || ed.selections.length !== 1) {
        return false;
      }
      const sel = ed.selection;
      return sel.isEmpty && sel.active.line === p.line && sel.active.character === p.character;
    },
  };
}
