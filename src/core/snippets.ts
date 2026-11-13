// 同文件相关片段：按光标附近（以及模型草稿里）的标识符，从窗口之外找出最相关的几段代码放进头部。
// 纯文本、按稀有度加权；只在防抖通过之后运行，允许 O(全文)。
import type { ContextSource, SourceResult } from './collector';
import type { TextSource } from './types';

const TOKEN_RE = /[A-Za-z_$][\w$-]*/g;
const MIN_TOKEN = 4;
const MAX_SCAN_LINES = 60_000;
const MAX_SCAN_LINE_CHARS = 2000;
/** 取光标前后这么多行的标识符作为检索词 */
const QUERY_BEFORE = 10;
const QUERY_AFTER = 3;
/** 片段以命中最密集的行为中心，上下各取这么多行 */
const RADIUS = 3;
const MAX_SNIPPETS = 6;
const MAX_TOTAL_CHARS = 3000;
const MAX_LINE_CHARS = 160;
/** 命中密集、或由意图注释对上的片段可以扩展成整块，上限如下 */
const MAX_BLOCK_LINES = 50;
const MAX_BLOCK_CHARS = 2200;
/** 扩展时，相邻两处命中之间最多隔这么多行 */
const GROW_GAP = 8;
/** 中文词组的最小长度；注释之间有这么长的相同文字才算对上 */
const PHRASE = 4;
const CJK_RE = /[\u3400-\u9fff]+/g;

const STOP = new Set([
  'this', 'that', 'const', 'return', 'function', 'console', 'true', 'false', 'null', 'undefined', 'else', 'import',
  'export', 'default', 'from', 'async', 'await', 'typeof', 'length', 'string', 'number', 'boolean', 'class', 'template',
  'script', 'style', 'case', 'break', 'continue', 'while', 'switch', 'catch', 'finally', 'throw', 'void', 'with',
  // 框架的通用入口，哪儿都有，不代表任何具体意图
  'refs', 'emit', 'nexttick', 'forceupdate', 'store', 'router', 'route',
]);

/** 拆复合词时忽略的高频结构词缀，避免 get/list/item/value 等泛词冲淡真实业务词 */
const SUB_STOP = new Set([
  'handle', 'handler', 'change', 'click', 'select', 'selected', 'update', 'init', 'load', 'fetch', 'query', 'check',
  'show', 'hide', 'open', 'close', 'visible', 'list', 'item', 'items', 'data', 'info', 'value', 'values', 'name', 'names',
  'code', 'type', 'types', 'index', 'count', 'current', 'temp', 'flag', 'status', 'state', 'result', 'params', 'param',
  'config', 'option', 'options', 'form', 'page', 'view', 'text', 'label', 'title', 'detail', 'details', 'last', 'first',
  'next', 'prev', 'true', 'false', 'null',
]);

/** 大小写、连字符与下划线写法不同的同一个名字归一：skuListPop / skulist-pop → skulistpop */
function normalize(token: string): string {
  return token.replace(/[-_$]/g, '').toLowerCase();
}

/** 从驼峰、下划线、连字符复合标识符中拆出有业务区分度的子词（如 getBankNumLast4 → bank） */
export function subTokensOf(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(TOKEN_RE)) {
    const raw = match[0];
    const whole = normalize(raw);
    const parts = raw
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/[-_$\s0-9]+/);
    if (parts.length < 2) {
      continue;
    }
    for (const part of parts) {
      const sub = part.toLowerCase();
      if (sub.length >= MIN_TOKEN && sub !== whole && !STOP.has(sub) && !SUB_STOP.has(sub)) {
        out.add(sub);
      }
    }
  }
  return [...out];
}

/** 一段文字里所有连续 PHRASE 个中文字的片段 */
function phrasesOf(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(CJK_RE)) {
    for (let i = 0; i + PHRASE <= match[0].length; i++) {
      out.push(match[0].slice(i, i + PHRASE));
    }
  }
  return out;
}

/**
 * 英文标识符；给了 phrases（意图注释里的中文词组）时，另外返回这段文字里对上的词组。
 * 中文只按"至少连续 5 个字相同"匹配（同一段中文里对上两个以上的 4 字片段）。
 * 试过按相邻两个字切分：在真实的 9000 行文件上，"弹出""取值""如果"这类词把无关代码排到前面，
 * 挤掉了真正相关的模板片段，所以不做短词匹配。
 */
export function tokensOf(text: string, phrases?: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(TOKEN_RE)) {
    const token = normalize(match[0]);
    if (token.length >= MIN_TOKEN && !STOP.has(token)) {
      out.add(token);
    }
  }
  if (phrases && phrases.size > 0) {
    for (const match of text.matchAll(CJK_RE)) {
      const found = phrasesOf(match[0]).filter((phrase) => phrases.has(phrase));
      if (found.length >= 2) {
        for (const phrase of found) {
          out.add(phrase);
        }
      }
    }
  }
  return [...out];
}

const COMMENT_LINE = /^\s*(\/\/|\/\*|\*|#|<!--)/;

export interface Query {
  /** 检索词 → 权重系数 */
  factors: Map<string, number>;
  /** 来自模型草稿的词：允许反向前缀匹配 */
  fromHint: Set<string>;
  /** 意图注释里的中文词组（4 字片段），用来对上文件里别处的注释 */
  phrases: Set<string>;
}

/**
 * 从光标附近取检索词。权重：紧贴光标上方的注释块（说明接下来要做什么）最高，
 * 其次是紧挨光标的行，再远的行减半；草稿里的名字与紧挨的行同级。
 */
/**
 * 光标上方说明意图的注释：
 * - 光标行本身是注释，或从光标行向上跳过至多 3 个空行后紧接着的注释块；
 * - 或者光标刚进入一个新声明的函数/方法开头（上方 2 行内是函数声明），而该函数声明行正上方紧贴着文档注释/行注释。
 * 返回最靠近光标（或函数声明）的那一行（去掉首尾空白）及其行号；没有、或太短（< 12 个字符，如 "// }"）时返回 undefined。
 */
export function intentComment(source: TextSource, cursorLine: number): { text: string; line: number } | undefined {
  let line = cursorLine;
  if (!COMMENT_LINE.test(source.lineAt(line))) {
    line--;
    while (line >= 0 && cursorLine - line <= 3 && source.lineAt(line).trim() === '') {
      line--;
    }
    if (line < 0 || !COMMENT_LINE.test(source.lineAt(line))) {
      const fnHead = enclosingFunctionAt(source, cursorLine);
      if (fnHead && cursorLine - fnHead.line <= 2) {
        line = fnHead.line - 1;
        while (line >= 0 && fnHead.line - line <= 2 && source.lineAt(line).trim() === '') {
          line--;
        }
      }
    }
  }
  if (line < 0 || !COMMENT_LINE.test(source.lineAt(line))) {
    return undefined;
  }
  const text = source.lineAt(line).trim();
  return text.length >= 12 ? { text, line } : undefined;
}

const CALL_RE = /([A-Za-z_$][\w$]*)\s*\(/g;
const DEFINITION_RE = /^\s*(?:async\s+)?(?:function\s+)?([A-Za-z_$][\w$]*)\s*\([^()]*\)(?:\s*:[^=]+)?\s*\{\s*$/;
const ARROW_DEFINITION_RE = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)(?:\s*:[^=]+)?\s*=>/;
const USE_STATE_RE = /^\s*(?:const|let)\s*\[\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*\]\s*=\s*(?:React\.)?useState\b/;
const NOT_CALLS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'await', 'super', 'constructor']);
/** 看光标之后、之前这么多行里的调用 */
const CALLS_AFTER = 12;
const CALLS_BEFORE = 5;
const MAX_DEFINITIONS = 2;
const MAX_CALL_SITES = 1;
const MAX_STATE_WRITES = 3;
/** "名字 + 固定搭档"的用法示例最多这么多段 */
const MAX_PATTERNS = 2;
const MAX_DEFINITION_LINES = 16;
const MAX_DEFINITION_CHARS = 600;
const MAX_STATE_WRITE_LINES = 24;
const MAX_STATE_WRITE_CHARS = 750;

/** 光标紧跟在一个新函数的开头（上方 4 行内出现函数/方法声明行且缩进包住光标）时，返回该函数声明行号与名字 */
function enclosingFunctionAt(source: TextSource, cursorLine: number): { line: number; name: string } | undefined {
  const own = source.lineAt(cursorLine);
  const cursorIndent = own.trim() === '' ? own.length : (/^[ \t]*/.exec(own) as RegExpExecArray)[0].length;
  for (let l = cursorLine; l >= Math.max(0, cursorLine - 4); l--) {
    const text = source.lineAt(l);
    if (text.length > MAX_SCAN_LINE_CHARS) {
      continue;
    }
    const name = (DEFINITION_RE.exec(text) ?? ARROW_DEFINITION_RE.exec(text))?.[1];
    if (!name || NOT_CALLS.has(name)) {
      continue;
    }
    const declIndent = (/^[ \t]*/.exec(text) as RegExpExecArray)[0].length;
    if (l === cursorLine || cursorIndent > declIndent) {
      return { line: l, name };
    }
  }
  return undefined;
}

export function queryOf(source: TextSource, cursorLine: number, hint?: string): Query {
  const factors = new Map<string, number>();
  const n = Math.min(source.lineCount, MAX_SCAN_LINES);
  const raise = (text: string, factor: number, withSub = false) => {
    for (const token of tokensOf(text)) {
      factors.set(token, Math.max(factors.get(token) ?? 0, factor));
    }
    if (withSub) {
      for (const sub of subTokensOf(text)) {
        factors.set(sub, Math.max(factors.get(sub) ?? 0, factor * 0.55));
      }
    }
  };
  // 光标刚进入一个新函数开头时，不再越过函数声明行去抓上一个已闭合兄弟函数体内的局部变量，但保留声明上方的注释与顶级状态声明
  const fnHead = enclosingFunctionAt(source, cursorLine);
  const from = Math.max(0, cursorLine - QUERY_BEFORE);
  const to = Math.min(n - 1, cursorLine + QUERY_AFTER);
  let blockedSiblingBody = false;
  const fnIndent = fnHead ? (/^[ \t]*/.exec(source.lineAt(fnHead.line)) as RegExpExecArray)[0].length : -1;
  for (let line = cursorLine; line >= from; line--) {
    const text = source.lineAt(line);
    if (fnHead && line < fnHead.line) {
      const trimmed = text.trim();
      if (trimmed === '' || COMMENT_LINE.test(text)) {
        continue;
      }
      const ind = (/^[ \t]*/.exec(text) as RegExpExecArray)[0].length;
      if (ind === fnIndent && /^\}/.test(trimmed)) {
        blockedSiblingBody = true;
        continue;
      }
      if (blockedSiblingBody) {
        if (ind <= fnIndent && ((DEFINITION_RE.exec(text) ?? ARROW_DEFINITION_RE.exec(text)) !== null)) {
          blockedSiblingBody = false;
        }
        continue;
      }
    }
    const distance = Math.abs(line - cursorLine);
    raise(text, distance <= 1 ? 2 : distance <= 2 ? 1 : 0.5, distance <= 1 || line === fnHead?.line);
  }
  for (let line = cursorLine + 1; line <= to; line++) {
    const distance = line - cursorLine;
    raise(source.lineAt(line), distance <= 1 ? 2 : distance <= 2 ? 1 : 0.5, distance <= 1);
  }
  // 意图注释：优先从光标所在行向上跳过空行找紧邻注释；若光标行后方无注释但刚进入新函数声明，再看函数声明上方的注释
  let line = cursorLine;
  if (!COMMENT_LINE.test(source.lineAt(line))) {
    line--;
    while (line >= 0 && cursorLine - line <= 3 && source.lineAt(line).trim() === '') {
      line--;
    }
    if ((line < 0 || !COMMENT_LINE.test(source.lineAt(line))) && fnHead && cursorLine - fnHead.line <= 2) {
      line = fnHead.line - 1;
      while (line >= 0 && fnHead.line - line <= 3 && source.lineAt(line).trim() === '') {
        line--;
      }
    }
  }
  const phrases = new Set<string>();
  for (let count = 0; line >= 0 && count < 8 && COMMENT_LINE.test(source.lineAt(line)); line--, count++) {
    raise(source.lineAt(line), 3, true);
    // 每个 4 字片段权重减半：连续 5 个字相同（两个片段）约等于一个少见的标识符，相同的字越多越靠前
    for (const phrase of phrasesOf(source.lineAt(line))) {
      phrases.add(phrase);
      factors.set(phrase, 1.5);
    }
  }
  const fromHint = new Set(tokensOf(hint ?? ''));
  for (const token of fromHint) {
    factors.set(token, Math.max(factors.get(token) ?? 0, 2));
  }
  for (const sub of subTokensOf(hint ?? '')) {
    factors.set(sub, Math.max(factors.get(sub) ?? 0, 1.1));
  }
  return { factors, fromHint, phrases };
}

/**
 * 文件里的名字与检索词相同，或以检索词开头（skulistpop → skulistpopshow）。
 * 反方向（reason1 → reason）会把泛称全带进来，只对草稿里的名字放开：草稿可能是真名的变体（skulistpoplist → skulistpop）。
 */
export function tokenMatches(query: string, token: string, loose: boolean): boolean {
  return query === token ||
    (query.length >= 6 && token.startsWith(query)) ||
    (loose && token.length >= 8 && query.startsWith(token));
}

/**
 * 光标附近调用的方法在本文件里的定义：先看光标之后（结果怎么被用），再看之前，由近到远。
 * 返回定义所在的行范围（含上方紧挨的注释），到方法结束或行数上限为止。
 */
export function calledDefinitions(source: TextSource, cursorLine: number, n = source.lineCount): Array<{ start: number; end: number }> {
  const names: string[] = [];
  const scan = (line: number) => {
    if (line < 0 || line >= n || line === cursorLine) {
      return;
    }
    for (const match of source.lineAt(line).matchAll(CALL_RE)) {
      const name = match[1] as string;
      if (name.length >= 4 && !NOT_CALLS.has(name) && !names.includes(name)) {
        names.push(name);
      }
    }
  };
  for (let d = 1; d <= CALLS_AFTER; d++) {
    scan(cursorLine + d);
  }
  for (let d = 1; d <= CALLS_BEFORE; d++) {
    scan(cursorLine - d);
  }
  if (names.length === 0) {
    return [];
  }
  const wanted = new Set(names);
  const found = new Map<string, number>();
  for (let line = 0; line < n && found.size < wanted.size; line++) {
    const text = source.lineAt(line);
    if (text.length > MAX_SCAN_LINE_CHARS) {
      continue;
    }
    const name = (DEFINITION_RE.exec(text) ?? ARROW_DEFINITION_RE.exec(text))?.[1];
    if (name && wanted.has(name) && !found.has(name)) {
      found.set(name, line);
    }
  }
  const out: Array<{ start: number; end: number }> = [];
  for (const name of names) {
    const at = found.get(name);
    if (at === undefined) {
      continue;
    }
    const indent = (/^[ \t]*/.exec(source.lineAt(at)) as RegExpExecArray)[0].length;
    let end = at;
    for (let line = at + 1; line < n && line - at < MAX_DEFINITION_LINES; line++) {
      end = line;
      const text = source.lineAt(line);
      if (text.trim() !== '' && (/^[ \t]*/.exec(text) as RegExpExecArray)[0].length <= indent) {
        // 回到定义的缩进：闭合行算进来，别的（下一个方法）不算
        if (!text.trim().startsWith('}')) {
          end = line - 1;
        }
        break;
      }
    }
    let start = at;
    while (start > 0 && at - start < 2 && COMMENT_LINE.test(source.lineAt(start - 1))) {
      start--;
    }
    out.push({ start, end });
  }
  return out;
}

export interface SnippetInput {
  source: TextSource;
  cursorLine: number;
  /** 已经在提示词窗口里的行范围（含两端），不重复取 */
  excludeStart: number;
  excludeEnd: number;
  /** 模型草稿等额外线索，其中的标识符权重更高 */
  hint?: string;
  /** 已预计算好的检索词，避免重复计算 */
  query?: Query;
}

/** definition：被调用方法的定义；pattern：名字与固定搭档的用法；anchor：意图注释对上的注释及其下面的代码；scored：其余按得分选出的 */
export type SnippetKind = 'definition' | 'pattern' | 'anchor' | 'scored';

export interface SnippetItem {
  text: string;
  kind: SnippetKind;
}

export function relatedSnippets(input: SnippetInput): string[] {
  return relatedSnippetItems(input).map((item) => item.text);
}

export function relatedSnippetItems(input: SnippetInput): SnippetItem[] {
  const { source } = input;
  const n = Math.min(source.lineCount, MAX_SCAN_LINES);
  const baseQuery = input.query ?? queryOf(source, input.cursorLine, input.hint);
  // expandQuery 会向 factors 写入搭档检索词，拷贝一份以免污染共享的 ctx.query
  const factors = new Map(baseQuery.factors);
  const { fromHint, phrases } = baseQuery;
  const index = new Map<string, number[]>();
  /** 行尾注释对上了意图注释的那些行，其代码部分的标识符：意图说的就是它们 */
  const named = new Set<string>();
  const stateSetters = new Map<string, string>();
  const stateDecls = new Map<string, { getter: string; setter: string }>();
  for (let line = 0; line < n; line++) {
    const text = source.lineAt(line);
    if (text.length > MAX_SCAN_LINE_CHARS) {
      continue;
    }
    const stateMatch = USE_STATE_RE.exec(text);
    if (stateMatch) {
      const getter = stateMatch[1] as string;
      const setter = stateMatch[2] as string;
      stateSetters.set(normalize(getter), setter);
      stateDecls.set(normalize(getter), { getter, setter });
    }
    const tokens = tokensOf(text, phrases);
    for (const token of tokens) {
      const lines = index.get(token);
      if (lines) {
        lines.push(line);
      } else {
        index.set(token, [line]);
      }
    }
    for (const sub of subTokensOf(text)) {
      if (!tokens.includes(sub)) {
        const lines = index.get(sub);
        if (lines) {
          lines.push(line);
        } else {
          index.set(sub, [line]);
        }
      }
    }
    if (phrases.size > 0 && !COMMENT_LINE.test(text) && !excluded(line) && tokens.some((token) => phrases.has(token))) {
      // 只认行尾注释：相同的中文必须出现在注释部分，字符串里的不算；取代码部分最前面的两个名字
      const mark = /\s(?:\/\/|\/\*)|<!--/.exec(text);
      if (mark && tokensOf(text.slice(mark.index), phrases).some((token) => phrases.has(token))) {
        for (const token of tokensOf(text.slice(0, mark.index)).slice(0, 2)) {
          named.add(token);
        }
      }
    }
  }
  const maxLines = Math.max(20, Math.floor(n * 0.01));
  /** 意图里的名字 → 它在文件里的固定搭档 */
  const partnersOf = new Map<string, string[]>();
  expandQuery();

  // 太常见的词没有区分度
  const weights = new Map<string, number>();
  const hits = new Map<number, Set<string>>();
  const rare = new Set<string>();
  for (const [query, factor] of factors) {
    const lines = new Set<number>();
    for (const [token, tokenLines] of index) {
      if (tokenMatches(query, token, fromHint.has(query))) {
        for (const line of tokenLines) {
          lines.add(line);
        }
      }
    }
    if (lines.size === 0 || lines.size > maxLines) {
      continue;
    }
    if (lines.size <= 5) {
      rare.add(query);
    }
    // 越少见的名字区分度越高。用对数而不是倒数：倒数会让"远处一行里的少见词"压过"意图注释里的常见词"
    weights.set(query, factor * Math.log(1 + n / lines.size));
    for (const line of lines) {
      if (line >= input.excludeStart && line <= input.excludeEnd) {
        continue;
      }
      const set = hits.get(line);
      if (set) {
        set.add(query);
      } else {
        hits.set(line, new Set([query]));
      }
    }
  }
  // 光标附近调用的方法在本文件里的定义排在最前：它们说明了参数和返回值的形状
  const snippets: SnippetItem[] = [];
  let used = 0;
  for (const range of calledDefinitions(source, input.cursorLine, n)) {
    if (excluded(range.start) || excluded(range.end)) {
      continue;
    }
    const text = render(range.start, range.end, MAX_DEFINITION_CHARS);
    if (text === undefined || snippets.length >= MAX_DEFINITIONS) {
      continue;
    }
    snippets.push({ text, kind: 'definition' });
    used += text.length;
    for (let l = Math.max(0, range.start - RADIUS); l <= Math.min(n - 1, range.end + RADIUS); l++) {
      hits.delete(l);
    }
  }
  // 反向结构召回 1：光标正在实现某个函数开头时，取出它在窗口外的调用点（说明外部对入参与返回值的期望）
  const activeFn = enclosingFunctionAt(source, input.cursorLine);
  const callSiteStateNorms = new Set<string>();
  if (activeFn && activeFn.name.length >= 4) {
    const callRe = new RegExp(`(?<![\\w$.])${activeFn.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`);
    let callSites = 0;
    for (let line = 0; line < n && callSites < MAX_CALL_SITES; line++) {
      if (line === activeFn.line || excluded(line)) {
        continue;
      }
      const raw = source.lineAt(line);
      if (raw.length > MAX_SCAN_LINE_CHARS || COMMENT_LINE.test(raw) || !callRe.test(raw)) {
        continue;
      }
      const range = frame(line, line, 3);
      const text = render(range.start, range.end, MAX_DEFINITION_CHARS);
      if (text !== undefined && used + text.length <= MAX_TOTAL_CHARS) {
        snippets.push({ text, kind: 'definition' });
        used += text.length;
        callSites++;
        // 调用点所在表达式紧邻的状态变量（如 `payValue === 4 ? '小金库' : getBankNumLast4()` 里的 `payValue`）正是当前函数要消费的状态，纳入下方 setter 召回
        for (let cl = Math.max(range.start, line - 1); cl <= Math.min(range.end, line + 1); cl++) {
          for (const tok of tokensOf(source.lineAt(cl))) {
            if (stateSetters.has(tok)) {
              callSiteStateNorms.add(tok);
            }
          }
        }
        for (let l = Math.max(0, range.start - RADIUS); l <= Math.min(n - 1, range.end + RADIUS); l++) {
          hits.delete(l);
        }
      }
    }
  }
  // 反向结构召回 2：检索词（或调用点条件）命中了同文件 React useState 状态时，取出对应的 setter(...) 数据构造与多分支赋值块
  if (stateSetters.size > 0) {
    const candidateWrites: Array<{ stateNorm: string; start: number; end: number; score: number }> = [];
    for (const [stateNorm, setterName] of stateSetters) {
      if ((factors.get(stateNorm) ?? 0) < 0.5 && !callSiteStateNorms.has(stateNorm)) {
        continue;
      }
      // 容错：有些项目的 setter 命名为 setCardList（不以 cardlist 为前缀），按索引直接找 normalize(setterName) 即可
      const setterRe = new RegExp(`(?<![\\w$.])${setterName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`);
      for (const site of index.get(normalize(setterName)) ?? []) {
        if (excluded(site)) {
          continue;
        }
        const raw = source.lineAt(site);
        if (COMMENT_LINE.test(raw) || USE_STATE_RE.test(raw) || !setterRe.test(raw)) {
          continue;
        }
        const baseInd = indentOf(site);
        let end = site;
        // 过滤仅传入标量/简单变量（如 setVisible(false)、payValueSet(payValue)）的开关式调用，保留多行构造、三元条件分支或数组/对象写入
        const trimmedRaw = raw.trim();
        const isMultilineOpen = /[{([]\s*$/.test(trimmedRaw) || /=>\s*\{?\s*$/.test(trimmedRaw);
        const isInlineDataWrite =
          /\{.*:/.test(trimmedRaw) ||
          /\?.*:/.test(trimmedRaw) ||
          /\.(?:map|concat|filter|push|unshift)\s*\(/.test(trimmedRaw);
        if (!isMultilineOpen && !isInlineDataWrite) {
          continue;
        }
        if (isMultilineOpen) {
          for (let l = site + 1; l < n && l - site < MAX_STATE_WRITE_LINES; l++) {
            end = l;
            const t = source.lineAt(l);
            if (t.trim() !== '' && indentOf(l) <= baseInd) {
              if (!/^\s*[)\]}]/.test(t)) {
                end = l - 1;
              }
              break;
            }
          }
        }
        let start = site;
        while (start > 0 && site - start < 2 && COMMENT_LINE.test(source.lineAt(start - 1))) {
          start--;
        }
        let score = 0;
        for (let l = Math.max(0, start - 2); l <= end; l++) {
          for (const q of hits.get(l) ?? []) {
            score += weights.get(q) ?? 0;
          }
        }
        candidateWrites.push({ stateNorm, start, end, score });
      }
    }
    candidateWrites.sort((a, b) => b.score - a.score);
    // 先为每个相关状态各取最高分的 1 处写入块（避免某一个状态的 3 处写入把另一个相关状态挤掉），剩余名额再按总分补齐
    const picked: Array<{ start: number; end: number }> = [];
    const seenState = new Set<string>();
    for (const item of candidateWrites) {
      if (picked.length >= MAX_STATE_WRITES) {
        break;
      }
      if (!seenState.has(item.stateNorm)) {
        seenState.add(item.stateNorm);
        picked.push(item);
      }
    }
    for (const item of candidateWrites) {
      if (picked.length >= MAX_STATE_WRITES) {
        break;
      }
      if (!picked.includes(item)) {
        picked.push(item);
      }
    }
    for (const item of picked) {
      const text = render(item.start, item.end, MAX_STATE_WRITE_CHARS);
      if (text === undefined || used + text.length > MAX_TOTAL_CHARS) {
        continue;
      }
      snippets.push({ text, kind: 'definition' });
      used += text.length;
      for (let l = Math.max(0, item.start - RADIUS); l <= Math.min(n - 1, item.end + RADIUS); l++) {
        hits.delete(l);
      }
    }
  }
  // 名字和它的固定搭档一起出现的位置，是"这个名字通常怎么用"最直接的例子：单独留名额，离光标近的优先。
  // 不走下面的计分——计分时声明所在的那一段会先被选中并把这两个词降权，真正的用法反而排不上。
  let patterns = 0;
  for (const [anchor, partners] of partnersOf) {
    const partnerLines = new Set(partners.flatMap((partner) => index.get(partner) ?? []));
    const sites = (index.get(anchor) ?? [])
      .filter((site) => !excluded(site) && hits.has(site))
      .map((site) => ({ site, near: [-2, -1, 0, 1, 2].map((d) => site + d).filter((l) => partnerLines.has(l)) }))
      .filter((item) => item.near.length > 0)
      .sort((a, b) => Math.abs(a.site - input.cursorLine) - Math.abs(b.site - input.cursorLine));
    for (const { site, near } of sites) {
      if (patterns >= MAX_PATTERNS) {
        break;
      }
      if (!hits.has(site)) {
        continue;
      }
      // 用法示例多带几行后文：条件成立之后、以及 else 分支里做了什么
      const range = frame(Math.min(site, ...near), Math.max(site, ...near), 5);
      const text = render(range.start, range.end, MAX_DEFINITION_CHARS);
      if (text === undefined || used + text.length > MAX_TOTAL_CHARS) {
        continue;
      }
      snippets.push({ text, kind: 'pattern' });
      used += text.length;
      patterns++;
      for (let l = Math.max(0, range.start - RADIUS); l <= Math.min(n - 1, range.end + RADIUS); l++) {
        hits.delete(l);
      }
    }
  }
  if (hits.size === 0) {
    return snippets;
  }
  for (let round = 0; round < MAX_SNIPPETS * 3 && snippets.length < MAX_SNIPPETS; round++) {
    // 片段得分 = 覆盖到的不同检索词的权重之和；同一个词在多行出现最多加三成，不按行数累加
    let best = -1;
    let bestSum = 0;
    const tried = new Set<number>();
    for (const line of hits.keys()) {
      for (let center = Math.max(0, line - RADIUS); center <= Math.min(n - 1, line + RADIUS); center++) {
        if (tried.has(center)) {
          continue;
        }
        tried.add(center);
        const seen = new Map<string, number>();
        for (let l = Math.max(0, center - RADIUS); l <= Math.min(n - 1, center + RADIUS); l++) {
          for (const query of hits.get(l) ?? []) {
            seen.set(query, (seen.get(query) ?? 0) + 1);
          }
        }
        let sum = 0;
        for (const [query, count] of seen) {
          sum += (weights.get(query) ?? 0) * (1 + Math.min(0.3, 0.1 * (count - 1)));
        }
        // 得分相近时取离光标近的：同一功能的代码通常挨得近。最多加一成；按 250 行分档，同一段代码内不因此偏移
        sum *= 1 + 0.1 / (1 + Math.floor(Math.abs(center - input.cursorLine) / 250) / 2);
        if (sum > bestSum) {
          bestSum = sum;
          best = center;
        }
      }
    }
    if (best < 0) {
      break;
    }
    // 以命中的行为准重新取景：上面带 2 行，下面多带几行——条件、调用之后发生什么比之前更有用
    let lo = Infinity;
    let hi = -1;
    for (let l = Math.max(0, best - RADIUS); l <= Math.min(n - 1, best + RADIUS); l++) {
      if (hits.has(l)) {
        lo = Math.min(lo, l);
        hi = Math.max(hi, l);
      }
    }
    const { start, end } = frame(lo, hi);
    const matched = new Map<string, number>();
    for (let l = start; l <= end; l++) {
      for (const query of hits.get(l) ?? []) {
        matched.set(query, (matched.get(query) ?? 0) + 1);
      }
    }
    // 算相关的条件：两个不同的检索词同时出现，或命中全文件都少见的名字，或同一个名字在这几行里集中出现
    const relevant = matched.size >= 2 || [...matched].some(([query, count]) => rare.has(query) || count >= 2);
    // 扩展成整块（在清掉命中记录之前做，扩展要用到相邻的命中）
    const grown = relevant ? grow(start, end) : undefined;
    // 用过的行不再参与下一轮；多清一圈避免片段首尾相接。用过的词降权，让后面的片段覆盖别的线索
    for (let l = Math.max(0, (grown?.start ?? start) - RADIUS); l <= Math.min(n - 1, (grown?.end ?? end) + RADIUS); l++) {
      hits.delete(l);
    }
    for (const query of matched.keys()) {
      weights.set(query, (weights.get(query) ?? 0) * 0.6);
    }
    if (!relevant) {
      continue;
    }
    // 扩展后的整块放不下时退回原来的几行
    const candidates = grown && (grown.start < start || grown.end > end) ? [grown, { start, end }] : [{ start, end }];
    for (const range of candidates) {
      const text = render(range.start, range.end, range === grown ? MAX_BLOCK_CHARS : MAX_TOTAL_CHARS);
      if (text !== undefined && used + text.length <= MAX_TOTAL_CHARS) {
        used += text.length;
        snippets.push({ text, kind: range === grown && grown.anchored ? 'anchor' : 'scored' });
        break;
      }
    }
  }
  return snippets;

  /**
   * 扩充检索词，两步：
   * 1. 行尾注释对上意图注释的行，它声明的名字按"意图里直接写出的名字"对待；
   * 2. 意图里的名字（权重 3）在文件里总是和谁一起出现——在它出现的位置前后 2 行内，
   *    至少 3 处、且占对方全部出现位置一半以上的名字，也加入检索词。这样能取回"这个名字通常怎么用"的代码。
   */
  function expandQuery(): void {
    for (const token of named) {
      const lines = index.get(token);
      if (lines && lines.length <= maxLines) {
        factors.set(token, 3);
      }
    }
    const anchors = [...factors].filter(([token, factor]) => factor >= 3 && !phrases.has(token)).map(([token]) => token).slice(0, 6);
    const added = new Set<string>();
    for (const anchor of anchors) {
      const sites = index.get(anchor) ?? [];
      if (sites.length < 3 || sites.length > maxLines) {
        continue;
      }
      const together = new Map<string, number>();
      for (const site of sites) {
        const near = new Set<string>();
        for (let l = Math.max(0, site - 2); l <= Math.min(n - 1, site + 2); l++) {
          for (const token of tokensOf(source.lineAt(l))) {
            near.add(token);
          }
        }
        for (const token of near) {
          together.set(token, (together.get(token) ?? 0) + 1);
        }
      }
      // 每个名字各自最多带 2 个搭档，互不挤占
      const partners: Array<{ token: string; ratio: number }> = [];
      for (const [token, count] of together) {
        const total = index.get(token)?.length ?? 0;
        if (token !== anchor && token.length >= 6 && !factors.has(token) && count >= 3 && count / total >= 0.5) {
          partners.push({ token, ratio: count / total });
        }
      }
      const chosen = partners.sort((x, y) => y.ratio - x.ratio).slice(0, 2).map((item) => item.token);
      if (chosen.length > 0) {
        partnersOf.set(anchor, chosen);
      }
      for (const token of chosen) {
        added.add(token);
      }
    }
    for (const token of added) {
      factors.set(token, 1.5);
    }
  }

  /** 以命中的行 [lo, hi] 为准取景：上面带 2 行，下面多带几行，但不越过命中行所在的代码块 */
  function frame(lo: number, hi: number, after = 1): { start: number; end: number } {
    const start = Math.max(0, lo - 2);
    let end = Math.min(n - 1, Math.max(start + 2 * RADIUS, hi + after));
    // 遇到缩进更浅的行就停，闭合行算进来。既闭合又打开的行（") {"、"} else {"）是同一条语句的延续，接着往下取
    let floor = indentOf(hi);
    for (let l = hi + 1; l <= end; l++) {
      const text = source.lineAt(l);
      if (text.trim() === '' || indentOf(l) >= floor) {
        continue;
      }
      if (/^\s*[)\]}]/.test(text) && /[{([]\s*$/.test(text)) {
        floor = indentOf(l);
        continue;
      }
      end = /^\s*[)\]}]/.test(text) ? l : l - 1;
      break;
    }
    return { start, end };
  }

  function indentOf(line: number): number {
    return (/^[ \t]*/.exec(source.lineAt(line)) as RegExpExecArray)[0].length;
  }
  function excluded(line: number): boolean {
    return line >= input.excludeStart && line <= input.excludeEnd;
  }

  /**
   * 两种扩展，都不越过缩进更浅的行（代码块边界）和提示词窗口：
   * 1. 这几行里有对上意图注释的注释行：把它下面紧跟的那段代码取到空行为止——注释描述的就是那段代码；
   * 2. 向上下吸收相邻的命中行（间隔不超过 GROW_GAP），每次先取更近的一侧。
   */
  function grow(from: number, to: number): { start: number; end: number; anchored: boolean } {
    let start = from;
    let end = to;
    let base = Infinity;
    let anchor = -1;
    for (let l = from; l <= to; l++) {
      if (source.lineAt(l).trim() !== '') {
        base = Math.min(base, indentOf(l));
      }
      // 只有独占一行的注释才描述它下面的代码；行尾注释描述的是它所在的那一行
      if (anchor < 0 && COMMENT_LINE.test(source.lineAt(l)) && [...(hits.get(l) ?? [])].some((query) => phrases.has(query))) {
        anchor = l;
      }
    }
    const inScope = (l: number) => l >= 0 && l < n && !excluded(l) && (source.lineAt(l).trim() === '' || indentOf(l) >= base);
    if (anchor >= 0) {
      base = indentOf(anchor);
      start = anchor;
      end = anchor;
      for (let l = anchor + 1; inScope(l) && source.lineAt(l).trim() !== '' && l - start < MAX_BLOCK_LINES; l++) {
        end = l;
      }
    }
    const next = (edge: number, step: 1 | -1): number | undefined => {
      for (let l = edge + step, gap = 0; inScope(l) && gap < GROW_GAP; l += step, gap++) {
        if (hits.has(l)) {
          return l;
        }
      }
      return undefined;
    };
    for (;;) {
      const up = next(start, -1);
      const down = next(end, 1);
      const takeUp = up !== undefined && (down === undefined || start - up <= down - end);
      const target = takeUp ? up : down;
      if (target === undefined || Math.max(end, target) - Math.min(start, target) + 1 > MAX_BLOCK_LINES) {
        break;
      }
      if (takeUp) {
        start = target;
      } else {
        end = target;
      }
    }
    // 块上方紧挨着的注释行一并带上
    while (start > 0 && inScope(start - 1) && COMMENT_LINE.test(source.lineAt(start - 1)) && end - start + 1 < MAX_BLOCK_LINES) {
      start--;
    }
    return { start, end, anchored: anchor >= 0 };
  }

  /** 去掉首尾空行与公共缩进；超过 maxChars 时在行边界截断。范围落在提示词窗口里时返回 undefined。 */
  function render(from: number, to: number, maxChars: number): string | undefined {
    let start = from;
    let end = to;
    // 不跨进提示词窗口
    if (start <= input.excludeEnd && end >= input.excludeStart) {
      if (start < input.excludeStart) {
        end = input.excludeStart - 1;
      } else {
        start = input.excludeEnd + 1;
      }
    }
    while (start <= end && source.lineAt(start).trim() === '') {
      start++;
    }
    while (end >= start && source.lineAt(end).trim() === '') {
      end--;
    }
    if (start > end) {
      return undefined;
    }
    const lines: string[] = [];
    for (let l = start; l <= end; l++) {
      lines.push(source.lineAt(l).replace(/\s+$/, ''));
    }
    const indent = Math.min(...lines.filter((text) => text.trim() !== '').map((text) => (/^[ \t]*/.exec(text) as RegExpExecArray)[0].length));
    const out: string[] = [];
    let size = 0;
    for (const line of lines) {
      const text = line.slice(indent).slice(0, MAX_LINE_CHARS);
      if (size + text.length + 1 > maxChars && out.length > 0) {
        break;
      }
      out.push(text);
      size += text.length + 1;
    }
    return out.join('\n');
  }
}

/** 放到光标上方的参照最多这么多 */
const MAX_NEAR = 2;
const MAX_NEAR_LINES = 40;
const MAX_NEAR_CHARS = 1200;

/** near 为真时，用法示例与对上意图注释的整段代码改放到光标上方（仅脚本区域），其余仍在头部 */
export function createSnippetSource(enabled: () => boolean, near: () => boolean = () => false): ContextSource {
  return {
    name: 'snippets',
    async collect(ctx): Promise<SourceResult | undefined> {
      if (!enabled()) {
        return undefined;
      }
      let windowLines = 0;
      for (let i = ctx.windowText.indexOf('\n'); i >= 0; i = ctx.windowText.indexOf('\n', i + 1)) {
        windowLines++;
      }
      const items = relatedSnippetItems({
        source: ctx.source,
        cursorLine: ctx.line,
        excludeStart: ctx.windowStartLine,
        excludeEnd: ctx.windowStartLine + windowLines,
        ...(ctx.hint ? { hint: ctx.hint } : {}),
        ...(ctx.query ? { query: ctx.query } : {}),
      });
      if (items.length === 0) {
        return undefined;
      }
      // 参照块用行注释，只在脚本里这么做
      const script = ctx.languageId === 'vue' ? ctx.region === 'script' : /^(javascript|typescript)(react)?$/.test(ctx.languageId);
      const chosen = new Set<SnippetItem>();
      if (near() && script) {
        let lines = 0;
        let chars = 0;
        for (const item of items) {
          const count = item.text.split('\n').length;
          if ((item.kind === 'pattern' || item.kind === 'anchor') && chosen.size < MAX_NEAR &&
            lines + count <= MAX_NEAR_LINES && chars + item.text.length <= MAX_NEAR_CHARS) {
            chosen.add(item);
            lines += count;
            chars += item.text.length;
          }
        }
      }
      const rest = items.filter((item) => !chosen.has(item)).map((item) => item.text);
      return {
        ...(rest.length > 0 ? { snippets: rest } : {}),
        ...(chosen.size > 0 ? { nearSnippets: [...chosen].map((item) => item.text) } : {}),
        status: String(items.length),
      };
    },
  };
}
