import { describe, expect, it } from 'vitest';
import { IgnoreResolver, type IgnoreFs } from '../../src/core/ignore';

function memFs(files: Record<string, string>, dirs: string[] = []): IgnoreFs & { reads: number } {
  const dirSet = new Set(dirs);
  const fs = {
    reads: 0,
    async readFile(p: string) {
      fs.reads++;
      return files[p];
    },
    async exists(p: string) {
      return p in files || dirSet.has(p);
    },
  };
  return fs;
}

const baseOpts = { respectGitignore: true, exclude: ['**/.env*', '**/*.pem', '**/node_modules/**', '**/dist/**'] };

describe('IgnoreResolver', () => {
  it('exclude 配置命中', async () => {
    const r = new IgnoreResolver(memFs({}, ['/w/.git']), baseOpts);
    expect(await r.isIgnored('/w/.env.local', '/w')).toBe(true);
    expect(await r.isIgnored('/w/keys/a.pem', '/w')).toBe(true);
    expect(await r.isIgnored('/w/src/a.ts', '/w')).toBe(false);
  });

  it('根 .gitignore：被忽略但不在 exclude 里的 JS 文件不许可（评审 P1）', async () => {
    const r = new IgnoreResolver(memFs({ '/w/.gitignore': 'generated/\nsecret.js\n' }, ['/w/.git']), baseOpts);
    expect(await r.isIgnored('/w/generated/api.js', '/w')).toBe(true);
    expect(await r.isIgnored('/w/src/secret.js', '/w')).toBe(true);
    expect(await r.isIgnored('/w/src/ok.js', '/w')).toBe(false);
  });

  it('嵌套 .gitignore 相对其所在目录；更深的优先（可用 ! 取回文件）', async () => {
    const r = new IgnoreResolver(
      memFs(
        {
          '/w/.gitignore': '*.log\n',
          '/w/pkg/.gitignore': '!keep.log\nlocal/\n',
        },
        ['/w/.git'],
      ),
      baseOpts,
    );
    expect(await r.isIgnored('/w/a.log', '/w')).toBe(true);
    expect(await r.isIgnored('/w/pkg/keep.log', '/w')).toBe(false);
    expect(await r.isIgnored('/w/pkg/other.log', '/w')).toBe(true);
    expect(await r.isIgnored('/w/pkg/local/x.ts', '/w')).toBe(true);
    expect(await r.isIgnored('/w/other/local/x.ts', '/w')).toBe(false);
  });

  it('父目录被忽略时无法用 ! 取回其中的文件', async () => {
    const r = new IgnoreResolver(memFs({ '/w/.gitignore': 'build/\n!build/keep.js\n' }, ['/w/.git']), baseOpts);
    expect(await r.isIgnored('/w/build/keep.js', '/w')).toBe(true);
  });

  it('工作区是仓库子目录：祖先 .gitignore 与 .git/info/exclude 生效', async () => {
    const fs = memFs(
      {
        '/repo/.gitignore': 'dist-*\n',
        '/repo/.git/info/exclude': 'scratch.js\n',
        '/repo/apps/web/.gitignore': '',
      },
      ['/repo/.git'],
    );
    const r = new IgnoreResolver(fs, baseOpts);
    expect(await r.isIgnored('/repo/apps/web/dist-x/a.js', '/repo/apps/web')).toBe(true);
    expect(await r.isIgnored('/repo/apps/web/scratch.js', '/repo/apps/web')).toBe(true);
    expect(await r.isIgnored('/repo/apps/web/src/a.js', '/repo/apps/web')).toBe(false);
  });

  it('git 根是家目录时不采用', async () => {
    const r = new IgnoreResolver(memFs({ '/home/u/.gitignore': '*\n' }, ['/home/u/.git']), { ...baseOpts, homeDir: '/home/u' });
    expect(await r.isIgnored('/home/u/proj/a.js', '/home/u/proj')).toBe(false);
  });

  it('respectGitignore=false 只应用 exclude', async () => {
    const r = new IgnoreResolver(memFs({ '/w/.gitignore': 'a.js\n' }, ['/w/.git']), { ...baseOpts, respectGitignore: false });
    expect(await r.isIgnored('/w/a.js', '/w')).toBe(false);
    expect(await r.isIgnored('/w/.env', '/w')).toBe(true);
  });

  it('不属于任何工作区文件夹：只应用 exclude', async () => {
    const r = new IgnoreResolver(memFs({}), baseOpts);
    expect(await r.isIgnored('/tmp/x/node_modules/a.js', undefined)).toBe(true);
    expect(await r.isIgnored('/tmp/x/a.js', undefined)).toBe(false);
  });

  it('peek：未判定前返回 undefined（调用方按不许可处理），判定后返回结果；clear 后失效', async () => {
    const r = new IgnoreResolver(memFs({ '/w/.gitignore': 'a.js\n' }, ['/w/.git']), baseOpts);
    expect(r.peek('/w/a.js')).toBeUndefined();
    await r.isIgnored('/w/a.js', '/w');
    expect(r.peek('/w/a.js')).toBe(true);
    r.clear();
    expect(r.peek('/w/a.js')).toBeUndefined();
  });

  it('规则文件变化后 clear 重新读取', async () => {
    const files: Record<string, string> = { '/w/.gitignore': 'a.js\n' };
    const r = new IgnoreResolver(memFs(files, ['/w/.git']), baseOpts);
    expect(await r.isIgnored('/w/a.js', '/w')).toBe(true);
    files['/w/.gitignore'] = '';
    r.clear();
    expect(await r.isIgnored('/w/a.js', '/w')).toBe(false);
  });

  it('报告实际采用的规则文件，包含工作区外祖先和 info/exclude', async () => {
    const watched = new Set<string>();
    const r = new IgnoreResolver(memFs({}, ['/repo/.git']), {
      ...baseOpts,
      onRuleFile: (file) => watched.add(file),
    });
    expect(await r.isIgnored('/repo/app/src/a.js', '/repo/app')).toBe(false);
    expect(watched).toContain('/repo/.gitignore');
    expect(watched).toContain('/repo/app/src/.gitignore');
    expect(watched).toContain('/repo/.git/info/exclude');
  });

  it('规则读取期间失效：旧许可不写回缓存，新判定正常使用新规则', async () => {
    let resolveOld!: (text: string) => void;
    let first = true;
    const r = new IgnoreResolver({
      exists: async (file) => file === '/w/.git',
      readFile: async (file) => {
        if (file === '/w/.gitignore') {
          if (first) {
            first = false;
            return new Promise<string>((resolve) => { resolveOld = resolve; });
          }
          return 'a.js\n';
        }
        return undefined;
      },
    }, baseOpts);
    const old = r.isIgnored('/w/a.js', '/w');
    while (!resolveOld) {
      await Promise.resolve();
    }
    r.clear();
    expect(await r.isIgnored('/w/a.js', '/w')).toBe(true);
    resolveOld('');
    expect(await old).toBe(true);
    expect(r.peek('/w/a.js')).toBe(true);
  });

  it('读取规则抛异常时按被忽略处理（宁可不发）', async () => {
    const fs: IgnoreFs = {
      async readFile() {
        throw new Error('boom');
      },
      async exists() {
        return true;
      },
    };
    const r = new IgnoreResolver(fs, baseOpts);
    expect(await r.isIgnored('/w/a.js', '/w')).toBe(true);
  });

  it('结果缓存：同一文件不重复读取规则', async () => {
    const fs = memFs({ '/w/.gitignore': 'x\n' }, ['/w/.git']);
    const r = new IgnoreResolver(fs, baseOpts);
    await r.isIgnored('/w/src/a.js', '/w');
    const n = fs.reads;
    await r.isIgnored('/w/src/a.js', '/w');
    expect(fs.reads).toBe(n);
  });

  it('Windows 风格路径', async () => {
    const r = new IgnoreResolver(memFs({ 'C:/w/.gitignore': 'gen/\n' }, ['C:/w/.git']), baseOpts);
    expect(await r.isIgnored('C:\\w\\gen\\a.js', 'C:\\w')).toBe(true);
    expect(await r.isIgnored('C:\\w\\src\\a.js', 'C:\\w')).toBe(false);
  });
});
