import { describe, expect, it } from 'vitest';
import { enclosingOpeners } from '../../src/core/blockAnchor';
import { src } from './helpers';

const text = [
  'export default {',
  '  methods: {',
  '    onConfirm(res) {',
  '      const same = 1',
  '      if (/* 商家险 */ this._isSegment && res.value) {',
  '        items.forEach((item) => {',
  '          ',
  '        })',
  '      }',
  '    },',
  '  },',
  '}',
].join('\n');

describe('enclosingOpeners 包着光标的块开头行', () => {
  const s = src(text);

  it('由内到外，去掉首尾空白；跳过兄弟块的闭合行', () => {
    expect(enclosingOpeners(s, 6, 10)).toEqual([
      'items.forEach((item) => {',
      'if (/* 商家险 */ this._isSegment && res.value) {',
      'onConfirm(res) {',
      // "methods: {" 只有 10 个字符，低于 12，不当锚点，但仍然是一层缩进
      'export default {',
    ]);
  });

  it('光标所在行已有文字时按这一行自己的缩进；缩进为 0 时没有外层', () => {
    expect(enclosingOpeners(src('a()\n  b()\n  c('), 2, 4)).toEqual([]);
    expect(enclosingOpeners(src('function work(order) {\n  const x = 1\n  y()'), 2, 3)).toEqual(['function work(order) {']);
    expect(enclosingOpeners(src('x\n'), 1, 0)).toEqual([]);
  });

  it('太短的开头行不返回；不以块开头符号结尾的低缩进行不返回', () => {
    expect(enclosingOpeners(src('function wrapper(a) {\n  try {\n    \n  }'), 2, 4)).toEqual(['function wrapper(a) {']);
    expect(enclosingOpeners(src('const total = 1\n  const here = 2\n    '), 2, 4)).toEqual([]);
  });
});
