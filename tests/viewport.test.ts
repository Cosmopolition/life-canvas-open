/**
 * 视口定位的纯逻辑测试。
 *
 * 重点是 `fitTo` 的**可读下限**（minScale）：
 * 渲染器在缩放 < 0.45（LOD_SCALE）时不画任何文字，
 * 所以自动定位一旦落到那儿，视图就退化成一片纯色块 —— 看得见有点，
 * 认不出那是什么。fit 必须守住这个下限。
 */
import { describe, expect, it } from 'vitest';
import { fitTo, MIN_SCALE, MAX_SCALE, clampScale, screenToWorld, worldToScreen, zoomAt } from '../src/canvas/viewport';
import { ellipsize, measure } from '../src/canvas/text-layout';

const rect = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

describe('fitTo', () => {
  it('空集合返回 null', () => {
    expect(fitTo([], 1000, 800)).toBeNull();
  });

  it('小内容缩到上限（不超过 maxScale）', () => {
    const t = fitTo([rect(0, 0, 100, 50)], 1000, 800, 78, 1.15);
    expect(t!.scale).toBeCloseTo(1.15, 5);
  });

  it('宽内容按包围盒等比缩小并居中', () => {
    const t = fitTo([rect(0, 0, 2000, 1000)], 1000, 800, 78, 1.15);
    // (1000-156)/2000 = 0.422；(800-156)/1000 = 0.644 → 取小
    expect(t!.scale).toBeCloseTo(0.422, 3);
    // 内容中心 (1000, 500) 映射到视口中心
    expect(t!.tx + 1000 * t!.scale).toBeCloseTo(500, 3);
    expect(t!.ty + 500 * t!.scale).toBeCloseTo(400, 3);
  });

  it('minScale 守住可读下限：算出来更小时不缩到 LOD 区', () => {
    const wide = [rect(0, 0, 2880, 1966)];   // 27 个点铺开的真实量级
    const noFloor = fitTo(wide, 1164, 844, 78, 1.15, 0);
    const floored = fitTo(wide, 1164, 844, 78, 1.15, 0.45);
    expect(noFloor!.scale).toBeLessThan(0.45);      // 不设下限 → 掉进 LOD 区
    expect(floored!.scale).toBeCloseTo(0.45, 5);   // 设下限 → 停在文字出现点
  });

  it('minScale 不会把缩放顶到超过 maxScale', () => {
    const t = fitTo([rect(0, 0, 100, 50)], 1000, 800, 78, 1.15, 0.9);
    expect(t!.scale).toBeCloseTo(1.15, 5);
  });

  it('minScale 也不会突破 MIN_SCALE', () => {
    const t = fitTo([rect(0, 0, 100000, 100000)], 1000, 800, 78, 1.15, 0.0001);
    expect(t!.scale).toBeGreaterThanOrEqual(MIN_SCALE);
  });
});

describe('ellipsize', () => {
  it('放得下就原样返回', () => {
    expect(ellipsize('短标题', 12, 200)).toBe('短标题');
  });

  it('放不下就截断加省略号', () => {
    const s = ellipsize('这是一段很长的标题需要被截断', 12, 60);
    expect(s.endsWith('…')).toBe(true);
    expect(s.length).toBeLessThan('这是一段很长的标题需要被截断'.length);
  });

  it('截断后的宽度不超过上限', () => {
    const src = '增肌3kg-体重维持';
    for (const w of [20, 40, 60, 90]) {
      expect(measure(ellipsize(src, 12, w), 12)).toBeLessThanOrEqual(w + 0.001);
    }
  });

  it('宽度太小时返回空串（不画半个字）', () => {
    expect(ellipsize('标题', 12, 1)).toBe('');
  });
});

describe('视口变换', () => {
  it('clampScale 卡在 [MIN_SCALE, MAX_SCALE]', () => {
    expect(clampScale(0.001)).toBe(MIN_SCALE);
    expect(clampScale(999)).toBe(MAX_SCALE);
  });

  it('world ↔ screen 互逆', () => {
    const v = { tx: 120, ty: -40, scale: 0.45 };
    const [sx, sy] = worldToScreen(v, 300, 200);
    const [wx, wy] = screenToWorld(v, sx, sy);
    expect(wx).toBeCloseTo(300, 6);
    expect(wy).toBeCloseTo(200, 6);
  });

  it('zoomAt 以光标为锚点', () => {
    const v = { tx: 0, ty: 0, scale: 1 };
    const next = zoomAt(v, 500, 400, 2);
    expect(next.scale).toBe(2);
    const [wx, wy] = screenToWorld(next, 500, 400);
    expect(wx).toBeCloseTo(500, 6);
    expect(wy).toBeCloseTo(400, 6);
  });
});
