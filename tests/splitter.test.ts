/**
 * 侧栏分隔条的纯逻辑测试。
 *
 * 这里守的是三件事：
 *   ① 拖动换算的符号别搞反（左栏往右拖变宽、右栏往左拖变宽）
 *   ② 宽度永远夹在 [0, 上限]，不会把画布挤成一条缝
 *   ③ 收起（0）与恢复的切换
 */
import { describe, expect, it } from 'vitest';
import {
  PANEL_MAX, PANEL_MIN, PANEL_STEP, clampPair, panelMax, toggleWidth, widthFromPointer,
} from '../src/ui/splitter';

describe('widthFromPointer', () => {
  it('左栏：往右拖变宽', () => {
    expect(widthFromPointer(100, 252, 200, 1, 560)).toBe(352);
  });

  it('左栏：往左拖变窄', () => {
    expect(widthFromPointer(100, 252, 50, 1, 560)).toBe(202);
  });

  it('右栏：往左拖变宽（dir 反过来）', () => {
    expect(widthFromPointer(100, 344, 50, -1, 560)).toBe(394);
  });

  it('右栏：往右拖变窄', () => {
    expect(widthFromPointer(100, 344, 200, -1, 560)).toBe(244);
  });

  it('拖到屏幕边外 → 收到 0（这就是"收起"）', () => {
    expect(widthFromPointer(300, 252, 0, 1, 560)).toBe(0);
    expect(widthFromPointer(100, 344, 9999, -1, 560)).toBe(0);
  });

  it('不超过上限', () => {
    expect(widthFromPointer(0, 252, 5000, 1, 560)).toBe(PANEL_MAX);
  });

  it('取整，不出小数像素', () => {
    expect(Number.isInteger(widthFromPointer(0, 252, 10.4, 1, 560))).toBe(true);
  });
});

describe('clampPair', () => {
  it('正常宽度原样保留（1920 宽的窗口放得下默认布局）', () => {
    expect(clampPair(252, 344, 1920)).toEqual({ left: 252, right: 344 });
  });

  it('收起的那个保持 0（不能被"顺手撑开"）', () => {
    const c = clampPair(0, 344, 1920);
    expect(c.left).toBe(0);
  });

  it('每边不超过窗口的 45%', () => {
    const c = clampPair(9999, 10, 900);
    expect(c.left).toBeLessThanOrEqual(Math.floor(900 * 0.45));
  });

  it('两侧合计不超过窗口的 70% —— 画布至少留三成', () => {
    const c = clampPair(500, 500, 900);
    expect(c.left + c.right).toBeLessThanOrEqual(Math.floor(900 * 0.7));
  });

  it('窗口很窄时两边都被夹小', () => {
    const c = clampPair(400, 400, 600);
    expect(c.left).toBeLessThanOrEqual(Math.floor(600 * 0.45));
    expect(c.right).toBeLessThanOrEqual(Math.floor(600 * 0.45));
    expect(c.left + c.right).toBeLessThanOrEqual(Math.floor(600 * 0.7));
  });

  it('单边不超过 PANEL_MAX', () => {
    const c = clampPair(9999, 10, 4000);
    expect(c.left).toBeLessThanOrEqual(PANEL_MAX);
  });

  it('不会死循环（第一版这里差值为负，越砍越大）', () => {
    const c = clampPair(560, 560, 1000);
    expect(c.left + c.right).toBeLessThanOrEqual(Math.floor(1000 * 0.7));
  });
});

describe('toggleWidth', () => {
  it('当前有宽度 → 收起', () => {
    expect(toggleWidth(252, 252)).toBe(PANEL_MIN);
  });

  it('当前是收起的 → 恢复成默认宽度', () => {
    expect(toggleWidth(0, 344)).toBe(344);
  });
});

describe('键盘步进', () => {
  it('步长是 16px', () => {
    expect(PANEL_STEP).toBe(16);
  });
});

describe('panelMax（拖动和夹紧必须用同一个上限）', () => {
  it('窗口的 45%（但不超过 PANEL_MAX）', () => {
    expect(panelMax(1000)).toBe(450);
    // 1920 宽时 45% 是 864，但 PANEL_MAX=560 先封顶
    expect(panelMax(1920)).toBe(PANEL_MAX);
    expect(panelMax(1200)).toBe(540);
  });

  it('不超过 PANEL_MAX', () => {
    expect(panelMax(9999)).toBe(PANEL_MAX);
  });

  it('窄窗口也不会算出负数', () => {
    expect(panelMax(10)).toBe(4);
    expect(panelMax(0)).toBe(0);
  });

  it('拖动上限 == 夹紧后的单边上限（不然宽度会"自己跳一下"）', () => {
    const avail = 1280;
    const dragged = widthFromPointer(0, 0, 9999, 1, panelMax(avail));
    const clamped = clampPair(dragged, 0, avail);
    expect(clamped.left).toBe(dragged);
  });
});
