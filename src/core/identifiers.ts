// 7.4 标识符提取：从光标附近取最多 20 个，按相关度排序。
import type { TextSource } from './types';

const IDENT_RE = /[A-Za-z_$][\w$-]*/g;

const KEYWORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum',
  'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'let', 'new',
  'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with',
  'yield', 'await', 'async', 'of', 'as', 'from', 'type', 'interface', 'undefined', 'static', 'get', 'set',
  'div', 'span', 'template', 'script', 'style', 'v-if', 'v-for', 'v-else', 'v-model', 'v-bind', 'v-on',
]);

export const MAX_IDENTIFIERS = 20;

/** 光标所在位置之前最近的未闭合标签名；没有则返回 undefined。 */
export function openTagAt(prefixTail: string): string | undefined {
  const lt = prefixTail.lastIndexOf('<');
  if (lt < 0) {
    return undefined;
  }
  const after = prefixTail.slice(lt + 1);
  if (after.includes('>')) {
    return undefined;
  }
  const m = /^([A-Za-z][\w.-]*)/.exec(after);
  return m ? m[1] : undefined;
}

export function extractIdentifiers(source: TextSource, line: number, character: number): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const push = (name: string) => {
    if (name.length < 2 || KEYWORDS.has(name) || seen.has(name) || result.length >= MAX_IDENTIFIERS) {
      return;
    }
    seen.add(name);
    result.push(name);
  };

  const lineText = source.lineAt(line);
  const from = Math.max(0, line - 19);
  let tail = '';
  for (let l = from; l < line; l++) {
    tail += source.lineAt(l) + '\n';
  }
  tail += lineText.slice(0, character);

  // 1. 未闭合标签名
  const tag = openTagAt(tail);
  if (tag) {
    push(tag);
  }

  // 2. 当前行
  for (const m of lineText.matchAll(IDENT_RE)) {
    push(m[0]);
  }

  // 3. 其余行，由近到远
  for (let l = line - 1; l >= from && result.length < MAX_IDENTIFIERS; l--) {
    for (const m of source.lineAt(l).matchAll(IDENT_RE)) {
      push(m[0]);
    }
  }
  return result;
}
