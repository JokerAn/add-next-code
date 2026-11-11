import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCollector, type CollectInput } from '../../src/core/collector';
import { DEFAULT_CONFIG } from '../../src/core/types';
import { src } from './helpers';

const input: CollectInput = {
  docKey: 'file:///a.vue',
  languageId: 'vue',
  fileLabel: 'a.vue',
  source: src('<script>\nconst value = 1\n</script>'),
  version: 1,
  line: 1,
  character: 10,
  windowStartLine: 0,
  windowText: 'const value = 1',
  cfg: DEFAULT_CONFIG,
};

describe('collector deadline', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('包信息始终不返回时，截止后仍返回基础上下文且不启动过期来源', async () => {
    const source = vi.fn(async () => ({ members: [{ kind: 'symbol', name: 'late' }] }));
    const collector = createCollector({
      vueMajor: () => new Promise(() => undefined),
      sources: [{ name: 'symbols', collect: source }],
    });
    const result = collector(input, Date.now() + 50);
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toMatchObject({ header: { text: '' }, status: { symbols: 'timeout' } });
    expect(source).not.toHaveBeenCalled();
  });

  it('包信息耗时和符号耗时共用一个截止时间', async () => {
    const collector = createCollector({
      vueMajor: () => new Promise((resolve) => setTimeout(() => resolve(3), 30)),
      sources: [{ name: 'symbols', collect: () => new Promise(() => undefined) }],
    });
    const result = collector(input, Date.now() + 50);
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toMatchObject({ framework: 'vue3', header: { text: '' }, status: { symbols: 'timeout' } });
  });

  it('包信息查询失败时继续使用剩余预算收集符号', async () => {
    const collector = createCollector({
      vueMajor: async () => { throw new Error('unavailable'); },
      sources: [{ name: 'symbols', collect: async () => ({ members: [{ kind: 'symbol', name: 'value' }] }) }],
    });
    const result = await collector(input, Date.now() + 50);
    expect(result.header.text).toContain('value');
    expect(result.status).toEqual({ symbols: 'ok' });
  });

  it('开始时已截止，不启动包信息或符号查询', async () => {
    const vueMajor = vi.fn(async () => 3);
    const source = vi.fn(async () => ({ members: [{ kind: 'symbol', name: 'value' }] }));
    const result = await createCollector({
      vueMajor, sources: [{ name: 'symbols', collect: source }],
    })(input, Date.now());
    expect(result.header.text).toBe('');
    expect(vueMajor).not.toHaveBeenCalled();
    expect(source).not.toHaveBeenCalled();
  });

  it('语言服务的 scope 成员与 Skimmer 同名的具体种类成员只保留具体种类', async () => {
    const collector = createCollector({
      vueMajor: async () => undefined,
      sources: [
        { name: 'symbols', collect: async () => ({ members: [
          { kind: 'scope', name: 'open' }, { kind: 'scope', name: 'toggle' }, { kind: 'scope', name: 'onlyLsp' },
        ] }) },
        { name: 'skimmer', collect: async () => ({ members: [
          { kind: 'state', name: 'open' }, { kind: 'handlers', name: 'toggle' },
        ] }) },
      ],
    });
    const result = await collector({ ...input, languageId: 'typescriptreact', source: src('const a = 1'), line: 0, character: 5 }, Date.now() + 50);
    const members = result.header.text.split('\n').find((line) => line.includes('members:')) ?? '';
    // 同名的 scope:open / scope:toggle 被具体种类取代，独有的 onlyLsp 仍然保留
    expect(members).toContain('state: open');
    expect(members).toContain('handlers: toggle');
    expect(members).toContain('scope: onlyLsp');
    expect(members).not.toMatch(/scope: [^;]*\b(open|toggle)\b/);
  });
});
