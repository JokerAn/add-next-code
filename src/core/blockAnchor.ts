// 光标所在的代码块：按缩进从光标向上找出一层层包着它的"块开头行"，如 `if (…) {`、`items.forEach((item) => {`。
// 头部沿用时用它当锚点：只要这一行还包着光标，就说明还在同一个代码块里写。纯缩进判断，不解析语法树。
import type { TextSource } from './types';

/** 太短的开头行（`} else {`、`try {`）区分度太低，不当锚点 */
const MIN_ANCHOR_CHARS = 12;
const MAX_LEVELS = 10;
const MAX_SCAN_LINES = 400;
const OPENER = /(?:[{(\[]|=>)$/;

function indentOf(text: string): number {
  return (/^[ \t]*/.exec(text) as RegExpExecArray)[0].length;
}

/**
 * 包着光标的块开头行，由内到外，去掉首尾空白。
 * 参照缩进：光标行光标之前只有空白时取光标所在列，否则取这一行自己的缩进。
 */
export function enclosingOpeners(source: TextSource, cursorLine: number, cursorCharacter: number): string[] {
  const own = source.lineAt(cursorLine);
  let limit = own.slice(0, cursorCharacter).trim() === '' ? Math.max(cursorCharacter, indentOf(own)) : indentOf(own);
  const out: string[] = [];
  for (let line = cursorLine - 1; line >= 0 && cursorLine - line <= MAX_SCAN_LINES && limit > 0 && out.length < MAX_LEVELS; line--) {
    const text = source.lineAt(line);
    if (text.trim() === '') {
      continue;
    }
    const indent = indentOf(text);
    if (indent >= limit) {
      continue;
    }
    limit = indent;
    const trimmed = text.trim();
    if (OPENER.test(trimmed) && trimmed.length >= MIN_ANCHOR_CHARS) {
      out.push(trimmed);
    }
  }
  return out;
}
