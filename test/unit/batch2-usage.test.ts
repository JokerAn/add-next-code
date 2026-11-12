import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HealthState } from '../../src/core/backoff';
import { CompletionCache } from '../../src/core/cache';
import { createCollector } from '../../src/core/collector';
import type { FimClient, FimRequest, FimResult } from '../../src/core/fim/client';
import { renderHeader } from '../../src/core/header';
import { Metrics, type CallRecord } from '../../src/core/metrics';
import { CompletionPipeline, type LiveDoc } from '../../src/core/pipeline';
import { postprocessTraced } from '../../src/core/postprocess';
import { Scheduler } from '../../src/core/scheduler';
import { DEFAULT_CONFIG, type Config } from '../../src/core/types';
import {
  collectCandidates, countNewProps, createUsageSource, declaredKeys, focusQueryAt, renderFocus,
} from '../../src/core/usage';
import { MutableDoc, TestToken, src } from './helpers';

const VUE = `<template>
  <div>
    <el-input v-model="form.name" />
    <span>{{ form.address.city }}</span>
    <li v-for="row in tableData">{{ row.skuName }} {{ row.price }}</li>
  </div>
</template>
<script>
export default {
  data() {
    return {
      loading: false,
      form: {
        name: '',
        age: 0,
        address: { city: '', street: '' },
        'quoted-free': 1,
        tags: ['a', 'b'],
        async load() {},
      },
      tableData: [],
    };
  },
  computed: {
    currentServiceType() {
      return this.form.serviceType;
    },
  },
  methods: {
    fetchList() {
      this.loading = true;
      this.form.name = 'x';
      this.form.validate();
      return this.$api.getList(this.form).then((res) => {
        this.tableData = res.data.list;
      });
    },
    reset() {
      this.fetchList();
      this.fetchList();
      const that = this;
      that.loading = false;
    },
  },
};
</script>`;

const names = (before: string, text = VUE) => {
  const query = focusQueryAt(before);
  return query ? collectCandidates(text, query).map((item) => item.name) : undefined;
};

describe('focusQueryAt 解析光标前的表达式', () => {
  it('成员访问：属性链与已敲出的半个名字', () => {
    expect(focusQueryAt('      this.form.')).toEqual({ kind: 'member', chain: ['form'], viaSelf: true, partial: '' });
    expect(focusQueryAt('  return this.form.address.ci')).toEqual({ kind: 'member', chain: ['form', 'address'], viaSelf: true, partial: 'ci' });
    expect(focusQueryAt('if (this.')).toEqual({ kind: 'member', chain: [], viaSelf: true, partial: '' });
    expect(focusQueryAt('{{ row.sku')).toEqual({ kind: 'member', chain: ['row'], viaSelf: false, partial: 'sku' });
    expect(focusQueryAt('a = form?.name?.')).toEqual({ kind: 'member', chain: ['form', 'name'], viaSelf: false, partial: '' });
  });

  it('接收者是调用结果、下标或展开时不猜', () => {
    expect(focusQueryAt('getForm().name.')).toBeUndefined();
    expect(focusQueryAt('list[0].')).toBeUndefined();
    expect(focusQueryAt('fn(...args.')).toBeUndefined();
  });

  it('独立名字至少敲出 3 个字符，关键字不算', () => {
    expect(focusQueryAt('  fetchL')).toEqual({ kind: 'ident', chain: [], viaSelf: false, partial: 'fetchL' });
    expect(focusQueryAt('  fe')).toBeUndefined();
    expect(focusQueryAt('  return')).toBeUndefined();
    expect(focusQueryAt('')).toBeUndefined();
  });
});

describe('declaredKeys 对象字面量里声明的子字段', () => {
  it('读取第一层键：带引号的键、方法简写、嵌套对象与数组不展开', () => {
    expect(declaredKeys(VUE, ['form'])).toEqual(['name', 'age', 'address', 'tags', 'load']);
  });

  it('按属性链逐层进入嵌套对象', () => {
    expect(declaredKeys(VUE, ['form', 'address'])).toEqual(['city', 'street']);
    expect(declaredKeys(VUE, ['form', 'tags'])).toEqual([]);
    expect(declaredKeys(VUE, ['missing'])).toEqual([]);
  });

  it('赋值、包装函数与注释里的花括号', () => {
    const text = 'const state = reactive({\n  // } 注释\n  open: false, /* { */ title: "}", ...rest,\n  [key]: 1,\n  count: 0,\n});\nthis.query = { page: 1, size: 20 };';
    expect(declaredKeys(text, ['state'])).toEqual(['open', 'title', 'count']);
    expect(declaredKeys(text, ['query'])).toEqual(['page', 'size']);
  });
});

describe('collectCandidates 候选名字', () => {
  it('this.：文件里经实例访问过的成员，按次数排序，方法带调用标记', () => {
    const query = focusQueryAt('    this.')!;
    const list = collectCandidates(VUE, query);
    expect(list.slice(0, 2).map((item) => item.name)).toEqual(['form', 'fetchList']);
    expect(list.find((item) => item.name === 'fetchList')?.call).toBe(true);
    // 别名 that 也算实例访问
    expect(list.find((item) => item.name === 'loading')?.count).toBe(2);
    expect(list.map((item) => item.name)).toContain('$api');
  });

  it('this.form.：先给声明的子字段，再给只在用法里出现的', () => {
    expect(names('      this.form.')).toEqual(['name', 'age', 'address', 'tags', 'load', 'serviceType', 'validate']);
  });

  it('模板里不带 this 的写法与脚本里的用法合并', () => {
    expect(names('{{ row.')).toEqual(['price', 'skuName']);
    expect(names('{{ form.address.')).toEqual(['city', 'street']);
  });

  it('已敲出半个名字时只给匹配项，前缀匹配在前', () => {
    // 不足 3 个字符只做前缀匹配
    expect(names('this.form.a')).toEqual(['age', 'address']);
    expect(names('this.form.ser')).toEqual(['serviceType']);
    // 3 个字符起才加上"名字中间包含"的匹配，排在前缀匹配之后
    expect(names('this.form.add')).toEqual(['address']);
    expect(names('this.form.type')).toEqual(['serviceType']);
    expect(names('this.form.dat', 'this.form.dateRange = 1;\nthis.form.validate();\nthis.form.updateTime = 2;')).toEqual(['dateRange', 'updateTime', 'validate']);
    // 一个都不匹配时退回全部
    expect(names('this.form.zzz')).toHaveLength(7);
  });

  it('光标处正在敲的半个名字本身不算候选', () => {
    expect(names('this.form.ser', `${VUE}\nthis.form.ser`)).toEqual(['serviceType']);
  });

  it('独立名字：全文件里以它开头的标识符，不区分大小写', () => {
    expect(names('  fetchL')).toEqual(['fetchList']);
    expect(names('  current')).toEqual(['currentServiceType']);
    expect(names('  tabled')).toEqual(['tableData']);
  });

  it('别的对象上的同名属性不计入', () => {
    expect(names('this.form.', 'a.form.x = 1;\nxform.y = 2;\nthis.form.z = 3;')).toEqual(['z']);
  });
});

describe('renderFocus', () => {
  it('成员与独立名字的文案，方法带括号', () => {
    const member = focusQueryAt('this.form.')!;
    expect(renderFocus(member, collectCandidates(VUE, member))?.text)
      .toBe('known members of this.form: name, age, address, tags, load, serviceType, validate()');
    const root = focusQueryAt('this.fetch')!;
    expect(renderFocus(root, collectCandidates(VUE, root))?.text).toBe('known members of this: fetchList()');
    const ident = focusQueryAt('  tabled')!;
    expect(renderFocus(ident, collectCandidates(VUE, ident))).toEqual({ text: 'names in this file starting with "tabled": tableData', count: 1 });
  });

  it('没有候选时不输出；数量与长度有上限', () => {
    const query = focusQueryAt('this.nothing.')!;
    expect(renderFocus(query, collectCandidates(VUE, query))).toBeUndefined();
    const many = Array.from({ length: 200 }, (_, i) => `this.veryLongMemberNameNumber${i} = 1;`).join('\n');
    const root = focusQueryAt('this.')!;
    const focus = renderFocus(root, collectCandidates(many, root))!;
    expect(focus.count).toBeLessThanOrEqual(30);
    expect(focus.text.length).toBeLessThanOrEqual(600);
  });
});

describe('countNewProps', () => {
  it('只统计补全里出现、但文件里从未出现过的属性名', () => {
    expect(countNewProps('this.form.name = this.form.nickName;', src(VUE))).toEqual({ props: 3, fresh: 1 });
    expect(countNewProps('const a = 1;', src(VUE))).toEqual({ props: 0, fresh: 0 });
  });
});

describe('头部与收集器里的候选行', () => {
  it('候选行排在头部最后；只有候选行时也生成头部', () => {
    const header = renderHeader({
      file: 'a.vue', framework: 'vue2', members: [{ kind: 'data', name: 'form' }], related: [], windowText: '',
      focus: ['known members of this.form: name, age'], style: 'line', budgetChars: 2000,
    });
    const lines = header.text.trimEnd().split('\n');
    expect(lines.at(-2)).toBe('// known members of this.form: name, age');
    const only = renderHeader({ file: 'a.js', framework: 'generic', members: [], related: [], windowText: '', focus: ['x: a'], style: 'line', budgetChars: 2000 });
    expect(only.text).toContain('// x: a');
  });

  it('超预算时先丢窗口里没出现的成员，候选行保留', () => {
    const members = Array.from({ length: 60 }, (_, i) => ({ kind: 'data', name: `memberNumber${i}` }));
    const header = renderHeader({
      file: 'a.vue', framework: 'vue2', members, related: [], windowText: 'memberNumber3', focus: ['known members of this.form: name'],
      style: 'line', budgetChars: 300,
    });
    expect(header.text).toContain('known members of this.form: name');
    expect(header.text).toContain('memberNumber3');
    expect(header.text).not.toContain('memberNumber40');
  });

  it('用法来源经收集器进入头部，状态记录种类与数量；关闭后不参与', async () => {
    const run = (enabled: boolean) => createCollector({ sources: [createUsageSource(() => enabled)], vueMajor: async () => 2 })({
      docKey: 'file:///a.vue', languageId: 'vue', fileLabel: 'a.vue', source: src(`${VUE}\n      this.form.`), version: 1,
      line: VUE.split('\n').length, character: 16, windowStartLine: 20, windowText: '', cfg: DEFAULT_CONFIG,
    }, Date.now() + 1000);
    const on = await run(true);
    expect(on.status.usage).toBe('member:7');
    expect(on.header.text).toContain('known members of this.form: name, age, address');
    const off = await run(false);
    expect(off.status.usage).toBe('empty');
    expect(off.header.text).toBe('');
  });
});

describe('日志字段', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  class Fim implements FimClient {
    reply = 'value;';
    latencyMs = 0;
    async complete(req: FimRequest): Promise<FimResult> {
      if (this.latencyMs > 0) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, this.latencyMs);
          req.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        });
      }
      return { text: this.reply, finishReason: 'stop', totalMs: 900, firstByteMs: 100, firstTokenMs: 700, finishMs: 880 };
    }
  }

  function setup(text: string) {
    const cfg: Config = { ...DEFAULT_CONFIG };
    const fim = new Fim();
    const metrics = new Metrics();
    const logs: CallRecord[] = [];
    const mutable = new MutableDoc(text);
    const doc: LiveDoc = {
      key: 'file:///a.js', languageId: 'javascript', fileLabel: 'a.js', source: mutable.source,
      version: () => mutable.version, cursorIsAt: () => true,
    };
    const pipeline = new CompletionPipeline({
      cfg: () => cfg, cache: new CompletionCache(), scheduler: new Scheduler({ timeoutMs: () => cfg.timeoutMs }), fim,
      collector: createCollector({ sources: [createUsageSource(() => true)], vueMajor: async () => undefined }),
      depsIo: { stat: async () => undefined, isDirty: () => false }, health: new HealthState(), metrics,
      log: (line) => logs.push(JSON.parse(line) as CallRecord),
    });
    return { fim, metrics, logs, mutable, doc, pipeline };
  }

  it('展示的调用记录位置、模式、候选、耗时分段、输出规模与新属性名', async () => {
    const h = setup('const form = { name: 1 };\nconst a = form.');
    h.fim.reply = 'name + form.other;\nnext();';
    const pending = h.pipeline.run({ doc: h.doc, position: { line: 1, character: 15 }, trigger: 'auto', token: new TestToken() });
    await vi.advanceTimersByTimeAsync(5000);
    expect((await pending)?.text).toBe('name + form.other;\nnext();');
    expect(h.logs[0]).toMatchObject({
      outcome: 'shown', line: 1, col: 15, winStart: 0, stage: 'post', mode: 'free', focus: 'member:1',
      tFirstByte: 100, tFirstToken: 700, tFinish: 880, tTotal: 900,
      rawChars: 26, rawLines: 2, outChars: 26, outLines: 2, props: 1, newProps: 1,
    });
    expect(h.logs[0]?.pp).toBeUndefined();
    const summary = h.metrics.summary();
    expect(summary).toContain('首段文本 p50/p95：700ms / 700ms；结束标记后等待流关闭 p50/p95：20ms / 20ms');
    expect(summary).toContain('文件内用法索引：1 / 1 次请求带候选名字');
    expect(summary).toContain('展示内容里的属性名 1 个，其中本文件从未出现过的 1 个');
  });

  it('被后处理拒绝时记录命中的规则', async () => {
    const h = setup('function f() {\n  \n  return total;\n}');
    h.fim.reply = 'return total;';
    const pending = h.pipeline.run({ doc: h.doc, position: { line: 1, character: 2 }, trigger: 'auto', token: new TestToken() });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toBeUndefined();
    expect(h.logs[0]).toMatchObject({ outcome: 'empty', mode: 'block', pp: ['suffixLine'], rawChars: 13 });
    expect(h.metrics.summary()).toContain('后处理规则命中：suffixLine=1；模型有输出但被拒绝 1 次');
  });

  it('请求在途时文档变化：记录阶段与原因，耗时不计入总耗时统计', async () => {
    const h = setup('const a = \nrest');
    h.fim.latencyMs = 3000;
    const token = new TestToken();
    const pending = h.pipeline.run({ doc: h.doc, position: { line: 0, character: 10 }, trigger: 'auto', token });
    await vi.advanceTimersByTimeAsync(1500);
    h.mutable.insertAt(0, 10, 'x');
    token.cancel();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toBeUndefined();
    expect(h.logs[0]).toMatchObject({ outcome: 'cancelled', stage: 'request', why: 'token', requested: true });
    expect(h.logs[0]?.tTotal).toBeUndefined();
    expect(h.metrics.summary()).toContain('取消与过期原因：request/token=1');
  });

  it('防抖期间取消：停在等待阶段', async () => {
    const h = setup('const a = \nrest');
    const token = new TestToken();
    const pending = h.pipeline.run({ doc: h.doc, position: { line: 0, character: 10 }, trigger: 'auto', token });
    await vi.advanceTimersByTimeAsync(200);
    token.cancel();
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toBeUndefined();
    expect(h.logs[0]).toMatchObject({ outcome: 'cancelled', stage: 'wait', why: 'token', requested: false });
  });

  it('postprocessTraced 返回实际改动结果的规则', () => {
    expect(postprocessTraced({ text: 'a, b);\nfoo();', prefix: 'bar(', suffix: ')\nnext', maxLines: 12 }))
      .toEqual({ text: 'a, b', rules: ['bracket'] });
    expect(postprocessTraced({ text: 'x + y', prefix: 'const s = ', suffix: ';\n', maxLines: 12 })).toEqual({ text: 'x + y', rules: [] });
    expect(postprocessTraced({ text: '  \n', prefix: '', suffix: '', maxLines: 12 })).toEqual({ text: '', rules: ['blank'] });
  });
});
