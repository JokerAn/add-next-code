import { describe, expect, it, vi } from 'vitest';
import { CompletionCache, dropEntriesAffectedByChange, type CacheEntry } from '../../src/core/cache';
import { depsValid } from '../../src/core/deps';
import { renderHeader } from '../../src/core/header';
import { buildWindow, cursorOf, readPrefix, type WindowLimits } from '../../src/core/window';
import type { Member } from '../../src/core/types';
import { MutableDoc } from './helpers';

const limits: WindowLimits = { prefixChars: 6000, suffixChars: 1500, maxPrefixLines: 300, maxSuffixLines: 100 };

describe('renderHeader', () => {
  const members: Member[] = [
    { kind: 'methods', name: 'onSearch' },
    { kind: 'props', name: 'visible' },
    { kind: 'props', name: 'id' },
    { kind: 'data', name: 'loading' },
  ];

  it('没有任何增强信息时返回空头部', () => {
    expect(renderHeader({ file: 'a.vue', framework: 'vue2', members: [], related: [], windowText: '', style: 'line', budgetChars: 2000 }).text).toBe('');
  });

  it('脚本区用 // 注释，成员按固定顺序与名称字典序', () => {
    const h = renderHeader({ file: 'src/A.vue', framework: 'vue2', members, related: [], windowText: '', style: 'line', budgetChars: 2000 });
    expect(h.text).toBe(
      [
        '// [context] reference only, not part of this file',
        '// file: src/A.vue (vue2)',
        '// members: props: id, visible; data: loading; methods: onSearch',
        '// [/context]',
        '',
      ].join('\n'),
    );
  });

  it('模板区用 HTML 注释', () => {
    const h = renderHeader({ file: 'a.vue', framework: 'vue2', members, related: [], windowText: '', style: 'html', budgetChars: 2000 });
    expect(h.text.startsWith('<!--\n')).toBe(true);
    expect(h.text.endsWith('-->\n')).toBe(true);
  });

  it('确定性：成员输入顺序不影响输出', () => {
    const a = renderHeader({ file: 'a', framework: 'vue2', members, related: [], windowText: '', style: 'line', budgetChars: 2000 });
    const b = renderHeader({ file: 'a', framework: 'vue2', members: [...members].reverse(), related: [], windowText: '', style: 'line', budgetChars: 2000 });
    expect(a.text).toBe(b.text);
  });

  it('预算紧张：先删关联项，deps 只含实际写入的', () => {
    const related = ['Alpha', 'Beta', 'Gamma'].map((name, i) => ({
      name,
      file: `src/${name}.vue`,
      interface: [{ kind: 'props', name: 'rows' }],
      dep: { uri: `file:///${name}`, mtimeMs: i, size: i },
    }));
    const full = renderHeader({ file: 'a', framework: 'vue2', members: [], related, windowText: '', style: 'line', budgetChars: 5000 });
    expect(full.deps.map((d) => d.uri)).toEqual(['file:///Alpha', 'file:///Beta', 'file:///Gamma']);
    const tight = renderHeader({ file: 'a', framework: 'vue2', members: [], related, windowText: '', style: 'line', budgetChars: 190 });
    expect(tight.text.length).toBeLessThanOrEqual(190);
    expect(tight.deps.length).toBeLessThan(3);
    expect(tight.text).toContain('Alpha');
    expect(tight.text).not.toContain('Gamma');
  });

  it('预算极小：整段丢弃', () => {
    const h = renderHeader({ file: 'a', framework: 'vue2', members, related: [], windowText: '', style: 'line', budgetChars: 10 });
    expect(h.text).toBe('');
  });

  it('裁剪成员：保留窗口文本里出现过的名称', () => {
    const many: Member[] = Array.from({ length: 60 }, (_, i) => ({ kind: 'methods', name: `method${i}` }));
    const h = renderHeader({ file: 'a', framework: 'vue2', members: many, related: [], windowText: 'this.method7()', style: 'line', budgetChars: 220 });
    expect(h.text).toContain('method7');
    expect(h.text).not.toContain('method8');
  });
});

describe('CompletionCache', () => {
  function entryFor(doc: MutableDoc, pos: { line: number; character: number }, completion: string, extra: Partial<CacheEntry> = {}) {
    const w = buildWindow(doc.source, pos, undefined, limits);
    return {
      docKey: 'doc',
      modelKey: 'm',
      windowStartLine: w.startLine,
      windowStartChar: w.startChar,
      anchorLine: w.anchorLine,
      prefix: w.prefix,
      suffix: w.suffix,
      completion,
      deps: [],
      ...extra,
    };
  }
  function lookup(cache: CompletionCache, doc: MutableDoc, pos: { line: number; character: number }, modelKey = 'm') {
    const w = buildWindow(doc.source, pos, undefined, limits);
    const cursor = cursorOf(pos);
    return cache.lookup({
      docKey: 'doc',
      modelKey,
      suffix: w.suffix,
      cursorLine: cursor.before.line,
      readPrefix: (sl, sc, maxChars) => readPrefix(doc.source, sl, sc, cursor, maxChars),
    });
  }

  it('相同上下文普通命中', () => {
    const doc = new MutableDoc('const x = \nnext');
    const cache = new CompletionCache();
    cache.put(entryFor(doc, { line: 0, character: 10 }, '42;'));
    expect(lookup(cache, doc, { line: 0, character: 10 })).toMatchObject({ text: '42;', remainder: false });
  });

  it('续显：用户敲入预测的前缀，返回剩余部分', () => {
    const doc = new MutableDoc('const x = \nnext');
    const cache = new CompletionCache();
    cache.put(entryFor(doc, { line: 0, character: 10 }, '42;'));
    doc.insertAt(0, 10, '4');
    expect(lookup(cache, doc, { line: 0, character: 11 })).toMatchObject({ text: '2;', remainder: true });
    doc.insertAt(0, 11, '2;');
    expect(lookup(cache, doc, { line: 0, character: 13 })).toBeUndefined(); // 已全部敲完
  });

  it('输入偏离预测：不命中', () => {
    const doc = new MutableDoc('const x = \nnext');
    const cache = new CompletionCache();
    cache.put(entryFor(doc, { line: 0, character: 10 }, '42;'));
    doc.insertAt(0, 10, '9');
    expect(lookup(cache, doc, { line: 0, character: 11 })).toBeUndefined();
  });

  it('评审样例：窗口内更早的声明被修改（附近文本不变）→ 不命中', () => {
    const doc = new MutableDoc(['const method = "GET"', ...Array.from({ length: 40 }, (_, i) => `// filler ${i}`), 'fetch(url, { method: '].join('\n'));
    const last = doc.lines.length - 1;
    const pos = { line: last, character: doc.lines[last]!.length };
    const cache = new CompletionCache();
    cache.put(entryFor(doc, pos, 'method })'));
    expect(lookup(cache, doc, pos)).toBeDefined();
    doc.setLine(0, 'const method = "POST"');
    expect(lookup(cache, doc, pos)).toBeUndefined();
  });

  it('后文被修改 → 不命中；整窗比较而不是只比开头', () => {
    const doc = new MutableDoc('const x = \nline2\nline3\nline4');
    const cache = new CompletionCache();
    cache.put(entryFor(doc, { line: 0, character: 10 }, '1;'));
    doc.setLine(3, 'line4 changed');
    expect(lookup(cache, doc, { line: 0, character: 10 })).toBeUndefined();
  });

  it('同一文件里重复的代码片段不会串用', () => {
    const block = ['function a() {', '  return ', '}'];
    const doc = new MutableDoc([...block, 'function b() {', '  return ', '}'].join('\n'));
    const cache = new CompletionCache();
    cache.put(entryFor(doc, { line: 1, character: 9 }, 'one;'));
    // 第二处相同的局部文本，但前文整窗不同
    expect(lookup(cache, doc, { line: 4, character: 9 })).toBeUndefined();
  });

  it('相同后文但光标远离预测范围时不重读旧窗口前文', () => {
    const doc = new MutableDoc(Array.from({ length: 100_000 }, () => '// filler').join('\n'));
    const cache = new CompletionCache();
    cache.put(entryFor(doc, { line: 0, character: 9 }, 'newCode()'));
    const pos = { line: 50_000, character: 9 };
    const current = buildWindow(doc.source, pos, undefined, limits);
    const read = vi.fn();
    expect(cache.lookup({
      docKey: 'doc', modelKey: 'm', suffix: current.suffix, cursorLine: pos.line, readPrefix: read,
    })).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it('同一行远距离移动时限制重读字符数，并拒绝已用完的预测', () => {
    const doc = new MutableDoc('x = ');
    const cache = new CompletionCache();
    cache.put(entryFor(doc, { line: 0, character: 4 }, 'next()'));
    doc.insertAt(0, 4, 'next()'.repeat(20_000));
    const pos = { line: 0, character: doc.lines[0]!.length };
    const cursor = cursorOf(pos);
    const read = vi.fn((sl: number, sc: number, maxChars?: number) => readPrefix(doc.source, sl, sc, cursor, maxChars));
    expect(cache.lookup({
      docKey: 'doc', modelKey: 'm', suffix: '', cursorLine: 0, readPrefix: read,
    })).toBeUndefined();
    expect(read).toHaveBeenCalledWith(0, 0, 10);
    expect(read.mock.results[0]?.value).toBe('x = next()');
  });

  it('长菜单选中项裁剪后的窗口仍可按相同口径命中缓存', () => {
    const doc = new MutableDoc('x');
    const pos = { line: 0, character: 1 };
    const sci = { start: { line: 0, character: 0 }, end: pos, text: 'a'.repeat(8000) + 'tail' };
    const w = buildWindow(doc.source, pos, sci, limits);
    const cache = new CompletionCache();
    cache.put({
      docKey: 'doc', modelKey: 'm', windowStartLine: w.startLine, windowStartChar: w.startChar,
      anchorLine: w.anchorLine, prefix: w.prefix, suffix: w.suffix, completion: 'more()', deps: [],
    });
    const cursor = cursorOf(pos, sci);
    expect(cache.lookup({
      docKey: 'doc', modelKey: 'm', suffix: w.suffix, cursorLine: cursor.before.line,
      readPrefix: (sl, sc, maxChars) => readPrefix(doc.source, sl, sc, cursor, maxChars),
    })).toMatchObject({ text: 'more()', remainder: false });
  });

  it('窗口上方增删行：起点行对不上 → 不命中', () => {
    const doc = new MutableDoc(['a', 'b', 'c', 'const x = ', 'tail'].join('\n'));
    const cache = new CompletionCache();
    cache.put(entryFor(doc, { line: 3, character: 10 }, '1;'));
    doc.lines.unshift('inserted');
    doc.version++;
    expect(lookup(cache, doc, { line: 4, character: 10 })).toBeUndefined();
  });

  it('modelKey 不同不命中；TTL 到期丢弃', () => {
    let now = 0;
    const doc = new MutableDoc('x = \ny');
    const cache = new CompletionCache({ now: () => now, ttlMs: 1000 });
    cache.put(entryFor(doc, { line: 0, character: 4 }, '1'));
    expect(lookup(cache, doc, { line: 0, character: 4 }, 'other')).toBeUndefined();
    now = 1001;
    expect(lookup(cache, doc, { line: 0, character: 4 })).toBeUndefined();
    expect(cache.length).toBe(0);
  });

  it('容量与单条大小上限', () => {
    const doc = new MutableDoc('x = ');
    const cache = new CompletionCache({ maxEntries: 3 });
    for (let i = 0; i < 5; i++) {
      cache.put({ ...entryFor(doc, { line: 0, character: 4 }, `v${i}`), prefix: `p${i}` });
    }
    expect(cache.length).toBe(3);
    expect(cache.put({ ...entryFor(doc, { line: 0, character: 4 }, 'y'.repeat(9000)) })).toBe(false);
    expect(cache.put({ ...entryFor(doc, { line: 0, character: 4 }, '') })).toBe(false);
  });

  it('窗口外改动触发条目删除；窗口内改动不处理', () => {
    const doc = new MutableDoc(Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n'));
    const cache = new CompletionCache();
    cache.put(entryFor(doc, { line: 100, character: 3 }, 'x\ny'));
    const e = cache.entriesOf('doc')[0]!;
    expect(dropEntriesAffectedByChange(cache, 'doc', [e.anchorLine])).toBe(0);
    expect(dropEntriesAffectedByChange(cache, 'doc', [e.anchorLine + 1])).toBe(0); // 预测文本占 2 行
    expect(dropEntriesAffectedByChange(cache, 'doc', [e.anchorLine + 2])).toBe(1);
    expect(cache.length).toBe(0);
  });

  it('dropDoc', () => {
    const doc = new MutableDoc('x = ');
    const cache = new CompletionCache();
    cache.put(entryFor(doc, { line: 0, character: 4 }, '1'));
    cache.dropDoc('doc');
    expect(cache.length).toBe(0);
    expect(cache.totalChars).toBe(0);
  });
});

describe('depsValid', () => {
  const dep = { uri: 'file:///child.vue', mtimeMs: 100, size: 10 };
  it('空 deps 不产生 IO', async () => {
    const stat = vi.fn();
    expect(await depsValid([], { stat, isDirty: () => false })).toBe(true);
    expect(stat).not.toHaveBeenCalled();
  });
  it('指纹一致且未保存状态为否 → 有效', async () => {
    expect(await depsValid([dep], { stat: async () => ({ mtimeMs: 100, size: 10 }), isDirty: () => false })).toBe(true);
  });
  it('未保存 / mtime 变 / size 变 / 文件不存在 / stat 抛错 → 无效', async () => {
    expect(await depsValid([dep], { stat: async () => ({ mtimeMs: 100, size: 10 }), isDirty: () => true })).toBe(false);
    expect(await depsValid([dep], { stat: async () => ({ mtimeMs: 101, size: 10 }), isDirty: () => false })).toBe(false);
    expect(await depsValid([dep], { stat: async () => ({ mtimeMs: 100, size: 11 }), isDirty: () => false })).toBe(false);
    expect(await depsValid([dep], { stat: async () => undefined, isDirty: () => false })).toBe(false);
    expect(await depsValid([dep], { stat: async () => { throw new Error('x'); }, isDirty: () => false })).toBe(false);
  });
});
