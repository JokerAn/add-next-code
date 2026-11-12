// 6.5 FIM 客户端：接口 + DeepSeek 原生协议实现（POST {endpoint}，prompt + suffix，SSE）。
import { FimError, httpError, isAbortError } from './errors';
import { SseDecoder } from './sse';

export interface FimRequest {
  prompt: string;
  suffix: string;
  maxTokens: number;
  temperature: number;
  stop?: string[];
  maxLines: number;
  /** 对累计文本的额外截断规则：返回截断后的文本即中止流，返回 undefined 表示继续。 */
  cut?(text: string): string | undefined;
  signal: AbortSignal;
}

export type FinishReason = 'stop' | 'length' | 'client_cut' | 'aborted' | 'timeout' | 'other';

export interface FimUsage {
  prompt: number;
  cacheHit: number;
  cacheMiss: number;
  completion: number;
}

export interface FimResult {
  text: string;
  finishReason: FinishReason;
  usage?: FimUsage;
  firstByteMs?: number;
  /** 第一段非空文本到达的时间 */
  firstTokenMs?: number;
  /** 带 finish_reason 的数据块到达的时间；与 totalMs 的差就是等待流关闭的时间 */
  finishMs?: number;
  totalMs: number;
}

export interface FimClient {
  complete(req: FimRequest): Promise<FimResult>;
}

export interface DeepSeekOptions {
  endpoint: string;
  model: string;
  getApiKey: () => Promise<string | undefined>;
  fetchImpl?: typeof fetch;
}

interface DeepSeekChoice {
  text?: string;
  finish_reason?: string | null;
}
interface DeepSeekChunk {
  choices?: DeepSeekChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  } | null;
}

function toUsage(u: DeepSeekChunk['usage']): FimUsage | undefined {
  if (!u) {
    return undefined;
  }
  return {
    prompt: u.prompt_tokens ?? 0,
    cacheHit: u.prompt_cache_hit_tokens ?? 0,
    cacheMiss: u.prompt_cache_miss_tokens ?? 0,
    completion: u.completion_tokens ?? 0,
  };
}

function mapFinish(reason: string | null | undefined): FinishReason {
  if (reason === 'insufficient_system_resource') {
    throw new FimError('transient', '服务端推理资源不足，请求已中断');
  }
  if (reason === 'stop') {
    return 'stop';
  }
  if (reason === 'length') {
    return 'length';
  }
  if (reason === 'aborted') {
    return 'aborted';
  }
  return 'other';
}

/** 累计文本的换行数达到 maxLines 时截到第 maxLines 行末尾；返回 undefined 表示尚未超限。 */
function cutToLines(text: string, maxLines: number): string | undefined {
  let nl = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      nl++;
      if (nl >= maxLines) {
        return text.slice(0, i);
      }
    }
  }
  return undefined;
}

export class DeepSeekFimClient implements FimClient {
  constructor(private readonly opts: DeepSeekOptions) {}

  async complete(req: FimRequest): Promise<FimResult> {
    const started = Date.now();
    const key = await this.opts.getApiKey();
    if (!key) {
      throw new FimError('auth', '未设置 API Key');
    }
    const doFetch = this.opts.fetchImpl ?? fetch;

    // 内部控制器：外部 signal 或客户端截断都能中止同一个请求
    const inner = new AbortController();
    const onAbort = () => inner.abort();
    if (req.signal.aborted) {
      inner.abort();
    } else {
      req.signal.addEventListener('abort', onAbort, { once: true });
    }

    const body: Record<string, unknown> = {
      model: this.opts.model,
      prompt: req.prompt,
      suffix: req.suffix === '' ? null : req.suffix,
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (req.stop && req.stop.length > 0) {
      body.stop = req.stop;
    }

    try {
      let res: Response;
      try {
        res = await doFetch(this.opts.endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
          },
          body: JSON.stringify(body),
          signal: inner.signal,
        });
      } catch (err) {
        if (isAbortError(err) || inner.signal.aborted) {
          throw abortError();
        }
        throw new FimError('transient', `网络错误: ${(err as Error).message}`);
      }

      if (!res.ok) {
        let text = '';
        try {
          text = await res.text();
        } catch {
          // 读不到响应体不影响分类
        }
        throw httpError(res.status, text, res.headers.get('retry-after'));
      }

      const contentType = res.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        return await this.readJson(res, started);
      }
      return await this.readStream(res, req, inner, started);
    } finally {
      req.signal.removeEventListener('abort', onAbort);
    }
  }

  private async readJson(res: Response, started: number): Promise<FimResult> {
    let data: DeepSeekChunk;
    try {
      data = (await res.json()) as DeepSeekChunk;
    } catch (err) {
      if (isAbortError(err)) {
        throw abortError();
      }
      throw new FimError('transient', '响应不是有效 JSON');
    }
    const choice = data.choices?.[0];
    const now = Date.now();
    return {
      text: choice?.text ?? '',
      finishReason: mapFinish(choice?.finish_reason),
      usage: toUsage(data.usage),
      firstByteMs: now - started,
      totalMs: now - started,
    };
  }

  private async readStream(
    res: Response,
    req: FimRequest,
    inner: AbortController,
    started: number,
  ): Promise<FimResult> {
    if (!res.body) {
      throw new FimError('transient', '响应没有正文');
    }
    const reader = res.body.getReader();
    const sse = new SseDecoder();
    let text = '';
    let finish: FinishReason = 'other';
    let usage: FimUsage | undefined;
    let firstByteMs: number | undefined;
    let firstTokenMs: number | undefined;
    let finishMs: number | undefined;
    let done = false;
    let cut = false;

    const handle = (payloads: string[]): void => {
      for (const p of payloads) {
        if (p.trim() === '[DONE]') {
          done = true;
          return;
        }
        let chunk: DeepSeekChunk;
        try {
          chunk = JSON.parse(p) as DeepSeekChunk;
        } catch {
          throw new FimError('transient', '流响应包含无效 JSON');
        }
        const choice = chunk.choices?.[0];
        if (choice?.finish_reason) {
          finish = mapFinish(choice.finish_reason);
          finishMs ??= Date.now() - started;
        }
        if (choice?.text) {
          firstTokenMs ??= Date.now() - started;
          text += choice.text;
          const clipped = req.cut?.(text) ?? cutToLines(text, req.maxLines);
          if (clipped !== undefined) {
            text = clipped;
            cut = true;
            done = true;
            return;
          }
        }
        const u = toUsage(chunk.usage);
        if (u) {
          usage = u;
        }
      }
    };

    try {
      while (!done) {
        const { value, done: eof } = await reader.read();
        if (firstByteMs === undefined) {
          firstByteMs = Date.now() - started;
        }
        if (eof) {
          handle(sse.flush());
          // 兼容省略 [DONE] 的代理，但必须保留有效的完成原因。
          if (!done && finish === 'other') {
            throw new FimError('transient', '流响应在完成前结束');
          }
          break;
        }
        if (value) {
          handle(sse.push(value));
        }
      }
    } catch (err) {
      if (isAbortError(err) || inner.signal.aborted) {
        throw abortError();
      }
      throw new FimError('transient', `读取流失败: ${(err as Error).message}`);
    } finally {
      if (cut || !done) {
        inner.abort();
      }
      reader.cancel().catch(() => undefined);
    }

    return {
      text,
      finishReason: cut ? 'client_cut' : finish,
      // 客户端截断时 usage 未知
      usage: cut ? undefined : usage,
      firstByteMs,
      firstTokenMs,
      finishMs,
      totalMs: Date.now() - started,
    };
  }
}

export function abortError(): Error {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}
