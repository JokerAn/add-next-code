import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HealthState } from '../../src/core/backoff';
import { CompletionCache } from '../../src/core/cache';
import { createCollector } from '../../src/core/collector';
import { DeepSeekFimClient, type FimClient, type FimRequest, type FimResult } from '../../src/core/fim/client';
import { buildFimRequest } from '../../src/core/fim/prompt';
import { cutStatement, firstExtraCloser, lineModeOf } from '../../src/core/linePolicy';
import { Metrics, type CallRecord } from '../../src/core/metrics';
import { CompletionPipeline, type LiveDoc } from '../../src/core/pipeline';
import { postprocess } from '../../src/core/postprocess';
import { estimateCost, isPeak } from '../../src/core/pricing';
import { Scheduler } from '../../src/core/scheduler';
import { DEFAULT_CONFIG, EMPTY_HEADER, type Config } from '../../src/core/types';
import { MutableDoc, TestToken } from './helpers';

describe('lineModeOf 空行分级', () => {
  it('非空行沿用原规则', () => {
    expect(lineModeOf('const a = ', '\nnext')).toBe('free');
    expect(lineModeOf('foo();\n  ', 'bar();\nnext')).toBe('free');
    // 行内只剩闭合符也不算空行
    expect(lineModeOf('foo(\n  ', ')\nnext')).toBe('free');
  });

  it('刚打开的代码块之后允许多行', () => {
    expect(lineModeOf('function f() {\n  ', '\n}')).toBe('block');
    expect(lineModeOf('items.map((x) =>\n  ', '\n)')).toBe('block');
    expect(lineModeOf('const list = [\n  ', '\n]')).toBe('block');
    expect(lineModeOf('switch (a) {\n  case 1:\n    ', '\n}')).toBe('block');
    expect(lineModeOf('<div class="a">\n  ', '\n</div>')).toBe('block');
    expect(lineModeOf('<template>\n  ', '')).toBe('block');
  });

  it('注释之后允许多行，中间隔空行也算', () => {
    expect(lineModeOf('// 计算合计\n', '')).toBe('block');
    expect(lineModeOf('/** 说明 */\n', '')).toBe('block');
    expect(lineModeOf('  <!-- 表单 -->\n\n  ', '')).toBe('block');
    expect(lineModeOf('# 说明\n', '')).toBe('block');
  });

  it('语句之间的空行只补一条语句', () => {
    expect(lineModeOf('const a = 1;\n', '\nconst c = 3;')).toBe('statement');
    expect(lineModeOf('  foo();\n\n  ', '\n}')).toBe('statement');
    expect(lineModeOf('  name: 1,\n  ', '\n}')).toBe('statement');
    expect(lineModeOf('<el-input v-model="a" />\n', '')).toBe('statement');
    expect(lineModeOf('</div>\n', '')).toBe('statement');
  });

  it('光标之前没有任何内容', () => {
    expect(lineModeOf('', '')).toBe('empty');
    expect(lineModeOf('\n\n  ', '\nfoo()')).toBe('empty');
  });
});

describe('cutStatement 只保留第一条语句', () => {
  it('单行语句在下一条语句出现时截断', () => {
    expect(cutStatement('foo();\nbar();')).toBe('foo();');
    expect(cutStatement('foo();\n\n  bar();')).toBe('foo();');
  });

  it('尚未看到下一行内容时不下结论，可用于流式累计', () => {
    expect(cutStatement('foo();')).toBeUndefined();
    expect(cutStatement('foo();\n')).toBeUndefined();
    expect(cutStatement('foo();\n  ')).toBeUndefined();
  });

  it('括号未配平时继续，配平后才截断', () => {
    const block = 'if (a) {\n  b();\n}';
    expect(cutStatement(`${block}\nc();`)).toBe(block);
    expect(cutStatement('if (a) {\n  b();')).toBeUndefined();
    expect(cutStatement('const o = {\n  a: 1,\n};\nnext')).toBe('const o = {\n  a: 1,\n};');
  });

  it('链式调用与运算符续行算同一条语句', () => {
    const chain = 'api.get(url)\n  .then(done)\n  .catch(fail);';
    expect(cutStatement(`${chain}\nnext();`)).toBe(chain);
    expect(cutStatement('const ok = a\n  && b;\nnext')).toBe('const ok = a\n  && b;');
  });

  it('字符串、模板字符串和行注释里的括号不参与计数', () => {
    expect(cutStatement("log('(');\nnext")).toBe("log('(');");
    expect(cutStatement('foo(); // 说明 (\nnext')).toBe('foo(); // 说明 (');
    expect(cutStatement('const s = `a\nb`;\nnext')).toBe('const s = `a\nb`;');
  });

  it('开头的空行不算语句；下一行是多余的闭合符也截断', () => {
    expect(cutStatement('\nfoo();\nbar();')).toBe('\nfoo();');
    expect(cutStatement('return 1;\n}\nfunction g() {')).toBe('return 1;');
  });

  it('以标签开头的结果不截断', () => {
    expect(cutStatement('<el-form-item label="a">\n  <el-input />\n</el-form-item>\n<div>')).toBeUndefined();
  });
});

describe('firstExtraCloser', () => {
  it('整体闭合多于打开时返回第一个多出的闭合符', () => {
    expect(firstExtraCloser('a, b);\nfoo();')).toEqual({ index: 4, ch: ')' });
    expect(firstExtraCloser('return 1;\n}')).toEqual({ index: 10, ch: '}' });
  });

  it('整体配平或字符串里的闭合符不算', () => {
    expect(firstExtraCloser('\n} else {\n  y();')).toBeUndefined();
    expect(firstExtraCloser('")"')).toBeUndefined();
    expect(firstExtraCloser('x)\n  .then((r) => {')).toBeUndefined();
  });
});

describe('postprocess 批次一补强', () => {
  const pp = (text: string, prefix: string, suffix: string) => postprocess({ text, prefix, suffix, maxLines: 12 });

  it('括号越界：后文以同一闭合符开头时，从多余闭合符处截断', () => {
    expect(pp('a, b);\nfoo();', 'bar(', ')\nnext')).toBe('a, b');
    expect(pp('return 1;\n}', 'function f() {\n  ', '\n}')).toBe('return 1;');
  });

  it('括号越界：后文不是同一闭合符、或整体配平时保持原样', () => {
    expect(pp('"a)b")', 'console.log(', '\n')).toBe('"a)b")');
    expect(pp('\n  } else {\n    y();', '  if (a) {\n    x();', '\n  }')).toBe('\n  } else {\n    y();');
  });

  it('缩进越界：出现比光标所在行更浅的行时从该行截断', () => {
    expect(pp('foo();\n  bar() {\n    x();', '  f() {\n    ', '')).toBe('foo();');
    expect(pp('foo();\n    bar();', '  f() {\n    ', '')).toBe('foo();\n    bar();');
  });

  it('缩进越界：以闭合符开头的浅缩进行交给括号规则，后文已有该闭合符才截断', () => {
    expect(pp('foo();\n  }\n  bar() {', '  f() {\n    ', '')).toBe('foo();\n  }');
    expect(pp('foo();\n  }\n  bar() {', '  f() {\n    ', '\n  }')).toBe('foo();');
  });

  it('缩进越界：空白行和同级缩进不触发，制表符与空格混用时不比较', () => {
    expect(pp('a();\n\n    b();', '    ', '')).toBe('a();\n\n    b();');
    expect(pp('a();\n\tb();', '    ', '')).toBe('a();\n\tb();');
  });

  it('空行上首行与后文下一非空行相同：拒绝', () => {
    expect(pp('return total;', 'function f() {\n  ', '\n  return total;\n}')).toBe('');
  });

  it('非空行的首行、以及较短的首行不受影响', () => {
    expect(pp('compute();', 'const a = ', '\ncompute();')).toBe('compute();');
    expect(pp('</div>', '  ', '\n</div>')).toBe('</div>');
  });
});

describe('流内语句截断', () => {
  const data = (text: string) => `data: ${JSON.stringify({ choices: [{ text, finish_reason: null }] })}\n\n`;

  it('cut 命中时中止流，结果标记为客户端截断', async () => {
    const chunks = ['foo();', '\n', 'bar();', '\nbaz();'].map(data);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    });
    const client = new DeepSeekFimClient({
      endpoint: 'http://x/beta/completions', model: 'deepseek-flash', getApiKey: async () => 'sk-test',
      fetchImpl: async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    });
    const request = buildFimRequest({ prefix: 'a();\n', suffix: '' }, EMPTY_HEADER, false, DEFAULT_CONFIG, new AbortController().signal, true);
    const result = await client.complete(request);
    expect(result.text).toBe('foo();');
    expect(result.finishReason).toBe('client_cut');
  });

  it('非语句模式按"配平后再截"：不在第一条语句处截断，行数硬上限是两倍', () => {
    const request = buildFimRequest({ prefix: 'a', suffix: '' }, EMPTY_HEADER, false, DEFAULT_CONFIG, new AbortController().signal);
    expect(request.cut?.('foo();\nbar();\nbaz();')).toBeUndefined();
    expect(request.maxLines).toBe(DEFAULT_CONFIG.maxLines * 2);
    expect(request.maxTokens).toBe(DEFAULT_CONFIG.maxTokens);
  });

  it('注释或代码块开头之后：输出上限放宽到手动触发的水平', () => {
    const request = buildFimRequest({ prefix: 'a', suffix: '' }, EMPTY_HEADER, false, DEFAULT_CONFIG, new AbortController().signal, false, true);
    expect(request.maxTokens).toBe(DEFAULT_CONFIG.maxTokensManual);
  });
});

describe('管线中的空行策略', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  class Fim implements FimClient {
    requests: FimRequest[] = [];
    reply = 'foo();\nbar();';
    async complete(req: FimRequest): Promise<FimResult> {
      this.requests.push(req);
      return { text: this.reply, finishReason: 'stop', totalMs: 1, firstByteMs: 1 };
    }
  }

  function setup(over: Partial<Config> = {}) {
    const cfg: Config = { ...DEFAULT_CONFIG, ...over };
    const fim = new Fim();
    const metrics = new Metrics();
    const pipeline = new CompletionPipeline({
      cfg: () => cfg, cache: new CompletionCache(), scheduler: new Scheduler({ timeoutMs: () => cfg.timeoutMs }), fim,
      collector: createCollector({ sources: [], vueMajor: async () => undefined }),
      depsIo: { stat: async () => undefined, isDirty: () => false }, health: new HealthState(), metrics, log: () => undefined,
    });
    const run = async (text: string, line: number, character: number, trigger: 'auto' | 'manual' = 'auto') => {
      const mutable = new MutableDoc(text);
      const doc: LiveDoc = {
        key: 'file:///a.js', languageId: 'javascript', fileLabel: 'a.js', source: mutable.source,
        version: () => mutable.version, cursorIsAt: () => true,
      };
      const pending = pipeline.run({ doc, position: { line, character }, trigger, token: new TestToken() });
      await vi.advanceTimersByTimeAsync(5000);
      return pending;
    };
    return { fim, metrics, run };
  }

  it('smart：语句之间的空行只返回一条语句', async () => {
    const h = setup();
    expect((await h.run('const a = 1;\n\nconst c = 3;', 1, 0))?.text).toBe('foo();');
    expect(h.fim.requests[0]?.cut).toBeDefined();
  });

  it('smart：代码块开头与注释之后保持多行', async () => {
    const h = setup();
    h.fim.reply = 'foo();\n  bar();';
    expect((await h.run('function f() {\n  \n}', 1, 2))?.text).toBe('foo();\n  bar();');
    // 多行模式不在第一条语句处截断，且用放宽后的输出上限
    expect(h.fim.requests[0]?.cut?.('foo();\n  bar();\n  baz();')).toBeUndefined();
    expect(h.fim.requests[0]?.maxTokens).toBe(DEFAULT_CONFIG.maxTokensManual);
  });

  it('smart：光标之前没有内容时自动不请求，手动可以', async () => {
    const h = setup();
    expect(await h.run('\n\nfoo()', 1, 0)).toBeUndefined();
    expect(h.fim.requests).toHaveLength(0);
    expect(h.metrics.summary()).toContain('skipped=1');
    expect((await h.run('\n\nfoo()', 1, 0, 'manual'))?.text).toBe('foo();');
  });

  it('strict：语句之间的空行自动不请求，注释之后与手动触发照常', async () => {
    const h = setup({ blankLine: 'strict' });
    expect(await h.run('const a = 1;\n\nconst c = 3;', 1, 0)).toBeUndefined();
    expect(h.fim.requests).toHaveLength(0);
    expect((await h.run('// 合计\n\nconst c = 3;', 1, 0))?.text).toBe('foo();\nbar();');
    expect((await h.run('const a = 1;\n\nconst d = 4;', 1, 0, 'manual'))?.text).toBe('foo();');
  });

  it('always：不区分空行', async () => {
    const h = setup({ blankLine: 'always' });
    expect((await h.run('const a = 1;\n\nconst c = 3;', 1, 0))?.text).toBe('foo();\nbar();');
  });
});

describe('采纳与费用统计', () => {
  const base: CallRecord = {
    seq: 1, trigger: 'auto', lang: 'vue', sci: false, prefixChars: 1, suffixChars: 0, headerChars: 0,
    cache: 'miss', outcome: 'shown', requested: true,
  };

  it('采纳率以模型新结果的展示次数为分母，续显不重复计入', () => {
    const metrics = new Metrics();
    metrics.record({ ...base });
    metrics.record({ ...base, seq: 2 });
    metrics.record({ ...base, seq: 3, cache: 'remainder', requested: false });
    metrics.record({ ...base, seq: 4, outcome: 'empty' });
    expect(metrics.markAccepted(3)).toBe(true);
    expect(metrics.markAccepted(99)).toBe(false);
    expect(metrics.summary()).toContain('采纳：1 次；模型新结果展示 2 次，采纳率 50%');
  });

  it('高峰时段按 UTC 工作日 01–04、06–10 判定', () => {
    expect(isPeak(new Date('2026-11-11T02:00:00Z'))).toBe(true); // 周三
    expect(isPeak(new Date('2026-11-11T09:59:00Z'))).toBe(true);
    expect(isPeak(new Date('2026-11-11T04:30:00Z'))).toBe(false);
    expect(isPeak(new Date('2026-11-11T10:00:00Z'))).toBe(false);
    expect(isPeak(new Date('2026-11-14T02:00:00Z'))).toBe(false); // 周六
  });

  it('按命中/未命中/输出分别计价，并给出全部未命中的对照', () => {
    const usage = { prompt: 2874, cacheHit: 2688, cacheMiss: 186, completion: 5 };
    const peak = estimateCost(DEFAULT_CONFIG.endpoint, 'deepseek-flash', usage, new Date('2026-11-11T02:00:00Z'));
    expect(peak?.usd).toBeCloseTo((2688 * 0.006 + 186 * 0.3 + 5 * 1.2) / 1e6, 12);
    expect(peak?.noCacheUsd).toBeCloseTo((2874 * 0.3 + 5 * 1.2) / 1e6, 12);
    const offPeak = estimateCost(DEFAULT_CONFIG.endpoint, 'deepseek-flash', usage, new Date('2026-11-14T02:00:00Z'));
    expect(offPeak?.usd).toBeCloseTo((peak?.usd ?? 0) / 2, 12);
  });

  it('未知模型或非官方端点不估算', () => {
    const usage = { prompt: 10, cacheHit: 0, cacheMiss: 10, completion: 1 };
    expect(estimateCost(DEFAULT_CONFIG.endpoint, 'other-model', usage, new Date())).toBeUndefined();
    expect(estimateCost('http://127.0.0.1:8080/completions', 'deepseek-flash', usage, new Date())).toBeUndefined();
  });

  it('会话统计汇总命中率、费用与缓存节省', () => {
    const metrics = new Metrics();
    metrics.record({ ...base, usage: { prompt: 1000, cacheHit: 900, cacheMiss: 100, completion: 10 }, cost: { usd: 0.0001, noCacheUsd: 0.0004 } });
    metrics.record({ ...base, seq: 2 });
    const summary = metrics.summary();
    expect(summary).toContain('输入缓存命中率：90%');
    expect(summary).toContain('费用估算（1 次请求');
    expect(summary).toContain('0.00010 美元；若输入全部未命中为 0.00040 美元，缓存节省 75%');
  });
});
