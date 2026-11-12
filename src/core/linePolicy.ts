// 空行分级：光标停在空行时信号最弱，按上一非空行决定允许模型写多少。纯函数，不解析语法树。

/**
 * free：非空行，沿用原有多行/单行规则。
 * block：空行位于刚打开的代码块或注释之后，允许多行。
 * statement：语句之间的空行，只补一条语句。
 * empty：窗口内光标之前没有任何内容，没有可依据的上下文。
 */
export type LineMode = 'free' | 'block' | 'statement' | 'empty';

const COMMENT_START = /^(\/\/|\/\*|\*|#|<!--)/;
const COMMENT_END = /(\*\/|-->)$/;
const BLOCK_OPENER = /(\{|\(|\[|=>|:)$/;
/** 未自闭合的开始标签结尾，如 <div class="a">、<template> */
const TAG_OPENER = /<[A-Za-z][^<>]*[^/<>]>$|<[A-Za-z]>$/;

export function lineModeOf(prefix: string, suffix: string): LineMode {
  const nl = suffix.indexOf('\n');
  const rest = nl < 0 ? suffix : suffix.slice(0, nl);
  const lineStart = prefix.lastIndexOf('\n') + 1;
  if (rest.trim() !== '' || prefix.slice(lineStart).trim() !== '') {
    return 'free';
  }
  const prev = prefix.slice(0, lineStart).trimEnd();
  if (prev === '') {
    return 'empty';
  }
  const last = prev.slice(prev.lastIndexOf('\n') + 1).trim();
  if (COMMENT_START.test(last) || COMMENT_END.test(last) || BLOCK_OPENER.test(last) || TAG_OPENER.test(last)) {
    return 'block';
  }
  return 'statement';
}

/**
 * 逐字符扫描括号深度，跳过字符串与行注释。单双引号字符串不跨行，模板字符串可跨行。
 * visit 返回 false 时停止。
 */
function walk(text: string, visit: (i: number, ch: string, depth: number, quote: string) => boolean | void): void {
  let depth = 0;
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === '\n' && quote !== '`') {
      quote = '';
    }
    if (quote) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) {
        quote = '';
      }
    } else if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
    } else if (ch === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      if (end < 0) {
        return;
      }
      i = end - 1;
      continue;
    } else if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
    }
    if (visit(i, ch, depth, quote) === false) {
      return;
    }
  }
}

/** 下一行以这些字符开头时视为同一条语句的续行（链式调用、三元、逻辑与算术运算）。 */
const CONTINUATION = new Set(['.', '?', ':', '&', '|', '+', '=']);

/**
 * 只保留第一条语句：在括号已配平的行尾截断，返回截断后的文本；尚不能确定截断点时返回 undefined。
 * 要等看到下一行的首个非空白字符才下结论，因此流式累计文本可以反复调用。
 * 以 < 开头的结果按标记（模板、JSX）处理，不截断。
 */
export function cutStatement(text: string): string | undefined {
  if (text.trimStart().startsWith('<')) {
    return undefined;
  }
  let cut: number | undefined;
  let pending = -1;
  let seen = false;
  walk(text, (i, ch, depth, quote) => {
    if (ch === '\n') {
      if (pending < 0 && seen && depth <= 0 && quote === '') {
        pending = i;
      }
      return;
    }
    if (ch.trim() === '') {
      return;
    }
    seen = true;
    if (pending >= 0) {
      if (CONTINUATION.has(ch)) {
        pending = -1;
        return;
      }
      cut = pending;
      return false;
    }
  });
  return cut === undefined ? undefined : text.slice(0, cut);
}

/**
 * 行数上限的软截断：到 maxLines 行时括号已配平就截在这里；没配平就继续，到配平的行尾为止，最多 2 × maxLines 行。
 * 避免把一个代码块截成半截。尚不能确定截断点时返回 undefined，流式累计文本可以反复调用。
 */
export function cutBalanced(text: string, maxLines: number): string | undefined {
  let newlines = 0;
  let cut: number | undefined;
  walk(text, (i, ch, depth) => {
    if (ch !== '\n') {
      return;
    }
    newlines++;
    if (newlines >= maxLines && (depth <= 0 || newlines >= maxLines * 2)) {
      cut = i;
      return false;
    }
  });
  return cut === undefined ? undefined : text.slice(0, cut);
}

/**
 * 首行是正常代码、后面整段都被 `//` 包着：模型把提示词头部里参照块的 `// ` 前缀一起抄了出来。
 * 条件：首行以 { ( [ 或 => 结尾；其后至少 3 个非空行且全部是 `//` 注释；去掉前缀后括号正好配平。
 * 返回去掉前缀（`//` 加一个空格）后的文本；不满足时返回 undefined。
 */
export function unwrapCommentedBlock(text: string): string | undefined {
  const lines = text.split('\n');
  if (lines.length < 4) {
    return undefined;
  }
  const first = (lines[0] as string).trim();
  if (first === '' || /^(\/\/|\/\*|\*|#|<!--)/.test(first) || !/(?:[{(\[]|=>)$/.test(first)) {
    return undefined;
  }
  const body = lines.slice(1).filter((line) => line.trim() !== '');
  if (body.length < 3 || !body.every((line) => /^\s*\/\/(?!\/)/.test(line))) {
    return undefined;
  }
  const out = lines.map((line, i) => (i === 0 ? line : line.replace(/^(\s*)\/\/ ?/, '$1'))).join('\n');
  return netDepth(out) === 0 ? out : undefined;
}

/** 打开的括号数减去闭合的括号数，跳过字符串与行注释。 */
export function netDepth(text: string): number {
  let net = 0;
  walk(text, (_i, _ch, depth) => {
    net = depth;
  });
  return net;
}

/** 结果整体上闭合多于打开时，返回每一个"多出来"的闭合符（让深度创下新低的那些）及其位置。 */
export function extraClosers(text: string): Array<{ index: number; ch: string }> {
  const out: Array<{ index: number; ch: string }> = [];
  let net = 0;
  let lowest = 0;
  walk(text, (i, ch, depth) => {
    net = depth;
    if (depth < lowest && (ch === ')' || ch === ']' || ch === '}')) {
      lowest = depth;
      out.push({ index: i, ch });
    }
  });
  return net < 0 ? out : [];
}

/**
 * 结果整体上闭合多于打开时，返回第一个多出来的闭合符及其位置。
 * 用于识别"模型把后文已有的闭合符又写了一遍"。
 */
export function firstExtraCloser(text: string): { index: number; ch: string } | undefined {
  let first: { index: number; ch: string } | undefined;
  let net = 0;
  walk(text, (i, ch, depth) => {
    net = depth;
    if (depth < 0 && !first && (ch === ')' || ch === ']' || ch === '}')) {
      first = { index: i, ch };
    }
  });
  return net < 0 ? first : undefined;
}
