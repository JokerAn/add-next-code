import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HealthState } from '../../src/core/backoff';
import { CompletionCache } from '../../src/core/cache';
import { createCollector } from '../../src/core/collector';
import type { FimClient, FimRequest, FimResult } from '../../src/core/fim/client';
import { Metrics } from '../../src/core/metrics';
import { CompletionPipeline, type LiveDoc } from '../../src/core/pipeline';
import { Scheduler } from '../../src/core/scheduler';
import { createSnippetSource } from '../../src/core/snippets';
import { DEFAULT_CONFIG, type Config } from '../../src/core/types';
import { MutableDoc, TestToken } from './helpers';

describe('debug.dumpCompletions', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const FILE = [
    '<template>',
    '  <skulist-pop :skuData="resResult.skuListPop" v-model="skulistPopShow" />',
    '</template>',
    '<script>',
    'export default {',
    '  methods: {',
    ...Array.from({ length: 400 }, (_, i) => `    unrelatedHelper${i}() { return ${i} },`),
    '    onChange(res) {',
    '      ',
    '    },',
    '  },',
    '}',
    '</script>',
  ];
  const BAD = 'this.skulistPopShow = true\n      this.skulistPopList = res.list';
  const GOOD = 'this.skulistPopShow = true\n      this.resResult.skuListPop = res.list';

  function setup(over: Partial<Config>) {
    const cfg: Config = { ...DEFAULT_CONFIG, ...over };
    const logs: string[] = [];
    const fim: FimClient = {
      async complete(req: FimRequest): Promise<FimResult> {
        return { text: req.prompt.includes('resResult.skuListPop') ? GOOD : BAD, finishReason: 'stop', totalMs: 1 };
      },
    };
    const mutable = new MutableDoc(FILE.join('\n'));
    const doc: LiveDoc = {
      key: 'file:///a.vue', languageId: 'vue', fileLabel: 'a.vue', source: mutable.source,
      version: () => mutable.version, cursorIsAt: () => true,
    };
    const pipeline = new CompletionPipeline({
      cfg: () => cfg, cache: new CompletionCache(), scheduler: new Scheduler({ timeoutMs: () => cfg.timeoutMs }), fim,
      collector: createCollector({ sources: [createSnippetSource(() => true)], vueMajor: async () => 2 }),
      depsIo: { stat: async () => undefined, isDirty: () => false }, health: new HealthState(), metrics: new Metrics(),
      log: (line) => logs.push(line),
    });
    const run = async () => {
      const pending = pipeline.run({ doc, position: { line: FILE.indexOf('      '), character: 6 }, trigger: 'manual', token: new TestToken() });
      await vi.advanceTimersByTimeAsync(5000);
      return pending;
    };
    return { logs, run };
  }

  it('默认关闭：日志只有一行 JSON，不含补全原文', async () => {
    const h = setup({});
    expect((await h.run())?.text).toBe(GOOD);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).not.toContain('skulistPop');
    expect(() => JSON.parse(h.logs[0] as string)).not.toThrow();
  });

  it('开启后依次写入原始输出、判定为不存在的名字、重发输出和最终展示的文本', async () => {
    const h = setup({ dumpCompletions: true });
    expect((await h.run())?.text).toBe(GOOD);
    expect(h.logs.filter((line) => line.startsWith('[completion#1'))).toEqual([
      `[completion#1 raw]\n${BAD}`,
      '[completion#1 invented]\nskulistPopList',
      `[completion#1 retry raw]\n${GOOD}`,
      `[completion#1 shown]\n${GOOD}`,
    ]);
    // 缓存命中时同样写入展示的文本
    expect((await h.run())?.text).toBe(GOOD);
    expect(h.logs.at(-1)).toBe(`[completion#2 shown]\n${GOOD}`);
  });

  it('dumpPrompts 开启时重发的 prompt 也写入', async () => {
    const h = setup({ dumpPrompts: true });
    await h.run();
    const prompts = h.logs.filter((line) => line.startsWith('[prompt#1'));
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain('related code elsewhere in this file');
    expect(prompts[1]?.startsWith('[prompt#1 retry]')).toBe(true);
    expect(prompts[1]).toContain('related code elsewhere in this file');
  });
});
