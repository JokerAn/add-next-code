import { describe, expect, it } from 'vitest';
import { createCollector } from '../../src/core/collector';
import { DEFAULT_CONFIG } from '../../src/core/types';
import { src } from './helpers';

const iface = [{ kind: 'props', name: 'value' }, { kind: 'props', name: 'skuData' }];
const collect = (related: Array<{ name: string; file: string; interface: typeof iface; kind?: 'component' }>) =>
  createCollector({
    sources: [{ name: 'skimmer', collect: async () => ({ related }) }], vueMajor: async () => 2,
  })({
    docKey: 'file:///a.vue', languageId: 'vue', fileLabel: 'a.vue', source: src('<script>\n</script>'), version: 1,
    line: 0, character: 0, windowStartLine: 0, windowText: '', cfg: DEFAULT_CONFIG,
  }, Date.now() + 100);

describe('关联接口去重', () => {
  it('同一文件、同一接口以标签名和导入名各列一次：只留第一个', async () => {
    const out = await collect([
      { name: 'skulist-pop', file: 'components/skulist-pop.vue', interface: iface, kind: 'component' },
      { name: 'SkulistPop', file: 'components/skulist-pop.vue', interface: iface, kind: 'component' },
    ]);
    expect(out.header.text.match(/skulist-pop\.vue/g)).toHaveLength(1);
    expect(out.header.text).toContain('<skulist-pop> components/skulist-pop.vue');
    expect(out.header.text).not.toContain('<SkulistPop>');
  });

  it('文件相同但接口不同、或接口相同但文件不同：都保留', async () => {
    const out = await collect([
      { name: 'A', file: 'a.vue', interface: iface },
      { name: 'B', file: 'a.vue', interface: [{ kind: 'props', name: 'other' }] },
      { name: 'C', file: 'c.vue', interface: iface },
    ]);
    expect(out.header.text).toContain('<A>');
    expect(out.header.text).toContain('<B>');
    expect(out.header.text).toContain('<C>');
  });
});
