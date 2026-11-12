import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseUnifiedDiff, pickDiffHunks, rankDiffHunks, renderDiffHunk } from '../../src/core/gitDiff';
import { renderHeader } from '../../src/core/header';
import { queryOf, tokensOf } from '../../src/core/snippets';
import { DEFAULT_CONFIG } from '../../src/core/types';
import { src } from './helpers';

const state = vi.hoisted(() => ({ dirty: new Set<string>(), trusted: true }));
vi.mock('vscode', () => {
  const make = (fsPath: string) => ({ scheme: 'file', fsPath, toString: () => `file://${fsPath}` });
  return {
    Uri: {
      file: make,
      parse: (text: string) => (text.startsWith('file://') ? make(text.slice(7)) : { scheme: 'untitled', fsPath: '', toString: () => text }),
    },
    workspace: {
      get isTrusted() {
        return state.trusted;
      },
      get textDocuments() {
        return [...state.dirty].map((fsPath) => ({ isDirty: true, uri: make(fsPath) }));
      },
    },
  };
});

const DIFF = `diff --git a/src/a.js b/src/a.js
index 1111111..2222222 100644
--- a/src/a.js
+++ b/src/a.js
@@ -10,4 +10,6 @@ function head() {
   const keep = 1
-  removedLine()
+  this.resResult.skuListPop = skuList
+  this.skulistPopShowF()
   return keep
 }
diff --git a/src/b.js b/src/b.js
--- a/src/b.js
+++ b/src/b.js
@@ -1,2 +1,3 @@
 const other = 1
+const unrelatedThing = computeUnrelated()
 export default other
diff --git a/gone.js b/gone.js
deleted file mode 100644
--- a/gone.js
+++ /dev/null
@@ -1,2 +0,0 @@
-const gone = 1
-export default gone
diff --git a/package-lock.json b/package-lock.json
--- a/package-lock.json
+++ b/package-lock.json
@@ -1,1 +1,2 @@
 {
+  "skulistPop": 1
diff --git a/img.png b/img.png
Binary files a/img.png and b/img.png differ
diff --git a/only-removed.js b/only-removed.js
--- a/only-removed.js
+++ b/only-removed.js
@@ -1,3 +1,2 @@
 const a = 1
-const b = 2
 const c = 3
`;

describe('parseUnifiedDiff', () => {
  it('只保留新文件一侧的文本，记录起始行与新增行数；删除的文件、锁文件、二进制、纯删除不产生改动块', () => {
    const hunks = parseUnifiedDiff(DIFF);
    expect(hunks.map((hunk) => hunk.file)).toEqual(['src/a.js', 'src/b.js']);
    expect(hunks[0]).toEqual({
      file: 'src/a.js', start: 9, added: 2,
      lines: ['  const keep = 1', '  this.resResult.skuListPop = skuList', '  this.skulistPopShowF()', '  return keep', '}'],
    });
  });

  it('长改动块切成小块，行号连续；没有新增行的小块丢弃', () => {
    const body = Array.from({ length: 25 }, (_, i) => (i < 12 ? `+added${i}` : ` context${i}`)).join('\n');
    const hunks = parseUnifiedDiff(`diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -1,13 +1,25 @@\n${body}\n`);
    expect(hunks.map((hunk) => [hunk.start, hunk.lines.length, hunk.added])).toEqual([[0, 10, 10], [10, 10, 2]]);
  });

  it('CRLF 行尾与超长行', () => {
    const hunks = parseUnifiedDiff(`diff --git a/x.js b/x.js\r\n--- a/x.js\r\n+++ b/x.js\r\n@@ -1,1 +1,2 @@\r\n keep\r\n+${'y'.repeat(400)}\r\n`);
    expect(hunks[0]?.lines[0]).toBe('keep');
    expect(hunks[0]?.lines[1]).toHaveLength(160);
  });
});

describe('queryOf 检索词权重', () => {
  it('紧贴光标上方的注释块权重最高，中间允许空行；两三个字的中文词不参与检索', () => {
    const lines = ['const farAway = 1', 'doSomething(nearName)', '// 弹出 skulist-pop 弹框', '// 取值 reasonList', '', ''];
    const query = queryOf(src(lines.join('\n')), 5);
    expect(query.factors.get('skulistpop')).toBe(3);
    expect(query.factors.get('reasonlist')).toBe(3);
    expect([...query.factors.keys()].some((token) => /[\u3400-\u9fff]/.test(token))).toBe(false);
    expect(query.factors.get('nearname')).toBe(0.5);
    expect(tokensOf('取值就是 ab')).toEqual([]);
  });

  it('光标上方不是注释时不加权；草稿里的名字与紧挨的行同级', () => {
    const query = queryOf(src('// 很远的注释 farComment\n\n\n\n\nconst nearValue = 1\n'), 6, 'this.draftName = 1');
    expect(query.factors.get('nearvalue')).toBe(2);
    expect(query.factors.get('farcomment')).toBe(0.5);
    expect(query.factors.get('draftname')).toBe(2);
    expect(query.fromHint.has('draftname')).toBe(true);
  });
});

describe('rankDiffHunks / pickDiffHunks', () => {
  const hunks = parseUnifiedDiff(DIFF);
  const query = queryOf(src('// 弹出 skulist-pop 弹框\n'), 1);
  const base = { hunks, query, windowStart: 100, windowEnd: 200 };

  it('其他文件的改动必须与光标处有交集', () => {
    const ranked = rankDiffHunks({ ...base, currentFile: 'src/c.js' });
    expect(ranked.map((hunk) => hunk.file)).toEqual(['src/a.js']);
  });

  it('当前文件的改动总是候选，但已在提示词窗口里的不重复取', () => {
    expect(rankDiffHunks({ ...base, currentFile: 'src/b.js' }).map((hunk) => hunk.file)).toEqual(['src/a.js', 'src/b.js']);
    expect(rankDiffHunks({ ...base, currentFile: 'src/b.js', windowStart: 0, windowEnd: 50 }).map((hunk) => hunk.file)).toEqual(['src/a.js']);
  });

  it('没有检索词时其他文件一块都不取', () => {
    expect(rankDiffHunks({ ...base, query: queryOf(src(''), 0), currentFile: 'src/c.js' })).toEqual([]);
  });

  it('按预算取，输出按文件与行号排成稳定顺序', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ file: `f${String(19 - i).padStart(2, '0')}.js`, start: i, lines: [`skulistPop${i}()`], added: 1 }));
    const picked = pickDiffHunks(many, { maxHunks: 3, maxChars: 1000 });
    expect(picked.map((hunk) => hunk.file)).toEqual(['f17.js', 'f18.js', 'f19.js']);
    expect(pickDiffHunks(many, { maxHunks: 10, maxChars: 45 })).toHaveLength(2);
  });

  it('渲染：首行是文件名，去掉公共缩进，不含行号', () => {
    expect(renderDiffHunk({ file: 'src/a.js', start: 40, added: 1, lines: ['', '    if (ok) {', '      run()', '    }', ''] }))
      .toBe('src/a.js:\nif (ok) {\n  run()\n}');
    // 块里有顶格的行时公共缩进为 0，保持原样
    expect(renderDiffHunk(hunks[0]!).split('\n').slice(0, 2)).toEqual(['src/a.js:', '  const keep = 1']);
  });
});

describe('头部里的未提交改动', () => {
  const base = { file: 'a.vue', framework: 'vue2' as const, related: [], windowText: '', style: 'line' as const };
  const dep = { uri: 'file:///b.js', mtimeMs: 1, size: 2 };

  it('排在成员之后、相关片段之前；其他文件的指纹进入依赖', () => {
    const header = renderHeader({
      ...base, members: [{ kind: 'data', name: 'form' }], changes: [{ text: 'src/b.js:\nconst x = 1', dep }, { text: 'a.vue:\nconst y = 2' }],
      snippets: ['snippet line'], budgetChars: 4000,
    });
    const lines = header.text.split('\n');
    const at = (text: string) => lines.findIndex((line) => line.includes(text));
    expect(at('members:')).toBeLessThan(at('uncommitted changes in this project'));
    expect(at('const y = 2')).toBeLessThan(at('related code elsewhere in this file'));
    expect(header.deps).toEqual([dep]);
  });

  it('超预算时先丢相关片段，再从末尾丢改动块；被丢掉的改动不留依赖', () => {
    const header = renderHeader({
      ...base, members: [], changes: [{ text: 'a.vue:\nkeepThisChange()' }, { text: `src/b.js:\n${'dropThisChange() '.repeat(20)}`, dep }],
      snippets: ['snippetToDrop '.repeat(10)], budgetChars: 260,
    });
    expect(header.text).toContain('keepThisChange()');
    expect(header.text).not.toContain('dropThisChange');
    expect(header.text).not.toContain('snippetToDrop');
    expect(header.deps).toEqual([]);
  });
});

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasGit())('GitDiffSource（临时目录里的真实 git 仓库）', () => {
  let root = '';
  let permitted = (_fsPath: string) => true;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  const write = async (name: string, text: string) => {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), text);
  };
  const filler = Array.from({ length: 60 }, (_, i) => `const filler${i} = ${i}`).join('\n');

  async function collect(file: string, text: string, line: number, recent: string[] = []) {
    const { GitDiffSource } = await import('../../src/vscode/gitDiff');
    const source = new GitDiffSource({
      enabled: () => true,
      gate: { permits: async (uri: { fsPath: string }) => permitted(uri.fsPath) } as never,
      recentDocs: () => recent,
    });
    return source.collect({
      docKey: `file://${path.join(root, file)}`, languageId: 'javascript', fileLabel: file, source: src(text), version: 1,
      line, character: 0, windowStartLine: Math.max(0, line - 5), windowText: 'a\nb\nc\nd\ne\nf', cfg: DEFAULT_CONFIG,
      framework: 'generic', region: 'other', identifiers: [],
    });
  }

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'anc-gitdiff-')));
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    await write('src/main.js', `${filler}\nexport function main() {}\n`);
    await write('src/store.js', 'export const store = {}\n');
    await write('src/noise.js', 'export const noise = 1\n');
    await write('secret/key.js', 'export const key = 1\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    // 未提交的改动：当前文件开头一处，另外三个文件各一处
    await write('src/main.js', `const early = setupEarlyThing()\n${filler}\nexport function main() {}\n`);
    await write('src/store.js', 'export const store = {}\nexport function saveSkuListPop(list) { store.skuListPop = list }\n');
    await write('src/noise.js', 'export const noise = 1\nexport const totallyDifferent = 2\n');
    await write('secret/key.js', 'export const key = 1\nexport const skuListPopSecret = 2\n');
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const current = `const early = setupEarlyThing()\n${filler}\nexport function main() {\n  // 保存 skuListPop\n  \n}\n`;
  const cursor = current.split('\n').length - 3;

  it('取回当前文件窗口外的改动，以及其他文件里与光标处相关的改动；不相关的文件不取', async () => {
    const result = await collect('src/main.js', current, cursor);
    const texts = result?.changes?.map((change) => change.text) ?? [];
    expect(texts.some((text) => text.startsWith('src/main.js:') && text.includes('setupEarlyThing'))).toBe(true);
    expect(texts.some((text) => text.startsWith('src/store.js:') && text.includes('saveSkuListPop'))).toBe(true);
    expect(texts.join('\n')).not.toContain('totallyDifferent');
    // 其他文件带指纹，当前文件不带
    const store = result?.changes?.find((change) => change.text.startsWith('src/store.js:'));
    expect(store?.dep?.uri).toBe(`file://${path.join(root, 'src/store.js')}`);
    expect(store?.dep?.size).toBeGreaterThan(0);
    expect(result?.changes?.find((change) => change.text.startsWith('src/main.js:'))?.dep).toBeUndefined();
    expect(result?.status).toMatch(/^\d+\/\d+$/);
  });

  it('没有发送许可的文件、有未保存修改的其他文件不进入', async () => {
    permitted = (fsPath) => !fsPath.includes(`${path.sep}secret${path.sep}`);
    const denied = await collect('src/main.js', current, cursor);
    expect(JSON.stringify(denied?.changes)).not.toContain('skuListPopSecret');
    expect(JSON.stringify(denied?.changes)).toContain('saveSkuListPop');

    state.dirty.add(path.join(root, 'src/store.js'));
    const dirty = await collect('src/main.js', current, cursor);
    expect(JSON.stringify(dirty?.changes)).not.toContain('saveSkuListPop');
    state.dirty.clear();
    permitted = () => true;
  });

  it('工作区不受信任、不在仓库内、非磁盘文件时不取', async () => {
    state.trusted = false;
    expect(await collect('src/main.js', current, cursor)).toBeUndefined();
    state.trusted = true;
    const { GitDiffSource } = await import('../../src/vscode/gitDiff');
    const source = new GitDiffSource({ enabled: () => true, gate: { permits: async () => true } as never, recentDocs: () => [] });
    const outside = await mkdtemp(path.join(tmpdir(), 'anc-nogit-'));
    const ctx = {
      languageId: 'javascript', fileLabel: 'x.js', source: src(current), version: 1, line: cursor, character: 0,
      windowStartLine: 0, windowText: '', cfg: DEFAULT_CONFIG, framework: 'generic' as const, region: 'other' as const, identifiers: [],
    };
    expect(await source.collect({ ...ctx, docKey: `file://${path.join(outside, 'x.js')}` })).toBeUndefined();
    expect(await source.collect({ ...ctx, docKey: 'untitled:Untitled-1' })).toBeUndefined();
    await rm(outside, { recursive: true, force: true });
  });
});
