import type { CancelToken } from './types';

/** 睡到指定时间点；token 取消时立即返回。 */
export function sleepUntil(at: number, token?: CancelToken): Promise<void> {
  const ms = at - Date.now();
  if (ms <= 0 || token?.isCancellationRequested) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let sub: { dispose(): void } | undefined;
    const timer = setTimeout(() => {
      sub?.dispose();
      resolve();
    }, ms);
    sub = token?.onCancellationRequested(() => {
      clearTimeout(timer);
      sub?.dispose();
      resolve();
    });
  });
}
