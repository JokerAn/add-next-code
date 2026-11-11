import { describe, expect, it } from 'vitest';
import { HealthState } from '../../src/core/backoff';
import { createCollector } from '../../src/core/collector';
import { FimError } from '../../src/core/fim/errors';
import { checkGuards, languageEnabled, type GuardInput } from '../../src/core/guards';
import { Metrics, percentile } from '../../src/core/metrics';
import { extractMembers, type SymbolNode } from '../../src/core/symbols';
import { DEFAULT_CONFIG } from '../../src/core/types';
import { src } from './helpers';

function ok(over: Partial<GuardInput> = {}): GuardInput {
  return {
    cfg: DEFAULT_CONFIG,
    runtimeEnabled: true,
    languageId: 'vue',
    scheme: 'file',
    permitted: true,
    hasKey: true,
    isActiveEditorDoc: true,
    selectionCount: 1,
    selectionEmpty: true,
    cursorAtPosition: true,
    trigger: 'auto',
    hasSelectedCompletion: false,
    health: new HealthState(),
    ...over,
  };
}

describe('checkGuards', () => {
  it('全部满足 → 通过', () => {
    expect(checkGuards(ok())).toBeUndefined();
  });
  it('1 全局/语言开关', () => {
    expect(checkGuards(ok({ runtimeEnabled: false }))).toBe('disabled');
    expect(checkGuards(ok({ cfg: { ...DEFAULT_CONFIG, enabled: false } }))).toBe('disabled');
    expect(checkGuards(ok({ languageId: 'markdown' }))).toBe('disabled');
    expect(languageEnabled(DEFAULT_CONFIG, 'vue')).toBe(true);
  });
  it('2 scheme', () => {
    expect(checkGuards(ok({ scheme: 'git' }))).toBe('scheme');
    expect(checkGuards(ok({ scheme: 'untitled' }))).toBeUndefined();
    expect(checkGuards(ok({ scheme: 'vscode-remote' }))).toBeUndefined();
  });
  it('3 发送许可：未得出结果按不许可（评审 P1）', () => {
    expect(checkGuards(ok({ permitted: false }))).toBe('not-permitted');
    expect(checkGuards(ok({ permitted: undefined }))).toBe('not-permitted');
  });
  it('4 缺 Key', () => {
    expect(checkGuards(ok({ hasKey: false }))).toBe('no-key');
  });
  it('5 活动编辑器 / 单光标 / 空选择区 / 光标位置', () => {
    expect(checkGuards(ok({ isActiveEditorDoc: false }))).toBe('editor-mismatch');
    expect(checkGuards(ok({ cursorAtPosition: false }))).toBe('editor-mismatch');
    expect(checkGuards(ok({ selectionCount: 2 }))).toBe('multi-cursor');
    expect(checkGuards(ok({ selectionEmpty: false }))).toBe('selection');
  });
  it('6 manual 模式拒绝自动触发，手动放行', () => {
    const cfg = { ...DEFAULT_CONFIG, triggerMode: 'manual' as const };
    expect(checkGuards(ok({ cfg }))).toBe('manual-only');
    expect(checkGuards(ok({ cfg, trigger: 'manual' }))).toBeUndefined();
  });
  it('7 配置错误拒绝自动、放行手动；退避自动与手动都拒绝', () => {
    const h = new HealthState();
    h.onError(new FimError('auth', 'x'));
    expect(checkGuards(ok({ health: h }))).toBe('health');
    expect(checkGuards(ok({ health: h, trigger: 'manual' }))).toBeUndefined();
    const b = new HealthState();
    b.onError(new FimError('rate', 'x'));
    expect(checkGuards(ok({ health: b, trigger: 'manual' }))).toBe('health');
  });
  it('8 补全菜单：skip 拒绝，extend 放行', () => {
    expect(checkGuards(ok({ hasSelectedCompletion: true, cfg: { ...DEFAULT_CONFIG, suggestWidget: 'skip' } }))).toBe('sci-skip');
    expect(checkGuards(ok({ hasSelectedCompletion: true }))).toBeUndefined();
  });
});

const node = (name: string, s: number, e: number, children: SymbolNode[] = []): SymbolNode => ({ name, startLine: s, endLine: e, children });

describe('extractMembers', () => {
  const vue2Tree = [
    node('default', 0, 50, [
      node('props', 1, 5, [node('id', 2, 2), node('visible', 3, 3)]),
      node('data', 6, 10, [node('loading', 7, 7)]),
      node('methods', 11, 40, [node('fetchList()', 12, 20), node('onSearch', 21, 30)]),
      node('name', 41, 41),
    ]),
  ];
  it('vue2：取 props/data/computed/methods/watch 的子项名称，不含行号', () => {
    const m = extractMembers(vue2Tree, 'vue2', 15);
    expect(m).toEqual([
      { kind: 'props', name: 'id' },
      { kind: 'props', name: 'visible' },
      { kind: 'data', name: 'loading' },
      { kind: 'methods', name: 'fetchList' },
      { kind: 'methods', name: 'onSearch' },
    ]);
    expect(JSON.stringify(m)).not.toMatch(/Line|line/);
  });
  it('vue2：符号树没有这些区段 → 空（降级为只有窗口）', () => {
    expect(extractMembers([node('x', 0, 1)], 'vue2', 0)).toEqual([]);
  });
  it('通用兜底：符号链与同级符号', () => {
    const tree = [node('A', 0, 10, [node('inner', 2, 6, [node('deep', 3, 4)])]), node('B', 12, 20)];
    const names = extractMembers(tree, 'node', 3).map((m) => m.name);
    expect(names).toEqual(expect.arrayContaining(['A', 'B', 'inner', 'deep']));
  });
  it('去重并限量', () => {
    const many = [node('default', 0, 99, [node('methods', 1, 98, Array.from({ length: 200 }, (_, i) => node(`m${i}`, i, i)))])];
    expect(extractMembers(many, 'vue2', 5).length).toBe(80);
  });
});

describe('createCollector', () => {
  it('并行收集；来源失败/超时只影响本次头部；超时来源状态标记', async () => {
    const collect = createCollector({
      sources: [
        { name: 'symbols', collect: async () => ({ members: [{ kind: 'methods', name: 'go' }] }) },
        { name: 'skimmer', collect: () => new Promise(() => undefined) },
        { name: 'broken', collect: async () => { throw new Error('x'); } },
      ],
      vueMajor: async () => 2,
    });
    const out = await collect(
      { docKey: 'k', languageId: 'vue', fileLabel: 'a.vue', source: src('<template>\n<div/>\n</template>\n<script>\nexport default {}\n</script>'), version: 1, line: 1, character: 0, windowStartLine: 0, windowText: '', cfg: DEFAULT_CONFIG },
      Date.now() + 30,
    );
    expect(out.status).toMatchObject({ symbols: 'ok', skimmer: 'timeout', broken: 'empty' });
    expect(out.framework).toBe('vue2');
    expect(out.region).toBe('template');
    expect(out.header.text.startsWith('<!--')).toBe(true); // 窗口起点在模板区 → HTML 注释
  });

  it('没有任何结果 → 空头部', async () => {
    const collect = createCollector({ sources: [], vueMajor: async () => undefined });
    const out = await collect({ docKey: 'k', languageId: 'typescript', fileLabel: 'a.ts', source: src('x'), version: 1, line: 0, character: 0, windowStartLine: 0, windowText: '', cfg: DEFAULT_CONFIG }, Date.now() + 10);
    expect(out.header.text).toBe('');
    expect(out.framework).toBe('node');
  });
});

describe('Metrics', () => {
  it('percentile', () => {
    expect(percentile([], 50)).toBeUndefined();
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
  });
  it('摘要统计：usage 未知单列，不做估算合并', () => {
    const m = new Metrics();
    const base = { seq: 0, trigger: 'auto' as const, lang: 'vue', sci: false, prefixChars: 1, suffixChars: 1, headerChars: 0 };
    m.record({ ...base, seq: 1, cache: 'miss', outcome: 'shown', requested: true, usage: { prompt: 100, cacheHit: 60, cacheMiss: 40, completion: 7 }, tEnd2End: 2000, tTotal: 900, tFirstByte: 300 });
    m.record({ ...base, seq: 2, cache: 'miss', outcome: 'cancelled', requested: true });
    m.record({ ...base, seq: 3, cache: 'remainder', outcome: 'shown', requested: false, tEnd2End: 5 });
    const s = m.summary();
    expect(s).toContain('调用：3');
    expect(s).toContain('续显 1');
    expect(s).toContain('模型请求 2');
    expect(s).toContain('输入命中 60 / 未命中 40，输出 7');
    expect(s).toContain('usage 未知的请求 1 个');
  });
});
