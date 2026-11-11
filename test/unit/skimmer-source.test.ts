import { mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCollector, type SourceContext } from '../../src/core/collector';
import { parseCompletionContext } from '../../src/core/skimmer/protocol';
import { DEFAULT_CONFIG } from '../../src/core/types';
import { SkimmerSource } from '../../src/vscode/skimmer';
import { src } from './helpers';

const mock = vi.hoisted(() => ({
  documents: [] as import('vscode').TextDocument[],
  folder: undefined as { uri: import('vscode').Uri } | undefined,
  query: vi.fn(),
  permits: vi.fn(async (_uri: import('vscode').Uri) => true),
}));
vi.mock('vscode', async () => {
  class Uri {
    constructor(readonly value: string) {}
    get scheme() { return new URL(this.value).protocol.slice(0, -1); }
    get path() { return decodeURIComponent(new URL(this.value).pathname); }
    get fsPath() { return this.scheme === 'file' ? fileURLToPath(this.value) : this.path; }
    toString() { return this.value; }
    with(changes: { path: string }) {
      const url = new URL(this.value);
      url.pathname = changes.path;
      return new Uri(url.toString());
    }
    static parse(value: string) { return new Uri(value); }
    static file(value: string) { return new Uri(pathToFileURL(value).toString()); }
  }
  return {
    Uri,
    workspace: {
      get textDocuments() { return mock.documents; },
      getWorkspaceFolder: () => mock.folder,
    },
  };
});
vi.mock('../../src/core/skimmer/client', () => ({
  SkimmerClient: class {
    ready = true;
    query = mock.query;
    ensureStarted() {}
    restart = async () => undefined;
    dispose = async () => undefined;
  },
}));
vi.mock('../../src/vscode/workspace', () => ({
  depsIo: {
    stat: async (uri: string) => {
      const url = new URL(uri);
      const fp = await stat(decodeURIComponent(url.pathname)).catch(() => undefined);
      return fp && { mtimeMs: fp.mtimeMs, size: fp.size };
    },
    isDirty: (uri: string) => mock.documents.some((doc) => doc.uri.toString() === uri && doc.isDirty),
  },
}));

let root: string;
let ctx: SourceContext;
let source: SkimmerSource;
let vscode: typeof import('vscode');
function document(file: string, dirty = false): import('vscode').TextDocument {
  return { uri: vscode.Uri.file(path.join(root, file)), isDirty: dirty, version: 1 } as import('vscode').TextDocument;
}
async function response(state = 'ready') {
  const fingerprint = async (file: string) => {
    const fp = await stat(path.join(root, file));
    return { mtimeMs: fp.mtimeMs, size: fp.size };
  };
  return {
    protocol: 1, framework: 'vue2', overlay: { state: 'ready' }, index: { state },
    self: { members: [{ kind: 'methods', name: 'load' }], truncated: false },
    related: [{
      name: 'Child', file: 'Child.vue', kind: 'component', binding: 'static',
      interface: [{ kind: 'props', name: 'rows' }], fingerprint: await fingerprint('Child.vue'),
      dependencies: [{ file: 'index.ts', fingerprint: await fingerprint('index.ts') }],
    }],
  };
}
beforeEach(async () => {
  vi.clearAllMocks();
  mock.permits.mockResolvedValue(true);
  vscode = await import('vscode');
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'add-next-code-source-')));
  await Promise.all(['App.vue', 'Child.vue', 'index.ts'].map((file) => writeFile(path.join(root, file), '// fixture')));
  mock.folder = { uri: vscode.Uri.file(root) };
  mock.documents = [document('App.vue')];
  ctx = {
    cfg: { ...DEFAULT_CONFIG, skimmerEnabled: true },
    source: src('<script>\r\nconst emoji = "😀"\r\n</script>'),
    docKey: mock.documents[0]!.uri.toString(), version: 1,
    languageId: 'vue', fileLabel: 'App.vue',
    line: 1, character: 12, framework: 'vue2', region: 'script',
    identifiers: ['Child'], windowStartLine: 0, windowText: 'Child',
  };
  source = new SkimmerSource({
    cfg: () => ctx.cfg, cacheDir: '/unused',
    gate: { permits: mock.permits } as never,
    status() {}, log() {}, onIndexChanged() {},
  });
  mock.query.mockResolvedValue(await response());
});
afterEach(async () => {
  await source.dispose();
  await rm(root, { recursive: true, force: true });
});
const collect = () => source.collect(ctx, Date.now() + 2000);

describe('Skimmer 来源边界', () => {
  it('I19 发送完整文本、UTF-16 光标和所有项目内未保存依赖', async () => {
    mock.documents.push(document('Child.vue', true), document('../outside.ts', true));
    const result = await collect();
    expect(mock.query).toHaveBeenCalledWith(expect.objectContaining({
      document: { text: '<script>\r\nconst emoji = "😀"\r\n</script>' },
      cursor: { line: 1, character: 12 }, dirty_files: ['Child.vue'],
    }), expect.any(Number));
    expect(result?.related).toEqual([]);
  });

  it('相关文件与barrel中间文件均进入来源依赖', async () => {
    const result = await collect();
    expect(result?.related).toHaveLength(1);
    expect(result?.related?.[0]?.dep?.uri).toBe(vscode.Uri.file(path.join(root, 'Child.vue')).toString());
    expect(result?.related?.[0]?.deps?.map((dep) => dep.uri)).toEqual([
      vscode.Uri.file(path.join(root, 'index.ts')).toString(),
    ]);
  });

  it('React TSX的Hook/Context类别和指纹传入头部来源', async () => {
    await Promise.all(['App.tsx', 'useDraft.ts', 'Session.ts'].map((file) => writeFile(path.join(root, file), '// fixture')));
    mock.documents = [document('App.tsx')];
    ctx = {
      ...ctx, docKey: mock.documents[0]!.uri.toString(),
      languageId: 'typescriptreact', fileLabel: 'App.tsx', framework: 'react', region: 'other',
      source: src('function App() { const draft = useDraft(); return <Child />; }'),
    };
    const data = await response();
    mock.query.mockResolvedValue({
      ...data, framework: 'react',
      self: { members: [{ kind: 'state', name: 'draft' }], truncated: false },
      related: await Promise.all([
        { kind: 'hook', name: 'useDraft', file: 'useDraft.ts', interface: [{ kind: 'returns', name: 'save' }] },
        { kind: 'module', name: 'Session', file: 'Session.ts', interface: [{ kind: 'context', name: 'userId' }] },
      ].map(async (item) => {
        const fp = await stat(path.join(root, item.file));
        return { ...item, binding: 'static', fingerprint: { mtimeMs: fp.mtimeMs, size: fp.size } };
      })),
    });
    const result = await collect();
    expect(result?.framework).toBe('react');
    expect(result?.members).toEqual([{ kind: 'state', name: 'draft' }]);
    expect(result?.related?.map((item) => [item.kind, item.name, item.dep?.uri])).toEqual([
      ['hook', 'useDraft', vscode.Uri.file(path.join(root, 'useDraft.ts')).toString()],
      ['module', 'Session', vscode.Uri.file(path.join(root, 'Session.ts')).toString()],
    ]);
  });

  it.each([
    { extension: 'mjs', languageId: 'javascript', reported: 'js', text: "import {read} from './barrel.mjs';\nconst value = read();" },
    { extension: 'cjs', languageId: 'javascript', reported: 'js', text: "const {read} = require('./barrel.cjs');\nconst value = read();" },
    { extension: 'mts', languageId: 'typescript', reported: 'ts', text: "import {read} from './barrel.mjs';\nconst value: string = read();" },
    { extension: 'cts', languageId: 'typescript', reported: 'ts', text: "const {read} = require('./barrel.cjs');\nconst value: string = read();" },
  ])('Node .$extension 沿用全文查询与来源校验，导出签名进入行注释头部', async ({ extension, languageId, reported, text }) => {
    const file = `App.${extension}`;
    const target = `service.${extension}`;
    const barrel = `barrel.${extension}`;
    await Promise.all([file, target, barrel].map((name) => writeFile(path.join(root, name), '// fixture')));
    mock.documents = [document(file)];
    const fingerprint = async (name: string) => {
      const fp = await stat(path.join(root, name));
      return { mtimeMs: fp.mtimeMs, size: fp.size };
    };
    mock.query.mockResolvedValue(parseCompletionContext({
      protocol: 1, framework: reported, overlay: { state: 'ready' }, index: { state: 'ready' },
      self: { members: [{ kind: 'function', name: 'main', signature: 'main()' }], truncated: false },
      related: [{
        kind: 'module', name: 'read', file: target, binding: 'static',
        interface: [{ kind: 'function', name: 'read', signature: 'read(path)' }],
        fingerprint: await fingerprint(target),
        dependencies: [{ file: barrel, fingerprint: await fingerprint(barrel) }],
      }],
    }));
    const collector = createCollector({
      sources: [source],
      vueMajor: async () => { throw new Error('Node 不应读取 Vue 依赖'); },
    });
    const result = await collector({
      ...ctx, languageId, docKey: mock.documents[0]!.uri.toString(), fileLabel: file,
      source: src(text), line: 1, character: 0, windowText: text,
    }, Date.now() + 2000);
    expect(mock.query).toHaveBeenCalledWith(expect.objectContaining({
      file_path: path.join(root, file), document: { text }, cursor: { line: 1, character: 0 },
    }), expect.any(Number));
    expect(result.framework).toBe('node');
    expect(result.header.text).toContain(`file: ${file} (node)`);
    expect(result.header.text).toContain(`module read ${target}: function read(path)`);
    expect(result.header.text.split('\n').filter(Boolean).every((line) => line.startsWith('// '))).toBe(true);
    expect(result.header.deps.map((dep) => dep.uri)).toEqual([
      vscode.Uri.file(path.join(root, target)).toString(),
      vscode.Uri.file(path.join(root, barrel)).toString(),
    ]);
    mock.documents.push(document(barrel, true));
    expect((await source.collect({
      ...ctx, languageId, docKey: mock.documents[0]!.uri.toString(), fileLabel: file,
      source: src(text), framework: 'node', line: 1, character: 0,
    }, Date.now() + 2000))?.related).toEqual([]);
  });

  it('任一barrel依赖不被许可时丢弃整个接口', async () => {
    mock.permits.mockImplementation(async (uri) => !uri.fsPath.endsWith('index.ts'));
    expect((await collect())?.related).toEqual([]);
  });

  it('查询期间文档变化，响应整体作废', async () => {
    mock.query.mockImplementationOnce(async () => {
      (mock.documents[0] as { version: number }).version++;
      return response();
    });
    expect(await collect()).toBeUndefined();
  });

  it('I25 锁占用时即使响应含related也只保留本文件成员', async () => {
    mock.query.mockResolvedValue(await response('locked'));
    expect(await collect()).toMatchObject({
      related: [], members: [{ kind: 'methods', name: 'load' }], status: 'locked',
    });
  });

  it('拒绝逃逸项目的路径及符号链接', async () => {
    await symlink(path.join(root, '..'), path.join(root, 'outside'));
    const data = await response();
    data.related[0]!.file = '../outside.vue';
    mock.query.mockResolvedValueOnce(data);
    expect((await collect())?.related).toEqual([]);
    data.related[0]!.file = 'outside/no-file.vue';
    mock.query.mockResolvedValueOnce(data);
    expect((await collect())?.related).toEqual([]);
  });

  it('remote 许可检查保留 scheme 与 authority，让相对exclude继续生效', async () => {
    const remoteRoot = vscode.Uri.parse(`vscode-remote://ssh-remote+fixture${root}`);
    mock.folder = { uri: remoteRoot };
    mock.documents[0] = { ...mock.documents[0], uri: remoteRoot.with({ path: `${root}/App.vue` }) } as import('vscode').TextDocument;
    ctx.docKey = mock.documents[0]!.uri.toString();
    mock.permits.mockImplementation(async (uri) => !uri.fsPath.endsWith('Child.vue'));
    expect((await collect())?.related).toEqual([]);
    const relatedChecks = mock.permits.mock.calls.filter(([uri]) => uri.fsPath.endsWith('Child.vue'));
    expect(relatedChecks.length).toBeGreaterThan(0);
    expect(relatedChecks.every(([uri]) => uri.toString().startsWith('vscode-remote://ssh-remote+fixture/'))).toBe(true);
  });

  it('超过快照预算时不发全文查询', async () => {
    ctx.cfg = { ...ctx.cfg, skimmerMaxDocumentChars: 10 };
    expect(await collect()).toEqual({ status: 'document-too-large' });
    expect(mock.query).not.toHaveBeenCalled();
  });

  it('Vue主版本只传collector核实值，不把语法猜测当作项目依赖', async () => {
    ctx.framework = 'vue3';
    await collect();
    expect(mock.query.mock.calls[0]?.[0]).not.toHaveProperty('vue_major');
    ctx.projectVueMajor = 3;
    await collect();
    expect(mock.query.mock.calls[1]?.[0]).toHaveProperty('vue_major', 3);
    ctx.projectVueMajor = 2;
    await collect();
    expect(mock.query.mock.calls[2]?.[0]).toHaveProperty('vue_major', 2);
  });
});
