import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HealthState } from '../../src/core/backoff';
import { CompletionCache } from '../../src/core/cache';
import { createCollector } from '../../src/core/collector';
import type { FimClient, FimRequest, FimResult } from '../../src/core/fim/client';
import { FimError } from '../../src/core/fim/errors';
import { Metrics, type CallRecord } from '../../src/core/metrics';
import { CompletionPipeline, type LiveDoc } from '../../src/core/pipeline';
import { Scheduler } from '../../src/core/scheduler';
import { DEFAULT_CONFIG, type Config } from '../../src/core/types';
import { MutableDoc, TestToken } from './helpers';

const ECHO = 'this.setFirstAndSecondReasonF(res.reason1?.value, res.reason2?.value)';
const LINES = ['function f(res) {', '  if (res.ok) {', '    ', '  }', `  ${ECHO}`, '}'];
const CURSOR = 2;

describe('负缓存：被整条拒绝的结果不再重复请求', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  class Fim implements FimClient {
    calls = 0;
    reply: string | Error = ECHO; // 后文里已有的一行，被"后文回声"规则整条拒绝
    async complete(_req: FimRequest): Promise<FimResult> {
      this.calls++;
      if (this.reply instanceof Error) {
        throw this.reply;
      }
      return { text: this.reply, finishReason: 'stop', totalMs: 1 };
    }
  }

  function setup(over: Partial<Config> = {}) {
    const cfg: Config = { ...DEFAULT_CONFIG, verifyMembers: 'off', ...over };
    const fim = new Fim();
    const logs: CallRecord[] = [];
    const mutable = new MutableDoc(LINES.join('\n'));
    const doc: LiveDoc = {
      key: 'file:///a.js', languageId: 'javascript', fileLabel: 'a.js', source: mutable.source,
      version: () => mutable.version, cursorIsAt: () => true,
    };
    const metrics = new Metrics();
    const pipeline = new CompletionPipeline({
      cfg: () => cfg, cache: new CompletionCache(), scheduler: new Scheduler({ timeoutMs: () => cfg.timeoutMs }), fim,
      collector: createCollector({ sources: [], vueMajor: async () => undefined }),
      depsIo: { stat: async () => undefined, isDirty: () => false }, health: new HealthState(), metrics,
      log: (line) => {
        if (line.startsWith('{')) {
          logs.push(JSON.parse(line) as CallRecord);
        }
      },
    });
    const run = async (trigger: 'auto' | 'manual' = 'auto') => {
      const pending = pipeline.run({ doc, position: { line: CURSOR, character: 4 }, trigger, token: new TestToken() });
      await vi.advanceTimersByTimeAsync(5000);
      return pending;
    };
    return { fim, logs, mutable, run, metrics, pipeline, closeDoc: () => pipeline.onDocumentClosed('file:///a.js') };
  }

  it('同一位置、同样的提示词：第一次请求并被拒绝，之后不再发请求', async () => {
    const h = setup();
    expect(await h.run()).toBeUndefined();
    expect(h.fim.calls).toBe(1);
    expect(h.logs[0]).toMatchObject({ outcome: 'empty', requested: true, neg: 'stored', pp: ['suffixEcho'] });

    expect(await h.run()).toBeUndefined();
    expect(await h.run()).toBeUndefined();
    expect(h.fim.calls).toBe(1);
    expect(h.logs[1]).toMatchObject({ outcome: 'empty', requested: false, neg: 'hit' });
    expect(h.logs[2]).toMatchObject({ outcome: 'empty', requested: false, neg: 'hit' });
    expect(h.metrics.summary()).toContain('负缓存拦截 2 次（记下 1 次）');
  });

  it('前缀或后文变了（键不同）、手动触发、温度不为 0：照常请求', async () => {
    const h = setup();
    await h.run();
    h.mutable.lines[CURSOR] = '    x';
    h.mutable.version++;
    await h.run();
    expect(h.fim.calls).toBe(2);

    await h.run('manual');
    expect(h.fim.calls).toBe(3);

    const warm = setup({ temperature: 0.4 });
    await warm.run();
    await warm.run();
    expect(warm.fim.calls).toBe(2);
    expect(warm.logs.every((log) => log.neg === undefined)).toBe(true);
  });

  it('两分钟之后失效；invalidate、关闭文档后清掉', async () => {
    const expired = setup();
    await expired.run();
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 1000);
    await expired.run();
    expect(expired.fim.calls).toBe(2);

    const reset = setup();
    await reset.run();
    reset.pipeline.invalidate();
    await reset.run();
    expect(reset.fim.calls).toBe(2);

    const closed = setup();
    await closed.run();
    closed.closeDoc();
    await closed.run();
    expect(closed.fim.calls).toBe(2);
  });

  it('请求出错、结果正常展示：不记负缓存', async () => {
    const failing = setup();
    failing.fim.reply = new FimError('transient', '网络错误');
    await failing.run();
    expect(failing.logs[0]?.neg).toBeUndefined();

    const shown = setup();
    shown.fim.reply = 'run()';
    expect((await shown.run())?.text).toBe('run()');
    expect(shown.logs[0]?.neg).toBeUndefined();
  });
});

describe('负缓存的键只在行尾空白上宽容', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  class Fim implements FimClient {
    calls = 0;
    async complete(_req: FimRequest): Promise<FimResult> {
      this.calls++;
      return { text: ECHO, finishReason: 'stop', totalMs: 1 };
    }
  }

  function setup() {
    const cfg: Config = { ...DEFAULT_CONFIG, verifyMembers: 'off' };
    const fim = new Fim();
    const logs: CallRecord[] = [];
    const mutable = new MutableDoc(LINES.join('\n'));
    const doc: LiveDoc = {
      key: 'file:///a.js', languageId: 'javascript', fileLabel: 'a.js', source: mutable.source,
      version: () => mutable.version, cursorIsAt: () => true,
    };
    const pipeline = new CompletionPipeline({
      cfg: () => cfg, cache: new CompletionCache(), scheduler: new Scheduler({ timeoutMs: () => cfg.timeoutMs }), fim,
      collector: createCollector({ sources: [], vueMajor: async () => undefined }),
      depsIo: { stat: async () => undefined, isDirty: () => false }, health: new HealthState(), metrics: new Metrics(),
      log: (line) => {
        if (line.startsWith('{')) {
          logs.push(JSON.parse(line) as CallRecord);
        }
      },
    });
    const run = async () => {
      const pending = pipeline.run({ doc, position: { line: CURSOR, character: 4 }, trigger: 'auto', token: new TestToken() });
      await vi.advanceTimersByTimeAsync(5000);
      return pending;
    };
    return { fim, logs, mutable, run };
  }

  it('后文只多了行尾空白（日志里同一位置后文每次多一个字符）：仍然拦截', async () => {
    const h = setup();
    await h.run();
    h.mutable.lines[CURSOR + 1] = '  }  ';
    h.mutable.version++;
    await h.run();
    h.mutable.lines[CURSOR + 1] = '  }   ';
    h.mutable.version++;
    await h.run();
    expect(h.fim.calls).toBe(1);
    expect(h.logs.map((log) => log.neg)).toEqual(['stored', 'hit', 'hit']);
  });

  it('后文多了真正的字符、光标之前多了字符：照常请求', async () => {
    const h = setup();
    await h.run();
    h.mutable.lines[CURSOR + 1] = '  } // x';
    h.mutable.version++;
    await h.run();
    expect(h.fim.calls).toBe(2);
    h.mutable.lines[0] = 'function f(res, extra) {';
    h.mutable.version++;
    await h.run();
    expect(h.fim.calls).toBe(3);
  });
});
