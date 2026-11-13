import * as vscode from 'vscode';
import type { LiveDoc } from '../core/pipeline';
import type { Position, TextSource } from '../core/types';

export function vscodeSource(document: vscode.TextDocument): TextSource {
  let cachedVersion = -1;
  let cachedText = '';
  let cachedLines: string[] | undefined;
  return {
    get lineCount() {
      return document.lineCount;
    },
    lineAt(line: number) {
      if (line < 0 || line >= document.lineCount) {
        return '';
      }
      if (cachedLines && cachedVersion === document.version) {
        return cachedLines[line] ?? '';
      }
      return document.lineAt(line).text;
    },
    getText(maxChars?: number) {
      if (typeof document.getText !== 'function') {
        const parts: string[] = [];
        let used = 0;
        const limit = maxChars ?? Infinity;
        for (let line = 0; line < document.lineCount && used < limit; line++) {
          const text = document.lineAt(line).text;
          parts.push(text);
          used += text.length + 1;
        }
        return parts.join('\n');
      }
      if (cachedVersion !== document.version) {
        const raw = document.getText();
        cachedText = raw.includes('\r') ? raw.replace(/\r\n/g, '\n') : raw;
        cachedLines = cachedText.split('\n');
        cachedVersion = document.version;
      }
      if (maxChars !== undefined && cachedText.length > maxChars) {
        const nl = cachedText.lastIndexOf('\n', maxChars);
        return nl >= 0 ? cachedText.slice(0, nl) : cachedText.slice(0, maxChars);
      }
      return cachedText;
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
