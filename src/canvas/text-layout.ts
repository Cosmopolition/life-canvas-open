/**
 * 文本排版（§6.4）。Canvas 没有自动换行，必须自己按字符宽度累加。
 * 中日韩字符按 1em，ASCII 按 0.55em 估算 —— 按"字数"折行在中文下会溢出。
 */

const CJK_RANGES: [number, number][] = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6],
];

export function charWidth(ch: string, fontSize: number): number {
  const c = ch.codePointAt(0) ?? 0;
  for (const [a, b] of CJK_RANGES) if (c >= a && c <= b) return fontSize;
  if (ch === ' ') return fontSize * 0.28;
  if (/[iIl1.,'!:;|]/.test(ch)) return fontSize * 0.32;
  if (/[mwMW@%&]/.test(ch)) return fontSize * 0.85;
  return fontSize * 0.55;
}

export function measure(text: string, fontSize: number): number {
  let w = 0;
  for (const ch of text) w += charWidth(ch, fontSize);
  return w;
}

/** 截断到指定宽度（放不下就加省略号）。单行标题用。 */
export function ellipsize(text: string, fontSize: number, maxWidth: number): string {
  if (measure(text, fontSize) <= maxWidth) return text;
  const ell = '…';
  const ellW = measure(ell, fontSize);
  let out = '';
  let w = 0;
  for (const ch of text) {
    const cw = charWidth(ch, fontSize);
    if (w + cw + ellW > maxWidth) break;
    out += ch; w += cw;
  }
  return out ? out + ell : '';
}

/** 按像素宽度折行 */
export function wrapByWidth(text: string, fontSize: number, maxWidth: number, maxLines: number): string[] {
  const lines: string[] = [];
  let cur = '';
  let curW = 0;
  for (const ch of text) {
    const w = charWidth(ch, fontSize);
    if (curW + w > maxWidth && cur.length) {
      lines.push(cur);
      cur = ch; curW = w;
      if (lines.length === maxLines) break;
    } else { cur += ch; curW += w; }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (!lines.length) lines.push('');

  // 超出行数上限 → 最后一行截断加省略号
  const joined = lines.join('');
  if (joined.length < text.length) {
    const li = lines.length - 1;
    const last = lines[li] ?? '';
    const room = Math.max(1, Math.floor(maxWidth / (fontSize * 0.55)) - 1);
    lines[li] = last.slice(0, Math.min(last.length, room)) + '…';
  }
  return lines;
}

/** 节点排版结果缓存：节点 id + 宽度 + 标题 → 行数组 */
export class LayoutCache {
  private map = new Map<string, { w: number; title: string; lines: string[] }>();
  private max = 4000;

  lines(id: string, title: string, nodeW: number, fontSize = 13.5, lines = 2): string[] {
    const hit = this.map.get(id);
    if (hit && hit.w === nodeW && hit.title === title) return hit.lines;
    const out = wrapByWidth(title, fontSize, nodeW - 28, lines);
    if (this.map.size > this.max) this.map.clear();
    this.map.set(id, { w: nodeW, title, lines: out });
    return out;
  }

  invalidate(id?: string): void { if (id) this.map.delete(id); else this.map.clear(); }
}
