// 6.6 输出后处理：纯函数。只处理有明确文本证据的情况，绝不删除用户已有的后文。
import { extraClosers, netDepth, unwrapCommentedBlock } from './linePolicy';

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
  return apply(input, () => undefined);
}

/** 同 postprocess，另外返回实际改动了结果的规则名，用于日志定位误伤。 */
export function postprocessTraced(input: PostprocessInput): { text: string; rules: string[] } {
  const rules: string[] = [];
  const text = apply(input, (rule) => rules.push(rule));
  return { text, rules };
}

function apply(input: PostprocessInput, hit: (rule: string) => void): string {
  let text = input.text;

  // 1. 去模型控制标记与代码围栏
  text = text.replace(CONTROL_MARK_RE, '');
  if (text !== input.text) {
    hit('marks');
  }
  if (text.startsWith('```')) {
    hit('fence');
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
    hit('blank');
    return '';
  }

  // 4. 行数截断
  let lines = text.split('\n');
  if (lines.length > input.maxLines) {
    hit('maxLines');
    lines = lines.slice(0, input.maxLines);
    text = lines.join('\n').trimEnd();
    if (text.trim() === '') {
      return '';
    }
  }

  // 3b. 整段被注释符包着：模型抄了头部参照块的 "// " 前缀。还原成代码，再走后面的各项检查。
  const unwrapped = unwrapCommentedBlock(text);
  if (unwrapped !== undefined) {
    text = unwrapped;
    lines = text.split('\n');
    hit('uncomment');
  }

  // 4a. 缩进越界：第 2 行起出现比光标所在行缩进更浅的非空行，说明已写出当前代码块，从该行截断。
  // 以闭合符开头的行（如 "} else {"）可能是合法续写，留给 4b 按括号配平判断。
  const currentLine = input.prefix.slice(input.prefix.lastIndexOf('\n') + 1);
  const baseIndent = (/^[ \t]*/.exec(currentLine) as RegExpExecArray)[0];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const indent = (/^[ \t]*/.exec(line) as RegExpExecArray)[0];
    const body = line.trim();
    if (body !== '' && !/^[)\]}]/.test(body) && indent.length < baseIndent.length && baseIndent.startsWith(indent)) {
      text = lines.slice(0, i).join('\n').trimEnd();
      hit('indent');
      break;
    }
  }

  // 4b. 括号越界：结果整体闭合多于打开，且后文正好以同一个闭合符开头，说明模型重写了后文的闭合符。
  // 后文的闭合符在另一行时还要缩进相同才算同一个：光标前有没闭合的代码块时，结果先把它闭合是对的，
  // 那个闭合符比后文的缩进更深，不能删。
  const after = /^[ \t]*((?:\n[ \t]*)*)([)\]}])/.exec(input.suffix);
  if (after) {
    const afterIndent = after[1] === '' ? undefined : (after[1] as string).length - (after[1] as string).lastIndexOf('\n') - 1;
    for (const extra of extraClosers(text)) {
      if (extra.ch !== after[2]) {
        continue;
      }
      const lineStart = text.lastIndexOf('\n', extra.index - 1) + 1;
      const atLineStart = text.slice(lineStart, extra.index).trim() === '';
      const indent = lineStart === 0 ? (currentLine.trim() === '' ? currentLine.length : -1) : extra.index - lineStart;
      if (afterIndent !== undefined && atLineStart && indent >= 0 && indent !== afterIndent) {
        continue;
      }
      text = text.slice(0, extra.index).trimEnd();
      hit('bracket');
      break;
    }
  }
  if (text.trim() === '') {
    return '';
  }
  lines = text.split('\n');

  // 4c. 光标停在只有闭合括号的一行之后，结果另起一行却比这一行缩进更深：代码块已经结束，模型还按"在块里"续写。
  // 以 . ? : 等开头的行是上一条表达式的延续（链式调用等），不算。
  if (/^\s*[}\])]+[;,]?\s*$/.test(currentLine) && lines.length > 1 && (lines[0] ?? '').trim() === '') {
    const first = lines.find((l, i) => i > 0 && l.trim() !== '');
    const indent = first === undefined ? 0 : (/^[ \t]*/.exec(first) as RegExpExecArray)[0].length;
    if (first !== undefined && indent > baseIndent.length && !/^(?:[.?:&|+\-*]|\/(?![/*]))/.test(first.trim())) {
      hit('overindent');
      return '';
    }
  }

  // 5. 复读前文：第一个非空行与 prefix 最后一个非空行相同（长度 >= 8）
  const firstNonEmpty = (lines.find((l) => l.trim() !== '') ?? '').trim();
  if (firstNonEmpty.length >= 8 && firstNonEmpty === lastNonEmptyLine(input.prefix)) {
    hit('repeatPrefix');
    return '';
  }

  // 5a. 复读刚写完的代码块：结果开头的若干行，逐行等于 prefix 结尾的若干行（至少 2 行、合计 >= 20 字符）。
  // 常见于接受一段补全后光标停在块尾，模型把同一段又写一遍。
  const tail = input.prefix.split('\n').map((l) => l.trim()).filter((l) => l !== '').slice(-30);
  const head = lines.map((l) => l.trim()).filter((l) => l !== '');
  for (let n = Math.min(tail.length, head.length); n >= 2; n--) {
    const run = tail.slice(-n);
    if (run.every((l, i) => l === head[i]) && run.join('').length >= 20) {
      hit('replay');
      return '';
    }
  }
  // 整个结果（去掉注释行后 4 行以上、相同部分合计 >= 60 字符）逐行等于光标前 40 行代码内的某一段：
  // 同样是复读，只是没接在最后一行。两边都以闭合符开头的行算对上（"}" 与 "} else {"）。
  // 有任何一行实质内容不同就不算——照着上一段写一个相似的块是正常写法。
  const isComment = (l: string) => /^(\/\/|\/\*|\*|#|<!--)/.test(l);
  const closer = /^[)\]}]/;
  const code = head.filter((l) => !isComment(l));
  const recent = input.prefix.split('\n').map((l) => l.trim()).filter((l) => l !== '' && !isComment(l)).slice(-40);
  if (code.length >= 4) {
    for (let j = 0; j + code.length <= recent.length; j++) {
      let same = 0;
      const all = code.every((l, i) => {
        const other = recent[j + i] as string;
        if (l === other) {
          same += l.length;
          return true;
        }
        return closer.test(l) && closer.test(other);
      });
      if (all && same >= 60) {
        hit('replay');
        return '';
      }
    }
  }

  // 5b. 整块照抄：结果里有一段连续的代码行（去掉注释与空行后至少 6 行、合计 >= 120 字符），与光标之前窗口里的某一段连续代码行逐行相同，
  // 并且这一段占结果代码行的 60% 以上。模型常把窗口里离得很远的一整块（埋点、提示之类）原样再写一遍。
  // 只要有零星几行不同、或者相同的连续行不多（照着相邻的块写个相似的），都不算。
  if (code.length >= 6) {
    const before = input.prefix.split('\n').map((l) => l.trim()).filter((l) => l !== '' && !isComment(l));
    let bestLines = 0;
    let bestChars = 0;
    for (let i = 0; i < code.length; i++) {
      for (let j = 0; j < before.length; j++) {
        let run = 0;
        let chars = 0;
        while (i + run < code.length && j + run < before.length && code[i + run] === before[j + run]) {
          chars += (code[i + run] as string).length;
          run++;
        }
        if (run > bestLines) {
          bestLines = run;
          bestChars = chars;
        }
      }
    }
    if (bestLines >= 6 && bestChars >= 120 && bestLines / code.length >= 0.6) {
      hit('clone');
      return '';
    }
  }

  // 6. 行尾重叠：当前行光标后的文本（足够长）原样出现在结果末尾
  const rest = firstLine(input.suffix).trim();
  if (rest.length >= 6 && text.endsWith(rest)) {
    text = text.slice(0, text.length - rest.length).trimEnd();
    lines = text.split('\n');
    hit('tailOverlap');
  }

  // 7. 后文行重叠：结果第 2 行起出现与后文下一非空行相同的行，从该行起截断。
  // 光标在空行时首行也参与比较（要求更长），拦住"把下面已有的那行原样抄上来"。
  const next = nextNonEmptyLineAfterFirst(input.suffix);
  let cutBySuffix = false;
  if (next.length >= 6) {
    for (let i = currentLine.trim() === '' && next.length >= 8 ? 0 : 1; i < lines.length; i++) {
      if ((lines[i] ?? '').trim() === next) {
        text = lines.slice(0, i).join('\n').trimEnd();
        hit('suffixLine');
        cutBySuffix = true;
        break;
      }
    }
  }

  // 7a. 后文回声：结果里有一行（去掉空白后至少 40 个字符、不是注释）与光标之后 80 行内的某一行逐字相同，
  // 说明模型把后面已经有的代码又写了一遍；从该行起截断，首行就是则整条拒绝。比规则 7 看得更远，但门槛更高。
  const echoed = new Set(input.suffix.split('\n').slice(1, 81).map((l) => l.trim())
    .filter((l) => l.length >= 40 && !/^(\/\/|\/\*|\*|#|<!--)/.test(l)));
  if (echoed.size > 0) {
    lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (echoed.has((lines[i] ?? '').trim())) {
        text = lines.slice(0, i).join('\n').trimEnd();
        hit('suffixEcho');
        cutBySuffix = true;
        break;
      }
    }
  }

  // 7b. 按后文截断之后留下的是写到一半的语句（括号没配平、且不是以 { 结尾的块开头）：残句比没有更糟，整条不展示。
  // 以 { 结尾的块开头（"if (x) {"）可以单独展示，用户接着往块里写。
  if (cutBySuffix && text.trim() !== '' && netDepth(text) > 0 && !/\{\s*$/.test(text)) {
    hit('fragment');
    return '';
  }

  // 8. 再次判空
  return text.trim() === '' ? '' : text;
}
