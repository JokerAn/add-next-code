import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SymbolSource } from '../../src/vscode/symbols';
import type { SourceContext } from '../../src/core/collector';
import { DEFAULT_CONFIG } from '../../src/core/types';
import { src } from './helpers';
import { findSfcBlocks } from '../../src/core/sfc';

const host = vi.hoisted(() => ({
  execute: vi.fn(),
  documents: [] as Array<{ uri: { toString(): string }; version: number }>,
}));
vi.mock('vscode', () => ({
  Uri: { parse: (value: string) => ({ toString: () => value }) },
  SymbolKind: { Function: 11, Variable: 12 },
  commands: { executeCommand: host.execute },
  workspace: { get textDocuments() { return host.documents; } },
}));

function tree(member: string, owner = 'App') {
  return [{
    name: owner, kind: 11, range: { start: { line: 0 }, end: { line: 20 } },
    children: [{ name: member, kind: 12, range: { start: { line: 2 }, end: { line: 2 } }, children: [] }],
  }];
}
const context: SourceContext = {
  cfg: DEFAULT_CONFIG, docKey: 'file:///App.tsx', source: src('function App(){}'),
  version: 1, line: 5, character: 0, languageId: 'typescriptreact', fileLabel: 'App.tsx',
  framework: 'react', region: 'other', identifiers: [], windowStartLine: 0, windowText: '',
};
let source: SymbolSource;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  host.documents = [{ uri: { toString: () => context.docKey }, version: 1 }];
  source = new SymbolSource(() => true);
});
afterEach(() => vi.useRealTimers());

describe('React 语言服务边界', () => {
  it('当前符号提取只带名称，文本编辑后旧范围不用于选择组件', async () => {
    host.execute.mockResolvedValue(tree('current'));
    expect(await source.collect(context, Date.now() + 50)).toEqual({
      members: [{ kind: 'scope', name: 'current' }],
    });
    host.documents[0]!.version = 2;
    let resolve!: (value: unknown) => void;
    host.execute.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = source.collect({ ...context, version: 2 }, Date.now() + 50);
    await vi.advanceTimersByTimeAsync(50);
    expect(await pending).toBeUndefined();
    resolve(tree('newMember'));
    await vi.advanceTimersByTimeAsync(0);
    expect((await source.collect({ ...context, version: 2 }, Date.now() + 50))?.members)
      .toEqual([{ kind: 'scope', name: 'newMember' }]);
  });

  it('关闭重开同路径且版本号重置，旧请求延迟返回不能覆盖新文档', async () => {
    let oldReply!: (value: unknown) => void;
    host.execute.mockImplementationOnce(() => new Promise((done) => { oldReply = done; }));
    const old = source.collect(context, Date.now() + 50);
    source.clearDoc(context.docKey);
    host.execute.mockResolvedValueOnce(tree('reopened'));
    expect((await source.collect(context, Date.now() + 50))?.members)
      .toEqual([{ kind: 'scope', name: 'reopened' }]);
    oldReply(tree('old'));
    await old;
    expect((await source.collect(context, Date.now() + 50))?.members)
      .toEqual([{ kind: 'scope', name: 'reopened' }]);
    expect(host.execute).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('符号请求期间版本变化，结果不标记为旧版本缓存', async () => {
    let reply!: (value: unknown) => void;
    host.execute.mockImplementationOnce(() => new Promise((done) => { reply = done; }));
    const pending = source.collect(context, Date.now() + 50);
    host.documents[0]!.version = 2;
    reply(tree('cannotTrust'));
    expect(await pending).toBeUndefined();
    host.execute.mockResolvedValueOnce(tree('fresh'));
    expect((await source.collect({ ...context, version: 2 }, Date.now() + 50))?.members)
      .toEqual([{ kind: 'scope', name: 'fresh' }]);
  });

  it('语言服务不可用时返回空来源，不影响其他上下文', async () => {
    host.execute.mockRejectedValue(new Error('no provider'));
    expect(await source.collect(context, Date.now() + 50)).toBeUndefined();
  });

  it('Vue 3 版本过期时不用当前script区块范围筛选旧树，刷新后再恢复', async () => {
    const text = '<script setup>\nconst count = 1\n</script>';
    const ctx: SourceContext = {
      ...context, framework: 'vue3', languageId: 'vue', source: src(text),
      sfcBlocks: findSfcBlocks(src(text)), line: 1,
    };
    host.execute.mockResolvedValueOnce([{
      name: 'count', kind: 12, range: { start: { line: 1 }, end: { line: 1 } }, children: [],
    }]);
    expect((await source.collect(ctx, Date.now() + 50))?.members).toEqual([{ kind: 'setup', name: 'count' }]);
    host.documents[0]!.version = 2;
    let reply!: (value: unknown) => void;
    host.execute.mockImplementationOnce(() => new Promise((done) => { reply = done; }));
    const pending = source.collect({ ...ctx, version: 2 }, Date.now() + 50);
    await vi.advanceTimersByTimeAsync(50);
    expect(await pending).toBeUndefined();
    reply([]);
    await vi.advanceTimersByTimeAsync(0);
  });
});
