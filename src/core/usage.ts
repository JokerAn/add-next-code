// 文件内用法索引：按光标前的表达式，从整份文件的声明与用法里找出候选名字，定向放进头部。
// 纯文本扫描，不依赖语言服务与 Skimmer；只在防抖通过之后运行，允许 O(全文)。
import type { ContextSource, SourceResult } from './collector';
import { netDepth } from './linePolicy';
import type { TextSource } from './types';

const IDENT = '[A-Za-z_$][\\w$]*';
/** 指向组件实例的常见写法 */
const SELF = '(?:this|that|self|vm|_this)';
const SELF_NAMES = new Set(['this', 'that', 'self', 'vm', '_this']);
const KEYWORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'delete', 'else', 'export', 'extends', 'false',
  'finally', 'for', 'function', 'import', 'instanceof', 'let', 'new', 'null', 'return', 'super', 'switch', 'throw',
  'true', 'try', 'typeof', 'var', 'void', 'while', 'yield', 'await', 'async', 'undefined',
]);

const MAX_SCAN_CHARS = 2_000_000;
const MAX_LITERAL_CHARS = 20_000;
const MAX_NAMES = 30;
const MAX_FOCUS_CHARS = 600;
const MIN_BARE_PARTIAL = 3;

export interface FocusQuery {
  /** member：光标在 "a.b." 之后；ident：正在敲一个独立的名字 */
  kind: 'member' | 'ident';
  /** 去掉实例别名后的属性链；空数组表示直接访问实例成员（this.） */
  chain: string[];
  viaSelf: boolean;
  /** 已敲出的半个名字，可以为空 */
  partial: string;
}

export interface Candidate {
  name: string;
  count: number;
  /** 出现在对象字面量的声明里 */
  declared: boolean;
  call: boolean;
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const CHAIN_RE = new RegExp(`(${IDENT}(?:\\s*\\??\\.\\s*${IDENT})*)\\s*\\??\\.\\s*(${IDENT})?$`);
const BARE_RE = new RegExp(`(?:^|[^\\w$.])(${IDENT})$`);

/** 解析光标之前的本行文本；看不出明确的接收者时返回 undefined。 */
export function focusQueryAt(before: string): FocusQuery | undefined {
  const member = CHAIN_RE.exec(before);
  if (member) {
    // 接收者是调用结果、下标或更长链条的一部分时无法按文本判断
    const previous = before[member.index - 1] ?? '';
    if (/[\w$.)\]]/.test(previous)) {
      return undefined;
    }
    const segments = (member[1] as string).split(/\s*\??\.\s*/);
    const viaSelf = SELF_NAMES.has(segments[0] as string);
    return { kind: 'member', chain: viaSelf ? segments.slice(1) : segments, viaSelf, partial: member[2] ?? '' };
  }
  const bare = BARE_RE.exec(before);
  const partial = bare?.[1] ?? '';
  if (partial.length >= MIN_BARE_PARTIAL && !KEYWORDS.has(partial) && !SELF_NAMES.has(partial)) {
    return { kind: 'ident', chain: [], viaSelf: false, partial };
  }
  return undefined;
}

export function fullText(source: TextSource): string {
  const parts: string[] = [];
  let used = 0;
  for (let line = 0; line < source.lineCount && used < MAX_SCAN_CHARS; line++) {
    const text = source.lineAt(line);
    parts.push(text);
    used += text.length + 1;
  }
  return parts.join('\n');
}

interface LiteralKey {
  name: string;
  /** 值是对象字面量时，其左花括号的位置 */
  brace?: number;
}

const KEY_RE = new RegExp(`^(?:(?:async|get|set|static)\\s+)?(?:(['"])(${IDENT})\\1|(${IDENT}))(\\s*:\\s*\\{)?`);

/** 读取从 open（左花括号）开始的对象字面量的第一层键名；跳过字符串、注释、展开与计算键。 */
function keysAt(text: string, open: number): LiteralKey[] {
  const keys: LiteralKey[] = [];
  const end = Math.min(text.length, open + MAX_LITERAL_CHARS);
  let depth = 0;
  let expectKey = true;
  let quote = '';
  for (let i = open + 1; i < end; i++) {
    const ch = text[i] as string;
    if (quote) {
      if (ch === '\\') {
        i++;
      } else if (ch === quote || (ch === '\n' && quote !== '`')) {
        quote = '';
      }
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      if (nl < 0) {
        break;
      }
      i = nl;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      if (close < 0) {
        break;
      }
      i = close + 1;
      continue;
    }
    if (depth === 0 && expectKey) {
      if (/\s/.test(ch)) {
        continue;
      }
      expectKey = false;
      const key = KEY_RE.exec(text.slice(i, i + 200));
      const name = key?.[2] ?? key?.[3];
      if (key && name) {
        if (key[4]) {
          keys.push({ name, brace: i + key[0].length - 1 });
          // 停在花括号之前，让下面的深度计数处理它
          i += key[0].length - 2;
        } else {
          keys.push({ name });
          i += key[0].length - 1;
        }
        continue;
      }
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
    } else if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) {
        break;
      }
      depth--;
    } else if (ch === ',' && depth === 0) {
      expectKey = true;
    }
  }
  return keys;
}

/** 属性链对应的对象字面量里声明的键，例如 data 里的 form: { name, age }。 */
export function declaredKeys(text: string, chain: string[]): string[] {
  const root = chain[0];
  if (!root) {
    return [];
  }
  const definition = new RegExp(
    `(?<![\\w$.])(?:${SELF}\\s*\\.\\s*)?['"]?${escapeRe(root)}['"]?\\s*[:=]\\s*(?:[A-Za-z_$][\\w$.]*\\s*\\(\\s*)?\\{`, 'g',
  );
  const names: string[] = [];
  let found = 0;
  for (let match = definition.exec(text); match && found < 4; match = definition.exec(text)) {
    found++;
    let keys = keysAt(text, match.index + match[0].length - 1);
    for (const segment of chain.slice(1)) {
      const next = keys.find((key) => key.name === segment && key.brace !== undefined);
      keys = next ? keysAt(text, next.brace as number) : [];
    }
    for (const key of keys) {
      if (!names.includes(key.name)) {
        names.push(key.name);
      }
    }
  }
  return names;
}

/** 候选按"先声明、再按用到的次数"排序。 */
export function collectCandidates(text: string, query: FocusQuery): Candidate[] {
  const found = new Map<string, Candidate>();
  const add = (name: string, call: boolean, declared: boolean) => {
    const item = found.get(name) ?? { name, count: 0, declared: false, call: false };
    item.count += declared ? 0 : 1;
    item.declared ||= declared;
    item.call ||= call;
    found.set(name, item);
  };
  if (query.kind === 'member') {
    for (const name of declaredKeys(text, query.chain)) {
      add(name, false, true);
    }
    const head = query.chain.map(escapeRe).join('\\s*\\??\\.\\s*');
    const usage = new RegExp(
      query.chain.length === 0
        ? `(?<![\\w$.])${SELF}\\s*\\??\\.\\s*(${IDENT})(\\s*\\()?`
        : `(?<![\\w$.])(?:${SELF}\\s*\\??\\.\\s*)?${head}\\s*\\??\\.\\s*(${IDENT})(\\s*\\()?`,
      'g',
    );
    for (const match of text.matchAll(usage)) {
      add(match[1] as string, match[2] !== undefined, false);
    }
  } else {
    const usage = new RegExp(`(?<![\\w$])(${escapeRe(query.partial)}[\\w$]*)(\\s*\\()?`, 'gi');
    for (const match of text.matchAll(usage)) {
      add(match[1] as string, match[2] !== undefined, false);
    }
  }
  // 光标处正在敲的半个名字本身不是候选
  const typed = found.get(query.partial);
  if (typed && !typed.declared && typed.count <= 1) {
    found.delete(query.partial);
  }
  const list = [...found.values()];
  if (query.kind === 'member' && query.partial) {
    // 已敲出半个名字时只给匹配的候选：前缀匹配在前，包含匹配在后；都没有才退回全部。
    // 太短的片段到处都能"包含"，不足 3 个字符时只做前缀匹配。
    const lower = query.partial.toLowerCase();
    const starts = list.filter((item) => item.name.toLowerCase().startsWith(lower));
    const contains = lower.length < 3 ? []
      : list.filter((item) => !starts.includes(item) && item.name.toLowerCase().includes(lower));
    if (starts.length + contains.length > 0) {
      return [...rank(starts), ...rank(contains)];
    }
  }
  return rank(list);
}

function rank(list: Candidate[]): Candidate[] {
  // 声明的键保持声明顺序（Map 的插入顺序），其余按次数、再按名字
  const declared = list.filter((item) => item.declared);
  const used = list.filter((item) => !item.declared)
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return [...declared, ...used];
}

export function renderFocus(query: FocusQuery, candidates: Candidate[]): { text: string; count: number } | undefined {
  if (candidates.length === 0) {
    return undefined;
  }
  const target = `${query.viaSelf ? 'this' : ''}${query.viaSelf && query.chain.length > 0 ? '.' : ''}${query.chain.join('.')}`;
  const label = query.kind === 'ident'
    ? `names in this file starting with "${query.partial}"`
    : `known members of ${target}`;
  const names: string[] = [];
  let used = label.length + 2;
  for (const item of candidates.slice(0, MAX_NAMES)) {
    const text = item.call ? `${item.name}()` : item.name;
    if (used + text.length + 2 > MAX_FOCUS_CHARS) {
      break;
    }
    names.push(text);
    used += text.length + 2;
  }
  return names.length > 0 ? { text: `${label}: ${names.join(', ')}`, count: names.length } : undefined;
}

/** 补全里出现的属性名有多少个在文件里从未出现过，用于观察"编造成员"的比例；只返回计数。 */
export function countNewProps(completion: string, source: TextSource): { props: number; fresh: number } {
  const names = new Set<string>();
  for (const match of completion.matchAll(new RegExp(`\\.\\s*(${IDENT})`, 'g'))) {
    if ((match[1] as string).length >= 3) {
      names.add(match[1] as string);
    }
  }
  if (names.size === 0) {
    return { props: 0, fresh: 0 };
  }
  const text = fullText(source);
  let fresh = 0;
  for (const name of names) {
    if (!new RegExp(`(?<![\\w$])${escapeRe(name)}(?![\\w$])`).test(text)) {
      fresh++;
    }
  }
  return { props: names.size, fresh };
}

/** ref 名字对应的标签是否是从本项目路径 import 的组件；DOM 元素与全局注册的库组件返回 false。 */
function refIsLocalComponent(fileText: string, ref: string): boolean {
  const tag = new RegExp(`<([A-Za-z][\\w-]*)\\b[^<>]*?\\bref=["']${escapeRe(ref)}["']`).exec(fileText)?.[1];
  if (!tag) {
    return false;
  }
  const wanted = tag.replace(/[-_]/g, '').toLowerCase();
  for (const match of fileText.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/g)) {
    if ((match[1] as string).replace(/[-_]/g, '').toLowerCase() === wanted && /^(\.|@\/|~\/)/.test(match[2] as string)) {
      return true;
    }
  }
  return false;
}

/**
 * 补全里没有依据的实例成员：
 * - this.xxx 与 $refs.xxx：名字在文件里从未出现过。以 $ 开头的成员由框架或插件注入，不算。
 * - $refs.ref.method：ref 指向本项目的组件，而 "ref.method" 这一对既没在文件里用过、method 也不在 evidence
 *   （提示词头部，可能含 Skimmer 给出的子组件接口）里。模型看不到子组件文件，这种方法名只能是猜的。
 *   返回形如 "ref.method" 的条目。
 */
export function inventedMembers(completion: string, fileText: string, evidence = ''): string[] {
  const exists = (name: string, text: string) => new RegExp(`(?<![\\w$])${escapeRe(name)}(?![\\w$])`).test(text);
  const out = new Set<string>();
  for (const match of completion.matchAll(new RegExp(`(?<![\\w$.])${SELF}\\s*\\??\\.\\s*(${IDENT})`, 'g'))) {
    const name = match[1] as string;
    if (!name.startsWith('$') && !exists(name, fileText)) {
      out.add(name);
    }
  }
  for (const match of completion.matchAll(new RegExp(`\\$refs\\s*\\??\\.\\s*(${IDENT})(?:\\s*\\??\\.\\s*(${IDENT}))?`, 'g'))) {
    const ref = match[1] as string;
    const method = match[2];
    if (!exists(ref, fileText)) {
      out.add(ref);
    } else if (method && !method.startsWith('$') && !exists(method, evidence) &&
      // 同一个 ref 上用过这个方法，包括 $refs['ref']?.method 的写法
      !new RegExp(`(?<![\\w$])${escapeRe(ref)}(?:['"]\\s*\\])?\\s*\\??\\.\\s*${escapeRe(method)}(?![\\w$])`).test(fileText) &&
      refIsLocalComponent(fileText, ref)) {
      out.add(`${ref}.${method}`);
    }
  }
  return [...out];
}

/** 从第一处用到这些成员的那一行起截断；返回 undefined 表示没有哪一行用到。 */
export function cutAtMembers(completion: string, names: string[]): string | undefined {
  if (names.length === 0) {
    return undefined;
  }
  // "ref.method" 条目按成员访问匹配，中间允许 ?. 与空白
  const patterns = names.map((name) => name.split('.').map(escapeRe).join('\\s*\\??\\.\\s*'));
  const used = new RegExp(`(?<![\\w$])(?:${patterns.join('|')})(?![\\w$])`);
  const lines = completion.split('\n');
  const index = lines.findIndex((line) => used.test(line));
  if (index < 0) {
    return undefined;
  }
  const kept = lines.slice(0, index);
  // 原结果末尾只含闭合符的行，正好能把保留部分配平时接回来，避免展示半截代码块
  let need = netDepth(kept.join('\n'));
  const closers: string[] = [];
  for (let i = lines.length - 1; i > index && need > 0; i--) {
    const line = lines[i] as string;
    const count = /^[\s)\]}]+[;,]?\s*$/.test(line) ? (line.match(/[)\]}]/g) ?? []).length : 0;
    if (count === 0 || count > need) {
      break;
    }
    closers.unshift(line);
    need -= count;
  }
  if (need !== 0) {
    return kept.join('\n').trimEnd();
  }
  // 内容被删光的空块（开头行紧接闭合行）不保留
  while (kept.length > 0 && closers.length > 0 && /[{([]\s*$/.test(kept[kept.length - 1] as string)) {
    kept.pop();
    closers.shift();
  }
  return [...kept, ...closers].join('\n').trimEnd();
}

export interface ScopeDecl {
  kind: 'let' | 'var' | 'const';
  name: string;
  line: number;
  text: string;
}

const DECL_RE = new RegExp(`^\\s*(let|var|const)\\s+(${IDENT})\\b`);
const MAX_SCOPE_SCAN = 4000;

function leading(text: string): number {
  return (/^[ \t]*/.exec(text) as RegExpExecArray)[0].length;
}

/**
 * 光标处按缩进能看到的变量声明，由近到远，同名只留最近的一个。
 * 向上扫描时"可见缩进"只减不增：缩进更深的行属于别的嵌套块，不在作用域里。只认 `let/var/const 名字` 这种单个声明。
 */
export function scopeDeclarations(source: TextSource, cursorLine: number): ScopeDecl[] {
  const out: ScopeDecl[] = [];
  const seen = new Set<string>();
  const own = source.lineAt(cursorLine);
  let limit = own.length > 0 ? leading(own) : Infinity;
  for (let line = cursorLine - 1; line >= 0 && cursorLine - line <= MAX_SCOPE_SCAN && limit > 0; line--) {
    const text = source.lineAt(line);
    if (text.trim() === '') {
      continue;
    }
    const indent = leading(text);
    if (indent > limit) {
      continue;
    }
    limit = indent;
    const match = DECL_RE.exec(text);
    if (match && !seen.has(match[2] as string)) {
      seen.add(match[2] as string);
      out.push({ kind: match[1] as ScopeDecl['kind'], name: match[2] as string, line, text: text.trim() });
    }
  }
  return out;
}

/**
 * 结果在光标所在的层级又用 let/var/const 声明了一个外层已经用 let/var 声明过的变量：去掉声明关键字，改成赋值。
 * 同一层重复声明是语法错误；在内层重复声明会遮蔽外层变量，后面用到外层变量的代码拿不到这次的值。
 * 外层是 const 的不动。返回改动后的文本和涉及的名字。
 */
export function fixRedeclare(
  completion: string, source: TextSource, cursorLine: number, cursorCharacter: number,
): { text: string; names: string[] } {
  const own = source.lineAt(cursorLine);
  const atStatementStart = own.slice(0, cursorCharacter).trim() === '';
  const level = leading(own.length > 0 ? own : ' '.repeat(cursorCharacter));
  const declared = new Map(scopeDeclarations(source, cursorLine).map((decl) => [decl.name, decl]));
  const names: string[] = [];
  const pattern = new RegExp(`^(\\s*)(?:let|var|const)\\s+(${IDENT})(\\s*=(?!=))`);
  const lines = completion.split('\n').map((line, index) => {
    const match = pattern.exec(line);
    if (!match) {
      return line;
    }
    const sameLevel = index === 0 ? atStatementStart && (match[1] as string) === '' : (match[1] as string).length === level;
    const outer = declared.get(match[2] as string);
    if (!sameLevel || !outer || outer.kind === 'const') {
      return line;
    }
    names.push(match[2] as string);
    return `${match[1]}${match[2]}${match[3]}${line.slice(match[0].length)}`;
  });
  return { text: lines.join('\n'), names };
}

const MAX_SCOPE_ITEMS = 6;
const MAX_SCOPE_CHARS = 500;

/** 光标附近用到、但声明在提示词窗口之外的外层变量：把声明原文告诉模型，避免重复声明。 */
export function createScopeSource(enabled: () => boolean): ContextSource {
  return {
    name: 'scope',
    async collect(ctx): Promise<SourceResult | undefined> {
      if (!enabled()) {
        return undefined;
      }
      const near = new Set<string>();
      const from = Math.max(0, ctx.line - 8);
      const to = Math.min(ctx.source.lineCount - 1, ctx.line + 20);
      for (let line = from; line <= to; line++) {
        for (const match of ctx.source.lineAt(line).matchAll(new RegExp(IDENT, 'g'))) {
          near.add(match[0]);
        }
      }
      const items: string[] = [];
      let used = 0;
      for (const decl of scopeDeclarations(ctx.source, ctx.line)) {
        if (decl.line >= ctx.windowStartLine || !near.has(decl.name)) {
          continue;
        }
        const text = decl.text.slice(0, 100);
        if (items.length >= MAX_SCOPE_ITEMS || used + text.length > MAX_SCOPE_CHARS) {
          break;
        }
        items.push(text);
        used += text.length;
      }
      return items.length > 0
        ? { focus: `already declared earlier in this function, outside the visible code (assign, do not redeclare): ${items.join(' | ')}`, status: String(items.length) }
        : undefined;
    },
  };
}

export function createUsageSource(enabled: () => boolean): ContextSource {
  return {
    name: 'usage',
    async collect(ctx): Promise<SourceResult | undefined> {
      if (!enabled()) {
        return undefined;
      }
      const query = focusQueryAt(ctx.source.lineAt(ctx.line).slice(0, ctx.character));
      if (!query) {
        return undefined;
      }
      const focus = renderFocus(query, collectCandidates(fullText(ctx.source), query));
      return focus ? { focus: focus.text, status: `${query.kind}:${focus.count}` } : undefined;
    },
  };
}
