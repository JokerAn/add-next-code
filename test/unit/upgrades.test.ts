import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HealthState } from '../../src/core/backoff';
import { BuildWatch } from '../../src/core/buildWatch';
import { CompletionCache } from '../../src/core/cache';
import { createCollector } from '../../src/core/collector';
import type { FimClient, FimRequest, FimResult } from '../../src/core/fim/client';
import { modelKeyOf } from '../../src/core/fim/prompt';
import { renderHeader } from '../../src/core/header';
import { cutBalanced, cutStatement, effectiveDebounceMs, netDepth, shouldSkipAutoTrigger } from '../../src/core/linePolicy';
import { Metrics } from '../../src/core/metrics';
import { selectOpenTabSnippets } from '../../src/core/openTabs';
import { CompletionPipeline, type LiveDoc } from '../../src/core/pipeline';
import { postprocessTraced } from '../../src/core/postprocess';
import { Scheduler } from '../../src/core/scheduler';
import { findSfcBlocks } from '../../src/core/sfc';
import { createSnippetSource, intentComment, queryOf, relatedSnippets, subTokensOf } from '../../src/core/snippets';
import { DEFAULT_CONFIG } from '../../src/core/types';
import { countNewProps, unverifiedStateItemProps } from '../../src/core/usage';
import { buildWindow, cursorOf, readPrefix, type WindowLimits } from '../../src/core/window';
import { MutableDoc, TestToken, src } from './helpers';

const limits: WindowLimits = { prefixChars: 6000, suffixChars: 1500, maxPrefixLines: 300, maxSuffixLines: 4 };

describe('升级优化回归', () => {
  describe('CompletionCache 多行回车续显与边界兼容性', () => {
    it('手动敲完多行补全的首行并回车：首行尾随空格或字符预算导致底部滑入新行均不影响续显命中', () => {
      const charLimited: WindowLimits = { prefixChars: 6000, suffixChars: 42, maxPrefixLines: 300, maxSuffixLines: 100 };
      const doc = new MutableDoc([
        'function run() {',
        '  ',
        '  const tail1 = 1;',
        '  const tail2 = 2;',
        '  const tail3 = 3;',
        '}',
      ].join('\n'));
      const cache = new CompletionCache();
      const pos0 = { line: 1, character: 2 };
      const win0 = buildWindow(doc.source, pos0, undefined, charLimited);
      const completion = 'const a = 1;\n  const b = 2;';
      cache.put({
        docKey: 'doc',
        modelKey: 'm',
        windowStartLine: win0.startLine,
        windowStartChar: win0.startChar,
        anchorLine: win0.anchorLine,
        prefix: win0.prefix,
        suffix: win0.suffix,
        completion,
        deps: [],
      });

      // 模拟用户手动敲完第一行并回车，同时光标右侧留有编辑器自动缩进的空格，且 suffix 字符预算因某处变化而略有不同
      doc.lines.splice(1, 1, '  const a = 1;', '    ');
      doc.version++;
      const pos1 = { line: 2, character: 2 }; // 光标后还有 2 个空格
      const win1 = buildWindow(doc.source, pos1, undefined, { ...charLimited, suffixChars: 80 });
      expect(win1.suffix).not.toBe(win0.suffix); // 光标后首行有空白 + 底部多读入一行，严格全等原本会失败

      const cursor1 = cursorOf(pos1);
      const hit = cache.lookup({
        docKey: 'doc',
        modelKey: 'm',
        suffix: win1.suffix,
        cursorLine: cursor1.before.line,
        readPrefix: (sl, sc, maxChars) => readPrefix(doc.source, sl, sc, cursor1, maxChars),
      });
      expect(hit).toMatchObject({ text: 'const b = 2;', remainder: true });
    });

    it('后文实际代码被修改时绝不误命中续显', () => {
      const doc = new MutableDoc(['function run() {', '  ', '  const tail1 = 1;', '}'].join('\n'));
      const cache = new CompletionCache();
      const pos0 = { line: 1, character: 2 };
      const win0 = buildWindow(doc.source, pos0, undefined, limits);
      cache.put({
        docKey: 'doc', modelKey: 'm',
        windowStartLine: win0.startLine, windowStartChar: win0.startChar, anchorLine: win0.anchorLine,
        prefix: win0.prefix, suffix: win0.suffix, completion: 'const a = 1;\n  const b = 2;', deps: [],
      });
      doc.lines.splice(1, 2, '  const a = 1;', '  ', '  const tail1 = 999;');
      doc.version++;
      const pos1 = { line: 2, character: 2 };
      const win1 = buildWindow(doc.source, pos1, undefined, limits);
      const cursor1 = cursorOf(pos1);
      expect(cache.lookup({
        docKey: 'doc', modelKey: 'm', suffix: win1.suffix, cursorLine: cursor1.before.line,
        readPrefix: (sl, sc, maxChars) => readPrefix(doc.source, sl, sc, cursor1, maxChars),
      })).toBeUndefined();
    });
  });

  describe('modelKeyOf 完整性', () => {
    it('maxTokensManual 或 maxLines 变化时产生不同的模型键', () => {
      const base = modelKeyOf(DEFAULT_CONFIG);
      expect(modelKeyOf({ ...DEFAULT_CONFIG, maxTokensManual: 512 })).not.toBe(base);
      expect(modelKeyOf({ ...DEFAULT_CONFIG, maxLines: 24 })).not.toBe(base);
    });
  });

  describe('linePolicy 块注释与模板字符串插值括号扫描', () => {
    it('块注释 /* ... */ 内的未闭合括号不影响 netDepth / cutStatement / cutBalanced', () => {
      expect(netDepth('/* ( { [ */ const a = 1;')).toBe(0);
      expect(cutStatement('/* 注释里的 ( */ foo();\nbar();')).toBe('/* 注释里的 ( */ foo();');
      const multi = ['/* 多行注释 {', '  未闭合 (', '*/', 'const x = 1;', 'const y = 2;', 'const z = 3;'].join('\n');
      expect(cutBalanced(multi, 4)).toBe(['/* 多行注释 {', '  未闭合 (', '*/', 'const x = 1;'].join('\n'));
    });

    it('模板字符串插值 `${...}` 内的字符串引号与花括号配平正确', () => {
      expect(netDepth('const msg = `hello ${fn("}") + 1}`;')).toBe(0);
      expect(cutStatement('const msg = `total: ${calc({ a: 1 })}`;\nnext();'))
        .toBe('const msg = `total: ${calc({ a: 1 })}`;');
    });
  });

  describe('findSfcBlocks 脚本内闭合标签字符串保护', () => {
    it('script 代码字符串或行注释中出现 </script> 不会提前截断区块', () => {
      const vue = [
        '<script setup lang="ts">',
        "const html = '<script>alert(1)</script>';",
        '// 注释里的 </script> 也不算',
        'const real = 1;',
        '</script>',
      ].join('\n');
      const blocks = findSfcBlocks(src(vue));
      expect(blocks).toEqual([{ tag: 'script', startLine: 0, endLine: 4, attrs: 'setup lang="ts"' }]);
    });
  });

  describe('effectiveDebounceMs 自适应防抖', () => {
    it('注释/代码块后空行（block）与属性点号（this.）缩短等待，普通位置保持原防抖', () => {
      expect(effectiveDebounceMs(1000, true, '// 计算总价\n  ', 'block')).toBe(450);
      expect(effectiveDebounceMs(1000, true, '  this.', 'free')).toBe(450);
      expect(effectiveDebounceMs(1000, true, '  res?.data.', 'free')).toBe(450);
      expect(effectiveDebounceMs(1000, true, 'const total = ', 'free')).toBe(1000);
      expect(effectiveDebounceMs(1000, false, '  this.', 'block')).toBe(1000);
    });
  });

  describe('OpenTabs 跨文件已打开标签页相关片段提取', () => {
    it('提取未跟踪新文件/参照文件中的强相关片段，过滤无关文件并带入来源指纹', () => {
      const apiDoc = src([
        'export interface ClaimApplyPayload {',
        '  skuListPop: string[];',
        '  applyReasonCode: number;',
        '}',
        'export function submitClaimApply(payload: ClaimApplyPayload) {',
        '  return request.post("/api/claim", payload);',
        '}',
      ].join('\n'));
      const noiseDoc = src('export function unrelatedUtil() { return 42; }');
      const dep = { uri: 'file:///src/api/claim.ts', mtimeMs: 10, size: 120 };

      const query = queryOf(src('// 调用 submitClaimApply 提交 skuListPop\n  '), 1);
      const items = selectOpenTabSnippets([
        { uri: 'file:///src/utils/noise.ts', label: 'src/utils/noise.ts', source: noiseDoc },
        { uri: dep.uri, label: 'src/api/claim.ts', source: apiDoc, dep, recent: true },
      ], query);

      expect(items.length).toBeGreaterThan(0);
      expect(items.every((item) => item.text.startsWith('src/api/claim.ts:'))).toBe(true);
      expect(items.map((i) => i.text).join('\n')).toContain('submitClaimApply');
      expect(items[0]?.dep).toEqual(dep);

      const header = renderHeader({
        file: 'src/views/Apply.vue',
        framework: 'vue3',
        members: [],
        related: [],
        windowText: '',
        openTabs: items,
        style: 'line',
        budgetChars: 4000,
      });
      expect(header.text).toContain('related code in open files:');
      expect(header.text).toContain('submitClaimApply');
      expect(header.deps).toEqual([dep]);
    });

    it('collector 对 gitDiff 与 openTabs 完全相同的片段自动去重', async () => {
      const dupText = 'src/api/claim.ts:\nexport const submitClaimApply = 1;';
      const collect = createCollector({
        sources: [
          { name: 'gitdiff', collect: async () => ({ changes: [{ text: dupText }] }) },
          { name: 'opentabs', collect: async () => ({ openTabs: [{ text: dupText }, { text: 'src/other.ts:\nconst keep = 2;' }] }) },
        ],
        vueMajor: async () => undefined,
      });
      const out = await collect({
        docKey: 'file:///a.ts', languageId: 'typescript', fileLabel: 'a.ts', source: src('const x = 1;'),
        version: 1, line: 0, character: 0, windowStartLine: 0, windowText: '', cfg: DEFAULT_CONFIG,
      }, Date.now() + 500);
      expect(out.header.text).toContain('uncommitted changes in this project');
      expect(out.header.text).toContain('related code in open files:');
      expect(out.header.text).toContain('const keep = 2;');
      expect(out.header.text.match(/submitClaimApply/g)).toHaveLength(1);
    });
  });

  describe('BuildWatch 异步刷新与 countNewProps 复用文本', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('支持异步读取 mtime 且只通知一次', async () => {
      let mtime = 100;
      const watch = new BuildWatch(async () => mtime);
      await vi.advanceTimersByTimeAsync(0);
      expect(await watch.refresh()).toBe(false);
      expect(watch.stale).toBe(false);

      mtime = 200;
      expect(await watch.refresh()).toBe(true);
      expect(watch.stale).toBe(true);
      expect(await watch.refresh()).toBe(false);
    });

    it('countNewProps 可直接复用已读取的全文字符串，不再访问 TextSource', () => {
      expect(countNewProps('this.existingProp + this.brandNewProp', 'const existingProp = 1;'))
        .toEqual({ props: 2, fresh: 1 });
    });
  });

  describe('第二轮实测根因优化回归（React 状态/调用点召回、驼峰子词、行尾克制）', () => {
    it('subTokensOf 从复合驼峰标识符拆出业务词并过滤高频泛词', () => {
      expect(subTokensOf('const getBankNumLast4 = () => {}')).toEqual(['bank']);
      expect(subTokensOf('xiaojinkuListSet')).toEqual(['xiaojinku']);
      expect(subTokensOf('handleItemClick')).toEqual([]);
    });

    it('实现新函数时：隔离上方已闭合兄弟函数局部变量，同时召回远端调用点与 React State 构造块', () => {
      const filler = Array.from({ length: 180 }, (_, i) => `  const fillerLine${i} = ${i};`);
      const lines = [
        'function PriceMatch() {',
        '  const [xiaojinkuShow, xiaojinkuShowSet] = useState<boolean>(false);',
        '  const [payValue, payValueSet] = useState<any>("");',
        '  const [linshiPayValue, linshiPayValueSet] = useState<any>("");',
        ...Array.from({ length: 8 }, (_, i) => `  const topState${i} = ${i};`),
        '  const [xiaojinkuList, xiaojinkuListSet] = useState<any>([]);',
        '  const xiaoJinKuOk = () => {',
        '    payValueSet(linshiPayValue);',
        '    xiaojinkuShowSet(false);',
        '  };',
        '  // 获取银行卡名称+后四位 调用该方法的必定是银行卡',
        '  const getBankNumLast4 = () => {',
        '    ',
        '  };',
        ...filler,
        '  const initBank = () => {',
        '    queryUserBankList().then((res: any) => {',
        '      xiaojinkuListSet((current: any) => {',
        '        return current.concat(res.map((item: any) => {',
        '          item.label = `${item.bankName}(${item.bankCardNo.slice(-4)})`;',
        '          item.value = item.bankCardId;',
        '          return item;',
        '        }));',
        '      });',
        '    });',
        '    if (isJDPay) {',
        '      xiaojinkuListSet((current: any) => current.concat({ label: isJDPay.name, value: 5 }));',
        '    }',
        '  };',
        ...filler,
        '  return (',
        '    <div>',
        '      <Popup onClose={() => { xiaojinkuShowSet(false); linshiPayValueSet(payValue); }} />',
        '      <span>理赔至{payValue === 4 ? "小金库" : getBankNumLast4()}</span>',
        '    </div>',
        '  );',
        '}',
      ];
      const cursorLine = lines.indexOf('    ');
      const source = src(lines.join('\n'));
      const query = queryOf(source, cursorLine);
      // 兄弟函数 xiaoJinKuOk 内部的 linshiPayValue 不应污染当前函数检索词，顶级声明的 xiaojinkuList 保留，且拆出 bank
      expect(query.factors.has('linshipayvalue')).toBe(false);
      expect(query.factors.has('xiaojinkulist')).toBe(true);
      expect(query.factors.has('bank')).toBe(true);

      const snippets = relatedSnippets({
        source,
        cursorLine,
        excludeStart: 0,
        excludeEnd: cursorLine + 5,
        query,
      });
      const joined = snippets.join('\n---\n');
      // 远端调用点与银行卡数据结构构造块均被成功召回
      expect(joined).toContain('payValue === 4 ? "小金库" : getBankNumLast4()');
      expect(joined).toContain('item.bankCardNo.slice(-4)');
      expect(joined).toContain('item.value = item.bankCardId');
    });

    it('unverifiedStateItemProps 发现草稿猜错 React 状态数组元素属性时触发带草稿二次重发', async () => {
      vi.useFakeTimers();
      try {
        const filler = Array.from({ length: 120 }, (_, i) => `  const gap${i} = ${i};`);
        const text = [
          'function AccountPage() {',
          '  const [accountRows, accountRowsSet] = useState<any[]>([]);',
          ...Array.from({ length: 35 }, (_, i) => `  const earlyLine${i} = ${i};`),
          '  const renderSelection = (payId: string) => {',
          '    ',
          '  };',
          ...filler,
          '  const load = (rows: any[]) => {',
          '    accountRowsSet(rows.map((r) => ({ bankName: r.bankName, bankCardId: r.bankCardId, bankCardNo: r.no })));',
          '  };',
          '}',
        ].join('\n');
        const draftBad = 'const found = accountRows.find((item: any) => item.wrongKey === payId);\n    return found?.wrongName;';
        const draftGood = 'const found = accountRows.find((item: any) => item.bankCardId === payId);\n    return found?.bankName;';
        expect(unverifiedStateItemProps(draftBad, text)).toEqual(['item.wrongKey']);
        expect(unverifiedStateItemProps(draftGood, text)).toEqual([]);

        const requests: FimRequest[] = [];
        const fim: FimClient = {
          async complete(req: FimRequest): Promise<FimResult> {
            requests.push(req);
            return { text: requests.length === 1 ? draftBad : draftGood, finishReason: 'stop', totalMs: 1 };
          },
        };
        const mutable = new MutableDoc(text);
        const doc: LiveDoc = {
          key: 'file:///card.tsx', languageId: 'typescriptreact', fileLabel: 'card.tsx', source: mutable.source,
          version: () => mutable.version, cursorIsAt: () => true,
        };
        const logs: string[] = [];
        const pipeline = new CompletionPipeline({
          cfg: () => ({ ...DEFAULT_CONFIG, prefixChars: 200, suffixChars: 80 }),
          cache: new CompletionCache(),
          scheduler: new Scheduler({ timeoutMs: () => 5000 }),
          fim,
          collector: createCollector({ sources: [createSnippetSource(() => true)], vueMajor: async () => undefined }),
          depsIo: { stat: async () => undefined, isDirty: () => false },
          health: new HealthState(),
          metrics: new Metrics(),
          log: (l) => logs.push(l),
        });
        const cursorLine = mutable.lines.indexOf('    ');
        const pending = pipeline.run({ doc, position: { line: cursorLine, character: 4 }, trigger: 'auto', token: new TestToken() });
        await vi.advanceTimersByTimeAsync(5000);
        const res = await pending;
        expect(logs[0]).toContain('"retry":"better"');
        expect(requests).toHaveLength(2);
        expect(requests[1]?.prompt).toContain('bankCardId');
        expect(res?.text).toBe(draftGood);
      } finally {
        vi.useRealTimers();
      }
    });

    it('shouldSkipAutoTrigger 抑制终止语句后与块尾分号后的蛇足自动请求，保留正常续写', () => {
      // 案例 1 seq 2：光标停在 return 语句末尾 `;`
      expect(shouldSkipAutoTrigger("    return bankName + '（' + bankNum.slice(-4) + '）';", '\n  };')).toBe(true);
      // 案例 1 seq 3：光标停在 return 语句下方紧接闭合 `}` 的空行
      expect(shouldSkipAutoTrigger("    return bankName;\n    ", '\n  };')).toBe(true);
      // 案例 2 seq 6：光标停在循环块最后一句完整 push(...); 行尾且下一非空行是缩进更浅的 `}`
      expect(shouldSkipAutoTrigger("        uploads[index].files.push({ type: 'img', src });", '\n      }\n    }\n  }')).toBe(true);

      // 正常场景绝不误杀：用户已回车到块尾空行想继续写下一句、语句未写完分号、或后面还有兄弟语句
      expect(shouldSkipAutoTrigger("        uploads[index].files.push({ type: 'img', src });\n        ", '\n      }')).toBe(false);
      expect(shouldSkipAutoTrigger('        const key = imageIdentity(src)', '\n      }')).toBe(false);
      expect(shouldSkipAutoTrigger('        seen[index].add(key);', "\n        uploads[index].files.push({ type: 'img', src });\n      }")).toBe(false);
    });

    it('postprocess 拦截非空代码行尾自动触发产生的纯注释续写，不影响空行注释与手动触发', () => {
      const prefix = "        uploads[index].files.push({ type: 'img', src });";
      const suffix = '\n      }';
      const waterComment = '\n        // 保留原始地址，避免缩略图前缀影响查看资料页的图片展示。';
      expect(postprocessTraced({ text: waterComment, prefix, suffix, maxLines: 12 })).toEqual({
        text: '',
        rules: ['commentOnly'],
      });
      // 手动触发时保留
      expect(postprocessTraced({ text: waterComment, prefix, suffix, maxLines: 12, manual: true }).text).toBe(waterComment);
      // 空行上正常补注释或带代码的块保留
      expect(postprocessTraced({
        text: '// 说明\n        doNext();',
        prefix: `${prefix}\n        `,
        suffix,
        maxLines: 12,
      }).text).toBe('// 说明\n        doNext();');
    });

    it('intentComment 识别新函数声明行正上方的意图注释，且跨兄弟函数不误沿用组件外层旧头部', async () => {
      vi.useFakeTimers();
      try {
        const lines = [
          'function PriceMatchComponent() {',
          '  const [payValue, payValueSet] = useState<any>("");',
          '  const firstHelper = () => {',
          '    ',
          '  };',
          '  // 获取银行卡名称+后四位 调用该方法的必定是银行卡',
          '  const getBankNumLast4 = () => {',
          '    ',
          '  };',
          '}',
        ];
        const s = src(lines.join('\n'));
        // 光标在 getBankNumLast4 函数体首行（第 7 行），声明在第 6 行，注释在第 5 行
        expect(intentComment(s, 7)).toEqual({
          text: '// 获取银行卡名称+后四位 调用该方法的必定是银行卡',
          line: 5,
        });

        // 管线：先在组件顶层或兄弟函数 firstHelper 内收集一次（记了外层 block 锚点），再跳进另一个兄弟函数 getBankNumLast4 必须重新收集（hdr: fresh）
        let collectCalls = 0;
        const logs: Array<{ hdr?: string; hdrBy?: string }> = [];
        const mutable = new MutableDoc([
          'const sharedEvidence = 1;',
          'function PriceMatchComponent() {',
          '  const [payValue, payValueSet] = useState<any>("");',
          '  ',
          '  const getBankNumLast4 = () => {',
          '    ',
          '  };',
          '}',
        ].join('\n'));
        const doc: LiveDoc = {
          key: 'file:///p.tsx', languageId: 'typescriptreact', fileLabel: 'p.tsx', source: mutable.source,
          version: () => mutable.version, cursorIsAt: () => true,
        };
        const pipeline = new CompletionPipeline({
          cfg: () => DEFAULT_CONFIG,
          cache: new CompletionCache(),
          scheduler: new Scheduler({ timeoutMs: () => 5000 }),
          fim: { async complete() { return { text: 'const x = 1;', finishReason: 'stop', totalMs: 1 }; } },
          collector: createCollector({
            sources: [{
              name: 'snippets',
              async collect() {
                collectCalls++;
                return { snippets: ['const sharedEvidence = 1;'] };
              },
            }],
            vueMajor: async () => undefined,
          }),
          depsIo: { stat: async () => undefined, isDirty: () => false },
          health: new HealthState(),
          metrics: new Metrics(),
          log: (l) => {
            if (l.startsWith('{')) {
              logs.push(JSON.parse(l) as { hdr?: string; hdrBy?: string });
            }
          },
        });

        // 第 1 次在组件顶层第 3 行触发：记下 `function PriceMatchComponent() {` 为 block 锚点
        const p1 = pipeline.run({ doc, position: { line: 3, character: 2 }, trigger: 'auto', token: new TestToken() });
        await vi.advanceTimersByTimeAsync(2000);
        await p1;
        expect(logs[0]).toMatchObject({ hdr: 'fresh', hdrBy: 'block' });

        // 第 2 次进入子函数 getBankNumLast4（第 5 行，无意图注释）：中间隔着具名函数声明，绝不沿用组件顶层旧头部
        mutable.lines[3] = '  const a = 1;';
        mutable.version++;
        await vi.advanceTimersByTimeAsync(4000);
        const p2 = pipeline.run({ doc, position: { line: 5, character: 4 }, trigger: 'auto', token: new TestToken() });
        await vi.advanceTimersByTimeAsync(2000);
        await p2;
        expect(logs[1]?.hdr).toBe('fresh');
        expect(collectCalls).toBe(2);

        // 第 3 次仍在同一个 getBankNumLast4 内部继续往下写：正常沿用 getBankNumLast4 自己的头部
        mutable.lines.splice(5, 1, '    const step1 = 1;', '    ');
        mutable.version++;
        await vi.advanceTimersByTimeAsync(4000);
        const p3 = pipeline.run({ doc, position: { line: 6, character: 4 }, trigger: 'auto', token: new TestToken() });
        await vi.advanceTimersByTimeAsync(2000);
        await p3;
        expect(logs[2]).toMatchObject({ hdr: 'reuse', hdrBy: 'block' });
        expect(collectCalls).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('openTabs 子词联动与调用点状态三元赋值块召回：把跨标签页京东钱包余额与本文件多行三元赋值一并召回', () => {
      const filler = Array.from({ length: 180 }, (_, i) => `  const gap${i} = ${i};`);
      const priceMatchLines = [
        'function PriceMatch() {',
        '  const [payValue, payValueSet] = useState<any>("");',
        '  const [xiaojinkuList, xiaojinkuListSet] = useState<any>([]);',
        ...Array.from({ length: 15 }, (_, i) => `  const otherState${i} = ${i};`),
        '  // 获取银行卡名称+后四位 调用该方法的必定是银行卡',
        '  const getBankNumLast4 = () => {',
        '    ',
        '  };',
        ...filler,
        '  const loadBank = (res: any[]) => {',
        '    xiaojinkuListSet((current: any) => current.concat(res.map((item: any) => {',
        '      item.label = `${item.bankName}(${item.bankCardNo.slice(-4)})`;',
        '      item.value = item.bankCardId;',
        '      return item;',
        '    })));',
        '  };',
        '  const echoPage = (result: any) => {',
        '    payValueSet(',
        '      result.data?.applyInfo?.payType === 4',
        '        ? 4',
        '        : result.data?.applyInfo?.payType === 5',
        '        ? 5',
        '        : result.data?.applyInfo?.bankCardId',
        '    );',
        '  };',
        ...filler,
        '  return <span>理赔至{payValue === 4 ? "小金库" : getBankNumLast4()}</span>;',
        '}',
      ];
      const cursorLine = priceMatchLines.indexOf('    ');
      const priceSource = src(priceMatchLines.join('\n'));
      const query = queryOf(priceSource, cursorLine);

      // 1. 同文件片段：尽管 payValue 声明在 QUERY_BEFORE 之外，仍通过第 987 行调用点的 `payValue === 4 ? ... : getBankNumLast4()` 联动召回多行三元 payValueSet(...)
      const sameFileSnippets = relatedSnippets({
        source: priceSource,
        cursorLine,
        excludeStart: 0,
        excludeEnd: cursorLine + 3,
        query,
      }).join('\n---\n');
      expect(sameFileSnippets).toContain('payType === 5');
      expect(sameFileSnippets).toContain('result.data?.applyInfo?.bankCardId');
      expect(sameFileSnippets).toContain('item.bankCardNo.slice(-4)');

      // 2. 跨文件打开标签页：通过 getBankNumLast4 拆出的子词 bank 命中 applyClaim/index.tsx 中的 bankCardId / bankName 区域，顺带拉回相邻的 `京东钱包余额`
      const applyClaimTab = src([
        'const refundWaysItems: any[] = [];',
        "if (payTypeList.some((item: any) => String(item.typeCode) === '5')) {",
        "  refundWaysItems.push({ value: '5', payType: 5, label: '京东钱包余额' });",
        '}',
        'bankCardInfos.forEach((item: any) => {',
        '  refundWaysItems.push({ bankCardId: item.bankCardId, label: `${item.bankName}(${item.bankCardNo.slice(-4)})` });',
        '});',
      ].join('\n'));
      const tabSnippets = selectOpenTabSnippets([
        { uri: 'file:///applyClaim/index.tsx', label: 'applyClaim/index.tsx', source: applyClaimTab },
      ], query);
      expect(tabSnippets.map((t) => t.text).join('\n')).toContain('京东钱包余额');
    });
  });
});
