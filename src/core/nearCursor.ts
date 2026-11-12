// 实验：把最相关的一两段参照代码放到光标正上方（意图注释之前），而不是提示词顶部。
// 背景：真实日志里参照代码已在提示词顶部，模型仍只按光标上方那句注释的字面意思写。离光标越近的内容对补全模型影响越大。
// 只改发给模型的提示词，不改文档；缓存、后处理、复核仍以真实的前文为准。

const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/;

/**
 * 在 prefix 里、光标上方的意图注释之前插入参照块；没有意图注释时插在光标所在行之前。
 * 参照块用行注释，缩进与插入位置一致。
 */
export function insertReference(prefix: string, snippets: readonly string[]): string {
  if (snippets.length === 0) {
    return prefix;
  }
  const lines = prefix.split('\n');
  const cursor = lines.length - 1;
  let at = cursor;
  let i = cursor - 1;
  for (let blanks = 0; i >= 0 && (lines[i] as string).trim() === '' && blanks < 3; blanks++) {
    i--;
  }
  while (i >= 0 && COMMENT_LINE.test(lines[i] as string)) {
    at = i;
    i--;
  }
  const basis = (lines[at] as string).trim() === '' ? (lines[cursor] as string) : (lines[at] as string);
  const indent = (/^[ \t]*/.exec(basis) as RegExpExecArray)[0];
  const block = [`${indent}// reference: similar code elsewhere in this file`];
  snippets.forEach((snippet, index) => {
    if (index > 0) {
      block.push(`${indent}//   ...`);
    }
    for (const line of snippet.split('\n')) {
      block.push(`${indent}//   ${line}`.trimEnd());
    }
  });
  block.push(`${indent}// end of reference`);
  return [...lines.slice(0, at), ...block, ...lines.slice(at)].join('\n');
}
