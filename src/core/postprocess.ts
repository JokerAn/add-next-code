// 6.6 输出后处理：纯函数。只处理有明确文本证据的情况，绝不删除用户已有的后文。

export interface PostprocessInput {
  text: string;
  prefix: string;
  suffix: string;
  maxLines: number;
}

const CONTROL_MARK_RE = /<[｜|][^｜|>\n]*[｜|]>/g;

function firstLine(text: string): string {
  const i = text.indexOf('\n');
  return i < 0 ? text : text.slice(0, i);
}

function lastNonEmptyLine(text: string): string {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = (lines[i] ?? '').trim();
    if (t) {
      return t;
    }
  }
  return '';
}

function nextNonEmptyLineAfterFirst(suffix: string): string {
  const lines = suffix.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const t = (lines[i] ?? '').trim();
    if (t) {
      return t;
    }
  }
  return '';
}

/** 返回空串表示拒绝。 */
export function postprocess(input: PostprocessInput): string {
  let text = input.text;

  // 1. 去模型控制标记与代码围栏
  text = text.replace(CONTROL_MARK_RE, '');
  if (text.startsWith('```')) {
    const nl = text.indexOf('\n');
    text = nl < 0 ? '' : text.slice(nl + 1);
    const close = text.indexOf('```');
    if (close >= 0) {
      text = text.slice(0, close);
    }
  }

  // 2/3. 去尾部空白；全空白拒绝
  text = text.trimEnd();
  if (text.trim() === '') {
    return '';
  }

  // 4. 行数截断
  let lines = text.split('\n');
  if (lines.length > input.maxLines) {
    lines = lines.slice(0, input.maxLines);
    text = lines.join('\n').trimEnd();
    if (text.trim() === '') {
      return '';
    }
  }

  // 5. 复读前文：第一个非空行与 prefix 最后一个非空行相同（长度 >= 8）
  const firstNonEmpty = (lines.find((l) => l.trim() !== '') ?? '').trim();
  if (firstNonEmpty.length >= 8 && firstNonEmpty === lastNonEmptyLine(input.prefix)) {
    return '';
  }

  // 6. 行尾重叠：当前行光标后的文本（足够长）原样出现在结果末尾
  const rest = firstLine(input.suffix).trim();
  if (rest.length >= 6 && text.endsWith(rest)) {
    text = text.slice(0, text.length - rest.length).trimEnd();
    lines = text.split('\n');
  }

  // 7. 后文行重叠：结果第 2 行起出现与后文下一非空行相同的行，从该行起截断
  const next = nextNonEmptyLineAfterFirst(input.suffix);
  if (next.length >= 6) {
    for (let i = 1; i < lines.length; i++) {
      if ((lines[i] ?? '').trim() === next) {
        text = lines.slice(0, i).join('\n').trimEnd();
        break;
      }
    }
  }

  // 8. 再次判空
  return text.trim() === '' ? '' : text;
}
