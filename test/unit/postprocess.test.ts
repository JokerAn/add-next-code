import { describe, expect, it } from 'vitest';
import { postprocess } from '../../src/core/postprocess';

const base = { prefix: 'const a = ', suffix: '\n', maxLines: 12 };
const pp = (text: string, o: Partial<typeof base> = {}) => postprocess({ ...base, ...o, text });

describe('postprocess', () => {
  it('去模型控制标记', () => {
    expect(pp('foo(1)<｜end▁of▁sentence｜>')).toBe('foo(1)');
    expect(pp('foo(1)<|im_end|>')).toBe('foo(1)');
  });

  it('代码围栏：删首行并在下一个围栏处截断', () => {
    expect(pp('```js\nfoo(1)\n```\n解释文字')).toBe('foo(1)');
  });

  it('只去尾部空白，保留开头缩进', () => {
    expect(pp('  indented()  \n\n')).toBe('  indented()');
  });

  it('空结果拒绝', () => {
    expect(pp('')).toBe('');
    expect(pp('  \n  ')).toBe('');
    expect(pp('<|im_end|>')).toBe('');
  });

  it('行数截断', () => {
    const text = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n');
    expect(pp(text, { maxLines: 5 }).split('\n')).toHaveLength(5);
  });

  it('复读前文拒绝（长度 >= 8 且与 prefix 最后非空行相同）', () => {
    expect(pp('const total = compute()', { prefix: 'x\nconst total = compute()' })).toBe('');
    // 太短不算
    expect(pp('i++', { prefix: 'i++' })).toBe('i++');
  });

  it('行尾重叠：结果以光标后文本结尾时去掉这一段', () => {
    expect(pp('compute(items, options)', { prefix: 'run(', suffix: 'items, options)\nnext' })).toBe('compute(');
    // 重叠整段 → 空
    expect(pp('items, options)', { prefix: 'run(', suffix: 'items, options)\n' })).toBe('');
  });

  it('评审反例：单个闭合符不触发行尾重叠（foo(|) 处返回 bar(x)）', () => {
    expect(pp('bar(x)', { prefix: 'foo(', suffix: ')\n' })).toBe('bar(x)');
  });

  it('后文行重叠：从与后文下一非空行相同的行起截断', () => {
    const out = pp('const b = 1;\nreturn total;\n}', { prefix: 'function f() {\n  ', suffix: '\n  return total;\n}' });
    expect(out).toBe('const b = 1;');
  });

  it('后文行重叠：第一行不处理，短行（< 6）不处理', () => {
    expect(pp('}\n}', { suffix: '\n}' })).toBe('}\n}');
  });

  it('评审反例：不做括号计数裁剪（console.log(|) 处返回 ")" 必须原样保留）', () => {
    expect(pp('")"', { prefix: 'console.log(', suffix: ')\n' })).toBe('")"');
    expect(pp('"a)b")', { prefix: 'console.log(', suffix: '\n' })).toBe('"a)b")');
  });

  it('不会删除用户已有的后文：无明确重叠证据时保持原样', () => {
    expect(pp('x + y', { prefix: 'const s = ', suffix: ';\nconst t = 2;' })).toBe('x + y');
  });
});
