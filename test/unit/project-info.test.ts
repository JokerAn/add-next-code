import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectInfo } from '../../src/vscode/workspace';

const host = vi.hoisted(() => ({
  root: '',
  invalidate: undefined as (() => void) | undefined,
}));
vi.mock('vscode', () => ({
  Uri: {
    parse: (value: string) => {
      const url = new URL(value);
      return { scheme: url.protocol.slice(0, -1), fsPath: decodeURIComponent(url.pathname), toString: () => value };
    },
  },
  workspace: {
    getWorkspaceFolder: () => ({ uri: { fsPath: host.root } }),
    createFileSystemWatcher: () => ({
      onDidChange: (listener: () => void) => { host.invalidate = listener; },
      onDidCreate() {},
      onDidDelete() {},
      dispose() {},
    }),
  },
}));
let directory: string;
let info: ProjectInfo;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'add-next-code-vue-project-'));
  host.root = path.join(directory, 'workspace');
  await mkdir(path.join(host.root, 'src'), { recursive: true });
  info = new ProjectInfo();
});
afterEach(async () => {
  info.dispose();
  await rm(directory, { recursive: true, force: true });
});

describe('Vue 项目版本', () => {
  it.each(['file://', 'vscode-remote://ssh-remote+fixture'])('%s 使用 workspace host 上最近的 package.json', async (scheme) => {
    await writeFile(path.join(host.root, 'package.json'), JSON.stringify({ dependencies: { vue: '^3.5.0' } }));
    expect(await info.vueMajor(`${scheme}${host.root}/src/App.vue`)).toBe(3);
    await writeFile(path.join(host.root, 'package.json'), JSON.stringify({ dependencies: { vue: '~2.7.16' } }));
    host.invalidate?.();
    expect(await info.vueMajor(`${scheme}${host.root}/src/App.vue`)).toBe(2);
  });

  it('最近的嵌套 package.json 优先，支持 dev/peer 依赖', async () => {
    await writeFile(path.join(host.root, 'package.json'), JSON.stringify({ dependencies: { vue: '^3.5.0' } }));
    await writeFile(path.join(host.root, 'src/package.json'), JSON.stringify({ devDependencies: { vue: '^2.7.0' } }));
    expect(await info.vueMajor(`file://${host.root}/src/App.vue`)).toBe(2);
    await writeFile(path.join(host.root, 'src/package.json'), JSON.stringify({ peerDependencies: { vue: '^3.0.0' } }));
    host.invalidate?.();
    expect(await info.vueMajor(`file://${host.root}/src/App.vue`)).toBe(3);
  });

  it('不越过工作区边界读取上级 package，未知依赖保持未知', async () => {
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ dependencies: { vue: '^2.7.0' } }));
    expect(await info.vueMajor(`file://${host.root}/src/App.vue`)).toBeUndefined();
    await writeFile(path.join(host.root, 'package.json'), JSON.stringify({ dependencies: { vue: 'workspace:*' } }));
    host.invalidate?.();
    expect(await info.vueMajor(`file://${host.root}/src/App.vue`)).toBeUndefined();
  });

  it('横跨多个主版本的范围不能冒充确定项目版本', async () => {
    await writeFile(path.join(host.root, 'package.json'), JSON.stringify({ dependencies: { vue: '>=2 <4' } }));
    expect(await info.vueMajor(`file://${host.root}/src/App.vue`)).toBeUndefined();
    await writeFile(path.join(host.root, 'package.json'), JSON.stringify({ dependencies: { vue: 'workspace:^3.5.0' } }));
    host.invalidate?.();
    expect(await info.vueMajor(`file://${host.root}/src/App.vue`)).toBe(3);
  });

  it('最近 package.json 损坏或不可作为文件读取时不借用祖先版本', async () => {
    await writeFile(path.join(host.root, 'package.json'), JSON.stringify({ dependencies: { vue: '^3.5.0' } }));
    await writeFile(path.join(host.root, 'src/package.json'), '');
    expect(await info.vueMajor(`file://${host.root}/src/App.vue`)).toBeUndefined();
    await rm(path.join(host.root, 'src/package.json'));
    await mkdir(path.join(host.root, 'src/package.json'));
    host.invalidate?.();
    expect(await info.vueMajor(`file://${host.root}/src/App.vue`)).toBeUndefined();
  });
});
