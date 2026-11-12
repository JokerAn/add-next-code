import { describe, expect, it } from 'vitest';
import { Metrics, type CallRecord, type SkimmerQueryRecord } from '../../src/core/metrics';

function record(outcome: SkimmerQueryRecord['outcome'], elapsedMs: number, extra: Partial<SkimmerQueryRecord> = {}): SkimmerQueryRecord {
  return { outcome, elapsedMs, dropped: { dirty: 0, stale: 0, budget: 0 }, ...extra };
}

describe('Skimmer 会话统计', () => {
  it('没有实际查询时不把启动或基础补全计为查询，耗时保持未知', () => {
    const metrics = new Metrics();
    metrics.record({
      seq: 1, trigger: 'auto', lang: 'vue', sci: false, prefixChars: 1, suffixChars: 0, headerChars: 0,
      cache: 'miss', outcome: 'shown', requested: true, skimmer: 'starting',
    });
    expect(metrics.summary()).toContain('Skimmer 查询（最近 2000 条）：0');
    expect(metrics.summary()).toContain('平均 -，p50/p95 - / -');
  });

  it('区分本地查询耗时与服务端耗时，统计超时和各类丢弃', () => {
    const metrics = new Metrics();
    metrics.recordSkimmer(record('ok', 20, { serverElapsedMs: 10, dropped: { dirty: 2, stale: 1, budget: 0 } }));
    metrics.recordSkimmer(record('ok', 60, { serverElapsedMs: 30, dropped: { dirty: 0, stale: 1, budget: 3 } }));
    metrics.recordSkimmer(record('timeout', 500));
    metrics.recordSkimmer(record('error', 10));
    metrics.recordSkimmer(record('cancelled', 10));
    const summary = metrics.summary();
    expect(summary).toContain('5；成功 2 / 超时 1 / 失败 1 / 取消 1');
    expect(summary).toContain('Skimmer 客户端耗时：平均 120ms，p50/p95 20ms / 500ms');
    expect(summary).toContain('Skimmer 服务端耗时 p50/p95（2 条响应）：10ms / 30ms');
    expect(summary).toContain('dirty=2，stale=2，budget=3');
  });

  it('统计窗口有界，淘汰后查询数、耗时与丢弃计数使用同一批记录', () => {
    const metrics = new Metrics(2);
    metrics.recordSkimmer(record('timeout', 500, { dropped: { dirty: 99, stale: 99, budget: 99 } }));
    metrics.recordSkimmer(record('ok', 10, { serverElapsedMs: 5 }));
    metrics.recordSkimmer(record('ok', 30, { serverElapsedMs: 15, dropped: { dirty: 1, stale: 0, budget: 0 } }));
    const summary = metrics.summary();
    expect(summary).toContain('Skimmer 查询（最近 2 条）：2；成功 2 / 超时 0');
    expect(summary).toContain('平均 20ms，p50/p95 10ms / 30ms');
    expect(summary).toContain('dirty=1，stale=0，budget=0');
  });

  it('传输成功、摘要状态和内容数量独立统计，缺少字段不冒充无内容', () => {
    const metrics = new Metrics();
    metrics.recordSkimmer(record('ok', 10, { overlay: 'ready', index: 'ready', selfMembers: 2, relatedItems: 1 }));
    metrics.recordSkimmer(record('ok', 20, { overlay: 'stale', index: 'indexing', selfMembers: 1, relatedItems: 0 }));
    metrics.recordSkimmer(record('ok', 30, { overlay: 'failed', index: 'empty', selfMembers: 0, relatedItems: 0 }));
    metrics.recordSkimmer(record('ok', 40, { overlay: 'failed', index: 'locked', selfMembers: 1, relatedItems: 0 }));
    metrics.recordSkimmer(record('ok', 50));
    metrics.recordSkimmer(record('timeout', 500));
    const summary = metrics.summary();
    expect(summary).toContain('6；成功 5 / 超时 1');
    expect(summary).toContain('摘要状态（5 条成功响应）：ready=1 / stale=1 / failed=2 / 未知=1');
    expect(summary).toContain('索引状态：ready=1 / indexing=1 / empty=1 / locked=1 / 未知=1');
    expect(summary).toContain('响应内容（扩展过滤前）：有内容 3 / 无内容 1 / 未知 1；成员 4，关联项 1');
  });

  it('摘要与内容计数遵循同一个有界查询窗口', () => {
    const metrics = new Metrics(2);
    metrics.recordSkimmer(record('ok', 10, { overlay: 'ready', selfMembers: 100, relatedItems: 8 }));
    metrics.recordSkimmer(record('ok', 20, { overlay: 'failed', selfMembers: 0, relatedItems: 0 }));
    metrics.recordSkimmer(record('ok', 30, { overlay: 'stale', selfMembers: 1, relatedItems: 0 }));
    const summary = metrics.summary();
    expect(summary).toContain('摘要状态（2 条成功响应）：ready=0 / stale=1 / failed=1 / 未知=0');
    expect(summary).toContain('有内容 1 / 无内容 1 / 未知 0；成员 1，关联项 0');
  });

  it('Provider 返回耗时分开自动、手动、缓存和续显，排除取消与空结果', () => {
    const metrics = new Metrics();
    const base: CallRecord = {
      seq: 1, trigger: 'auto', lang: 'vue', sci: false, prefixChars: 1, suffixChars: 0, headerChars: 0,
      cache: 'miss', outcome: 'shown', requested: true, tEnd2End: 1000,
    };
    [
      base,
      { ...base, seq: 2, tEnd2End: 3000 },
      { ...base, seq: 3, trigger: 'manual' as const, tEnd2End: 500 },
      { ...base, seq: 4, cache: 'hit' as const, requested: false, tEnd2End: 3 },
      { ...base, seq: 5, cache: 'remainder' as const, requested: false, tEnd2End: 0 },
      { ...base, seq: 6, outcome: 'cancelled' as const, tEnd2End: 8000 },
      { ...base, seq: 7, outcome: 'empty' as const, tEnd2End: 10000 },
    ].forEach((item) => metrics.record(item));
    const summary = metrics.summary();
    expect(summary).toContain('Provider 调用到返回 p50/p95（自动非缓存，2 次）：1000ms / 3000ms');
    expect(summary).toContain('Provider 调用到返回 p50/p95（手动非缓存，1 次）：500ms / 500ms');
    expect(summary).toContain('Provider 调用到返回 p50/p95（缓存命中，1 次）：3ms / 3ms');
    expect(summary).toContain('Provider 调用到返回 p50/p95（续显，1 次）：0ms / 0ms');
    expect(summary).not.toContain('停笔到展示');
  });
});
