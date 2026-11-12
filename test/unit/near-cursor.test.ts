import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HealthState } from '../../src/core/backoff';
import { CompletionCache } from '../../src/core/cache';
import { createCollector } from '../../src/core/collector';
import type { FimClient, FimRequest, FimResult } from '../../src/core/fim/client';
import { Metrics, type CallRecord } from '../../src/core/metrics';
import { insertReference } from '../../src/core/nearCursor';
import { CompletionPipeline, type LiveDoc } from '../../src/core/pipeline';
import { postprocessTraced } from '../../src/core/postprocess';
import { Scheduler } from '../../src/core/scheduler';
import { createSnippetSource, relatedSnippetItems } from '../../src/core/snippets';
import { DEFAULT_CONFIG, type Config } from '../../src/core/types';
import { MutableDoc, TestToken, src } from './helpers';

describe('insertReference 参照放到光标上方', () => {
  it('插在意图注释之前，缩进与注释一致；多段之间用省略号隔开', () => {
    const prefix = ['function f() {', '  if (ready) {', '    // 第一行意图', '    // 第二行意图', '    '].join('\n');
    expect(insertReference(prefix, ['if (a ||\n  b) {\n  run()', 'other()']).split('\n')).toEqual([
      'function f() {',
      '  if (ready) {',
      '    // reference: similar code elsewhere in this file',
      '    //   if (a ||',
      '    //     b) {',
      '    //     run()',
      '    //   ...',
      '    //   other()',
      '    // end of reference',
      '    // 第一行意图',
      '    // 第二行意图',
      '    ',
    ]);
  });

  it('意图注释和光标之间允许空行；没有注释时插在光标所在行之前', () => {
    const spaced = insertReference('  // 意图\n\n  ', ['x()']).split('\n');
    expect(spaced.slice(0, 4)).toEqual(['  // reference: similar code elsewhere in this file', '  //   x()', '  // end of reference', '  // 意图']);
    const bare = insertReference('  const a = 1\n  const b = ', ['x()']).split('\n');
    expect(bare).toEqual(['  const a = 1', '  // reference: similar code elsewhere in this file', '  //   x()', '  // end of reference', '  const b = ']);
  });

  it('没有参照时原样返回；参照里的空行不留行尾空格', () => {
    expect(insertReference('a\nb', [])).toBe('a\nb');
    expect(insertReference('  ', ['x()\n\ny()']).split('\n')[2]).toBe('  //');
  });
});

const filler = (count: number, tag: string) => Array.from({ length: count }, (_, i) => `    const ${tag}${i} = ${i}`);
const pair = ['      if (', '        this.isSpecial ||', '        this.query.kind === this.specialKindCode', '      ) {'];
const FILE = [
  'export default {',
  '  data() {',
  '    return {',
  '      isSpecial: false, // 是否是特殊补偿类型的订单',
  '    }',
  '  },',
  '  methods: {',
  '    submitA() {', ...pair, "        params.type = '8'", '      } else if (this.justPay) {', "        params.type = '4'", '      }', '    },',
  ...filler(120, 'gapA'),
  '    submitB() {', ...pair, '        this.specialSubmit()', '      }', '    },',
  ...filler(120, 'gapB'),
  '    submitC() {', ...pair, '        return', '      }', '    },',
  ...filler(300, 'gapC'),
  '    choose(items) {',
  '      // 判断是否是特殊补偿类型的 如果是则选中第 8 项',
  '      ',
  '    },',
  '  },',
  '}',
];
const CURSOR = FILE.lastIndexOf('      ');

describe('片段来源：哪些参照放到光标上方', () => {
  const collect = (near: boolean, languageId = 'javascript', region: 'script' | 'template' = 'script') =>
    createSnippetSource(() => true, () => near).collect({
      docKey: 'file:///a.js', languageId, fileLabel: 'a.js', source: src(FILE.join('\n')), version: 1, line: CURSOR, character: 6,
      windowStartLine: CURSOR - 150, windowText: 'a\nb\nc', cfg: DEFAULT_CONFIG, framework: 'generic', region, identifiers: [],
    }, Date.now() + 100);

  it('片段带种类：名字与固定搭档的用法标为 pattern', () => {
    const items = relatedSnippetItems({ source: src(FILE.join('\n')), cursorLine: CURSOR, excludeStart: CURSOR - 150, excludeEnd: CURSOR + 3 });
    expect(items.filter((item) => item.kind === 'pattern')).toHaveLength(2);
    expect(items[0]?.kind).toBe('pattern');
  });

  it('开关关闭：全部在头部；打开：用法示例移到光标上方，其余留在头部，不重复', async () => {
    const off = await collect(false);
    expect(off?.nearSnippets).toBeUndefined();
    const on = await collect(true);
    expect(on?.nearSnippets).toHaveLength(2);
    expect(on?.nearSnippets?.every((text) => text.includes('this.isSpecial ||'))).toBe(true);
    expect((on?.snippets ?? []).length).toBe((off?.snippets ?? []).length - 2);
    expect(on?.snippets?.some((text) => on.nearSnippets?.includes(text))).toBe(false);
  });

  it('只在脚本区域这么做：Vue 模板里不移动', async () => {
    expect((await collect(true, 'vue', 'template'))?.nearSnippets).toBeUndefined();
    expect((await collect(true, 'vue', 'script'))?.nearSnippets).toHaveLength(2);
  });
});

describe('管线：实验开关', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(over: Partial<Config>) {
    const cfg: Config = { ...DEFAULT_CONFIG, ...over };
    const requests: FimRequest[] = [];
    const fim: FimClient = {
      async complete(req: FimRequest): Promise<FimResult> {
        requests.push(req);
        return { text: 'if (this.isSpecial || this.query.kind === this.specialKindCode) {\n        items[8].checked = true\n      }', finishReason: 'stop', totalMs: 1 };
      },
    };
    const logs: CallRecord[] = [];
    const mutable = new MutableDoc(FILE.join('\n'));
    const doc: LiveDoc = {
      key: 'file:///a.js', languageId: 'javascript', fileLabel: 'a.js', source: mutable.source,
      version: () => mutable.version, cursorIsAt: () => true,
    };
    const pipeline = new CompletionPipeline({
      cfg: () => cfg, cache: new CompletionCache(), scheduler: new Scheduler({ timeoutMs: () => cfg.timeoutMs }), fim,
      collector: createCollector({ sources: [createSnippetSource(() => true, () => cfg.nearCursorReference)], vueMajor: async () => undefined }),
      depsIo: { stat: async () => undefined, isDirty: () => false }, health: new HealthState(), metrics: new Metrics(),
      log: (line) => {
        if (line.startsWith('{')) {
          logs.push(JSON.parse(line) as CallRecord);
        }
      },
    });
    const run = async () => {
      const pending = pipeline.run({ doc, position: { line: CURSOR, character: 6 }, trigger: 'manual', token: new TestToken() });
      await vi.advanceTimersByTimeAsync(3000);
      return pending;
    };
    return { requests, logs, run };
  }

  it('打开：参照出现在提示词末尾的意图注释之前，头部不再重复；日志记录段数', async () => {
    const h = setup({ nearCursorReference: true });
    await h.run();
    const prompt = h.requests[0]?.prompt ?? '';
    const tail = prompt.slice(prompt.lastIndexOf('// reference: similar code elsewhere in this file'));
    expect(tail).toMatch(/\/\/ +this\.isSpecial \|\|/);
    expect(tail).toContain('// end of reference\n      // 判断是否是特殊补偿类型的 如果是则选中第 8 项\n      ');
    expect(prompt.endsWith('      ')).toBe(true);
    // 移到光标上方的两段不在头部重复出现
    const head = prompt.slice(0, prompt.indexOf('[/context]'));
    expect(head).not.toContain('this.specialSubmit()');
    expect(tail).toContain('this.specialSubmit()');
    expect(h.logs[0]).toMatchObject({ outcome: 'shown', near: 2 });
  });

  it('关闭：提示词里没有参照块，日志没有 near 字段', async () => {
    const h = setup({});
    await h.run();
    expect(h.requests[0]?.prompt).not.toContain('// reference: similar code elsewhere in this file');
    expect(h.logs[0]?.near).toBeUndefined();
  });

  it('只改发给模型的内容：第二次在同一位置触发仍命中本地缓存', async () => {
    const h = setup({ nearCursorReference: true });
    await h.run();
    await h.run();
    expect(h.requests).toHaveLength(1);
    expect(h.logs[1]).toMatchObject({ cache: 'hit', outcome: 'shown' });
  });
});

describe('括号规则：后文的闭合符在另一行时按缩进区分', () => {
  const prefix = ['    } else {', '      if (this.isSpecial) {', '        const found = items.find((item) => item.id === 1)', '        if (found) {', '          this.current = found', '        }'].join('\n');
  const suffix = '\n    }\n  }\n';

  it('光标前有没闭合的代码块：结果先把它闭合（缩进更深）保留，再往后与后文缩进相同的闭合符才截掉', () => {
    expect(postprocessTraced({ text: '\n      }\n    }\n    next()', prefix, suffix, maxLines: 24 }))
      .toEqual({ text: '\n      }', rules: ['indent', 'bracket'] });
    expect(postprocessTraced({ text: '\n      }', prefix, suffix, maxLines: 24 })).toEqual({ text: '\n      }', rules: [] });
  });

  it('缩进与后文的闭合符相同：是重写了后文，照旧截掉', () => {
    expect(postprocessTraced({ text: '\n    }', prefix: `${prefix}\n      }`, suffix, maxLines: 24 }).text).toBe('');
    expect(postprocessTraced({ text: 'return 1;\n}', prefix: 'function f() {\n  ', suffix: '\n}', maxLines: 24 }).text).toBe('return 1;');
  });

  it('后文的闭合符就在光标这一行：照旧按字符判断', () => {
    expect(postprocessTraced({ text: 'a, b);\nfoo();', prefix: 'bar(', suffix: ')\nnext', maxLines: 24 }).text).toBe('a, b');
  });
});
