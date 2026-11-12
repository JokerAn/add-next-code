import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HealthState } from '../../src/core/backoff';
import { CompletionCache } from '../../src/core/cache';
import { createCollector } from '../../src/core/collector';
import type { FimClient, FimRequest, FimResult } from '../../src/core/fim/client';
import { renderHeader } from '../../src/core/header';
import { Metrics, type CallRecord } from '../../src/core/metrics';
import { CompletionPipeline, type LiveDoc } from '../../src/core/pipeline';
import { Scheduler } from '../../src/core/scheduler';
import { postprocessTraced } from '../../src/core/postprocess';
import { createSnippetSource, relatedSnippets, tokensOf } from '../../src/core/snippets';
import { DEFAULT_CONFIG, type Config } from '../../src/core/types';
import { cutAtMembers, inventedMembers } from '../../src/core/usage';
import { MutableDoc, TestToken, src } from './helpers';

/** 模板与已有写法都在文件前部，光标所在的方法在 500 行之后，中间是无关代码。 */
function bigFile(tail: string[]): string[] {
  return [
    '<template>',
    '  <div>',
    '    <!-- skuList弹框 -->',
    '    <skulist-pop',
    '      v-if="_is5666"',
    '      ref="skuListPopRef"',
    '      :skuData="resResult.skuListPop"',
    '      v-model="skulistPopShow"',
    '    />',
    '  </div>',
    '</template>',
    '<script>',
    'export default {',
    '  methods: {',
    '    skulistPopShowF() {',
    '      if (this._is5666) this.skulistPopShow = true',
    '    },',
    ...Array.from({ length: 500 }, (_, i) => `    unrelatedHelper${i}() { return ${i} },`),
    ...tail,
    '  },',
    '}',
    '</script>',
  ];
}

describe('relatedSnippets 同文件相关片段', () => {
  it('名字归一：大小写、连字符、下划线写法不同视为同一个', () => {
    expect(tokensOf('skuListPop skulist-pop _sku_list_pop')).toEqual(['skulistpop']);
    expect(tokensOf('a bb ccc this const')).toEqual([]);
  });

  it('按光标上方注释里的名字，取回窗口之外的模板绑定', () => {
    const lines = bigFile([
      '    onChange(res) {',
      '      // 如果是5666应该弹出skulist-pop弹框',
      '      ',
      '    },',
    ]);
    const cursorLine = lines.indexOf('      ');
    const snippets = relatedSnippets({ source: src(lines.join('\n')), cursorLine, excludeStart: cursorLine - 200, excludeEnd: cursorLine + 10 });
    expect(snippets[0]).toContain(':skuData="resResult.skuListPop"');
    expect(snippets[0]).toContain('v-model="skulistPopShow"');
    // 去掉公共缩进：至少有一行顶格
    expect(snippets[0]?.split('\n').some((line) => /^\S/.test(line))).toBe(true);
    expect(snippets[0]).toContain('<skulist-pop');
    expect(snippets.join('\n')).not.toMatch(/unrelatedHelper/);
  });

  it('提示词窗口里已有的行不重复取', () => {
    const lines = bigFile(['    onChange() {', '      // skulist-pop', '      ', '    },']);
    const cursorLine = lines.indexOf('      ');
    expect(relatedSnippets({ source: src(lines.join('\n')), cursorLine, excludeStart: 0, excludeEnd: lines.length })).toEqual([]);
  });

  it('光标附近没有线索时不取；草稿里的名字可以把相关片段带回来，变体写法也能对上真名', () => {
    const lines = bigFile(['    onChange(res) {', '      ', '    },']);
    const cursorLine = lines.indexOf('      ');
    const input = { source: src(lines.join('\n')), cursorLine, excludeStart: cursorLine - 200, excludeEnd: cursorLine + 10 };
    expect(relatedSnippets(input)).toEqual([]);
    const withDraft = relatedSnippets({ ...input, hint: 'this.skulistPopList = res.list' });
    expect(withDraft.join('\n')).toContain('resResult.skuListPop');
  });

  it('只有一个常见词对上、没有少见的名字时不算相关', () => {
    const lines = [
      ...Array.from({ length: 40 }, (_, i) => `const commonName${i} = commonValue + ${i};`),
      ...Array.from({ length: 300 }, (_, i) => `const filler${i} = ${i};`),
      'const result = commonValue;',
      '',
    ];
    const cursorLine = lines.length - 1;
    expect(relatedSnippets({ source: src(lines.join('\n')), cursorLine, excludeStart: cursorLine - 100, excludeEnd: cursorLine })).toEqual([]);
  });

  it('片段数量与总长度有上限', () => {
    const lines = [
      ...Array.from({ length: 400 }, (_, i) => (i % 40 === 0 ? `targetAlpha(${i}); targetBeta(${i}); // ${'x'.repeat(300)}` : `const filler${i} = ${i};`)),
      ...Array.from({ length: 300 }, (_, i) => `const other${i} = ${i};`),
      'targetAlpha(1); targetBeta(2);',
      '',
    ];
    const cursorLine = lines.length - 1;
    const snippets = relatedSnippets({ source: src(lines.join('\n')), cursorLine, excludeStart: cursorLine - 100, excludeEnd: cursorLine });
    expect(snippets.length).toBeGreaterThan(0);
    expect(snippets.length).toBeLessThanOrEqual(6);
    expect(snippets.join('').length).toBeLessThanOrEqual(1800);
    expect(Math.max(...snippets.flatMap((snippet) => snippet.split('\n').map((line) => line.length)))).toBeLessThanOrEqual(160);
  });
});

describe('头部里的相关片段', () => {
  const base = { file: 'a.vue', framework: 'vue2' as const, related: [], windowText: '' };

  it('片段排在成员之后、候选行之前；HTML 注释风格下转义结束符', () => {
    const header = renderHeader({
      ...base, members: [{ kind: 'data', name: 'form' }], snippets: ['<a>\n  <!-- x -->\n</a>'], focus: ['known members of this: form'],
      style: 'html', budgetChars: 4000,
    });
    const lines = header.text.split('\n');
    expect(lines.indexOf('related code elsewhere in this file:')).toBeGreaterThan(lines.findIndex((line) => line.startsWith('members:')));
    expect(lines.indexOf('known members of this: form')).toBeGreaterThan(lines.indexOf('...'));
    expect(header.text).toContain('<!-- x -- >');
    expect(header.text.trimEnd().endsWith('-->')).toBe(true);
  });

  it('超预算时先丢成员，再从末尾丢片段', () => {
    const members = Array.from({ length: 40 }, (_, i) => ({ kind: 'data', name: `memberNumber${i}` }));
    const header = renderHeader({
      ...base, members, snippets: ['first snippet line', 'second snippet line'.repeat(8)], style: 'line', budgetChars: 220,
    });
    expect(header.text).toContain('first snippet line');
    expect(header.text).not.toContain('second snippet line');
    expect(header.text).not.toContain('memberNumber');
  });
});

describe('inventedMembers / cutAtMembers', () => {
  const file = 'export default {\n  data() { return { skulistPopShow: false, resResult: {} } },\n  // ref="skuListPopRef"\n}';

  it('只认 this 成员与 $refs 名字，区分大小写；$ 开头的成员不校验', () => {
    expect(inventedMembers('this.skulistPopShow = true\nthis.skulistPopList = res.list', file)).toEqual(['skulistPopList']);
    expect(inventedMembers('this.$refs.skulistPopRef?.open()', file)).toEqual(['skulistPopRef']);
    expect(inventedMembers('this.$refs.skuListPopRef.open()', file)).toEqual([]);
    expect(inventedMembers('this.$emit("change"); this.$toast("x")', file)).toEqual([]);
    expect(inventedMembers('const that = this\nthat.missingOne = 1', file)).toEqual(['missingOne']);
  });

  it('别的对象上的属性、局部变量不校验', () => {
    expect(inventedMembers('const total = res.data.unknownField + row.price', file)).toEqual([]);
  });

  it('从第一处用到编造成员的那一行起截断；末尾的闭合行正好配平时接回来', () => {
    expect(cutAtMembers('if (a) {\n  this.skulistPopShow = true\n  this.skulistPopList = 1\n}', ['skulistPopList']))
      .toBe('if (a) {\n  this.skulistPopShow = true\n}');
    // 被删掉的部分之后还有别的语句：闭合行不在末尾连续出现，不接
    expect(cutAtMembers('if (a) {\n  this.ok = 1\n  this.bad = 1\n}\nnext()', ['bad'])).toBe('if (a) {\n  this.ok = 1');
    // 截完只剩空块：整条不展示
    expect(cutAtMembers('if (a) {\n  this.bad = 1\n}', ['bad'])).toBe('');
    expect(cutAtMembers('fn(() => {\n  if (a) {\n    this.bad = 1\n  }\n})', ['bad'])).toBe('');
    // 被删掉的语句自己跨多行：只接回配平所需的那一个闭合行
    expect(cutAtMembers('if (a) {\n  this.ok = 1\n  this.bad({\n    x: 1\n  })\n}', ['bad'])).toBe('if (a) {\n  this.ok = 1\n}');
    expect(cutAtMembers('this.skulistPopList = 1', ['skulistPopList'])).toBe('');
    expect(cutAtMembers('this.ok = 1', [])).toBeUndefined();
  });
});

describe('$refs 上的子组件方法', () => {
  const file = [
    '<template>',
    '  <skulist-pop',
    '    v-if="_is5666"',
    '    ref="skuListPopRef"',
    '    :skuData="resResult.skuListPop"',
    '  />',
    '  <main-pop ref="mainPopRef" />',
    '  <el-form ref="formRef" />',
    '  <input ref="inputRef" />',
    '</template>',
    '<script>',
    "import SkulistPop from './components/skulist-pop.vue'",
    "import MainPop from '@/components/main-pop.vue'",
    'export default {',
    '  methods: {',
    '    show() { this.$refs.mainPopRef?.popShowF(true) },',
    '  },',
    '}',
    '</script>',
  ].join('\n');

  it('本项目组件的 ref 上，没在文件里用过的方法视为没有依据', () => {
    expect(inventedMembers('this.$refs.skuListPopRef?.initF(res.list)', file)).toEqual(['skuListPopRef.initF']);
    expect(inventedMembers('this.$refs.skuListPopRef.setSkuList(res.list)', file)).toEqual(['skuListPopRef.setSkuList']);
    // 方法名在文件里出现过，但用在另一个 ref 上，同样不算依据
    expect(inventedMembers('this.$refs.skuListPopRef?.popShowF(true)', file)).toEqual(['skuListPopRef.popShowF']);
  });

  it('同一个 ref 上已经用过的方法、提示词头部给出的方法、$ 开头的成员不算', () => {
    expect(inventedMembers('this.$refs.mainPopRef?.popShowF(false)', file)).toEqual([]);
    // 文件里用方括号访问过也算
    expect(inventedMembers('this.$refs.skuListPopRef.reload()', `${file}\nthis.$refs?.['skuListPopRef']?.reload?.()`)).toEqual([]);
    expect(inventedMembers('this.$refs.skuListPopRef?.open()', file, '// <skulist-pop> a.vue: methods close, open')).toEqual([]);
    expect(inventedMembers('this.$refs.skuListPopRef.$forceUpdate()', file)).toEqual([]);
    expect(inventedMembers('const pop = this.$refs.skuListPopRef', file)).toEqual([]);
  });

  it('DOM 元素与全局注册的库组件不校验方法', () => {
    expect(inventedMembers('this.$refs.formRef.validate()', file)).toEqual([]);
    expect(inventedMembers('this.$refs.inputRef.focus()', file)).toEqual([]);
  });

  it('ref 名字本身不存在时只报 ref', () => {
    expect(inventedMembers('this.$refs.skulistPopRef?.initF()', file)).toEqual(['skulistPopRef']);
  });

  it('截断按 "ref.method" 这一对匹配，不误伤别的 ref 上的同名方法', () => {
    const text = 'if (a) {\n  this.$refs.mainPopRef?.popShowF(true)\n  this.$refs.skuListPopRef?.popShowF(true)\n}';
    expect(cutAtMembers(text, inventedMembers(text, file))).toBe('if (a) {\n  this.$refs.mainPopRef?.popShowF(true)\n}');
  });
});

describe('复读刚写完的代码块', () => {
  const block = '        // 如果是5666应该弹出弹框\n        if (this._is5666) {\n          this.skulistPopShow = true\n        }';
  const pp = (text: string, prefix: string) => postprocessTraced({ text, prefix, suffix: '\n      }', maxLines: 12 });

  it('光标停在块尾，结果把前面几行原样又写一遍：拒绝', () => {
    expect(pp(`\n${block}`, `      start()\n${block}`)).toEqual({ text: '', rules: ['replay'] });
    // 已经循环了几遍、结果被长度截断时同样拒绝
    expect(pp(`\n${block}\n${block.split('\n').slice(0, 3).join('\n')}`, `${block}\n${block}`).rules).toEqual(['replay']);
  });

  it('只和更早的代码相同、没有接着光标前的最后几行，不算复读', () => {
    expect(pp('} else {\n  return null\n}', 'if (x) {\n  doA()\n} else {\n  return null\n}\nif (y) {\n  doB()').rules).not.toContain('replay');
  });

  it('太短的重复（例如连续的闭合括号）不算', () => {
    expect(pp('\n  })\n})', 'a(() => {\n  b(() => {\n  })\n})').rules).not.toContain('replay');
  });
});

describe('管线中的成员校验与重发', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const GOOD = 'this.skulistPopShow = true\n      this.resResult.skuListPop = res.list';
  const BAD = 'this.skulistPopShow = true\n      this.skulistPopList = res.list';

  class Fim implements FimClient {
    requests: FimRequest[] = [];
    reply: (req: FimRequest) => string = () => BAD;
    async complete(req: FimRequest): Promise<FimResult> {
      this.requests.push(req);
      return {
        text: this.reply(req), finishReason: 'stop', totalMs: 500, firstByteMs: 100,
        usage: { prompt: 1000, cacheHit: 600, cacheMiss: 400, completion: 10 },
      };
    }
  }

  function setup(over: Partial<Config> = {}) {
    const cfg: Config = { ...DEFAULT_CONFIG, ...over };
    const fim = new Fim();
    const metrics = new Metrics();
    const logs: CallRecord[] = [];
    // 光标附近没有任何线索，第一次检索拿不到模板片段
    const lines = bigFile(['    onChange(res) {', '      ', '    },']);
    const mutable = new MutableDoc(lines.join('\n'));
    const doc: LiveDoc = {
      key: 'file:///a.vue', languageId: 'vue', fileLabel: 'a.vue', source: mutable.source,
      version: () => mutable.version, cursorIsAt: () => true,
    };
    const pipeline = new CompletionPipeline({
      cfg: () => cfg, cache: new CompletionCache(), scheduler: new Scheduler({ timeoutMs: () => cfg.timeoutMs }), fim,
      collector: createCollector({ sources: [createSnippetSource(() => cfg.fileSnippets)], vueMajor: async () => 2 }),
      depsIo: { stat: async () => undefined, isDirty: () => false }, health: new HealthState(), metrics,
      log: (line) => logs.push(JSON.parse(line) as CallRecord),
    });
    const run = async () => {
      const pending = pipeline.run({ doc, position: { line: lines.indexOf('      '), character: 6 }, trigger: 'manual', token: new TestToken() });
      await vi.advanceTimersByTimeAsync(5000);
      return pending;
    };
    return { fim, metrics, logs, run };
  }

  it('草稿含不存在的成员：以草稿重新检索，重发后采用更好的结果', async () => {
    const h = setup();
    h.fim.reply = (req) => (req.prompt.includes(':skuData="resResult.skuListPop"') ? GOOD : BAD);
    expect((await h.run())?.text).toBe(GOOD);
    expect(h.fim.requests).toHaveLength(2);
    expect(h.fim.requests[0]?.prompt).not.toContain('resResult.skuListPop');
    expect(h.fim.requests[1]?.prompt).toContain('related code elsewhere in this file:');
    expect(h.logs[0]).toMatchObject({
      outcome: 'shown', snippets: 'empty', draftInvented: 1, invented: 0, retry: 'better', tRetry: 500,
      usage: { prompt: 2000, cacheHit: 1200, cacheMiss: 800, completion: 20 },
    });
    expect(h.logs[0]?.pp).toBeUndefined();
    expect(h.metrics.summary()).toContain('成员校验：1 次草稿含本文件不存在的成员；重发结果 better=1；最终仍含 0 次');
  });

  it('strict：重发后仍然编造，从那一行起不展示', async () => {
    const h = setup();
    expect((await h.run())?.text).toBe('this.skulistPopShow = true');
    expect(h.fim.requests).toHaveLength(2);
    expect(h.logs[0]).toMatchObject({ outcome: 'shown', draftInvented: 1, invented: 1, retry: 'same', pp: ['invented'] });
  });

  it('strict：编造的成员在第一行时整条不展示', async () => {
    const h = setup();
    h.fim.reply = () => 'this.skulistPopList = res.list';
    expect(await h.run()).toBeUndefined();
    expect(h.logs[0]).toMatchObject({ outcome: 'empty', invented: 1, pp: ['invented'] });
  });

  it('retry：重发一次但不截断', async () => {
    const h = setup({ verifyMembers: 'retry' });
    expect((await h.run())?.text).toBe(BAD);
    expect(h.fim.requests).toHaveLength(2);
    expect(h.logs[0]).toMatchObject({ retry: 'same', invented: 1 });
    expect(h.logs[0]?.pp).toBeUndefined();
  });

  it('off：不校验也不重发', async () => {
    const h = setup({ verifyMembers: 'off' });
    expect((await h.run())?.text).toBe(BAD);
    expect(h.fim.requests).toHaveLength(1);
    expect(h.logs[0]?.draftInvented).toBeUndefined();
  });

  it('没有新线索时不重发；成员都存在时不触发', async () => {
    const noHint = setup({ fileSnippets: false });
    expect((await noHint.run())?.text).toBe('this.skulistPopShow = true');
    expect(noHint.fim.requests).toHaveLength(1);
    expect(noHint.logs[0]).toMatchObject({ retry: 'nohint', invented: 1 });

    const clean = setup();
    clean.fim.reply = () => 'this.skulistPopShowF()\n      this.$emit("change", res)';
    expect((await clean.run())?.text).toBe('this.skulistPopShowF()\n      this.$emit("change", res)');
    expect(clean.fim.requests).toHaveLength(1);
    expect(clean.logs[0]?.retry).toBeUndefined();
  });
});
