import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HealthState } from '../../src/core/backoff';
import { CompletionCache } from '../../src/core/cache';
import { createCollector, type ContextSource } from '../../src/core/collector';
import type { DepsIo } from '../../src/core/deps';
import { abortError, type FimClient, type FimRequest, type FimResult } from '../../src/core/fim/client';
import { FimError } from '../../src/core/fim/errors';
import { Metrics } from '../../src/core/metrics';
import { CompletionPipeline, type LiveDoc, type PipelineRequest } from '../../src/core/pipeline';
import { Scheduler } from '../../src/core/scheduler';
import { DEFAULT_CONFIG, type Config, type Position, type TextSource } from '../../src/core/types';
import { MutableDoc, TestToken, numberedLines } from './helpers';

/** 假模型：按调用序号返回文本；支持延迟、abort 后延迟落定、抛错 */
class FakeFim implements FimClient {
  requests: FimRequest[] = [];
  replies: Array<string | Error | ((req: FimRequest) => string)> = [];
  latencyMs = 50;
  settleDelayMs = 0;
  async complete(req: FimRequest): Promise<FimResult> {
    this.requests.push(req);
    const reply = this.replies[this.requests.length - 1] ?? this.replies[this.replies.length - 1] ?? 'done()';
    return new Promise<FimResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (reply instanceof Error) {
          reject(reply);
          return;
        }
        resolve({ text: typeof reply === 'function' ? reply(req) : reply, finishReason: 'stop', totalMs: this.latencyMs, firstByteMs: 10 });
      }, this.latencyMs);
      req.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        setTimeout(() => reject(abortError()), this.settleDelayMs);
      });
    });
  }
}

class Doc implements LiveDoc {
  readonly mutable: MutableDoc;
  cursorOk = true;
  constructor(text: string, readonly key = 'file:///a.vue', readonly languageId = 'javascript', readonly fileLabel = 'a.js') {
    this.mutable = new MutableDoc(text);
  }
  get source(): TextSource {
    return this.mutable.source;
  }
  version(): number {
    return this.mutable.version;
  }
  cursorIsAt(_p: Position): boolean {
    return this.cursorOk;
  }
}

interface Harness {
  pipeline: CompletionPipeline;
  fim: FakeFim;
  cache: CompletionCache;
  health: HealthState;
  metrics: Metrics;
  cfg: Config;
  logs: string[];
  dirty: Set<string>;
  stats: Map<string, { mtimeMs: number; size: number }>;
  sourceCalls: { count: number };
  setSource(s: Partial<ContextSource>): void;
}

function harness(cfgOver: Partial<Config> = {}, sourceName = 'symbols'): Harness {
  const cfg: Config = { ...DEFAULT_CONFIG, ...cfgOver };
  const fim = new FakeFim();
  const cache = new CompletionCache();
  const health = new HealthState();
  const metrics = new Metrics();
  const logs: string[] = [];
  const dirty = new Set<string>();
  const stats = new Map<string, { mtimeMs: number; size: number }>();
  const sourceCalls = { count: 0 };
  let source: ContextSource = {
    name: 'symbols',
    async collect() {
      sourceCalls.count++;
      return { members: [{ kind: 'methods', name: 'fetchList' }] };
    },
  };
  const depsIo: DepsIo = { stat: async (u) => stats.get(u), isDirty: (u) => dirty.has(u) };
  const collector = createCollector({ sources: [{ name: sourceName, collect: (c, d) => source.collect(c, d) }], vueMajor: async () => undefined });
  const scheduler = new Scheduler({ timeoutMs: () => cfg.timeoutMs });
  const pipeline = new CompletionPipeline({ cfg: () => cfg, cache, scheduler, fim, collector, depsIo, health, metrics, log: (l) => logs.push(l) });
  return {
    pipeline, fim, cache, health, metrics, cfg, logs, dirty, stats, sourceCalls,
    setSource: (s) => {
      source = { ...source, ...s } as ContextSource;
    },
  };
}

function request(doc: Doc, position: Position, over: Partial<PipelineRequest> = {}): PipelineRequest & { token: TestToken } {
  const token = new TestToken();
  return { doc, position, trigger: 'auto', token, ...over } as PipelineRequest & { token: TestToken };
}

describe('CompletionPipeline', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('I1 停笔后约 debounceMs 发出 1 个请求，结果即为灰字文本', async () => {
    const h = harness();
    h.fim.replies = ['compute(1)'];
    const doc = new Doc('const total = \nrest');
    const p = h.pipeline.run(request(doc, { line: 0, character: 14 }));
    await vi.advanceTimersByTimeAsync(999);
    expect(h.fim.requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toEqual({ text: 'compute(1)', seq: 1 });
    expect(h.fim.requests).toHaveLength(1);
    const req = h.fim.requests[0]!;
    expect(req.prompt.endsWith('const total = ')).toBe(true);
    expect(req.suffix).toBe('\nrest');
    expect(req.prompt).toContain('[context]'); // 增强头部已拼入
  });

  it('I2 请求在途时继续输入：旧请求被中止，旧结果不显示', async () => {
    const h = harness();
    h.fim.replies = ['old()'];
    h.fim.latencyMs = 5000;
    const doc = new Doc('x = \n');
    const r1 = request(doc, { line: 0, character: 4 });
    const p1 = h.pipeline.run(r1);
    await vi.advanceTimersByTimeAsync(1100);
    expect(h.fim.requests).toHaveLength(1);
    // 用户继续输入：文档版本变化，旧 token 被取消
    doc.mutable.insertAt(0, 4, 'a');
    r1.token.cancel();
    await vi.advanceTimersByTimeAsync(10);
    expect(h.fim.requests[0]?.signal.aborted).toBe(true);
    expect(await p1).toBeUndefined();
  });

  it('I3 两次自动请求的发送间隔不少于 minIntervalMs', async () => {
    const h = harness();
    h.fim.replies = ['a()', 'b()'];
    const doc = new Doc('x = \nline2');
    const t0 = Date.now();
    const p1 = h.pipeline.run(request(doc, { line: 0, character: 4 }));
    await vi.advanceTimersByTimeAsync(1200);
    await p1;
    const sentAt1 = t0 + 1000;
    // 紧接着在另一个位置再触发
    doc.mutable.setLine(1, 'other = ');
    const p2 = h.pipeline.run(request(doc, { line: 1, character: 8 }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.fim.requests).toHaveLength(1); // 还没到 3s 间隔
    await vi.advanceTimersByTimeAsync(2000);
    await p2;
    expect(h.fim.requests).toHaveLength(2);
    expect(Date.now() - sentAt1).toBeGreaterThanOrEqual(3000);
  });

  it('I4 续显：手敲预测的前 3 个字符，不产生新的模型请求', async () => {
    const h = harness();
    h.fim.replies = ['computeTotal(items)'];
    const doc = new Doc('const total = \nrest');
    const p = h.pipeline.run(request(doc, { line: 0, character: 14 }));
    await vi.advanceTimersByTimeAsync(1500);
    expect((await p)?.text).toBe('computeTotal(items)');
    doc.mutable.insertAt(0, 14, 'com');
    const r = await h.pipeline.run(request(doc, { line: 0, character: 17 }));
    expect(r?.text).toBe('puteTotal(items)');
    expect(h.fim.requests).toHaveLength(1);
    const last = JSON.parse(h.logs.at(-1)!);
    expect(last.cache).toBe('remainder');
  });

  it('I5 手动触发：不等防抖，立即发出，输出上限更大', async () => {
    const h = harness();
    h.fim.replies = ['x()'];
    const doc = new Doc('a = \n');
    const p = h.pipeline.run(request(doc, { line: 0, character: 4 }, { trigger: 'manual' }));
    await vi.advanceTimersByTimeAsync(100);
    expect(h.fim.requests).toHaveLength(1);
    expect(h.fim.requests[0]?.maxTokens).toBe(DEFAULT_CONFIG.maxTokensManual);
    expect((await p)?.text).toBe('x()');
  });

  it('I6 相同上下文重复触发：只有 1 个请求', async () => {
    const h = harness();
    h.fim.replies = ['same()'];
    h.fim.latencyMs = 3000;
    const doc = new Doc('a = \n');
    const pa = h.pipeline.run(request(doc, { line: 0, character: 4 }, { trigger: 'manual' }));
    const pb = h.pipeline.run(request(doc, { line: 0, character: 4 }, { trigger: 'manual' }));
    await vi.advanceTimersByTimeAsync(3500);
    expect((await pa)?.text).toBe('same()');
    expect((await pb)?.text).toBe('same()');
    expect(h.fim.requests).toHaveLength(1);
  });

  it.each([
    ['transient', 'ok', undefined],
    ['rate', 'backoff', 5000],
  ] as const)('合并请求只更新一次 %s 健康状态', async (kind, status, wait) => {
    const h = harness();
    h.fim.replies = [new FimError(kind, 'one HTTP failure')];
    const onError = vi.spyOn(h.health, 'onError');
    const doc = new Doc('a = \n');
    const pending = Array.from({ length: 3 }, () =>
      h.pipeline.run(request(doc, { line: 0, character: 4 }, { trigger: 'manual' })),
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(await Promise.all(pending)).toEqual([undefined, undefined, undefined]);
    expect(h.fim.requests).toHaveLength(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(h.health.snapshot.status).toBe(status);
    if (wait !== undefined) {
      expect(h.health.snapshot.until).toBe(Date.now() - 50 + wait);
    }
  });

  it('合并请求只记录一次成功和一次超时', async () => {
    const h = harness({ timeoutMs: 1000 });
    const onSuccess = vi.spyOn(h.health, 'onSuccess');
    const onError = vi.spyOn(h.health, 'onError');
    const doc = new Doc('a = \n');
    const run = () => h.pipeline.run(request(doc, { line: 0, character: 4 }, { trigger: 'manual' }));
    const success = [run(), run(), run()];
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all(success);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    h.cache.clear();
    h.fim.latencyMs = 60_000;
    const timeouts = [run(), run(), run()];
    await vi.advanceTimersByTimeAsync(1100);
    expect(await Promise.all(timeouts)).toEqual([undefined, undefined, undefined]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(h.health.snapshot.status).toBe('ok');
  });

  it('关闭后立即重开：等待中的旧调用仍失效，不需要取消原 token', async () => {
    const h = harness();
    const doc = new Doc('a = \n');
    const pending = h.pipeline.run(request(doc, { line: 0, character: 4 }));
    await vi.advanceTimersByTimeAsync(200);
    h.pipeline.invalidate();
    await vi.advanceTimersByTimeAsync(1500);
    expect(await pending).toBeUndefined();
    expect(h.fim.requests).toHaveLength(0);
  });

  it('停用会中止在途模型请求，不显示、不缓存', async () => {
    const h = harness();
    h.fim.latencyMs = 5000;
    const doc = new Doc('a = \n');
    const pending = h.pipeline.run(request(doc, { line: 0, character: 4 }, { trigger: 'manual' }));
    await vi.advanceTimersByTimeAsync(100);
    h.pipeline.invalidate();
    expect(h.fim.requests[0]?.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toBeUndefined();
    expect(h.cache.length).toBe(0);
  });

  it('宿主发送许可在防抖期间改变：不发送模型请求', async () => {
    const h = harness();
    const doc = new Doc('a = \n');
    let allowed = true;
    const pending = h.pipeline.run(request(doc, { line: 0, character: 4 }, { isValid: () => allowed }));
    await vi.advanceTimersByTimeAsync(100);
    allowed = false;
    await vi.advanceTimersByTimeAsync(1500);
    expect(await pending).toBeUndefined();
    expect(h.fim.requests).toHaveLength(0);
  });

  it('收集上下文期间进入退避：发送前再次复查健康状态', async () => {
    const h = harness();
    h.setSource({
      async collect() {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return undefined;
      },
    });
    const doc = new Doc('a = \n');
    const pending = h.pipeline.run(request(doc, { line: 0, character: 4 }, { trigger: 'manual' }));
    await vi.advanceTimersByTimeAsync(10);
    h.health.onError(new FimError('rate', 'rate limited'));
    await vi.advanceTimersByTimeAsync(200);
    expect(await pending).toBeUndefined();
    expect(h.fim.requests).toHaveLength(0);
    expect(JSON.parse(h.logs.at(-1)!).outcome).toBe('backoff');
  });

  it('I7 文档版本变化（切换/编辑）后旧结果返回：不显示', async () => {
    const h = harness();
    h.fim.replies = ['late()'];
    h.fim.latencyMs = 2000;
    const doc = new Doc('a = \n');
    const p = h.pipeline.run(request(doc, { line: 0, character: 4 }, { trigger: 'manual' }));
    await vi.advanceTimersByTimeAsync(500);
    doc.mutable.insertAt(0, 0, ' '); // 版本变化，但 token 没取消（不依赖 VS Code 一定取消）
    await vi.advanceTimersByTimeAsync(2500);
    expect(await p).toBeUndefined();
    expect(h.cache.length).toBe(0);
  });

  it('光标移动（cursorIsAt 为假）→ 不显示、不缓存', async () => {
    const h = harness();
    h.fim.latencyMs = 500;
    const doc = new Doc('a = \n');
    const p = h.pipeline.run(request(doc, { line: 0, character: 4 }, { trigger: 'manual' }));
    await vi.advanceTimersByTimeAsync(100);
    doc.cursorOk = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toBeUndefined();
    expect(h.cache.length).toBe(0);
  });

  it('I8 超时：无灰字，指标正确，后续请求可正常发出', async () => {
    const h = harness({ timeoutMs: 1000 });
    h.fim.latencyMs = 60_000;
    const doc = new Doc('a = \n');
    const p = h.pipeline.run(request(doc, { line: 0, character: 4 }, { trigger: 'manual' }));
    await vi.advanceTimersByTimeAsync(1500);
    expect(await p).toBeUndefined();
    expect(JSON.parse(h.logs.at(-1)!).outcome).toBe('timeout');
    h.fim.latencyMs = 10;
    h.fim.replies = ['ok()'];
    h.fim.requests = [];
    const p2 = h.pipeline.run(request(doc, { line: 0, character: 4 }, { trigger: 'manual' }));
    await vi.advanceTimersByTimeAsync(100);
    expect((await p2)?.text).toBe('ok()');
  });

  it('I9 401：进入配置错误，自动触发不再发请求，手动可以', async () => {
    const h = harness();
    h.fim.replies = [new FimError('auth', 'HTTP 401', 401)];
    const doc = new Doc('a = \n');
    const p = h.pipeline.run(request(doc, { line: 0, character: 4 }, { trigger: 'manual' }));
    await vi.advanceTimersByTimeAsync(200);
    expect(await p).toBeUndefined();
    expect(h.health.snapshot.status).toBe('configError');
    const auto = await h.pipeline.run(request(doc, { line: 0, character: 4 }));
    expect(auto).toBeUndefined();
    expect(h.fim.requests).toHaveLength(1);
  });

  it('I9 429：退避期内自动与手动都不发请求', async () => {
    const h = harness();
    h.fim.replies = [new FimError('rate', 'HTTP 429', 429)];
    const doc = new Doc('a = \n');
    const p = h.pipeline.run(request(doc, { line: 0, character: 4 }, { trigger: 'manual' }));
    await vi.advanceTimersByTimeAsync(200);
    await p;
    const again = await h.pipeline.run(request(doc, { line: 0, character: 4 }, { trigger: 'manual' }));
    expect(again).toBeUndefined();
    expect(h.fim.requests).toHaveLength(1);
    expect(JSON.parse(h.logs.at(-1)!).outcome).toBe('backoff');
  });

  it('I13 配置变更（epoch 变）后不命中旧缓存', async () => {
    const h = harness();
    h.fim.replies = ['one()', 'two()'];
    const doc = new Doc('a = \n');
    const p = h.pipeline.run(request(doc, { line: 0, character: 4 }, { trigger: 'manual' }));
    await vi.advanceTimersByTimeAsync(200);
    expect((await p)?.text).toBe('one()');
    h.cfg.model = 'other-model';
    h.cfg.epoch++;
    const p2 = h.pipeline.run(request(doc, { line: 0, character: 4 }, { trigger: 'manual' }));
    await vi.advanceTimersByTimeAsync(200);
    expect((await p2)?.text).toBe('two()');
    expect(h.fim.requests).toHaveLength(2);
  });

  it('I14 万行文件：请求体字符数不超过预算，光标两侧紧邻字符正确', async () => {
    const h = harness();
    const text = numberedLines(10_000, 40);
    const doc = new Doc(text);
    for (const line of [0, 5000, 8500, 9999]) {
      h.fim.requests = [];
      h.cache.clear();
      const ch = 7;
      const p = h.pipeline.run(request(doc, { line, character: ch }, { trigger: 'manual' }));
      await vi.advanceTimersByTimeAsync(300);
      await p;
      const req = h.fim.requests[0]!;
      const lineText = doc.mutable.lines[line]!;
      expect(req.prompt.length).toBeLessThanOrEqual(DEFAULT_CONFIG.prefixChars + DEFAULT_CONFIG.headerChars);
      expect(req.suffix.length).toBeLessThanOrEqual(DEFAULT_CONFIG.suffixChars);
      expect(req.prompt.endsWith(lineText.slice(0, ch))).toBe(true);
      expect(req.suffix.startsWith(lineText.slice(ch))).toBe(true);
    }
  });

  it('I21 改动窗口内更早的一行，再回到原位置触发：产生新请求，不返回旧结果', async () => {
    const h = harness();
    h.fim.replies = ['method })', 'method, body })'];
    const doc = new Doc(['const method = "GET"', ...Array.from({ length: 30 }, (_, i) => `// ${i}`), 'fetch(url, { method: '].join('\n'));
    const last = doc.mutable.lines.length - 1;
    const pos = { line: last, character: doc.mutable.lines[last]!.length };
    let p = h.pipeline.run(request(doc, pos, { trigger: 'manual' }));
    await vi.advanceTimersByTimeAsync(200);
    expect((await p)?.text).toBe('method })');
    doc.mutable.setLine(0, 'const method = "POST"');
    h.pipeline.onDocumentChanged(doc.key, [0]); // 窗口起点是第 0 行，改动在窗口内，交给文本比较裁决
    p = h.pipeline.run(request(doc, pos, { trigger: 'manual' }));
    await vi.advanceTimersByTimeAsync(200);
    expect((await p)?.text).toBe('method, body })');
    expect(h.fim.requests).toHaveLength(2);
  });

  it('I22 以 600ms 间隔持续输入：没有上下文收集、没有模型请求', async () => {
    const h = harness();
    const doc = new Doc('a = \n');
    let token: TestToken | undefined;
    const pending: Promise<unknown>[] = [];
    for (let i = 0; i < 16; i++) {
      token?.cancel();
      doc.mutable.insertAt(0, 4, 'x');
      const r = request(doc, { line: 0, character: 5 + i });
      token = r.token;
      pending.push(h.pipeline.run(r));
      await vi.advanceTimersByTimeAsync(600);
    }
    token?.cancel();
    await vi.advanceTimersByTimeAsync(2000);
    await Promise.all(pending);
    expect(h.fim.requests).toHaveLength(0);
    expect(h.sourceCalls.count).toBe(0);
  });

  it('I23 旧请求被中止但迟迟不落定：这段时间内没有新的模型请求发出', async () => {
    const h = harness();
    h.fim.settleDelayMs = 1000;
    h.fim.latencyMs = 5000;
    const doc = new Doc('a = \nb');
    const r1 = request(doc, { line: 0, character: 4 }, { trigger: 'manual' });
    void h.pipeline.run(r1);
    await vi.advanceTimersByTimeAsync(100);
    expect(h.fim.requests).toHaveLength(1);
    // 换一个位置再手动触发 → 需要中止旧请求
    doc.mutable.setLine(1, 'b = ');
    const r2 = request(doc, { line: 1, character: 4 }, { trigger: 'manual' });
    r1.token.cancel();
    const p2 = h.pipeline.run(r2);
    await vi.advanceTimersByTimeAsync(900);
    expect(h.fim.requests).toHaveLength(1);
    h.fim.latencyMs = 10;
    await vi.advanceTimersByTimeAsync(1200);
    await p2;
    expect(h.fim.requests).toHaveLength(2);
  });

  it('I24 Skimmer 头部关联文件在请求在途时被改写 → 不显示、不缓存', async () => {
    const h = harness({}, 'skimmer');
    h.setSource({
      async collect() {
        return {
          related: [{ name: 'Child', file: 'Child.vue', interface: [{ kind: 'props', name: 'rows' }], dep: { uri: 'file:///Child.vue', mtimeMs: 1, size: 10 } }],
        };
      },
    });
    h.stats.set('file:///Child.vue', { mtimeMs: 1, size: 10 });
    h.fim.latencyMs = 1000;
    h.fim.replies = ['<Child :rows="x" />'];
    const doc = new Doc('<Child \n');
    const p = h.pipeline.run(request(doc, { line: 0, character: 7 }, { trigger: 'manual' }));
    await vi.advanceTimersByTimeAsync(500);
    expect(h.fim.requests[0]?.prompt).toContain('<Child> Child.vue');
    h.stats.set('file:///Child.vue', { mtimeMs: 2, size: 12 }); // 在途期间子组件被保存
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toBeUndefined();
    expect(h.cache.length).toBe(0);
    expect(JSON.parse(h.logs.at(-1)!).outcome).toBe('stale');
  });

  it('React Hook返回结构进入FIM头部，Hook来源变化后响应不显示或缓存', async () => {
    const h = harness({}, 'skimmer');
    h.setSource({
      async collect() {
        return {
          framework: 'react',
          members: [{ kind: 'state', name: 'draft' }, { kind: 'setters', name: 'setDraft' }],
          related: [{
            kind: 'hook', name: 'useDraft', file: 'useDraft.ts',
            interface: [{ kind: 'returns', name: 'save', signature: 'save()' }],
            dep: { uri: 'file:///useDraft.ts', mtimeMs: 1, size: 20 },
          }],
        };
      },
    });
    h.stats.set('file:///useDraft.ts', { mtimeMs: 1, size: 20 });
    h.fim.latencyMs = 1000;
    const doc = new Doc('const next = \n', 'file:///App.tsx', 'typescriptreact', 'App.tsx');
    const pending = h.pipeline.run(request(doc, { line: 0, character: 13 }, { trigger: 'manual' }));
    await vi.advanceTimersByTimeAsync(200);
    expect(h.fim.requests[0]?.prompt).toContain('hook useDraft useDraft.ts: returns save()');
    expect(h.fim.requests[0]?.prompt).not.toContain('<!--');
    h.stats.set('file:///useDraft.ts', { mtimeMs: 2, size: 21 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toBeUndefined();
    expect(h.cache.length).toBe(0);
  });

  it('Node模块签名进入FIM头部，CommonJS barrel未保存时在途结果不显示或缓存', async () => {
    const h = harness({}, 'skimmer');
    h.setSource({
      async collect() {
        return {
          framework: 'node',
          related: [{
            kind: 'module', name: 'read', file: 'service.cts',
            interface: [{ kind: 'function', name: 'read', signature: 'read(path)' }],
            dep: { uri: 'file:///service.cts', mtimeMs: 1, size: 20 },
            deps: [{ uri: 'file:///barrel.cjs', mtimeMs: 2, size: 30 }],
          }],
        };
      },
    });
    h.stats.set('file:///service.cts', { mtimeMs: 1, size: 20 });
    h.stats.set('file:///barrel.cjs', { mtimeMs: 2, size: 30 });
    h.fim.latencyMs = 1000;
    const doc = new Doc('const value = \n', 'file:///App.cts', 'typescript', 'App.cts');
    const pending = h.pipeline.run(request(doc, { line: 0, character: 14 }, { trigger: 'manual' }));
    await vi.advanceTimersByTimeAsync(200);
    expect(h.fim.requests[0]?.prompt).toContain('file: App.cts (node)');
    expect(h.fim.requests[0]?.prompt).toContain('module read service.cts: function read(path)');
    expect(h.fim.requests[0]?.prompt).not.toContain('<!--');
    h.dirty.add('file:///barrel.cjs');
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toBeUndefined();
    expect(h.cache.length).toBe(0);
    expect(JSON.parse(h.logs.at(-1)!).outcome).toBe('stale');
  });

  it('来源依赖：收集完成时依赖已变 → 本次退回基础模式（头部为空）但照常补全', async () => {
    const h = harness();
    h.setSource({
      async collect() {
        return { related: [{ name: 'Child', file: 'Child.vue', interface: [], dep: { uri: 'file:///Child.vue', mtimeMs: 1, size: 10 } }] };
      },
    });
    h.dirty.add('file:///Child.vue');
    h.fim.replies = ['ok()'];
    const doc = new Doc('a = \n');
    const p = h.pipeline.run(request(doc, { line: 0, character: 4 }, { trigger: 'manual' }));
    await vi.advanceTimersByTimeAsync(300);
    expect((await p)?.text).toBe('ok()');
    expect(h.fim.requests[0]?.prompt).not.toContain('[context]');
  });

  it('缓存命中时依赖已变：不返回旧结果，并删除条目', async () => {
    const h = harness();
    h.setSource({
      async collect() {
        return { related: [{ name: 'Child', file: 'Child.vue', interface: [], dep: { uri: 'file:///Child.vue', mtimeMs: 1, size: 10 } }] };
      },
    });
    h.stats.set('file:///Child.vue', { mtimeMs: 1, size: 10 });
    h.fim.replies = ['first()', 'second()'];
    const doc = new Doc('a = \n');
    let p = h.pipeline.run(request(doc, { line: 0, character: 4 }, { trigger: 'manual' }));
    await vi.advanceTimersByTimeAsync(300);
    expect((await p)?.text).toBe('first()');
    h.stats.set('file:///Child.vue', { mtimeMs: 9, size: 10 });
    p = h.pipeline.run(request(doc, { line: 0, character: 4 }, { trigger: 'manual' }));
    await vi.advanceTimersByTimeAsync(300);
    expect((await p)?.text).toBe('second()');
    expect(h.fim.requests).toHaveLength(2);
  });

  it('I15 Skimmer 超时：本次不含增强内容，FIM 请求仍按时发出', async () => {
    const h = harness({ extraWaitMs: 500 }, 'skimmer');
    h.setSource({
      collect: () => new Promise(() => undefined), // 永不返回
    });
    h.fim.replies = ['ok()'];
    const doc = new Doc('a = \n');
    const p = h.pipeline.run(request(doc, { line: 0, character: 4 }, { trigger: 'manual' }));
    await vi.advanceTimersByTimeAsync(499);
    expect(h.fim.requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(300);
    expect(h.fim.requests).toHaveLength(1);
    expect(h.fim.requests[0]?.prompt).not.toContain('[context]');
    await vi.advanceTimersByTimeAsync(200);
    expect((await p)?.text).toBe('ok()');
    expect(JSON.parse(h.logs.at(-1)!).skimmer).toBe('timeout');
  });

  it('上下文来源抛错：只影响本次头部', async () => {
    const h = harness();
    h.setSource({
      collect: async () => {
        throw new Error('lsp crashed');
      },
    });
    h.fim.replies = ['ok()'];
    const doc = new Doc('a = \n');
    const p = h.pipeline.run(request(doc, { line: 0, character: 4 }, { trigger: 'manual' }));
    await vi.advanceTimersByTimeAsync(300);
    expect((await p)?.text).toBe('ok()');
  });

  it('后处理为空 → 不显示、不缓存', async () => {
    const h = harness();
    h.fim.replies = ['   \n  '];
    const doc = new Doc('a = \n');
    const p = h.pipeline.run(request(doc, { line: 0, character: 4 }, { trigger: 'manual' }));
    await vi.advanceTimersByTimeAsync(300);
    expect(await p).toBeUndefined();
    expect(h.cache.length).toBe(0);
  });

  it('指标：每次调用一行 JSON，不含源码', async () => {
    const h = harness();
    h.fim.replies = ['SECRET_COMPLETION()'];
    const doc = new Doc('const SECRET_SOURCE = \n');
    const p = h.pipeline.run(request(doc, { line: 0, character: 22 }, { trigger: 'manual' }));
    await vi.advanceTimersByTimeAsync(300);
    await p;
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).not.toContain('SECRET');
    expect(JSON.parse(h.logs[0]!)).toMatchObject({ trigger: 'manual', outcome: 'shown', requested: true });
    expect(h.metrics.summary()).toContain('模型请求 1');
  });

  it('文档关闭后缓存被清理', async () => {
    const h = harness();
    h.fim.replies = ['x()'];
    const doc = new Doc('a = \n');
    const p = h.pipeline.run(request(doc, { line: 0, character: 4 }, { trigger: 'manual' }));
    await vi.advanceTimersByTimeAsync(300);
    await p;
    expect(h.cache.length).toBe(1);
    h.pipeline.onDocumentClosed(doc.key);
    expect(h.cache.length).toBe(0);
  });
});
