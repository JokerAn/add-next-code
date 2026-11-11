// 6.4 在途控制：本扩展持有的、尚未落定的模型请求至多一个。
// "落定"指请求 promise 已 resolve 或 reject；调用 abort() 不算落定。
import type { FimResult } from './fim/client';
import { isAbortError } from './fim/errors';
import type { CancelToken } from './types';

interface Inflight {
  key: string;
  controller: AbortController;
  result: Promise<FimResult>;
  settled: Promise<void>;
  waiters: number;
  timedOut: boolean;
}

export interface SchedulerOptions {
  /** 返回当前超时毫秒数（配置可变） */
  timeoutMs: () => number;
  /** abort 之后超过该毫秒数仍未落定，视为卡死 */
  stuckMs?: number;
  onStuck?: () => void;
  onAbortSettled?: (ms: number) => void;
}

export class Scheduler {
  private inflight: Inflight | undefined;

  constructor(private readonly opts: SchedulerOptions) {}

  get busy(): boolean {
    return this.inflight !== undefined;
  }

  /**
   * 发起或合并请求。
   * - 与在途请求 key 相同：合并，等同一个结果。
   * - 不同：中止旧请求，等它**落定**之后才发新请求；落定后先调用 isValid()，为假返回 undefined。
   */
  async run(
    key: string,
    exec: (signal: AbortSignal) => Promise<FimResult>,
    isValid: () => boolean,
    token?: CancelToken,
  ): Promise<FimResult | undefined> {
    for (;;) {
      const cur = this.inflight;
      if (!cur) {
        break;
      }
      if (cur.controller.signal.aborted) {
        // 正在收尾的请求不能合并：等它落定后重新判断
        await cur.settled;
        if (!isValid() || token?.isCancellationRequested) {
          return undefined;
        }
        continue;
      }
      if (cur.key === key) {
        return this.wait(cur, token);
      }
      this.abort(cur);
      await cur.settled;
      if (!isValid() || token?.isCancellationRequested) {
        return undefined;
      }
    }
    if (!isValid() || token?.isCancellationRequested) {
      return undefined;
    }

    const controller = new AbortController();
    const inflight: Inflight = {
      key,
      controller,
      result: undefined as unknown as Promise<FimResult>,
      settled: undefined as unknown as Promise<void>,
      waiters: 0,
      timedOut: false,
    };
    const timer = setTimeout(() => {
      inflight.timedOut = true;
      controller.abort();
    }, this.opts.timeoutMs());

    inflight.result = exec(controller.signal).catch((err: unknown): FimResult => {
      if (isAbortError(err) || controller.signal.aborted) {
        return { text: '', finishReason: inflight.timedOut ? 'timeout' : 'aborted', totalMs: 0 };
      }
      throw err;
    });
    inflight.settled = inflight.result.then(
      () => undefined,
      () => undefined,
    );
    this.inflight = inflight;
    void inflight.settled.then(() => {
      clearTimeout(timer);
      if (this.inflight === inflight) {
        this.inflight = undefined;
      }
    });
    return this.wait(inflight, token);
  }

  /** 全部中止（文档关闭、停用等） */
  abortAll(): void {
    if (this.inflight) {
      this.abort(this.inflight);
    }
  }

  private async wait(inflight: Inflight, token?: CancelToken): Promise<FimResult | undefined> {
    inflight.waiters++;
    let released = false;
    const release = () => {
      if (released) {
        return;
      }
      released = true;
      inflight.waiters--;
      if (inflight.waiters <= 0) {
        this.abort(inflight);
      }
    };
    const sub = token?.onCancellationRequested(release);
    if (token?.isCancellationRequested) {
      release();
    }
    try {
      return await inflight.result;
    } finally {
      sub?.dispose();
      if (!released) {
        released = true;
        inflight.waiters--;
      }
    }
  }

  private abort(inflight: Inflight): void {
    if (inflight.controller.signal.aborted) {
      return;
    }
    const at = Date.now();
    inflight.controller.abort();
    const stuckMs = this.opts.stuckMs ?? 2000;
    const stuckTimer = setTimeout(() => this.opts.onStuck?.(), stuckMs);
    void inflight.settled.then(() => {
      clearTimeout(stuckTimer);
      this.opts.onAbortSettled?.(Date.now() - at);
    });
  }
}
