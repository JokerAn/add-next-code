import { describe, expect, it } from 'vitest';
import { createCollector } from '../../src/core/collector';
import { renderHeader } from '../../src/core/header';
import { extractMembers, type SymbolNode } from '../../src/core/symbols';
import { DEFAULT_CONFIG } from '../../src/core/types';
import { src } from './helpers';

function symbol(name: string, startLine: number, endLine: number, children: SymbolNode[] = [], kind: SymbolNode['kind'] = 'variable'): SymbolNode {
  return { name, startLine, endLine, children, kind };
}

const tree = [
  symbol('Child', 0, 0, [], 'other'),
  symbol('PanelProps', 1, 3, [symbol('label', 2, 2)], 'other'),
  symbol('First', 4, 20, [
    symbol('show', 4, 4),
    symbol('[count, setCount]', 5, 5),
    symbol('inputRef', 6, 6),
    symbol('onSave()', 7, 12, [symbol('handlerOnly', 8, 8)], 'function'),
    symbol('CapitalizedConstant', 13, 13),
    // 真实 tsserver：对象字面量常量的成员是 property/method，对应 SymbolKind.Property/Method → 'other'。
    symbol('Styles', 14, 17, [symbol('root', 15, 15, [], 'other')], 'variable'),
  ], 'function'),
  symbol('Second', 22, 30, [symbol('secondOnly', 23, 23)], 'function'),
];

describe('React 基础上下文', () => {
  it('只包含当前组件直接绑定，排除兄弟、类型和 handler 临时变量', () => {
    const members = extractMembers(tree, 'react', 8);
    expect(members.map((item) => item.name)).toEqual([
      'show', 'count', 'setCount', 'inputRef', 'onSave', 'CapitalizedConstant', 'Styles',
    ]);
    expect(JSON.stringify(members)).not.toMatch(/handlerOnly|secondOnly|PanelProps|startLine|endLine/);
    expect(extractMembers(tree, 'react', 23)).toEqual([{ kind: 'scope', name: 'secondOnly' }]);
  });

  it('光标在组件外或旧符号范围不可用时不拼接其他组件成员', () => {
    expect(extractMembers(tree, 'react', 1)).toEqual([]);
    expect(extractMembers(tree, 'react', -1)).toEqual([]);
    expect(extractMembers(tree, 'react', 13).map((item) => item.name)).toContain('count');
    expect(extractMembers(tree, 'react', 15).map((item) => item.name)).toContain('count');
    expect(extractMembers(tree, 'react', 15).map((item) => item.name)).not.toContain('root');
  });

  it('嵌套组件与自定义 Hook 使用自己的直接绑定', () => {
    const nested = [symbol('Outer', 0, 30, [
      symbol('outerOnly', 1, 1),
      symbol('Inner', 3, 12, [symbol('innerOnly', 4, 4)], 'function'),
    ], 'function'), symbol('useDraft', 32, 40, [symbol('draft', 33, 33)], 'function')];
    expect(extractMembers(nested, 'react', 5)).toEqual([{ kind: 'scope', name: 'innerOnly' }]);
    expect(extractMembers(nested, 'react', 35)).toEqual([{ kind: 'scope', name: 'draft' }]);
  });

  it('箭头函数组件（语言服务里是 Variable）按函数体内的 const/function 识别，对象常量不会被当成组件', () => {
    // 与 VS Code 内置 tsserver 的 navtree 一致：箭头组件子节点是 const/function，对象常量子节点是 property/method。
    const arrow = [
      symbol('Arrow', 2, 9, [
        symbol('open', 3, 3),
        symbol('setOpen', 3, 3),
        symbol('toggle', 4, 4),
        symbol('useEffect() callback', 6, 6, [], 'function'),
      ], 'variable'),
      symbol('Styles', 11, 14, [symbol('root', 12, 12, [], 'other'), symbol('title', 13, 13, [], 'other')], 'variable'),
      symbol('Decl', 16, 18, [symbol('a', 17, 17)], 'function'),
    ];
    // `useEffect() callback` 是匿名回调节点，不是可引用的绑定，名称过滤会把它排除。
    expect(extractMembers(arrow, 'react', 5).map((item) => item.name)).toEqual(['open', 'setOpen', 'toggle']);
    expect(extractMembers(arrow, 'react', 12)).toEqual([]);
    expect(extractMembers(arrow, 'react', 17)).toEqual([{ kind: 'scope', name: 'a' }]);
  });

  it('嵌套的箭头函数组件使用自己的直接绑定；只有 return 没有局部绑定的箭头函数不成为作用域', () => {
    const nested = [
      symbol('Outer', 0, 12, [
        symbol('outerOnly', 1, 1),
        symbol('Inner', 3, 8, [symbol('innerOnly', 4, 4)], 'variable'),
      ], 'variable'),
      symbol('Empty', 14, 15, [], 'variable'),
    ];
    expect(extractMembers(nested, 'react', 5)).toEqual([{ kind: 'scope', name: 'innerOnly' }]);
    expect(extractMembers(nested, 'react', 10).map((item) => item.name)).toEqual(['outerOnly', 'Inner']);
    expect(extractMembers(nested, 'react', 14)).toEqual([]);
  });

  it('同行组件按列定位，不把第二个组件的成员混入第一个', () => {
    const sameLine = [
      { ...symbol('First', 0, 0, [symbol('one', 0, 0)], 'function'), startCharacter: 0, endCharacter: 40 },
      { ...symbol('Second', 0, 0, [symbol('two', 0, 0)], 'function'), startCharacter: 42, endCharacter: 90 },
    ];
    expect(extractMembers(sameLine, 'react', 0, 20)).toEqual([{ kind: 'scope', name: 'one' }]);
    expect(extractMembers(sameLine, 'react', 0, 60)).toEqual([{ kind: 'scope', name: 'two' }]);
  });

  it.each(['javascriptreact', 'typescriptreact'])('%s 头部始终使用行注释，保留组件/Hook/Context类型及来源', async (languageId) => {
    const componentDep = { uri: 'file:///Child.tsx', mtimeMs: 1, size: 20 };
    const hookDep = { uri: 'file:///useDraft.ts', mtimeMs: 2, size: 30 };
    const contextDep = { uri: 'file:///Session.ts', mtimeMs: 3, size: 40 };
    const collector = createCollector({
      vueMajor: async () => { throw new Error('React 不应读取 Vue 依赖'); },
      sources: [{
        name: 'skimmer',
        collect: async () => ({
          framework: 'react',
          members: [
            { kind: 'state', name: 'draft' },
            { kind: 'setters', name: 'setDraft' },
            { kind: 'refs', name: 'inputRef' },
            { kind: 'handlers', name: 'save' },
          ],
          related: [
            { kind: 'component', name: 'Child', file: 'Child.tsx', interface: [{ kind: 'props', name: 'value' }], dep: componentDep },
            { kind: 'hook', name: 'useDraft', file: 'useDraft.ts', interface: [{ kind: 'returns', name: 'save', signature: 'save()' }], dep: hookDep },
            { kind: 'module', name: 'Session', file: 'Session.ts', interface: [{ kind: 'context', name: 'userId' }], dep: contextDep },
          ],
        }),
      }],
    });
    const outcome = await collector({
      docKey: 'file:///App.tsx', languageId, fileLabel: 'App.tsx',
      source: src('const quoted = "<template>";\nfunction App() { return <Child value={draft} />; }'),
      version: 1, line: 1, character: 45, windowStartLine: 0, windowText: 'draft',
      cfg: DEFAULT_CONFIG,
    }, Date.now() + 1000);
    expect(outcome.framework).toBe('react');
    expect(outcome.header.text.split('\n').filter(Boolean).every((line) => line.startsWith('// '))).toBe(true);
    expect(outcome.header.text).toContain('<Child> Child.tsx: props value');
    expect(outcome.header.text).toContain('hook useDraft useDraft.ts: returns save()');
    expect(outcome.header.text).toContain('module Session Session.ts: context userId');
    expect(outcome.header.text).toContain('state: draft; setters: setDraft; refs: inputRef; handlers: save');
    expect(outcome.header.deps).toEqual([componentDep, contextDep, hookDep]);
  });

  it('Hook返回结构超预算裁剪时，同步去掉对应来源依赖', () => {
    const header = renderHeader({
      file: 'App.tsx', framework: 'react', members: [], windowText: '', style: 'line', budgetChars: 220,
      related: [
        { kind: 'hook', name: 'useSmall', file: 'useSmall.ts', interface: [{ kind: 'returns', name: 'value' }], dep: { uri: 'file:///small', mtimeMs: 1, size: 1 } },
        { kind: 'hook', name: 'useZLarge', file: 'large.ts', interface: [{ kind: 'returns', name: 'huge', signature: 'x'.repeat(500) }], dep: { uri: 'file:///large', mtimeMs: 1, size: 1 } },
      ],
    });
    expect(header.text).toContain('hook useSmall');
    expect(header.text).not.toContain('useZLarge');
    expect(header.deps.map((dep) => dep.uri)).toEqual(['file:///small']);
  });
});
