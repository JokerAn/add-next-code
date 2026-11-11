// 12. 指标：每次调用一行 JSON（不含源码与 Key）+ 会话统计。
import type { FimUsage } from './fim/client';
import type { Framework, Region, TriggerKind } from './types';

export type Outcome =
  | 'shown'
  | 'empty'
  | 'cancelled'
  | 'stale'
  | 'timeout'
  | 'backoff'
  | 'skipped'
  | `error:${string}`;

export type CacheState = 'miss' | 'hit' | 'remainder';

export interface CallRecord {
  seq: number;
  trigger: TriggerKind;
  lang: string;
  framework?: Framework;
  region?: Region;
  sci: boolean;
  prefixChars: number;
  suffixChars: number;
  headerChars: number;
  cache: CacheState;
  tWait?: number;
  tContext?: number;
  tFirstByte?: number;
  tTotal?: number;
  /** 从 Provider 被调用到返回的总耗时 */
  tEnd2End?: number;
  outcome: Outcome;
  finish?: string;
  usage?: FimUsage;
  skimmer?: string;
  sym?: string;
  /** 本次是否真正发出了模型请求 */
  requested: boolean;
}

export function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export class Metrics {
  private readonly records: CallRecord[] = [];
  private readonly max: number;
  abortSettleMs: number[] = [];
  stuck = 0;

  constructor(max = 2000) {
    this.max = max;
  }

  record(r: CallRecord): string {
    this.records.push(r);
    if (this.records.length > this.max) {
      this.records.shift();
    }
    return JSON.stringify(r);
  }

  get count(): number {
    return this.records.length;
  }

  summary(): string {
    const rs = this.records;
    const auto = rs.filter((r) => r.trigger === 'auto').length;
    const manual = rs.length - auto;
    const hit = rs.filter((r) => r.cache === 'hit').length;
    const rem = rs.filter((r) => r.cache === 'remainder').length;
    const requested = rs.filter((r) => r.requested);
    const shown = rs.filter((r) => r.outcome === 'shown').length;
    const byOutcome = new Map<string, number>();
    for (const r of rs) {
      byOutcome.set(r.outcome, (byOutcome.get(r.outcome) ?? 0) + 1);
    }
    let promptHit = 0;
    let promptMiss = 0;
    let completion = 0;
    let unknownUsage = 0;
    for (const r of requested) {
      if (r.usage) {
        promptHit += r.usage.cacheHit;
        promptMiss += r.usage.cacheMiss;
        completion += r.usage.completion;
      } else {
        unknownUsage++;
      }
    }
    const e2e = rs.filter((r) => r.outcome === 'shown' && r.tEnd2End !== undefined).map((r) => r.tEnd2End as number);
    const fb = requested.filter((r) => r.tFirstByte !== undefined).map((r) => r.tFirstByte as number);
    const tot = requested.filter((r) => r.tTotal !== undefined).map((r) => r.tTotal as number);
    const ctx = rs.filter((r) => r.tContext !== undefined).map((r) => r.tContext as number);
    const fmt = (v: number | undefined) => (v === undefined ? '-' : `${Math.round(v)}ms`);
    const lines = [
      `调用：${rs.length}（自动 ${auto} / 手动 ${manual}）`,
      `来源：缓存命中 ${hit}，续显 ${rem}，模型请求 ${requested.length}`,
      `展示：${shown}`,
      `结果分布：${[...byOutcome.entries()].map(([k, v]) => `${k}=${v}`).join('，') || '-'}`,
      `Token（usage 已知部分）：输入命中 ${promptHit} / 未命中 ${promptMiss}，输出 ${completion}；usage 未知的请求 ${unknownUsage} 个`,
      `上下文耗时 p50/p95：${fmt(percentile(ctx, 50))} / ${fmt(percentile(ctx, 95))}`,
      `首字节 p50/p95：${fmt(percentile(fb, 50))} / ${fmt(percentile(fb, 95))}`,
      `请求总耗时 p50/p95：${fmt(percentile(tot, 50))} / ${fmt(percentile(tot, 95))}`,
      `停笔到展示 p50/p95：${fmt(percentile(e2e, 50))} / ${fmt(percentile(e2e, 95))}`,
      `取消后落定耗时 p95：${fmt(percentile(this.abortSettleMs, 95))}；卡死 ${this.stuck} 次`,
    ];
    return lines.join('\n');
  }
}
