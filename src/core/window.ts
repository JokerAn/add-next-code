// 6.2 窗口切片。纯函数，只读取光标附近的行。
import type { Position, SelectedInfo, TextSource } from './types';

export interface WindowLimits {
  prefixChars: number;
  suffixChars: number;
  maxPrefixLines: number;
  maxSuffixLines: number;
}

export interface WindowResult {
  /** 光标（或虚拟光标）之前的文本。行之间一律用 \n 连接，与文档实际换行符无关。 */
  prefix: string;
  /** 光标（或虚拟光标）之后的文本。 */
  suffix: string;
  /** prefix 起点所在行与列；同一行的 sci 文本视为接在原前文之后，startChar 可以落在 sci 内。 */
  startLine: number;
  startChar: number;
  /** （虚拟）光标所在行。 */
  anchorLine: number;
}

/** 前缀起点按这个行数对齐，让连续请求共享长前缀（D9）。 */
export const WINDOW_ALIGN_LINES = 25;

/** 虚拟光标：存在 sci 时按"用户已接受菜单选中项"来构造窗口。 */
export interface Cursor {
  /** prefix 止于此位置（不含 sciText）。 */
  before: Position;
  /** suffix 始于此位置。 */
  after: Position;
  /** 拼在 before 之后的文本（菜单选中项）。 */
  insertedText: string;
}

export function cursorOf(position: Position, sci?: SelectedInfo): Cursor {
  if (sci) {
    return { before: sci.start, after: sci.end, insertedText: sci.text };
  }
  return { before: position, after: position, insertedText: '' };
}

/**
 * 读取 [startLine:startChar, cursor.before) 的文本并接上 insertedText。
 * 窗口构造与缓存查找共用这一个实现，保证两边的文本口径完全一致。
 */
export function readPrefix(
  source: TextSource,
  startLine: number,
  startChar: number,
  cursor: Cursor,
  maxChars = Infinity,
): string {
  if (maxChars <= 0) {
    return '';
  }
  const endLine = cursor.before.line;
  if (startLine > endLine) {
    return cursor.insertedText.slice(0, maxChars);
  }
  const parts: string[] = [];
  let used = 0;
  for (let line = startLine; line <= endLine; line++) {
    let text = source.lineAt(line);
    if (line === endLine) {
      text = text.slice(0, cursor.before.character) + cursor.insertedText;
    }
    if (line === startLine) {
      text = text.slice(startChar);
    }
    if (line > startLine) {
      used++;
    }
    parts.push(text.slice(0, maxChars - used));
    used += text.length;
    if (used >= maxChars) {
      break;
    }
  }
  return parts.join('\n');
}

export function readSuffix(source: TextSource, cursor: Cursor, limits: WindowLimits): string {
  const startLine = cursor.after.line;
  if (startLine >= source.lineCount) {
    return '';
  }
  const half = Math.max(1, Math.floor(limits.suffixChars / 2));
  const first = source.lineAt(startLine).slice(cursor.after.character);
  // 长行保护：光标后的部分过长时只保留紧邻光标的一半预算。
  const firstKept = first.length > half ? first.slice(0, half) : first;
  const parts: string[] = [firstKept];
  let used = firstKept.length;
  let lines = 1;
  if (first.length > half) {
    return firstKept;
  }
  for (let line = startLine + 1; line < source.lineCount; line++) {
    if (lines >= limits.maxSuffixLines) {
      break;
    }
    const text = source.lineAt(line);
    // +1 为换行符
    if (used + 1 + text.length > limits.suffixChars) {
      break;
    }
    parts.push(text);
    used += 1 + text.length;
    lines++;
  }
  return parts.join('\n');
}

/** 计算前缀起点（行、列）。 */
export function computePrefixStart(
  source: TextSource,
  cursor: Cursor,
  limits: WindowLimits,
): { startLine: number; startChar: number } {
  const anchorLine = cursor.before.line;
  const lineText = source.lineAt(anchorLine);
  const beforeOnLine = lineText.slice(0, cursor.before.character).length + cursor.insertedText.length;
  const half = Math.max(1, Math.floor(limits.prefixChars / 2));
  if (beforeOnLine > half) {
    // 长行保护：只保留紧邻光标的 prefixChars/2 个字符（含菜单选中项），不对齐。
    const startChar = beforeOnLine - half;
    return { startLine: anchorLine, startChar };
  }

  let used = beforeOnLine;
  let raw = anchorLine;
  let lines = 1;
  for (let line = anchorLine - 1; line >= 0; line--) {
    if (lines >= limits.maxPrefixLines) {
      break;
    }
    const len = source.lineAt(line).length + 1; // 含换行符
    if (used + len > limits.prefixChars) {
      break;
    }
    used += len;
    raw = line;
    lines++;
  }
  const aligned = Math.ceil(raw / WINDOW_ALIGN_LINES) * WINDOW_ALIGN_LINES;
  const startLine = aligned > anchorLine ? raw : aligned;
  return { startLine, startChar: 0 };
}

export function buildWindow(
  source: TextSource,
  position: Position,
  sci: SelectedInfo | undefined,
  limits: WindowLimits,
): WindowResult {
  const cursor = cursorOf(position, sci);
  const { startLine, startChar } = computePrefixStart(source, cursor, limits);
  return {
    prefix: readPrefix(source, startLine, startChar, cursor),
    suffix: readSuffix(source, cursor, limits),
    startLine,
    startChar,
    anchorLine: cursor.before.line,
  };
}
