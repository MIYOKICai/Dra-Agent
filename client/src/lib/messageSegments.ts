/**
 * 助手消息分段：把含 ``` 围栏的回复拆成 文本 / 代码 段。
 * 流式期间围栏可能尚未闭合——按"代码段直到结尾"处理，保证打字过程中代码块也能实时渲染。
 */

export interface MessageSegment {
  type: 'text' | 'code';
  content: string;
  /** 代码段语言（围栏标注优先，缺失时按内容探测）；文本段为空串 */
  language: string;
}

/** 未标注语言时按代码内容粗探测（只做高频场景） */
function detectLanguage(code: string): string {
  if (/^\s*(<!doctype\s+html|<html[\s>])/i.test(code)) return 'html';
  if (/^\s*<svg[\s>]/i.test(code)) return 'svg';
  /* HTML 片段（<div… 等标签开头、无 DOCTYPE）也按 html 高亮，避免整块纯文本 */
  if (/^\s*<\/?[a-zA-Z][a-zA-Z0-9-]*[\s>]/.test(code)) return 'html';
  if (/^\s*[[{][\s\S]*[\]}]\s*$/.test(code)) return 'json';
  return '';
}

/** 按围栏拆分消息；返回的段顺序与原文一致 */
export function parseMessageSegments(text: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  // 闭合围栏正常截断；未闭合（流式中）匹配到串尾
  const re = /```([a-zA-Z0-9_+#-]*)[ \t]*\n?([\s\S]*?)(?:```|$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) {
      segments.push({ type: 'text', content: text.slice(last, m.index), language: '' });
    }
    const code = m[2].replace(/\n$/, '');
    if (code.trim().length > 0) {
      const annotated = m[1].toLowerCase();
      segments.push({
        type: 'code',
        content: code,
        language: annotated || detectLanguage(code),
      });
    } else if (annotatedOrEmpty(m[1])) {
      // 空代码体（如刚出现 ```lang 还没流入内容）保留占位，让流式渲染稳定
      segments.push({ type: 'code', content: '', language: m[1].toLowerCase() });
    }
    last = m.index + m[0].length;
    if (m[0].length === 0) break; // 零长匹配防护
  }
  if (last < text.length) {
    segments.push({ type: 'text', content: text.slice(last), language: '' });
  }
  return segments;
}

function annotatedOrEmpty(lang: string): boolean {
  return lang.length > 0;
}
