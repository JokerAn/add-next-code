import { describe, expect, it } from 'vitest';
import { createCollector, type SourceContext } from '../../src/core/collector';
import { findSfcBlocks } from '../../src/core/sfc';
import { extractMembers, type SymbolNode } from '../../src/core/symbols';
import { DEFAULT_CONFIG } from '../../src/core/types';
import { src } from './helpers';

function symbol(name: string, startLine: number, endLine = startLine, children: SymbolNode[] = [], kind: SymbolNode['kind'] = 'variable'): SymbolNode {
  return { name, startLine, endLine, children, kind };
}
const setupText = `<script>
const moduleOnly = 1
</script>
<script setup lang="ts">
import Child from './Child.vue'
type Form = { hidden: string }
const count = ref(0)
const props = defineProps<{label: string}>()
function save() {
  const handlerOnly = 1
}
</script>
<template><Child /></template>`;

describe('Vue 3 语言服务兜底', () => {
  it('script setup 只取本区块顶层运行时绑定，不进入对象和函数的内部', () => {
    const tree = [
      symbol('moduleOnly', 1),
      symbol('Child', 4),
      symbol('Form', 5, 5, [symbol('hidden', 5)], 'other'),
      symbol('count', 6),
      symbol('props', 7, 7, [symbol('label', 7)]),
      symbol('save()', 8, 10, [symbol('handlerOnly', 9)], 'function'),
    ];
    expect(extractMembers(tree, 'vue3', 12, 0, findSfcBlocks(src(setupText)))).toEqual([
      { kind: 'setup', name: 'Child' },
      { kind: 'setup', name: 'count' },
      { kind: 'setup', name: 'props' },
      { kind: 'setup', name: 'save' },
    ]);
  });

  it('能展开语言服务明确标识的 script wrapper，普通 script 的绑定不混入', () => {
    const tree = [
      symbol('script', 0, 2, [symbol('moduleOnly', 1)], 'other'),
      symbol('script setup', 3, 11, [symbol('count', 6)], 'other'),
    ];
    expect(extractMembers(tree, 'vue3', 12, 0, findSfcBlocks(src(setupText))))
      .toEqual([{ kind: 'setup', name: 'count' }]);
  });

  it('普通 setup 只接受明确 return 字段，别名和私有局部变量不混淆', () => {
    const tree = [symbol('default', 0, 20, [
      symbol('props', 1, 1, [symbol('label', 1)]),
      symbol('setup()', 2, 16, [
        symbol('privateValue', 3),
        symbol('count', 4),
        symbol('save()', 5, 10, [symbol('return', 8, 8, [symbol('nestedReturn', 8)])], 'function'),
        symbol('return {}', 12, 14, [symbol('visibleCount', 13), symbol('save', 14)]),
      ], 'function'),
    ], 'other')];
    expect(extractMembers(tree, 'vue3', 17)).toEqual([
      { kind: 'props', name: 'label' },
      { kind: 'setup', name: 'save' },
      { kind: 'setup', name: 'visibleCount' },
    ]);
  });

  it('没有明确 return 或返回字段不一致时，省略 setup 成员', () => {
    const noReturn = [symbol('default', 0, 20, [
      symbol('setup()', 1, 18, [symbol('privateValue', 2), symbol('props', 4, 5, [symbol('privateProp', 5)])], 'function'),
    ], 'other')];
    expect(extractMembers(noReturn, 'vue3', 10)).toEqual([]);
    const inconsistent = [symbol('default', 0, 20, [
      symbol('setup()', 1, 18, [
        symbol('return', 4, 4, [symbol('one', 4)]),
        symbol('return', 8, 8, [symbol('two', 8)]),
      ], 'function'),
    ], 'other')];
    expect(extractMembers(inconsistent, 'vue3', 10)).toEqual([]);
    const dynamic = [symbol('default', 0, 20, [
      symbol('setup()', 1, 18, [
        symbol('return {...}', 4, 4, [symbol('stable', 4)]),
        symbol('return {}', 8, 8, [symbol('stable', 8)]),
      ], 'function'),
    ], 'other')];
    expect(extractMembers(dynamic, 'vue3', 10)).toEqual([]);
  });

  it('Vue 3 Options API 保留组件的分组，不递归猜测未识别树形状', () => {
    const tree = [symbol('default', 0, 20, [
      symbol('props', 1, 2, [symbol('label', 2)]),
      symbol('data()', 3, 5, [symbol('count', 4)]),
      symbol('computed', 6, 8, [symbol('total()', 7)]),
      symbol('methods', 9, 12, [symbol('save()', 10)]),
    ], 'other')];
    expect(extractMembers(tree, 'vue3', 10)).toEqual(extractMembers(tree, 'vue2', 10));
    expect(extractMembers([symbol('unknownWrapper', 0, 20, tree, 'other')], 'vue3', 10)).toEqual([]);
  });
});

async function collectVue(text: string, major: number | undefined, reported?: 'vue2' | 'vue3', startLine = 0) {
  let observed: SourceContext | undefined;
  const collect = createCollector({
    vueMajor: async () => major,
    sources: [{
      name: 'skimmer',
      collect: async (ctx) => {
        observed = ctx;
        return { framework: reported, members: [{ kind: 'props', name: 'label' }, { kind: 'setup', name: 'count' }] };
      },
    }],
  });
  const result = await collect({
    docKey: 'file:///App.vue', languageId: 'vue', fileLabel: 'App.vue', source: src(text),
    version: 1, line: startLine, character: 0, windowStartLine: startLine, windowText: 'label count', cfg: DEFAULT_CONFIG,
  }, Date.now() + 1000);
  return { result, observed };
}

describe('Vue 项目版本和头部', () => {
  it.each([
    { major: 2, reported: 'vue3' as const, expected: 'vue2' },
    { major: 3, reported: 'vue2' as const, expected: 'vue3' },
  ])('项目 Vue $major 不被服务端语法猜测覆盖', async ({ major, reported, expected }) => {
    const { result, observed } = await collectVue('<script>export default {props:["label"]}</script>', major, reported);
    expect(result.framework).toBe(expected);
    expect(observed?.projectVueMajor).toBe(major);
    expect(result.header.text).toContain(`(${expected})`);
  });

  it('未知项目版本时，collector确实把script片段用于setup语法兜底', async () => {
    const { result, observed } = await collectVue('<script>\nexport default { setup() { return {count:1} } }\n</script>', undefined);
    expect(result.framework).toBe('vue3');
    expect(observed?.projectVueMajor).toBeUndefined();
  });

  it('Vue 2 composition-api 项目普通 setup 保持 Vue 2，script setup 依方案按语法标 Vue 3', async () => {
    const normal = await collectVue('<script>\nimport {ref} from "@vue/composition-api"; export default {setup(){return {count:ref(0)}}}\n</script>', 2, 'vue3');
    expect(normal.result.framework).toBe('vue2');
    const setup = await collectVue('<script setup>\nconst count = 1\n</script>', 2, 'vue2');
    expect(setup.result.framework).toBe('vue3');
  });

  it('模板与脚本头部依窗口起点分别使用HTML和行注释', async () => {
    const text = '<template>\n<div>{{label}}</div>\n</template>\n<script setup>\nconst count = 1\n</script>';
    expect((await collectVue(text, 3, 'vue3', 1)).result.header.text.startsWith('<!--\n')).toBe(true);
    expect((await collectVue(text, 3, 'vue3', 4)).result.header.text.startsWith('// ')).toBe(true);
  });
});
