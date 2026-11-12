import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HealthState } from '../../src/core/backoff';
import { CompletionCache } from '../../src/core/cache';
import { createCollector } from '../../src/core/collector';
import type { FimClient, FimRequest, FimResult } from '../../src/core/fim/client';
import { BuildWatch } from '../../src/core/buildWatch';
import { cutBalanced } from '../../src/core/linePolicy';
import { Metrics, type CallRecord } from '../../src/core/metrics';
import { CompletionPipeline, type LiveDoc } from '../../src/core/pipeline';
import { postprocessTraced } from '../../src/core/postprocess';
import { Scheduler } from '../../src/core/scheduler';
import { calledDefinitions, relatedSnippets } from '../../src/core/snippets';
import { DEFAULT_CONFIG, type Config } from '../../src/core/types';
import { createScopeSource, fixRedeclare, scopeDeclarations } from '../../src/core/usage';
import { MutableDoc, TestToken, src } from './helpers';

const filler = (count: number) => Array.from({ length: count }, (_, i) => `      const filler${i} = ${i}`);

/** 方法开头声明了变量，光标在 300 多行之后的内层代码块里；后面调用了另一个方法。 */
const FILE = [
  'export default {',
  '  methods: {',
  '    // 选中后关闭弹框',
  '    pickOrderF(value, row) {',
  '      this.selected = value',
  '      if (row.children?.length) {',
  '        this.ids = row.children.filter((item) => !item.disabled)',
  '      }',
  '    },',
  '    otherMethod() {',
  '      let canSelect = "other scope"',
  '    },',
  '    processData(res) {',
  '      let canSelect = []',
  '      const fixed = 1',
  '      if (res.other) {',
  '        let innerOnly = 1',
  '      }',
  ...filler(300),
  '      if (res.success) {',
  '        // 只有 1 个可选的则直接选中',
  '        ',
  '        console.log(canSelect, fixed)',
  '        if (canSelect.length === 1) {',
  '          this.pickOrderF(canSelect[0].value, canSelect[0])',
  '        }',
  '      }',
  '    },',
  '  },',
  '}',
];
const CURSOR = FILE.indexOf('        ');
const source = src(FILE.join('\n'));

describe('scopeDeclarations 光标处按缩进可见的声明', () => {
  it('外层块的声明可见；别的方法里、兄弟嵌套块里的不可见', () => {
    const names = scopeDeclarations(source, CURSOR).map((decl) => `${decl.kind} ${decl.name}`);
    expect(names).toContain('let canSelect');
    expect(names).toContain('const fixed');
    expect(names).not.toContain('let innerOnly');
    expect(scopeDeclarations(source, CURSOR).find((decl) => decl.name === 'canSelect')?.text).toBe('let canSelect = []');
  });

  it('同名时只留最近的一个', () => {
    const text = 'function f() {\n  let a = 1\n  if (x) {\n    let a = 2\n    \n  }\n}';
    expect(scopeDeclarations(src(text), 4).map((decl) => decl.text)).toEqual(['let a = 2']);
  });
});

describe('fixRedeclare 外层已声明的变量不重复声明', () => {
  it('结果首行重复声明外层 let 变量：改成赋值，其余原样', () => {
    const out = fixRedeclare('let canSelect = []\n        res.list.forEach((item) => {\n          canSelect.push(item)\n        })', source, CURSOR, 8);
    expect(out.names).toEqual(['canSelect']);
    expect(out.text.split('\n')[0]).toBe('canSelect = []');
    expect(out.text.split('\n')[2]).toBe('          canSelect.push(item)');
  });

  it('后续行在同一层级的重复声明同样处理；更深层级（新的嵌套块）里的不动', () => {
    const out = fixRedeclare('const first = 1\n        let canSelect = res.list\n        run(() => {\n          let canSelect = 2\n        })', source, CURSOR, 8);
    expect(out.names).toEqual(['canSelect']);
    expect(out.text.split('\n')[1]).toBe('        canSelect = res.list');
    expect(out.text.split('\n')[3]).toBe('          let canSelect = 2');
  });

  it('外层是 const、名字没在外层声明过、不是赋值声明、光标不在语句开头：都不动', () => {
    expect(fixRedeclare('const fixed = 2', source, CURSOR, 8).names).toEqual([]);
    expect(fixRedeclare('let brandNew = []', source, CURSOR, 8).names).toEqual([]);
    expect(fixRedeclare('let canSelect', source, CURSOR, 8).names).toEqual([]);
    const midLine = src('function f() {\n  let a = 1\n  foo(');
    expect(fixRedeclare('let a = 2', midLine, 2, 6).names).toEqual([]);
  });
});

describe('createScopeSource', () => {
  const collect = (enabled: boolean, windowStartLine: number) => createScopeSource(() => enabled).collect({
    docKey: 'file:///a.js', languageId: 'javascript', fileLabel: 'a.js', source, version: 1, line: CURSOR, character: 8,
    windowStartLine, windowText: '', cfg: DEFAULT_CONFIG, framework: 'generic', region: 'other', identifiers: [],
  }, Date.now() + 100);

  it('光标附近用到、声明在窗口之外的外层变量：把声明原文放进提示词', async () => {
    const result = await collect(true, CURSOR - 100);
    expect(result?.status).toBe('2');
    expect(result?.focus).toBe('already declared earlier in this function, outside the visible code (assign, do not redeclare): const fixed = 1 | let canSelect = []');
  });

  it('声明已在窗口内、或开关关闭时不输出', async () => {
    expect(await collect(true, 0)).toBeUndefined();
    expect(await collect(false, CURSOR - 100)).toBeUndefined();
  });
});

describe('calledDefinitions 光标附近调用的方法的定义', () => {
  it('取到光标之后调用的方法定义，带上方注释，到方法结束为止', () => {
    const ranges = calledDefinitions(source, CURSOR);
    expect(ranges).toEqual([{ start: FILE.indexOf('    // 选中后关闭弹框'), end: FILE.indexOf('    },') }]);
  });

  it('作为第一段进入相关片段；已在提示词窗口里的定义不取', () => {
    const input = { source, cursorLine: CURSOR, excludeStart: CURSOR - 100, excludeEnd: CURSOR + 6 };
    const snippets = relatedSnippets(input);
    expect(snippets[0]?.split('\n').slice(0, 2)).toEqual(['// 选中后关闭弹框', 'pickOrderF(value, row) {']);
    expect(snippets[0]).toContain('row.children.filter((item) => !item.disabled)');
    expect(relatedSnippets({ ...input, excludeStart: 0 }).join('\n')).not.toContain('pickOrderF(value, row) {');
  });

  it('调用点、关键字、过长的方法：只认定义行，最多 16 行', () => {
    const long = ['function caller() {', '  helperF(1)', '}', 'if (ready) {', '}', 'function helperF(a) {', ...Array.from({ length: 40 }, (_, i) => `  step${i}()`), '}'];
    const ranges = calledDefinitions(src(long.join('\n')), 0);
    expect(ranges).toEqual([{ start: 5, end: 20 }]);
  });
});

describe('cutBalanced 配平后再截断', () => {
  const block = ['list.forEach((item) => {', '  if (item.ok) {', '    out.push(item)', '  }', '})', 'next()', 'more()'].join('\n');

  it('到行数上限时括号没配平：继续到配平的行尾', () => {
    expect(cutBalanced(block, 3)).toBe(block.split('\n').slice(0, 5).join('\n'));
  });

  it('到行数上限时已配平：就在上限处截；没到上限不截', () => {
    expect(cutBalanced('a()\nb()\nc()\nd()', 2)).toBe('a()\nb()');
    expect(cutBalanced('a()\nb()', 5)).toBeUndefined();
    // 末尾没有换行时还不能确定这一行写完了
    expect(cutBalanced(block.split('\n').slice(0, 5).join('\n'), 3)).toBeUndefined();
  });

  it('一直不配平时硬上限是两倍行数', () => {
    const open = Array.from({ length: 30 }, (_, i) => `f${i}(() => {`).join('\n');
    expect(cutBalanced(open, 4)?.split('\n')).toHaveLength(8);
  });
});

describe('复读：整个结果等于光标前不久的一段', () => {
  const body = ['if (item.children?.length) {', '  item.children.forEach((child) => {', '    canSelect.push(child)', '  })', '}'];
  const prefix = ['list.forEach((item) => {', ...body.map((line) => `  ${line}`), '})', ''].join('\n');
  const pp = (text: string) => postprocessTraced({ text, prefix, suffix: '\nnext()', maxLines: 24 });

  it('没接在最后一行的整段复读也拒绝', () => {
    expect(pp(body.join('\n'))).toEqual({ text: '', rules: ['replay'] });
  });

  it('开头相同但后面有新内容：照着上一段写相似的块是正常写法，不拒绝', () => {
    const similar = [...body.slice(0, 2), '    otherList.push(child)', '  })', '}'].join('\n');
    expect(pp(similar).rules).not.toContain('replay');
  });

  it('开头多一行新注释、或末行的 "}" 对上的是 "} else {"：仍然算复读', () => {
    expect(pp(['// 其他情况', ...body].join('\n')).rules).toEqual(['replay']);
    const written = ['if (this.isSpecial) {', '  this.current = items.find(', "    (item) => item.id === '8'", '  )', '} else {', '  this.current = null', '}', ''].join('\n');
    const again = ['if (this.isSpecial) {', '  this.current = items.find(', "    (item) => item.id === '8'", '  )', '}'].join('\n');
    expect(postprocessTraced({ text: again, prefix: written, suffix: '\nnext()', maxLines: 24 }).rules).toEqual(['replay']);
  });

  it('只有闭合符对得上的不算', () => {
    expect(pp('}\n})\n}\n})').rules).not.toContain('replay');
  });

  it('不足 4 行或太短的不算', () => {
    expect(pp('  })\n}').rules).not.toContain('replay');
  });
});

describe('管线：软截断与重复声明修正', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('注释之后的整段：超过行数上限但未配平时保留到配平，重复的 let 改成赋值，日志记录规则', async () => {
    const cfg: Config = { ...DEFAULT_CONFIG, maxLines: 3 };
    const reply = 'let canSelect = []\n        res.list.forEach((item) => {\n          if (item.ok) {\n            canSelect.push(item)\n          }\n        })\n        extra()\n        more()';
    const requests: FimRequest[] = [];
    const fim: FimClient = {
      async complete(req: FimRequest): Promise<FimResult> {
        requests.push(req);
        return { text: reply, finishReason: 'stop', totalMs: 1 };
      },
    };
    const logs: CallRecord[] = [];
    const mutable = new MutableDoc(FILE.join('\n'));
    const doc: LiveDoc = {
      key: 'file:///a.js', languageId: 'javascript', fileLabel: 'a.js', source: mutable.source,
      version: () => mutable.version, cursorIsAt: () => true,
    };
    const pipeline = new CompletionPipeline({
      cfg: () => cfg, cache: new CompletionCache(), scheduler: new Scheduler({ timeoutMs: () => cfg.timeoutMs }), fim,
      collector: createCollector({ sources: [createScopeSource(() => true)], vueMajor: async () => undefined }),
      depsIo: { stat: async () => undefined, isDirty: () => false }, health: new HealthState(), metrics: new Metrics(),
      log: (line) => logs.push(JSON.parse(line) as CallRecord),
    });
    const pending = pipeline.run({ doc, position: { line: CURSOR, character: 8 }, trigger: 'auto', token: new TestToken() });
    await vi.advanceTimersByTimeAsync(5000);
    const text = (await pending)?.text ?? '';
    expect(text.split('\n')).toHaveLength(6);
    expect(text.split('\n')[0]).toBe('canSelect = []');
    expect(text.split('\n').at(-1)).toBe('        })');
    expect(logs[0]).toMatchObject({ outcome: 'shown', mode: 'block', scope: '2', pp: ['balanced', 'redeclare'] });
    expect(requests[0]?.prompt).toContain('already declared earlier in this function');
    expect(requests[0]?.maxTokens).toBe(DEFAULT_CONFIG.maxTokensManual);
  });
});

describe('代码块结束之后缩进更深的续写', () => {
  const prefix = ['    if (ready) {', '      if (this.isSpecial) {', '        this.current = items[0]', '      }'].join('\n');
  const pp = (text: string, before = prefix) => postprocessTraced({ text, prefix: before, suffix: '\n    }', maxLines: 24 });

  it('光标在 "}" 之后，另起一行却缩进更深：拒绝', () => {
    expect(pp('\n        // 其他情况\n        this.current = items[1]\n        this.current.active = true')).toEqual({ text: '', rules: ['overindent'] });
  });

  it('另起一行缩进相同或更浅、链式调用的延续、光标不在闭合行之后：不受影响', () => {
    expect(pp('\n      this.done = true').rules).not.toContain('overindent');
    expect(pp('\n    }').rules).not.toContain('overindent');
    expect(pp('\n        .then(() => this.done())', '    load().then(() => {\n      })').rules).not.toContain('overindent');
    expect(pp('\n        nested()', '      if (ready) {').rules).not.toContain('overindent');
    expect(pp('this.next()').rules).not.toContain('overindent');
  });
});

describe('BuildWatch 磁盘上的扩展被替换', () => {
  it('文件修改时间变了才算过期，只提醒一次', () => {
    let mtime: number | undefined = 100;
    const watch = new BuildWatch(() => mtime);
    expect(watch.stale).toBe(false);
    expect(watch.shouldNotify()).toBe(false);
    mtime = 200;
    expect(watch.stale).toBe(true);
    expect(watch.shouldNotify()).toBe(true);
    expect(watch.shouldNotify()).toBe(false);
    expect(watch.stale).toBe(true);
  });

  it('读不到文件时不提醒', () => {
    let mtime: number | undefined;
    const missing = new BuildWatch(() => mtime);
    mtime = 200;
    expect(missing.shouldNotify()).toBe(false);
    let later: number | undefined = 100;
    const removed = new BuildWatch(() => later);
    later = undefined;
    expect(removed.shouldNotify()).toBe(false);
  });
});

describe('整段被 // 包着：还原成代码', () => {
  const prefix = '          } else {\n            // 判断是否是挽留补偿类型的\n            ';
  const pp = (text: string) => postprocessTraced({ text, prefix, suffix: '\n          }\n        }\n', maxLines: 24 });
  const wrapped = [
    'if (this.isWLBC) {',
    "            //   this.current = items.find(",
    "            //     (item) => item.id === '8'",
    '            //   )',
    '            // } else if (this.justPay) {',
    "            //   this.current = items[0]",
    '            // }',
  ].join('\n');

  it('首行是代码、其后整段是注释、去掉前缀后括号配平：还原，缩进保持', () => {
    const out = pp(wrapped);
    expect(out.rules).toEqual(['uncomment']);
    expect(out.text.split('\n')).toEqual([
      'if (this.isWLBC) {',
      '              this.current = items.find(',
      "                (item) => item.id === '8'",
      '              )',
      '            } else if (this.justPay) {',
      '              this.current = items[0]',
      '            }',
    ]);
  });

  it('真正的注释不动：首行也是注释、首行不是开块、去掉后括号不配平、混有代码行、行数太少', () => {
    expect(pp('// 说明一\n            // 说明二\n            // 说明三\n            // 说明四').rules).not.toContain('uncomment');
    expect(pp('run()\n            // 说明二\n            // 说明三\n            // 说明四').rules).not.toContain('uncomment');
    expect(pp('if (a) {\n            //   b()\n            //   c()\n            //   d()').rules).not.toContain('uncomment');
    expect(pp('if (a) {\n            //   b()\n            run()\n            //   c()\n            // }').rules).not.toContain('uncomment');
    expect(pp('if (a) {\n            //   b()\n            // }').rules).not.toContain('uncomment');
  });
});

describe('后文回声：把后面已有的代码又写一遍', () => {
  const suffix = ['', '      }', '      console.log({ reason1IsSame, reason2IsSame })', '      if (!reason1IsSame || !reason2IsSame) {', '        this.setFirstAndSecondReasonF(res.reason1?.value, res.reason2?.value)', '      }'].join('\n');
  const prefix = "      if (/* 商家险并且是分段履约 */ this._isSegment && res.reason1?.value) {\n        ";
  const pp = (text: string) => postprocessTraced({ text, prefix, suffix, maxLines: 24 });

  it('结果就是后文里某一行（日志里 seq 9 的原文）：整条拒绝', () => {
    expect(pp('this.setFirstAndSecondReasonF(res.reason1?.value, res.reason2?.value)')).toEqual({ text: '', rules: ['suffixEcho'] });
  });

  it('中间出现这一行：从该行起截断，前面的新内容保留', () => {
    const out = pp('const status = this.update(res)\n        this.setFirstAndSecondReasonF(res.reason1?.value, res.reason2?.value)\n        done()');
    expect(out).toEqual({ text: 'const status = this.update(res)', rules: ['suffixEcho'] });
  });

  it('短行、注释行、和后文只是相似不是相同、光标之后 80 行以外的行：不受影响', () => {
    expect(pp('this.setFirstAndSecondReasonF(res.reason1?.value, res.reason2)').rules).toEqual([]);
    expect(pp('console.log({ a })').rules).toEqual([]);
    expect(postprocessTraced({
      text: '// this.setFirstAndSecondReasonF(res.reason1?.value, res.reason2?.value)', prefix, maxLines: 24,
      suffix: `\n      other()\n      // this.setFirstAndSecondReasonF(res.reason1?.value, res.reason2?.value)`,
    }).rules).toEqual([]);
    const far = ['', ...Array.from({ length: 90 }, (_, i) => `      const filler${i} = ${i}`), '      this.setFirstAndSecondReasonF(res.reason1?.value, res.reason2?.value)'].join('\n');
    expect(postprocessTraced({ text: 'this.setFirstAndSecondReasonF(res.reason1?.value, res.reason2?.value)', prefix, suffix: far, maxLines: 24 }).rules).toEqual([]);
  });
});

describe('按后文截断后留下的残句', () => {
  const prefix = '      if (a) {\n        ';
  const suffix = ['', '      }', '      if (res.serviceType) {', '        this.serviceTypeItems = [', '          ...(this.$refs.mainPopRef?.serviceTypeList || [])', '        ]', '      }'].join('\n');
  const pp = (text: string) => postprocessTraced({ text, prefix, suffix, maxLines: 24 });

  it('截在回声行之前，剩下的括号没配平且不是块开头：整条不展示（日志里 seq 5）', () => {
    const out = pp('// 商家险分段履约 需要重新渲染\n        this.serviceTypeItems = [\n          ...(this.$refs.mainPopRef?.serviceTypeList || [])\n        ]');
    expect(out).toEqual({ text: '', rules: ['suffixEcho', 'fragment'] });
  });

  it('剩下的以 { 结尾（块开头）：可以单独展示；剩下的是完整语句：不受影响', () => {
    expect(pp('if (res.reason1?.value) {\n          ...(this.$refs.mainPopRef?.serviceTypeList || [])\n        }')).toEqual({ text: 'if (res.reason1?.value) {', rules: ['suffixEcho'] });
    expect(pp('const status = this.update(res)\n          ...(this.$refs.mainPopRef?.serviceTypeList || [])').text).toBe('const status = this.update(res)');
  });

  it('不是按后文截断的结果不受这条规则影响', () => {
    expect(postprocessTraced({ text: 'foo(', prefix, suffix: '\nbar()', maxLines: 24 }).rules).not.toContain('fragment');
  });
});

describe('整块照抄窗口里已有的代码', () => {
  const block = [
    'this.mdF2({', "  key: this.pageId + '|mdError2',", '  value: {', "    anTitle: '履约闭环报案页面身份证没有填写还没有露出,强制露出',",
    "    msg: '身份证未上传',", '    identityCardAjaxObj: this.identityCardAjaxObj,', '    getIDCardSuccess: this.getIDCardSuccess,',
    '    SC1notUpload: this.SC1notUpload,', '    _isRepeatOrder: this._isRepeatOrder', '  }', '})',
  ];
  const far = [
    'if (a) {', '  step1()', '  step2()', ...block.map((l) => `  ${l}`), '}',
    ...Array.from({ length: 60 }, (_, i) => `const filler${i} = ${i}`),
    'if (ready) {', '  ',
  ].join('\n');
  const suffix = '\n} else {\n  other()\n}';
  const pp = (text: string, before = far) => postprocessTraced({ text, prefix: before, suffix, maxLines: 24 });

  it('连续 11 行逐行相同、占结果的大部分（日志里 seq 27）：整条拒绝，哪怕外面包了一层新的 if', () => {
    const copied = ['if (this._isRepeatOrder) {', ...block.map((l) => `  ${l}`), "  this.$toastMd('身份证未上传')", "  return this.$toastMd('身份证未上传')", '}'].join('\n');
    expect(pp(copied)).toEqual({ text: '', rules: ['clone'] });
    expect(pp(block.join('\n')).rules).toEqual(['clone']);
  });

  it('只相同开头几行、中间换了内容的相似块：不算照抄', () => {
    const similar = block.map((l) => l.replace("'|mdError2'", "'|mdWarn3'").replace('身份证未上传', '发票未上传').replace('identityCardAjaxObj', 'invoiceAjaxObj').replace('getIDCardSuccess', 'getInvoiceSuccess'));
    expect(pp(similar.join('\n')).rules).not.toContain('clone');
  });

  it('连续相同的行不够长或占比低：不算照抄', () => {
    // 只有 5 行连续相同
    expect(pp([...block.slice(0, 5), 'brandNew1()', 'brandNew2()', 'brandNew3()', 'brandNew4()'].join('\n')).rules).not.toContain('clone');
    // 6 行连续相同，但占比低于 60%
    const mostlyNew = [...block.slice(2, 8), ...Array.from({ length: 10 }, (_, i) => `    const brandNew${i} = compute(${i}, 'value-${i}')`)];
    expect(pp(mostlyNew.join('\n')).rules).not.toContain('clone');
    // 注释不参与
    expect(pp(block.map((l) => `// ${l}`).join('\n')).rules).not.toContain('clone');
  });
});
