import { describe, expect, it } from 'vitest';
import { HealthState } from '../../src/core/backoff';
import { DeepSeekFimClient } from '../../src/core/fim/client';
import { FimError, classifyStatus, parseRetryAfter } from '../../src/core/fim/errors';
import { buildFimRequest, isSingleLineMode } from '../../src/core/fim/prompt';
import { SseDecoder } from '../../src/core/fim/sse';
import { DEFAULT_CONFIG, EMPTY_HEADER } from '../../src/core/types';

const enc = new TextEncoder();

describe('SseDecoder', () => {
  it('跨 chunk 半行、CRLF、保活注释、空行', () => {
    const d = new SseDecoder();
    const out: string[] = [];
    out.push(...d.push(enc.encode('data: {"a":1}\r\n\r\n: keep')));
    out.push(...d.push(enc.encode('alive\n\ndata: {"b"')));
    out.push(...d.push(enc.encode(':2}\n\ndata: [DONE]\n')));
    expect(out).toEqual(['{"a":1}', '{"b":2}', '[DONE]']);
  });

  it('多字节字符被分块截断时不乱码', () => {
    const bytes = enc.encode('data: {"t":"你好😀"}\n');
    const d = new SseDecoder();
    const out: string[] = [];
    for (let i = 0; i < bytes.length; i += 3) {
      out.push(...d.push(bytes.slice(i, i + 3)));
    }
    expect(out).toEqual(['{"t":"你好😀"}']);
  });

  it('flush 处理没有结尾换行的最后一行', () => {
    const d = new SseDecoder();
    expect(d.push(enc.encode('data: [DONE]'))).toEqual([]);
    expect(d.flush()).toEqual(['[DONE]']);
  });
});

function sseResponse(chunks: string[], init: ResponseInit = {}, delayMs = 0): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const c of chunks) {
        if (delayMs) {
          await new Promise((r) => setTimeout(r, delayMs));
        }
        controller.enqueue(enc.encode(c));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' }, ...init });
}

function data(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function client(fetchImpl: typeof fetch, key: string | null = 'sk-test') {
  return new DeepSeekFimClient({ endpoint: 'http://x/beta/completions', model: 'deepseek-flash', getApiKey: async () => key ?? undefined, fetchImpl });
}

const req = (over: Partial<Parameters<DeepSeekFimClient['complete']>[0]> = {}) => ({
  prompt: 'p',
  suffix: 's',
  maxTokens: 64,
  temperature: 0.2,
  maxLines: 12,
  signal: new AbortController().signal,
  ...over,
});

describe('DeepSeekFimClient', () => {
  it('请求体符合官方字段，流式累加文本并读取 usage', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const c = client(async (url, init) => {
      captured = { url: String(url), init: init as RequestInit };
      return sseResponse([
        data({ choices: [{ text: 'foo', index: 0, finish_reason: null }] }),
        data({ choices: [{ text: '(1)', index: 0, finish_reason: null }] }),
        data({ choices: [{ text: '', index: 0, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40 } }),
        'data: [DONE]\n\n',
      ]);
    });
    const r = await c.complete(req({ stop: ['\n'] }));
    expect(r.text).toBe('foo(1)');
    expect(r.finishReason).toBe('stop');
    expect(r.usage).toEqual({ prompt: 100, cacheHit: 60, cacheMiss: 40, completion: 5 });
    const body = JSON.parse(String(captured?.init.body));
    expect(body).toMatchObject({ model: 'deepseek-flash', prompt: 'p', suffix: 's', max_tokens: 64, temperature: 0.2, stream: true, stream_options: { include_usage: true }, stop: ['\n'] });
    expect((captured?.init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
  });

  it('suffix 为空串时传 null；没有 stop 时不带 stop', async () => {
    let body: Record<string, unknown> = {};
    const c = client(async (_u, init) => {
      body = JSON.parse(String((init as RequestInit).body));
      return sseResponse(['data: [DONE]\n\n']);
    });
    await c.complete(req({ suffix: '' }));
    expect(body.suffix).toBeNull();
    expect('stop' in body).toBe(false);
  });

  it('达到 maxLines 时客户端截断，usage 未知', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => data({ choices: [{ text: `l${i}\n`, finish_reason: null }] }));
    const c = client(async () => sseResponse(lines));
    const r = await c.complete(req({ maxLines: 3 }));
    expect(r.finishReason).toBe('client_cut');
    expect(r.text).toBe('l0\nl1\nl2');
    expect(r.usage).toBeUndefined();
  });

  it('中转忽略 stream 返回 JSON 时按非流式解析', async () => {
    const c = client(async () => new Response(JSON.stringify({ choices: [{ text: 'abc', finish_reason: 'length' }] }), { headers: { 'content-type': 'application/json' } }));
    const r = await c.complete(req());
    expect(r).toMatchObject({ text: 'abc', finishReason: 'length' });
  });

  it.each(['stop', 'length'] as const)('兼容代理省略 [DONE] 但返回 %s 完成原因', async (finishReason) => {
    const c = client(async () => sseResponse([
      data({ choices: [{ text: 'abc', finish_reason: finishReason }] }),
    ]));
    await expect(c.complete(req())).resolves.toMatchObject({ text: 'abc', finishReason });
  });

  it.each([
    { name: '空流', chunks: [] },
    { name: '未完成文本', chunks: [data({ choices: [{ text: 'compute(', finish_reason: null }] })] },
    { name: '未完成 JSON', chunks: [data({ choices: [{ text: 'compute(', finish_reason: null }] }), 'data: {"choices":'] },
  ])('无完成原因和 [DONE] 的 EOF 不返回半截结果：$name', async ({ chunks }) => {
    const c = client(async () => sseResponse(chunks));
    await expect(c.complete(req())).rejects.toMatchObject({ kind: 'transient' });
  });

  it('畸形 data 即使随后有 [DONE] 也不能当成完整补全', async () => {
    const c = client(async () => sseResponse([
      data({ choices: [{ text: 'compute(' }] }),
      'data: {broken}\n\n',
      'data: [DONE]\n\n',
    ]));
    await expect(c.complete(req())).rejects.toMatchObject({ kind: 'transient' });
  });

  it('流读取中途失败不返回已累计的半截结果', async () => {
    const c = client(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(data({ choices: [{ text: 'compute(' }] })));
      },
      pull(controller) {
        controller.error(new Error('connection closed'));
      },
    }), { headers: { 'content-type': 'text/event-stream' } }));
    await expect(c.complete(req())).rejects.toMatchObject({ kind: 'transient' });
  });

  it.each(['json', 'sse'] as const)('%s 的资源不足结束原因归类 transient，不返回半截结果', async (format) => {
    const chunk = { choices: [{ text: 'compute(', finish_reason: 'insufficient_system_resource' }] };
    const c = client(async () => format === 'json'
      ? new Response(JSON.stringify(chunk), { headers: { 'content-type': 'application/json' } })
      : sseResponse([data(chunk), 'data: [DONE]\n\n']));
    await expect(c.complete(req())).rejects.toMatchObject({ kind: 'transient' });
  });

  it('资源不足优先于同一个 chunk 的客户端行数截断', async () => {
    const c = client(async () => sseResponse([
      data({ choices: [{ text: 'first\nsecond\n', finish_reason: 'insufficient_system_resource' }] }),
      'data: [DONE]\n\n',
    ]));
    await expect(c.complete(req({ maxLines: 1 }))).rejects.toMatchObject({ kind: 'transient' });
  });

  it('HTTP 错误分类', async () => {
    for (const [status, kind] of [[401, 'auth'], [402, 'balance'], [400, 'config'], [404, 'config'], [422, 'config'], [429, 'rate'], [500, 'transient'], [503, 'transient']] as const) {
      const c = client(async () => new Response('{"error":"x"}', { status, headers: status === 429 ? { 'retry-after': '7' } : {} }));
      const err = await c.complete(req()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FimError);
      expect((err as FimError).kind).toBe(kind);
      if (status === 429) {
        expect((err as FimError).retryAfterMs).toBe(7000);
      }
    }
  });

  it('没有 Key → auth 错误，且不发请求', async () => {
    let called = false;
    const c = client(async () => {
      called = true;
      return sseResponse([]);
    }, null);
    await expect(c.complete(req())).rejects.toMatchObject({ kind: 'auth' });
    expect(called).toBe(false);
  });

  it('网络错误 → transient；外部中止 → AbortError', async () => {
    const c1 = client(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(c1.complete(req())).rejects.toMatchObject({ kind: 'transient' });

    const ac = new AbortController();
    const c2 = client((_u, init) => new Promise((_res, rej) => {
      (init as RequestInit).signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const p = c2.complete(req({ signal: ac.signal }));
    setTimeout(() => ac.abort(), 5);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('流读取中途被中止 → AbortError', async () => {
    const ac = new AbortController();
    const c = client(async (_u, init) => {
      const signal = (init as RequestInit).signal as AbortSignal;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(enc.encode(data({ choices: [{ text: 'a' }] })));
          signal.addEventListener('abort', () => controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        },
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    });
    const p = c.complete(req({ signal: ac.signal }));
    setTimeout(() => ac.abort(), 10);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('errors', () => {
  it('classifyStatus / parseRetryAfter', () => {
    expect(classifyStatus(418)).toBe('transient');
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT', Date.parse('Wed, 21 Oct 2015 07:27:50 GMT'))).toBe(10_000);
    expect(parseRetryAfter('abc')).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});

describe('prompt', () => {
  it('单行模式判定', () => {
    expect(isSingleLineMode('foo(bar);\nnext')).toBe(true);
    expect(isSingleLineMode(');\nnext')).toBe(false);
    expect(isSingleLineMode('  })  \nnext')).toBe(false);
    expect(isSingleLineMode('\nnext')).toBe(false);
    expect(isSingleLineMode('')).toBe(false);
    expect(isSingleLineMode(' x')).toBe(true);
  });

  it('请求组装：头部拼在 prefix 前；手动触发使用更大的输出上限；单行带 stop', () => {
    const sig = new AbortController().signal;
    const header = { text: '// h\n', deps: [] };
    const a = buildFimRequest({ prefix: 'P', suffix: 'rest' }, header, false, DEFAULT_CONFIG, sig);
    expect(a.prompt).toBe('// h\nP');
    expect(a.maxTokens).toBe(96);
    expect(a.stop).toEqual(['\n']);
    const b = buildFimRequest({ prefix: 'P', suffix: '\nrest' }, EMPTY_HEADER, true, DEFAULT_CONFIG, sig);
    expect(b.prompt).toBe('P');
    expect(b.maxTokens).toBe(192);
    expect(b.stop).toBeUndefined();
  });
});

describe('HealthState', () => {
  const err = (kind: FimError['kind'], retryAfterMs?: number) => new FimError(kind, kind, undefined, retryAfterMs);

  it('auth/config：自动触发被拒，手动放行；配置变更后恢复', () => {
    const h = new HealthState(() => 0);
    h.onError(err('auth'));
    expect(h.snapshot.status).toBe('configError');
    expect(h.canRequest(false)).toBe(false);
    expect(h.canRequest(true)).toBe(true);
    h.onConfigChanged();
    expect(h.canRequest(false)).toBe(true);
  });

  it('balance：5 分钟后允许再试', () => {
    let now = 0;
    const h = new HealthState(() => now);
    h.onError(err('balance'));
    expect(h.canRequest(false)).toBe(false);
    now = 5 * 60_000 + 1;
    expect(h.canRequest(false)).toBe(true);
  });

  it('429：5s 起翻倍，上限 60s，Retry-After 优先，成功清零；退避期自动与手动都拒绝', () => {
    let now = 0;
    const h = new HealthState(() => now);
    h.onError(err('rate'));
    expect(h.snapshot.until).toBe(5000);
    expect(h.canRequest(true)).toBe(false);
    now = 5000;
    expect(h.canRequest(false)).toBe(true);
    h.onError(err('rate'));
    expect(h.snapshot.until).toBe(5000 + 10_000);
    now = 20_000;
    h.canRequest(false);
    h.onError(err('rate', 2000));
    expect(h.snapshot.until).toBe(22_000);
    h.onSuccess();
    now = 100_000;
    h.onError(err('rate'));
    expect(h.snapshot.until).toBe(105_000);
    for (let i = 0; i < 6; i++) {
      now += 61_000;
      h.canRequest(false);
      h.onError(err('rate'));
    }
    expect((h.snapshot.until ?? 0) - now).toBeLessThanOrEqual(60_000);
  });

  it('transient：连续 3 次才退避 30s，成功清零', () => {
    let now = 0;
    const h = new HealthState(() => now);
    h.onError(err('transient'));
    h.onError(err('transient'));
    expect(h.canRequest(false)).toBe(true);
    h.onSuccess();
    h.onError(err('transient'));
    h.onError(err('transient'));
    expect(h.canRequest(false)).toBe(true);
    h.onError(err('transient'));
    expect(h.canRequest(false)).toBe(false);
    now = 30_000;
    expect(h.canRequest(false)).toBe(true);
  });

  it('状态变化通知监听器', () => {
    const h = new HealthState(() => 0);
    const seen: string[] = [];
    h.onChange((s) => seen.push(s.status));
    h.onError(err('auth'));
    h.onConfigChanged();
    expect(seen).toEqual(['configError', 'ok']);
  });
});
