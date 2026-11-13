// 已打开标签页上下文（Open Tabs）：从本窗口打开的其他同工作区文件（包括 git diff 看不到的未跟踪新文件与未修改参照文件）中，
// 按光标附近的稀有标识符与中文意图注释取出最相关的 1～3 段代码。纯函数，不访问 VS Code API。
import { subTokensOf, tokenMatches, tokensOf, type Query } from './snippets';
import type { ChangeItem, SourceDep, TextSource } from './types';

export interface OpenTabCandidate {
  /** 文档标识（uri 字符串） */
  uri: string;
  /** 展示用相对路径（如 src/api/order.ts） */
  label: string;
  source: TextSource;
  /** 已保存文件的磁盘指纹；未保存或 untitled 文档没有指纹（为安全起见，由宿主决定是否传入或过滤） */
  dep?: SourceDep;
  /** 是否在本次会话近期编辑过 */
  recent?: boolean;
}

const MAX_TAB_LINES = 8000;
const MAX_LINE_CHARS = 160;
const RADIUS = 3;
const MAX_ITEMS = 3;
const MAX_TOTAL_CHARS = 1200;
const MAX_BLOCK_CHARS = 600;

interface ScoredTabSnippet {
  label: string;
  start: number;
  text: string;
  score: number;
  dep?: SourceDep;
}

/**
 * 从候选打开文档里挑出与 query 强相关的代码片段：
 * - 必须至少命中一个在候选集中罕见的词，或同时命中两个不同的检索词（与跨文件 gitDiff 门槛对齐，绝不塞无关噪音）；
 * - 按得分取前 MAX_ITEMS 段（合计不超过 MAX_TOTAL_CHARS），最后按文件名与行号稳定排序，保护服务端前缀缓存。
 */
export function selectOpenTabSnippets(
  tabs: readonly OpenTabCandidate[],
  query: Query,
): ChangeItem[] {
  if (tabs.length === 0 || query.factors.size === 0) {
    return [];
  }

  // 统计每个检索词在多少个打开文档里出现过，过滤到处都有的泛称
  const docFreq = new Map<string, number>();
  const tabLineTokens: Array<Map<number, string[]>> = [];

  for (const tab of tabs) {
    const n = Math.min(tab.source.lineCount, MAX_TAB_LINES);
    const lineMap = new Map<number, string[]>();
    const seenInDoc = new Set<string>();
    for (let line = 0; line < n; line++) {
      const raw = tab.source.lineAt(line);
      if (raw.length > 2000 || raw.trim() === '') {
        continue;
      }
      const baseTokens = tokensOf(raw, query.phrases);
      const subs = subTokensOf(raw);
      const tokens = subs.length > 0 ? [...new Set([...baseTokens, ...subs])] : baseTokens;
      if (tokens.length === 0) {
        continue;
      }
      const matchedQueries: string[] = [];
      for (const [word] of query.factors) {
        if (tokens.some((t) => tokenMatches(word, t, query.fromHint.has(word)))) {
          matchedQueries.push(word);
          seenInDoc.add(word);
        }
      }
      if (matchedQueries.length > 0) {
        lineMap.set(line, matchedQueries);
      }
    }
    for (const word of seenInDoc) {
      docFreq.set(word, (docFreq.get(word) ?? 0) + 1);
    }
    tabLineTokens.push(lineMap);
  }

  const specificDocMax = Math.max(1, Math.ceil(tabs.length * 0.4));
  const candidates: ScoredTabSnippet[] = [];

  tabs.forEach((tab, idx) => {
    const lineMap = tabLineTokens[idx]!;
    if (lineMap.size === 0) {
      return;
    }
    const n = Math.min(tab.source.lineCount, MAX_TAB_LINES);
    const remaining = new Map(lineMap);

    // 每个文件最多取 2 段
    for (let pick = 0; pick < 2 && remaining.size > 0; pick++) {
      let bestCenter = -1;
      let bestScore = 0;
      let bestWords = new Set<string>();

      for (const line of remaining.keys()) {
        for (let center = Math.max(0, line - RADIUS); center <= Math.min(n - 1, line + RADIUS); center++) {
          const words = new Set<string>();
          const wordCounts = new Map<string, number>();
          for (let l = Math.max(0, center - RADIUS); l <= Math.min(n - 1, center + RADIUS); l++) {
            for (const w of remaining.get(l) ?? []) {
              words.add(w);
              wordCounts.set(w, (wordCounts.get(w) ?? 0) + 1);
            }
          }
          if (words.size === 0) {
            continue;
          }
          const hasSpecific = [...words].some(
            (w) => (docFreq.get(w) ?? 0) <= specificDocMax && (w.length >= 5 || (wordCounts.get(w) ?? 0) >= 2),
          );
          if (!hasSpecific && words.size < 2) {
            continue;
          }
          let score = 0;
          for (const w of words) {
            const cnt = wordCounts.get(w) ?? 1;
            score += ((query.factors.get(w) ?? 0) * (1 + Math.min(0.3, 0.1 * (cnt - 1)))) / Math.max(1, docFreq.get(w) ?? 1);
          }
          if (tab.recent) {
            score += 0.3;
          }
          if (score > bestScore) {
            bestScore = score;
            bestCenter = center;
            bestWords = words;
          }
        }
      }

      if (bestCenter < 0 || bestWords.size === 0) {
        break;
      }

      let lo = Infinity;
      let hi = -1;
      for (let l = Math.max(0, bestCenter - RADIUS); l <= Math.min(n - 1, bestCenter + RADIUS); l++) {
        if (remaining.has(l)) {
          lo = Math.min(lo, l);
          hi = Math.max(hi, l);
        }
      }
      const start = Math.max(0, lo - 2);
      const end = Math.min(n - 1, Math.max(start + 2 * RADIUS, hi + 4));
      for (let l = Math.max(0, start - RADIUS); l <= Math.min(n - 1, end + RADIUS); l++) {
        remaining.delete(l);
      }

      const rendered = renderTabSnippet(tab.label, tab.source, start, end);
      if (rendered) {
        candidates.push({
          label: tab.label,
          start,
          text: rendered,
          score: bestScore,
          ...(tab.dep ? { dep: tab.dep } : {}),
        });
      }
    }
  });

  candidates.sort((a, b) => b.score - a.score);
  const chosen: ScoredTabSnippet[] = [];
  let used = 0;
  for (const item of candidates) {
    if (chosen.length >= MAX_ITEMS) {
      break;
    }
    if (used + item.text.length > MAX_TOTAL_CHARS) {
      continue;
    }
    used += item.text.length;
    chosen.push(item);
  }

  chosen.sort((a, b) => (a.label === b.label ? a.start - b.start : a.label < b.label ? -1 : 1));
  return chosen.map((item) => ({ text: item.text, ...(item.dep ? { dep: item.dep } : {}) }));
}

function renderTabSnippet(label: string, source: TextSource, from: number, to: number): string | undefined {
  let start = from;
  let end = to;
  while (start <= end && source.lineAt(start).trim() === '') {
    start++;
  }
  while (end >= start && source.lineAt(end).trim() === '') {
    end--;
  }
  if (start > end) {
    return undefined;
  }
  const rawLines: string[] = [];
  for (let l = start; l <= end; l++) {
    rawLines.push(source.lineAt(l).replace(/\s+$/, ''));
  }
  const indents = rawLines
    .filter((t) => t.trim() !== '')
    .map((t) => (/^[ \t]*/.exec(t) as RegExpExecArray)[0].length);
  const minIndent = indents.length > 0 ? Math.min(...indents) : 0;

  const out: string[] = [`${label}:`];
  let size = out[0]!.length + 1;
  for (const line of rawLines) {
    const trimmed = line.slice(minIndent).slice(0, MAX_LINE_CHARS);
    if (size + trimmed.length + 1 > MAX_BLOCK_CHARS && out.length > 1) {
      break;
    }
    out.push(trimmed);
    size += trimmed.length + 1;
  }
  return out.length > 1 ? out.join('\n') : undefined;
}
