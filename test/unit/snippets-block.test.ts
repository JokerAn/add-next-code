import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff, rankDiffHunks } from '../../src/core/gitDiff';
import { queryOf, relatedSnippets, tokensOf } from '../../src/core/snippets';
import { src } from './helpers';

const filler = (count: number, tag = 'filler') => Array.from({ length: count }, (_, i) => `    const ${tag}${i} = ${i}`);

/** 文件前部有一段带注释的旧实现，光标在 400 行之后，上方是意图注释。 */
function fileWith(intent: string, oldComment = '        // 拿到接口结果后立即将原始字段归一化为弹框视图字段。') {
  const lines = [
    'export default {',
    '  methods: {',
    '    async loadGoods() {',
    '      try {',
    oldComment,
    '        const latestList = (result.data?.skuList || []).map((item) => {',
    '          const num = Number(item.quantity) || 0',
    '          const max = Number(item.canApplyQuantity)',
    '          return { ...item, skuImg: item.image, num, max }',
    '        })',
    '        if (this._pendingDraft) delete this._pendingDraft.skuSelection',
    "        this.$set(this.resResult, 'skuListPop', latestList)",
    '',
    '        return true',
    '      } catch (error) {',
    '        return false',
    '      }',
    '    },',
    ...filler(400),
    '    onReasonChange(res) {',
    `      ${intent}`,
    '      ',
    '    },',
    '  },',
    '}',
  ];
  const cursorLine = lines.indexOf('      ');
  return { source: src(lines.join('\n')), cursorLine, excludeStart: cursorLine - 150, excludeEnd: cursorLine + 3 };
}

describe('中文意图注释对上文件里已有的注释', () => {
  it('连续 5 个以上相同的字：取回那条注释和它下面的整段代码，到空行为止', () => {
    const snippets = relatedSnippets(fileWith('// 原因接口的商品字段需要转换为弹框视图字段，并同步提交列表。'));
    const first = snippets[0] ?? '';
    expect(first.split('\n')[0]).toBe('// 拿到接口结果后立即将原始字段归一化为弹框视图字段。');
    expect(first).toContain('const latestList = (result.data?.skuList || []).map((item) => {');
    expect(first).toContain('skuImg: item.image');
    expect(first).toContain("this.$set(this.resResult, 'skuListPop', latestList)");
    // 空行之后的不带，缩进更浅的 catch 也不带
    expect(first).not.toContain('return true');
    expect(first).not.toContain('catch');
  });

  it('只有两三个字相同的常见词不算对上', () => {
    const snippets = relatedSnippets(fileWith('// 如果字段为空需要弹出弹框提示。', '        // 字段处理完成后弹框。'));
    expect(snippets.join('\n')).not.toContain('latestList');
  });

  it('正好 4 个字相同（只有一个片段）不算，5 个字才算', () => {
    expect(tokensOf('视图字段', new Set(['视图字段']))).toEqual([]);
    expect(tokensOf('框视图字段', new Set(['框视图字', '视图字段']))).toEqual(['框视图字', '视图字段']);
    const query = queryOf(src('// 转换为弹框视图字段\n'), 1);
    expect([...query.phrases]).toEqual(['转换为弹', '换为弹框', '为弹框视', '弹框视图', '框视图字', '视图字段']);
    expect(query.factors.get('弹框视图')).toBe(1.5);
  });

  it('未提交改动里的中文注释同样参与匹配', () => {
    const diff = 'diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -1,1 +1,3 @@\n keep\n+// 把原始字段归一化为弹框视图字段\n+const list = normalize(raw)\n'
      + 'diff --git a/y.js b/y.js\n--- a/y.js\n+++ b/y.js\n@@ -1,1 +1,2 @@\n keep\n+const other = compute()\n';
    const ranked = rankDiffHunks({
      hunks: parseUnifiedDiff(diff), query: queryOf(src('// 需要转换为弹框视图字段\n'), 1), currentFile: 'z.js', windowStart: 0, windowEnd: 0,
    });
    expect(ranked.map((hunk) => hunk.file)).toEqual(['x.js']);
  });
});

describe('命中密集的片段扩展成整块', () => {
  function dense(blockLines: string[], cap = 400) {
    const lines = ['export default {', '  methods: {', ...blockLines, ...filler(cap), '    caller() {', '      this.refreshOrderTable(orderTableRows)', '      ', '    },', '  },', '}'];
    const cursorLine = lines.indexOf('      ');
    return relatedSnippets({ source: src(lines.join('\n')), cursorLine, excludeStart: cursorLine - 150, excludeEnd: cursorLine + 3 });
  }

  it('相邻的命中合并成一段，带上块前的注释，不越过缩进更浅的行', () => {
    const snippets = dense([
      '    // 刷新订单表格',
      '    refreshOrderTable(rows) {',
      '      const first = 1',
      '      const second = 2',
      '      const third = 3',
      '      const fourth = 4',
      '      const fifth = 5',
      '      this.orderTableRows = rows',
      '      const sixth = 6',
      '      const seventh = 7',
      '      const eighth = 8',
      '      const ninth = 9',
      '      this.orderTableRows.sort()',
      '    },',
      '    unrelatedNeighbour() {',
      '      return 1',
      '    },',
    ]);
    const first = snippets[0] ?? '';
    expect(first.split('\n')[0]).toBe('// 刷新订单表格');
    expect(first).toContain('refreshOrderTable(rows) {');
    expect(first).toContain('this.orderTableRows = rows');
    expect(first).toContain('this.orderTableRows.sort()');
    expect(first).not.toContain('unrelatedNeighbour');
  });

  it('命中之间隔得太远时不合并', () => {
    const snippets = dense([
      '    refreshOrderTable(rows) {',
      ...filler(20, 'gap').map((line) => `  ${line}`),
      '      this.orderTableRows = rows',
      '    },',
    ]);
    expect(snippets.some((snippet) => snippet.includes('refreshOrderTable(rows) {') && snippet.includes('this.orderTableRows = rows'))).toBe(false);
  });

  it('整块不超过 50 行；所有片段合计不超过预算', () => {
    const snippets = dense([
      '    refreshOrderTable(rows) {',
      ...Array.from({ length: 120 }, (_, i) => `      this.orderTableRows.push(${i}) // ${'x'.repeat(30)}`),
      '    },',
    ]);
    expect(snippets.length).toBeGreaterThan(0);
    expect(Math.max(...snippets.map((snippet) => snippet.split('\n').length))).toBeLessThanOrEqual(50);
    expect(snippets.join('').length).toBeLessThanOrEqual(3000);
  });
});

describe('意图注释对上行尾注释：它声明的名字，以及这个名字通常和谁一起用', () => {
  const pair = (indent: string) => [`${indent}if (`, `${indent}  this.isSpecial ||`, `${indent}  this.query.kind === this.specialKindCode`, `${indent}) {`];
  const lines = [
    'export default {',
    '  data() {',
    '    return {',
    '      isSpecial: false, // 是否是特殊补偿类型的订单',
    ...Array.from({ length: 60 }, (_, i) => `      dataField${i}: ${i},`),
    '    }',
    '  },',
    '  methods: {',
    '    submitA() {',
    ...pair('      '),
    "        params.type = '8'",
    '      } else if (this.justPay) {',
    "        params.type = '4'",
    '      }',
    '    },',
    ...filler(120, 'gapA'),
    '    submitB() {',
    ...pair('      '),
    '        this.specialSubmit()',
    '      }',
    '    },',
    ...filler(120, 'gapB'),
    '    submitC() {',
    ...pair('      '),
    '        return',
    '      }',
    '    },',
    ...filler(300, 'gapC'),
    '    choose(items) {',
    '      // 判断是否是特殊补偿类型的 如果是则选中第 8 项',
    '      ',
    '    },',
    '  },',
    '}',
  ];
  const cursorLine = lines.lastIndexOf('      ');
  const snippets = relatedSnippets({ source: src(lines.join('\n')), cursorLine, excludeStart: cursorLine - 150, excludeEnd: cursorLine + 3 });
  const all = snippets.join('\n');

  it('行尾注释对上时只取那一行附近，不把下面几十行无关字段带进来', () => {
    expect(all).toContain('isSpecial: false, // 是否是特殊补偿类型的订单');
    expect(all).not.toContain('dataField30');
  });

  it('取回这个名字和它的固定搭档一起出现的代码', () => {
    expect(all).toContain('this.isSpecial ||');
    expect(all).toContain('this.query.kind === this.specialKindCode');
    // 离光标最近的一处排在前面
    expect(all.indexOf('return')).toBeGreaterThan(-1);
    expect(snippets.some((snippet) => snippet.includes("params.type = '8'") && snippet.includes('} else if (this.justPay) {'))).toBe(true);
  });

  it('意图注释还对上了别的注释、字符串里也有相同的中文：用法示例仍然保留，且带上 else 分支', () => {
    const busy = [...lines];
    busy[lines.lastIndexOf('      ') - 1] = '      // 判断是否是特殊补偿类型的 如果只有付款方式的则选第 4 项';
    // 别处一条对得上的注释，和一行字符串里含相同中文的日志
    busy.splice(lines.indexOf('    submitB() {'), 0,
      '    // 打开付款方式的弹框', '    openPay() {', "      console.log('是否是特殊补偿类型的日志', this.$refs.payPanel)", '      this.$refs.payPanel.show = true', '    },',
      ...filler(30, 'payGapA'), '    closePay() {', '      this.$refs.payPanel.show = false', '    },',
      ...filler(30, 'payGapB'), '    togglePay() {', '      this.$refs.payPanel.toggle()', '    },');
    const at = busy.lastIndexOf('      ');
    const result = relatedSnippets({ source: src(busy.join('\n')), cursorLine: at, excludeStart: at - 150, excludeEnd: at + 3 });
    expect(result.some((snippet) => snippet.includes('this.isSpecial ||') && snippet.includes("params.type = '8'") &&
      snippet.includes('} else if (this.justPay) {'))).toBe(true);
    // 用法示例有单独的名额，排在按得分选出的片段之前，离光标近的在前
    expect(result[0]).toContain('this.isSpecial ||');
    expect(result[0]).toContain('return');
    expect(result[1]).toContain('this.isSpecial ||');
    expect(result[1]).toContain('this.specialSubmit()');
    // 字符串里的中文不算行尾注释，payPanel 不会被当成意图里的名字去带出它的各处用法
    expect(result.filter((snippet) => snippet.includes('payPanel')).length).toBeLessThanOrEqual(1);
  });

  it('意图注释没有对上任何行尾注释时，不扩充检索词', () => {
    const other = [...lines];
    other[lines.lastIndexOf('      ') - 1] = '      // 这里随便写点别的说明文字';
    const result = relatedSnippets({ source: src(other.join('\n')), cursorLine, excludeStart: cursorLine - 150, excludeEnd: cursorLine + 3 });
    expect(result.join('\n')).not.toContain('specialKindCode');
  });
});
