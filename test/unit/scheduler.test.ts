import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FimResult } from '../../src/core/fim/client';
import { abortError } from '../../src/core/fim/client';
import { Scheduler } from '../../src/core/scheduler';
import { TestToken } from './helpers';

const ok = (text: string): FimResult => ({ text, finishReason: 'stop', totalMs: 1 });

/** 可控的假请求：abort 后延迟 settleDelay 毫秒才落定 */
function fake(opts: { text?: string; settleDelay?: number; duration?: number } = {}) {
  const calls: { signal: AbortSignal; resolve: (r: FimResult) => void }[] = [];
  const exec = (signal: AbortSignal) =>
    new Promise<FimResult>((resolve, reject) => {
      const entry = { signal, resolve };
      calls.push(entry);
      if (opts.duration !== undefined) {
        setTimeout(() => resolve(ok(opts.text ?? 't')), opts.duration);
      }
      signal.addEventListener('abort', () => {
        setTimeout(() => reject(abortError()), opts.settleDelay ?? 0);
      });
    });
  return { exec, calls };
}

describe('Scheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('相同 key 合并：只发一次', async () => {
    const s = new Scheduler({ timeoutMs: () => 8000 });
    const f = fake({ duration: 100, text: 'x' });
    const p1 = s.run('k', f.exec, () => true);
    const p2 = s.run('k', f.exec, () => true);
    await vi.advanceTimersByTimeAsync(100);
    expect((await p1)?.text).toBe('x');
    expect((await p2)?.text).toBe('x');
    expect(f.calls).toHaveLength(1);
  });

  it('不同 key：中止旧请求，**落定之前不发送**新请求（评审：严格单在途）', async () => {
    const s = new Scheduler({ timeoutMs: () => 8000 });
    const f = fake({ settleDelay: 1000 });
    const old = s.run('a', f.exec, () => true);
    await vi.advanceTimersByTimeAsync(10);
    expect(f.calls).toHaveLength(1);

    const g = fake({ duration: 10, text: 'new' });
    const next = s.run('b', g.exec, () => true);
    await vi.advanceTimersByTimeAsync(500);
    expect(f.calls[0]?.signal.aborted).toBe(true);
    expect(g.calls).toHaveLength(0); // 旧请求还没落定，新请求不能发
    await vi.advanceTimersByTimeAsync(600);
    expect(g.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20);
    expect((await next)?.text).toBe('new');
    expect((await old)?.finishReason).toBe('aborted');
  });

  it('等待落定之后 isValid 为假：不发送', async () => {
    const s = new Scheduler({ timeoutMs: () => 8000 });
    const f = fake({ settleDelay: 100 });
    void s.run('a', f.exec, () => true);
    await vi.advanceTimersByTimeAsync(5);
    let valid = true;
    const g = fake({ duration: 1 });
    const next = s.run('b', g.exec, () => valid);
    valid = false;
    await vi.advanceTimersByTimeAsync(200);
    expect(await next).toBeUndefined();
    expect(g.calls).toHaveLength(0);
  });

  it('超时：到期中止并标记 timeout', async () => {
    const s = new Scheduler({ timeoutMs: () => 8000 });
    const f = fake();
    const p = s.run('a', f.exec, () => true);
    await vi.advanceTimersByTimeAsync(8001);
    expect((await p)?.finishReason).toBe('timeout');
  });

  it('所有等待方都取消后才中止；仍有等待方时不中止', async () => {
    const s = new Scheduler({ timeoutMs: () => 8000 });
    const f = fake({ duration: 1000 });
    const t1 = new TestToken();
    const t2 = new TestToken();
    void s.run('a', f.exec, () => true, t1);
    void s.run('a', f.exec, () => true, t2);
    await vi.advanceTimersByTimeAsync(10);
    t1.cancel();
    expect(f.calls[0]?.signal.aborted).toBe(false);
    t2.cancel();
    expect(f.calls[0]?.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
  });

  it('已在收尾的请求不能合并：等它落定再发', async () => {
    const s = new Scheduler({ timeoutMs: () => 8000 });
    const f = fake({ settleDelay: 300 });
    const t = new TestToken();
    void s.run('a', f.exec, () => true, t);
    await vi.advanceTimersByTimeAsync(5);
    t.cancel(); // 唯一等待方取消 → abort，收尾 300ms
    const g = fake({ duration: 1, text: 'again' });
    const again = s.run('a', g.exec, () => true);
    await vi.advanceTimersByTimeAsync(100);
    expect(g.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(300);
    expect(g.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5);
    expect((await again)?.text).toBe('again');
  });

  it('卡死检测：abort 后 2 秒仍未落定触发 onStuck，落定后记录耗时', async () => {
    const onStuck = vi.fn();
    const settled = vi.fn();
    const s = new Scheduler({ timeoutMs: () => 8000, onStuck, onAbortSettled: settled });
    const f = fake({ settleDelay: 2500 });
    const t = new TestToken();
    void s.run('a', f.exec, () => true, t);
    await vi.advanceTimersByTimeAsync(5);
    t.cancel();
    await vi.advanceTimersByTimeAsync(2100);
    expect(onStuck).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(2500);
  });

  it('非中止错误向上抛出，槽位随后释放', async () => {
    const s = new Scheduler({ timeoutMs: () => 8000 });
    const p = s.run('a', () => Promise.reject(new Error('boom')), () => true);
    await expect(p).rejects.toThrow('boom');
    await vi.advanceTimersByTimeAsync(1);
    expect(s.busy).toBe(false);
  });
});
