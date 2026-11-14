/**
 * 左右侧栏分隔条（画布全屏）。
 *
 * 需求：拖着分隔条调侧栏宽度；一直拖到屏幕边上，侧栏宽度归零 = 收起，
 * 画布占满整宽。
 *
 * 为什么单独抽一个模块：几何换算是纯逻辑，值得单测。
 * DOM 那部分在 app.ts 里接。
 */

/** 侧栏宽度上限（px）。再宽就把画布挤没了。 */
export const PANEL_MAX = 560;

/** 键盘微调一步（px）。 */
export const PANEL_STEP = 16;

/** 拖到多窄算"收起"。0 就是收起，但留一点点余量让指针还能继续往外拖。 */
export const PANEL_MIN = 0;

/**
 * 单侧宽度上限。
 *
 * 窗口的 45%：再宽就把画布挤没了。
 * 拖动和夹紧**必须用同一个值** —— 不然用户能拖到 50%，
 * 下次窗口一变就被夹回 45%，宽度会"自己跳一下"。
 */
export function panelMax(avail: number): number {
  return Math.max(0, Math.min(PANEL_MAX, Math.floor(avail * 0.45)));
}

/**
 * 指针位置 → 侧栏宽度。
 *
 * @param startX   按下时的指针 X
 * @param startW   按下时的侧栏宽度
 * @param clientX  当前指针 X
 * @param dir      1 = 往右拖变宽（左栏）；-1 = 往左拖变宽（右栏）
 * @param max      宽度上限
 */
export function widthFromPointer(
  startX: number, startW: number, clientX: number, dir: 1 | -1, max: number,
): number {
  const raw = startW + (clientX - startX) * dir;
  return Math.round(Math.max(PANEL_MIN, Math.min(max, raw)));
}

/**
 * 两侧栏合计不能把画布挤没了。
 *
 * 规则：每边不超过窗口的 45%（也不超过 PANEL_MAX），两边合计不超过窗口的 70%
 * —— 画布至少留 30%。不然拖完左栏才发现右栏也没地方去，画布变成一条缝。
 */
export function clampPair(
  left: number, right: number, avail: number,
): { left: number; right: number } {
  const each = panelMax(avail);
  const total = Math.floor(avail * 0.7);
  let l = Math.max(PANEL_MIN, Math.min(each, Math.round(left)));
  let r = Math.max(PANEL_MIN, Math.min(each, Math.round(right)));
  // 合计超了：从大的一边砍一刀。
  // ⚠️ 这里只能砍一刀 —— 写成 while 的话，"砍多少"算错（差值为负）就会
  //    越砍越大，直接死循环。单测第一次就撞上了这个。
  const over = l + r - total;
  if (over > 0) {
    if (l >= r) l = Math.max(PANEL_MIN, l - over);
    else r = Math.max(PANEL_MIN, r - over);
  }
  return { left: l, right: r };
}

/** 双击 / 回车：收起 ↔ 恢复。收起时恢复成默认宽度。 */
export function toggleWidth(current: number, defaultW: number): number {
  return current > 0 ? PANEL_MIN : Math.max(PANEL_MIN, defaultW);
}
