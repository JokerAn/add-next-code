// 6.5 错误分类后的健康状态与退避。
import { FimError } from './fim/errors';

export type HealthStatus = 'ok' | 'backoff' | 'configError';

export interface HealthSnapshot {
  status: HealthStatus;
  /** 人类可读原因（配置错误/退避时） */
  reason?: string;
  /** 配置错误的细分：auth / balance / config */
  errorKind?: string;
  until?: number;
}

export type HealthListener = (s: HealthSnapshot) => void;

const BALANCE_RETRY_MS = 5 * 60_000;
const RATE_BASE_MS = 5_000;
const RATE_MAX_MS = 60_000;
const TRANSIENT_STREAK = 3;
const TRANSIENT_BACKOFF_MS = 30_000;

export class HealthState {
  private state: HealthSnapshot = { status: 'ok' };
  private rateStep = 0;
  private transientStreak = 0;
  private listeners = new Set<HealthListener>();

  constructor(private readonly now: () => number = Date.now) {}

  get snapshot(): HealthSnapshot {
    this.expire();
    return this.state;
  }

  onChange(listener: HealthListener): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /**
   * 是否允许发起请求。
   * 配置错误：拒绝自动触发，手动触发放行（用户可能刚改完配置想试一下）。
   * 退避期：自动与手动都拒绝。
   */
  canRequest(manual: boolean): boolean {
    this.expire();
    if (this.state.status === 'backoff') {
      return false;
    }
    if (this.state.status === 'configError') {
      return manual;
    }
    return true;
  }

  onSuccess(): void {
    this.rateStep = 0;
    this.transientStreak = 0;
    this.set({ status: 'ok' });
  }

  onError(err: FimError): void {
    const now = this.now();
    switch (err.kind) {
      case 'auth':
        this.set({ status: 'configError', errorKind: 'auth', reason: err.message });
        break;
      case 'balance':
        this.set({ status: 'configError', errorKind: 'balance', reason: err.message, until: now + BALANCE_RETRY_MS });
        break;
      case 'config':
        this.set({ status: 'configError', errorKind: 'config', reason: err.message });
        break;
      case 'rate': {
        const exp = Math.min(RATE_MAX_MS, RATE_BASE_MS * 2 ** this.rateStep);
        this.rateStep++;
        const wait = err.retryAfterMs !== undefined ? Math.min(err.retryAfterMs, 10 * 60_000) : exp;
        this.set({ status: 'backoff', errorKind: 'rate', reason: '请求过于频繁', until: now + wait });
        break;
      }
      case 'transient':
        this.transientStreak++;
        if (this.transientStreak >= TRANSIENT_STREAK) {
          this.transientStreak = 0;
          this.set({ status: 'backoff', errorKind: 'transient', reason: '连续请求失败', until: now + TRANSIENT_BACKOFF_MS });
        }
        break;
    }
  }

  /** 卡死信号（取消后迟迟不落定）：进入短退避。 */
  onStuck(): void {
    this.set({ status: 'backoff', errorKind: 'stuck', reason: '取消后请求迟迟未结束', until: this.now() + TRANSIENT_BACKOFF_MS });
  }

  /** Key 或配置变更后调用：清除配置错误。 */
  onConfigChanged(): void {
    this.rateStep = 0;
    this.transientStreak = 0;
    this.set({ status: 'ok' });
  }

  private expire(): void {
    const until = this.state.until;
    if (until !== undefined && this.now() >= until) {
      // 到期：清除状态，允许再试一次（再失败会重新进入）
      this.set({ status: 'ok' });
    }
  }

  private set(next: HealthSnapshot): void {
    const prev = this.state;
    this.state = next;
    if (prev.status !== next.status || prev.errorKind !== next.errorKind) {
      for (const l of this.listeners) {
        l(next);
      }
    }
  }
}
