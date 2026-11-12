import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HealthState } from '../../src/core/backoff';
import { CompletionCache } from '../../src/core/cache';
import { createCollector, type ContextSource } from '../../src/core/collector';
import type { DepsIo } from '../../src/core/deps';
import type { FimClient, FimRequest, FimResult } from '../../src/core/fim/client';
import { Metrics, type CallRecord } from '../../src/core/metrics';
import { CompletionPipeline, type LiveDoc } from '../../src/core/pipeline';
import { Scheduler } from '../../src/core/scheduler';
import { intentComment } from '../../src/core/snippets';
import { DEFAULT_CONFIG, type Config } from '../../src/core/types';
import { MutableDoc, TestToken, src } from './helpers';

const INTENT = '  // 把订单列表按状态分组并返回结果';
const HEAD = ['function isExpired(order) {', '  return order.expireAt < now', '}'];
const filler = Array.from({ length: 40 }, (_, i) => `const filler${i} = ${i}`);

function baseLines(intent = INTENT): string[] {
  return [...HEAD, ...filler, 'function group(orders) {', intent, '  ', '}'];
}

describe('intentComment', () => {
  it('光标在空行或注释行上；中间最多隔 3 个空行；太短的不算', () => {
    const s = src(['a()', '  // 把订单列表按状态分组', '', '  '].join('\n'));
    expect(intentComment(s, 3)).toEqual({ text: '// 把订单列表按状态分组', line: 1 });
    expect(intentComment(s, 1)?.line).toBe(1);
    expect(intentComment(src('a()\n// x\n  '), 2)).toBeUndefined();
    expect(intentComment(src('// 说明\n\n\n\n\n  '), 5)).toBeUndefined();
    expect(intentComment(src('a()\nb()\n  '), 2)).toBeUndefined();
  });
});

describe('头部沿用', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  class Fim implements FimClient {
    prompts: string[] = [];
    async complete(req: FimRequest): Promise<FimResult> {
      this.prompts.push(req.prompt);
      return { text: 'return grouped', finishReason: 'stop', totalMs: 1 };
    }
  }

  function setup(over: Partial<Config> = {}) {
    let cfg: Config = { ...DEFAULT_CONFIG, ...over };
    const fim = new Fim();
    const logs: CallRecord[] = [];
    const calls = { n: 0 };
    const stats = new Map<string, { mtimeMs: number; size: number }>([['file:///dep.js', { mtimeMs: 1, size: 1 }]]);
    const depsIo: DepsIo = { stat: async (u) => stats.get(u), isDirty: () => false };
    let withDep = false;
    const source: ContextSource = {
      name: 'snippets',
      async collect() {
        calls.n++;
        return {
          members: [{ kind: 'methods', name: 'group' }],
          snippets: [HEAD.join('\n').replace(/\n {2}/g, '\n  ')],
          ...(withDep ? { related: [{ name: 'Dep', file: 'dep.js', interface: [{ kind: 'props', name: 'value' }], dep: { uri: 'file:///dep.js', mtimeMs: 1, size: 1 } }] } : {}),
        };
      },
    };
    const mutable = new MutableDoc(baseLines().join('\n'));
    const doc: LiveDoc = {
      key: 'file:///a.js', languageId: 'javascript', fileLabel: 'a.js', source: mutable.source,
      version: () => mutable.version, cursorIsAt: () => true,
    };
    const pipeline = new CompletionPipeline({
      cfg: () => cfg, cache: new CompletionCache(), scheduler: new Scheduler({ timeoutMs: () => cfg.timeoutMs }), fim,
      collector: createCollector({ sources: [source], vueMajor: async () => undefined }), depsIo, health: new HealthState(),
      metrics: new Metrics(), log: (line) => {
        if (line.startsWith('{')) {
          logs.push(JSON.parse(line) as CallRecord);
        }
      },
    });
    const run = async (line: number, trigger: 'auto' | 'manual' = 'auto') => {
      const pending = pipeline.run({ doc, position: { line, character: (mutable.lines[line] ?? '').length }, trigger, token: new TestToken() });
      await vi.advanceTimersByTimeAsync(5000);
      return pending;
    };
    /** 模拟接受补全：在光标行写入若干行，光标落到新的末行 */
    const accept = (line: number, text: string[]) => {
      mutable.lines.splice(line, 1, ...text, '  ');
      mutable.version++;
      return line + text.length;
    };
    /** 接受一行补全并在新的光标处触发；每次文档都变，本地缓存不会替它回答 */
    let counter = 0;
    const step = async (line: number, trigger: 'auto' | 'manual' = 'auto') => {
      const next = accept(line, [`  const part${counter++} = ${counter}`]);
      await run(next, trigger);
      return next;
    };
    return {
      fim, logs, calls, mutable, run, accept, step, stats,
      setCfg: (next: Partial<Config>) => { cfg = { ...cfg, ...next }; },
      useDep: () => { withDep = true; },
      invalidate: () => pipeline.invalidate(),
      closeDoc: () => pipeline.onDocumentClosed('file:///a.js'),
    };
  }
  const CURSOR = baseLines().indexOf('  ');
  const common = (a: string, b: string) => {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) {
      i++;
    }
    return i;
  };

  it('同一段意图之下连续两次：第二次不再收集，沿用头部，两次提示词共享到上一次的光标处', async () => {
    const h = setup();
    await h.run(CURSOR);
    const next = h.accept(CURSOR, ['  const grouped = {}', '  orders.forEach((o) => { grouped[o.status] = o })']);
    await h.run(next);
    expect(h.calls.n).toBe(1);
    expect(h.logs.map((log) => log.hdr)).toEqual(['fresh', 'reuse']);
    const [first, second] = h.fim.prompts as [string, string];
    // 第一次提示词止于光标处的缩进；第二次在它之后接着写，前面的部分逐字相同
    expect(common(first, second)).toBeGreaterThanOrEqual(first.length - 4);
    expect(common(first, second) / second.length).toBeGreaterThan(0.85);
  });

  it('没有沿用时：头部变了，提示词前缀几乎不共享（对照）', async () => {
    const h = setup({ reuseHeader: 'off' });
    await h.run(CURSOR);
    h.accept(CURSOR, ['  const grouped = {}']);
    await h.run(CURSOR + 1);
    expect(h.logs.map((log) => log.hdr)).toEqual(['fresh', 'fresh']);
    expect(h.calls.n).toBe(2);
  });

  it('光标自己的意图换了、手动触发、超过 5 分钟、离开 60 行以上、配置变化：重新收集', async () => {
    const h = setup();
    await h.run(CURSOR);

    // 手动触发
    let line = await h.step(CURSOR, 'manual');
    expect(h.logs.at(-1)?.hdr).toBe('fresh');

    // 沿用之后，超过 5 分钟
    line = await h.step(line);
    expect(h.logs.at(-1)?.hdr).toBe('reuse');
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    line = await h.step(line);
    expect(h.logs.at(-1)?.hdr).toBe('fresh');

    // 离开 60 行以上
    line = h.accept(line, Array.from({ length: 70 }, (_, i) => `  const step${i} = ${i}`));
    await h.run(line);
    expect(h.logs.at(-1)?.hdr).toBe('fresh');

    // 新的意图：光标上方换了一条注释
    const before = h.calls.n;
    line = h.accept(line, ['  // 过滤掉已经取消的订单再统计数量']);
    await h.run(line);
    expect(h.logs.at(-1)?.hdr).toBe('fresh');
    expect(h.calls.n).toBe(before + 1);

    // 配置变化
    line = await h.step(line);
    expect(h.logs.at(-1)?.hdr).toBe('reuse');
    h.setCfg({ epoch: 99 });
    await h.step(line);
    expect(h.logs.at(-1)?.hdr).toBe('fresh');
  });

  it('在原位置附近写了新的意图注释：即使旧的意图仍在上方，也重新收集', async () => {
    const h = setup();
    await h.run(CURSOR);
    let line = await h.step(CURSOR);
    expect(h.logs.at(-1)?.hdr).toBe('reuse');
    const before = h.calls.n;
    line = h.accept(line, ['  // 过滤掉已经取消的订单再统计数量']);
    await h.run(line);
    expect(h.logs.at(-1)?.hdr).toBe('fresh');
    expect(h.calls.n).toBe(before + 1);
    // 新的意图成为之后沿用的依据
    await h.step(line);
    expect(h.logs.at(-1)?.hdr).toBe('reuse');
  });

  it('当时的意图注释被删掉、头部引用的代码被改过（包括片段中间的行）：重新收集', async () => {
    const edited = setup();
    await edited.run(CURSOR);
    const next = edited.accept(CURSOR, ['  const grouped = {}']);
    edited.mutable.lines[1] = '  return order.expireAt <= now'; // 被引用的片段改了中间一行
    edited.mutable.version++;
    await edited.run(next);
    expect(edited.logs.at(-1)?.hdr).toBe('fresh');

    const removed = setup();
    await removed.run(CURSOR);
    const after = removed.accept(CURSOR, ['  const grouped = {}']);
    removed.mutable.lines.splice(removed.mutable.lines.indexOf(INTENT), 1);
    removed.mutable.version++;
    await removed.run(after - 1);
    expect(removed.logs.at(-1)?.hdr).toBe('fresh');
  });

  it('头部里引用的其他文件变了：不沿用', async () => {
    const h = setup();
    h.useDep();
    await h.run(CURSOR);
    const next = h.accept(CURSOR, ['  const grouped = {}']);
    h.stats.set('file:///dep.js', { mtimeMs: 2, size: 1 });
    await h.run(next);
    expect(h.logs.at(-1)?.hdr).toBe('fresh');
  });

  it('第一次没有意图注释、也不在任何代码块里：不记录；关闭文档、invalidate 后也清掉', async () => {
    const none = setup();
    none.mutable.lines.splice(0, none.mutable.lines.length, 'const a = 1', '');
    none.mutable.version++;
    let line = await none.step(1);
    line = await none.step(line);
    expect(none.logs.map((log) => log.hdr)).toEqual(['fresh', 'fresh']);

    const closed = setup();
    await closed.run(CURSOR);
    closed.closeDoc();
    await closed.step(CURSOR);
    expect(closed.logs.at(-1)?.hdr).toBe('fresh');

    const reset = setup();
    await reset.run(CURSOR);
    reset.invalidate();
    await reset.step(CURSOR);
    expect(reset.logs.at(-1)?.hdr).toBe('fresh');
  });

  it('会话统计显示沿用次数', async () => {
    const h = setup();
    await h.run(CURSOR);
    const next = h.accept(CURSOR, ['  const grouped = {}']);
    await h.run(next);
    expect(h.logs.filter((log) => log.hdr === 'reuse')).toHaveLength(1);
  });
});

describe('头部沿用：同一个代码块内', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const OPENER = '      if (/* 商家险并且是分段履约 */ this._isSegment && res.reason1?.value) {';
  const LINES = [
    ...HEAD, ...filler,
    'export default {', '  methods: {', '    onConfirm(res) {', '      const same = res.a === this.a', OPENER, '        ', '      }', '      this.after()', '    },', '  },', '}',
  ];
  const BODY = LINES.indexOf('        ');

  class Fim implements FimClient {
    prompts: string[] = [];
    async complete(req: FimRequest): Promise<FimResult> {
      this.prompts.push(req.prompt);
      return { text: 'this.go()', finishReason: 'stop', totalMs: 1 };
    }
  }

  function setup(over: Partial<Config> = {}) {
    // 成员校验会在发现文件里没有的 this 成员时重新收集并重发，这里只测头部沿用，关掉它
    const cfg: Config = { ...DEFAULT_CONFIG, verifyMembers: 'off', ...over };
    const fim = new Fim();
    const logs: CallRecord[] = [];
    const calls = { n: 0 };
    const base: ContextSource = {
      name: 'snippets',
      async collect() {
        calls.n++;
        return { members: [{ kind: 'methods', name: 'onConfirm' }], snippets: [HEAD.join('\n')] };
      },
    };
    // 和真实的候选名字来源一致：光标前是 this. 时才有候选行，否则返回空
    const usage: ContextSource = {
      name: 'usage',
      async collect(ctx) {
        const before = ctx.source.lineAt(ctx.line).slice(0, ctx.character);
        return /this\.$/.test(before) ? { focus: 'known members of this: a, b', status: 'member:2' } : undefined;
      },
    };
    const mutable = new MutableDoc(LINES.join('\n'));
    const doc: LiveDoc = {
      key: 'file:///b.js', languageId: 'javascript', fileLabel: 'b.js', source: mutable.source,
      version: () => mutable.version, cursorIsAt: () => true,
    };
    const pipeline = new CompletionPipeline({
      cfg: () => cfg, cache: new CompletionCache(), scheduler: new Scheduler({ timeoutMs: () => cfg.timeoutMs }), fim,
      collector: createCollector({ sources: [base, usage], vueMajor: async () => undefined }),
      depsIo: { stat: async () => undefined, isDirty: () => false }, health: new HealthState(), metrics: new Metrics(),
      log: (line) => {
        if (line.startsWith('{')) {
          logs.push(JSON.parse(line) as CallRecord);
        }
      },
    });
    let counter = 0;
    /** 在 line 行写入 text，光标落到下一行（缩进与 indent 相同）；返回新的光标行 */
    const write = (line: number, text: string, indent: string) => {
      mutable.lines.splice(line, 1, text, indent);
      mutable.version++;
      return line + 1;
    };
    const run = async (line: number, trigger: 'auto' | 'manual' = 'auto') => {
      const pending = pipeline.run({
        doc, position: { line, character: (mutable.lines[line] ?? '').length }, trigger, token: new TestToken(),
      });
      await vi.advanceTimersByTimeAsync(5000);
      counter++;
      return pending;
    };
    return { fim, logs, calls, mutable, write, run };
  }

  it('在块里逐行往下写：第一次收集并记下块开头行，后面几次沿用，提示词共享长前缀', async () => {
    const h = setup();
    await h.run(BODY);
    let line = h.write(BODY, '        const status = this.update(res)', '        ');
    await h.run(line);
    line = h.write(line, '        console.log(status)', '        ');
    await h.run(line);
    expect(h.calls.n).toBe(1);
    expect(h.logs.map((log) => [log.hdr, log.hdrBy])).toEqual([['fresh', 'block'], ['reuse', 'block'], ['reuse', 'block']]);
    const [a, b] = h.fim.prompts as [string, string, string];
    let i = 0;
    while (i < a.length && a[i] === b[i]) {
      i++;
    }
    expect(i).toBeGreaterThanOrEqual(a.length - 4);
  });

  it('块里又开了一层：仍在原来的块里，沿用；写完块回到外面（块开头行不再包着光标）：重新收集', async () => {
    const h = setup();
    await h.run(BODY);
    let line = h.write(BODY, '        items.forEach((item) => {', '          ');
    await h.run(line);
    expect(h.logs.at(-1)).toMatchObject({ hdr: 'reuse', hdrBy: 'block' });
    expect(h.calls.n).toBe(1);

    // 光标在块外：写到 "}" 之后、与块开头行同一缩进
    h.mutable.lines.splice(line, 1, '          run(item)', '        })');
    h.mutable.version++;
    line += 2;
    const out = h.mutable.lines.indexOf('      this.after()');
    h.mutable.lines.splice(out, 0, '      ');
    h.mutable.version++;
    await h.run(out);
    expect(h.logs.at(-1)?.hdr).toBe('fresh');
    expect(h.calls.n).toBe(2);
  });

  it('光标前正在补候选名字（this.）：这一次重新收集，候选行不会带进之后沿用的头部', async () => {
    const h = setup();
    await h.run(BODY);
    let line = h.write(BODY, '        const status = 1', '        ');
    h.mutable.lines[line] = '        this.';
    h.mutable.version++;
    await h.run(line);
    expect(h.logs.at(-1)?.hdr).toBe('fresh');
    expect(h.fim.prompts.at(-1)).toContain('known members of this: a, b');

    h.mutable.lines[line] = '        this.go()';
    line = h.write(line, '        this.go()', '        ');
    await h.run(line);
    expect(h.logs.at(-1)?.hdr).toBe('reuse');
    expect(h.fim.prompts.at(-1)).not.toContain('known members of this');
  });

  it("设置为 'intent' 时只认意图注释，块里逐行写不沿用；'off' 都不沿用", async () => {
    const intentOnly = setup({ reuseHeader: 'intent' });
    await intentOnly.run(BODY);
    const line = intentOnly.write(BODY, '        const status = 1', '        ');
    await intentOnly.run(line);
    expect(intentOnly.logs.map((log) => log.hdr)).toEqual(['fresh', 'fresh']);
    expect(intentOnly.calls.n).toBe(2);
  });

  it('块开头行太短（如 try {）区分度低，不当锚点：退到更外一层足够长的开头行；一层都没有则不沿用', async () => {
    const outer = setup();
    outer.mutable.lines[outer.mutable.lines.indexOf(OPENER)] = '      try {';
    outer.mutable.version++;
    await outer.run(BODY);
    let line = outer.write(BODY, '        const status = 1', '        ');
    await outer.run(line);
    expect(outer.logs.map((log) => [log.hdr, log.hdrBy])).toEqual([['fresh', 'block'], ['reuse', 'block']]);

    const none = setup();
    none.mutable.lines.splice(0, none.mutable.lines.length, 'const a = 1', 'try {', '  ', '}');
    none.mutable.version++;
    line = none.write(2, '  const b = 2', '  ');
    await none.run(2);
    await none.run(line);
    expect(none.logs.map((log) => log.hdr)).toEqual(['fresh', 'fresh']);
  });
});
