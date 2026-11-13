// 7.1 .vue 顶层区块定位。按行扫描，不依赖任何解析器。
import type { Region, TextSource } from './types';

export interface SfcBlock {
  tag: 'template' | 'script' | 'style';
  startLine: number;
  /** 区块结束行（含）。输入过程中未闭合时取文件最后一行。 */
  endLine: number;
  /** 开始标签里的属性文本，用于判断 `setup` 等。 */
  attrs: string;
}

const OPEN_RE = /^\s*<(template|script|style)\b([^>]*)>?/;

function count(re: RegExp, text: string): number {
  return (text.match(re) ?? []).length;
}

/** 排除单双引号与反引号字符串字面量后，判断是否存在闭合标签（避免 `const s = '</script>'` 提前截断）。 */
function hasOutsideString(lineText: string, re: RegExp): boolean {
  let stripped = '';
  let quote = '';
  for (let i = 0; i < lineText.length; i++) {
    const ch = lineText[i] as string;
    if (quote) {
      if (ch === '\\') {
        i++;
      } else if (ch === quote) {
        quote = '';
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '/' && lineText[i + 1] === '/') {
      break;
    }
    stripped += ch;
  }
  return re.test(stripped);
}

export function findSfcBlocks(source: TextSource): SfcBlock[] {
  const blocks: SfcBlock[] = [];
  const last = source.lineCount - 1;
  let line = 0;
  while (line <= last) {
    const text = source.lineAt(line);
    const m = OPEN_RE.exec(text);
    if (!m) {
      line++;
      continue;
    }
    const tag = m[1] as SfcBlock['tag'];
    const attrs = (m[2] ?? '').trim();
    let end = last;
    if (tag === 'template') {
      // 嵌套的 <template> 计数；开始行里的第一个 <template 属于本区块自己。
      let depth = 0;
      let found = false;
      for (let l = line; l <= last; l++) {
        const t = source.lineAt(l);
        depth += count(/<template\b/g, t);
        depth -= count(/<\/template\s*>/g, t);
        if (depth <= 0) {
          end = l;
          found = true;
          break;
        }
      }
      if (!found) {
        end = last;
      }
    } else {
      const closeRe = tag === 'script' ? /<\/script\s*>/ : /<\/style\s*>/;
      for (let l = line; l <= last; l++) {
        const t = source.lineAt(l);
        // 开始行本身可能就带结束标签：<script src="x"></script>
        const searchFrom = l === line ? t.indexOf('>') + 1 : 0;
        const slice = t.slice(Math.max(0, searchFrom));
        if (tag === 'script' ? hasOutsideString(slice, closeRe) : closeRe.test(slice)) {
          end = l;
          break;
        }
      }
    }
    blocks.push({ tag, startLine: line, endLine: end, attrs });
    line = end + 1;
  }
  return blocks;
}

export function regionAt(blocks: SfcBlock[], line: number): Region {
  for (const b of blocks) {
    if (line >= b.startLine && line <= b.endLine) {
      return b.tag;
    }
  }
  return 'other';
}

export function hasScriptSetup(blocks: SfcBlock[]): boolean {
  return blocks.some((b) => b.tag === 'script' && /(^|\s)setup(\s|=|$)/.test(b.attrs));
}
