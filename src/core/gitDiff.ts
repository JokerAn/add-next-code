// 未提交改动（git diff HEAD）作为上下文：只取与光标处相关的改动块，设硬上限。纯函数，不执行 git。
// 背景：Continue 的补全曾把整份 diff 放进提示词，后来禁用，原因是 diff 通常太大、把其他上下文挤掉。
import { tokenMatches, tokensOf, type Query } from './snippets';

export interface DiffHunk {
  /** 仓库内的相对路径（新文件名） */
  file: string;
  /** 这一块在新文件里的起始行（0 起） */
  start: number;
  /** 新文件一侧的文本：上下文行与新增行，不含被删除的行 */
  lines: string[];
  /** 其中新增行的数量 */
  added: number;
}

const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
/** 改动块切成不超过这么多行的小块，分别计分 */
const CHUNK_LINES = 10;
const MAX_LINE_CHARS = 160;
const SKIP_FILE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|.*\.min\.(js|css)|.*\.map)$/;

/** 解析 `git diff -U<n> --no-color` 的输出。二进制文件、删除的文件、锁文件与压缩产物不产生改动块。 */
export function parseUnifiedDiff(text: string, maxChunks = 600): DiffHunk[] {
  const out: DiffHunk[] = [];
  let file: string | undefined;
  let current: DiffHunk | undefined;
  let line = 0;
  const flush = () => {
    if (current && current.added > 0 && current.lines.some((l) => l.trim() !== '')) {
      out.push(current);
    }
    current = undefined;
  };
  for (const raw of text.split('\n')) {
    if (out.length >= maxChunks) {
      break;
    }
    if (raw.startsWith('diff --git ')) {
      flush();
      file = undefined;
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const path = raw.slice(4).trim();
      file = path === '/dev/null' || !path.startsWith('b/') || SKIP_FILE.test(path) ? undefined : path.slice(2);
      continue;
    }
    const header = HUNK_RE.exec(raw);
    if (header) {
      flush();
      line = Number(header[1]) - 1;
      current = file === undefined ? undefined : { file, start: line, lines: [], added: 0 };
      continue;
    }
    if (!current || raw.startsWith('-') || raw.startsWith('\\')) {
      continue;
    }
    if (raw.startsWith('+') || raw.startsWith(' ')) {
      if (current.lines.length >= CHUNK_LINES) {
        const next: DiffHunk = { file: current.file, start: line, lines: [], added: 0 };
        flush();
        current = next;
      }
      current.lines.push(raw.slice(1).replace(/\s+$/, '').slice(0, MAX_LINE_CHARS));
      if (raw.startsWith('+')) {
        current.added++;
      }
      line++;
    }
  }
  flush();
  return out;
}

export interface RankInput {
  hunks: DiffHunk[];
  query: Query;
  /** 当前文档在仓库内的相对路径；不在仓库内时为空 */
  currentFile?: string;
  /** 当前文档已在提示词窗口里的行范围（0 起，含两端） */
  windowStart: number;
  windowEnd: number;
  /** 本次会话里编辑过的文件（仓库内相对路径） */
  recentFiles?: ReadonlySet<string>;
}

/**
 * 按与光标处的相关度排序，不相关的不返回：
 * - 当前文件的改动块（窗口之外）总是候选；
 * - 其他文件的改动块必须与检索词有交集：命中一个只在少数改动块里出现的词，或同时命中两个不同的词。
 */
export function rankDiffHunks(input: RankInput): DiffHunk[] {
  const { hunks, query } = input;
  const tokens = hunks.map((hunk) => tokensOf(hunk.lines.join('\n'), query.phrases));
  const scored: Array<{ hunk: DiffHunk; score: number }> = [];
  const matched: string[][] = hunks.map(() => []);
  const frequency = new Map<string, number>();
  for (const [word] of query.factors) {
    let count = 0;
    hunks.forEach((_, i) => {
      if ((tokens[i] as string[]).some((token) => tokenMatches(word, token, query.fromHint.has(word)))) {
        (matched[i] as string[]).push(word);
        count++;
      }
    });
    frequency.set(word, count);
  }
  const specificMax = Math.max(2, Math.ceil(hunks.length * 0.25));
  hunks.forEach((hunk, i) => {
    const words = matched[i] as string[];
    const own = hunk.file === input.currentFile;
    if (own && hunk.start <= input.windowEnd && hunk.start + hunk.lines.length - 1 >= input.windowStart) {
      return;
    }
    let relevance = 0;
    for (const word of words) {
      relevance += (query.factors.get(word) ?? 0) / (frequency.get(word) ?? 1);
    }
    const specific = words.some((word) => (frequency.get(word) ?? 0) <= specificMax);
    if (!own && !(specific || words.length >= 2)) {
      return;
    }
    scored.push({ hunk, score: relevance + (own ? 0.5 : 0) + (input.recentFiles?.has(hunk.file) ? 0.3 : 0) });
  });
  return scored.sort((a, b) => b.score - a.score).map((item) => item.hunk);
}

export interface PickOptions {
  maxHunks: number;
  maxChars: number;
}

export const DEFAULT_PICK: PickOptions = { maxHunks: 6, maxChars: 1600 };

/** 按排名取到预算为止，再按"文件、行号"排成稳定顺序（相同的选择得到相同的文本，利于服务端前缀缓存）。 */
export function pickDiffHunks(ranked: DiffHunk[], options: PickOptions = DEFAULT_PICK): DiffHunk[] {
  const chosen: DiffHunk[] = [];
  let used = 0;
  for (const hunk of ranked) {
    if (chosen.length >= options.maxHunks) {
      break;
    }
    const size = renderDiffHunk(hunk).length;
    if (used + size > options.maxChars) {
      continue;
    }
    used += size;
    chosen.push(hunk);
  }
  return chosen.sort((a, b) => (a.file === b.file ? a.start - b.start : a.file < b.file ? -1 : 1));
}

/** 去掉公共缩进后的新文件一侧文本，首行标明文件。不含行号。 */
export function renderDiffHunk(hunk: DiffHunk): string {
  const lines = [...hunk.lines];
  while (lines.length > 0 && (lines[0] as string).trim() === '') {
    lines.shift();
  }
  while (lines.length > 0 && (lines[lines.length - 1] as string).trim() === '') {
    lines.pop();
  }
  const indents = lines.filter((l) => l.trim() !== '').map((l) => (/^[ \t]*/.exec(l) as RegExpExecArray)[0].length);
  const indent = indents.length > 0 ? Math.min(...indents) : 0;
  return [`${hunk.file}:`, ...lines.map((l) => l.slice(indent))].join('\n');
}
