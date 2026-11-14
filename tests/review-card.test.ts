/**
 * 阶段五：复盘卡片（1080×1440 PNG）的排版逻辑。
 *
 * 这里测的是**纯排版层**（planCard / wrapText）—— 渲染层要 canvas，测不了。
 *
 * ★ 硬约束：软件不生成总结文字。
 *   所以这里有一条断言专门盯着：**卡片上的每一行都必须是用户原文的片段**，
 *   不许出现任何"总结""亮点""本周关键词"这类软件自己写的话。
 */
import { describe, expect, it } from 'vitest';
import {
  BODY_LH, CARD_DPR, CARD_H, CARD_W, F_BODY, F_TITLE, GAP, IMG_RATIO, MIN_SCALE,
  PAD, TITLE_LH, cardLines, cardMetaLines, metaLine, planCard, wrapText,
} from '../src/export/review-card';
import type { Measure } from '../src/export/review-card';
import { MAIN_SPACE } from '../src/model/space';
import type { LifeNode } from '../src/model/types';

const mkNode = (id: string, over: Partial<LifeNode> = {}): LifeNode => ({
  id, kind: 'node', spaceId: MAIN_SPACE, type: 'idea', title: id, content: '',
  tags: [], themeIds: [], stageIds: [],
  x: 0, y: 0, w: 200, h: 80,
  createdAt: 0, updatedAt: 0, ...over,
});

/** 假的量宽函数：每个字符 1em（宽字符正好，中文符合）—— 便于手算期望值 */
const measureFake: Measure = (t, f) => t.length * f.size;
const CW = CARD_W - PAD * 2;

/* ============================================================
 * 卡片尺寸
 * ============================================================ */

describe('卡片尺寸', () => {
  it('1080 × 1440（3:4 竖版）', () => {
    expect(CARD_W).toBe(1080);
    expect(CARD_H).toBe(1440);
    expect(CARD_W / CARD_H).toBeCloseTo(0.75, 5);
  });

  it('后备存储是 2 倍（2160 × 2880）', () => {
    expect(CARD_DPR).toBe(2);
  });
});

/* ============================================================
 * 折行
 * ============================================================ */

describe('折行', () => {
  it('中文按字断', () => {
    // 标题 26px、内容区宽 936 ⇒ 每行 36 字
    const lines = wrapText(measureFake, '一'.repeat(50), CW, F_TITLE);
    expect(lines.length).toBe(2);
    expect(lines[0]!.length).toBe(36);
    expect(lines[1]!.length).toBe(14);
  });

  it('英文按词断，不把单词劈两半', () => {
    const lines = wrapText(measureFake, 'hello world foo', 110, F_BODY);
    expect(lines).toEqual(['hello', 'world', 'foo']);
  });

  it('折行处的空格不单独占一行', () => {
    const lines = wrapText(measureFake, 'hello world', 110, F_BODY);
    expect(lines.every((l) => l.trim().length > 0)).toBe(true);
    expect(lines.join(' ')).toContain('hello');
    expect(lines.join(' ')).toContain('world');
  });

  it('放得下就不折', () => {
    const lines = wrapText(measureFake, '短句', CW, F_BODY);
    expect(lines).toEqual(['短句']);
  });

  it('换行符保留分段', () => {
    const lines = wrapText(measureFake, '第一段\n第二段', CW, F_BODY);
    expect(lines).toEqual(['第一段', '第二段']);
  });

  it('每一行都不超过给定宽度（长单词除外）', () => {
    const text = '这'.repeat(37) + ' end';
    const lines = wrapText(measureFake, text, CW, F_TITLE);
    for (const l of lines) expect(measureFake(l, F_TITLE)).toBeLessThanOrEqual(CW);
  });
});

/* ============================================================
 * 排版决策
 * ============================================================ */

const noImg = (): boolean => false;

describe('planCard', () => {
  it('按用户给的顺序排，不自己排序', () => {
    const nodes = [mkNode('c'), mkNode('a'), mkNode('b')];
    const p = planCard(nodes, { showFooter: true, withImage: noImg }, measureFake);
    expect(p.blocks.map((b) => b.nodeId)).toEqual(['c', 'a', 'b']);
  });

  it('有图 ⇒ 图块；没图 ⇒ 文字块', () => {
    const nodes = [mkNode('a', { imageData: 'data:image/png;base64,xx' }), mkNode('b')];
    const p = planCard(nodes, {
      showFooter: true,
      withImage: (n) => n.id === 'a',
    }, measureFake);
    expect(p.blocks[0]!.kind).toBe('image');
    expect(p.blocks[1]!.kind).toBe('text');
  });

  it('图拉不下来 ⇒ 退化成文字块（不占图位）', () => {
    const nodes = [mkNode('a', { imageUrl: 'https://x/y.jpg' })];
    const p = planCard(nodes, { showFooter: true, withImage: noImg }, measureFake);
    expect(p.blocks[0]!.kind).toBe('text');
  });

  it('图块比同尺寸文字块高（图 + 标题）', () => {
    const withImg = planCard([mkNode('a', { title: '标题' })], {
      showFooter: true, withImage: () => true,
    }, measureFake);
    const noImgPlan = planCard([mkNode('a', { title: '标题' })], {
      showFooter: true, withImage: noImg,
    }, measureFake);
    expect(withImg.blocks[0]!.h).toBeGreaterThan(noImgPlan.blocks[0]!.h);
    // 图块高 = 图高 + 间距 + 标题高 + 小字高
    const expectH = Math.round(CW * IMG_RATIO) + 14 + TITLE_LH + 10 + 24;
    expect(withImg.blocks[0]!.h).toBe(expectH);
  });

  it('放得下 ⇒ 不缩、不截', () => {
    const p = planCard([mkNode('a', { title: '短' })], { showFooter: true, withImage: noImg }, measureFake);
    expect(p.scale).toBe(1);
    expect(p.clipped).toBe(false);
    expect(p.totalH).toBeLessThan(p.availH);
  });

  it('放不下 ⇒ 先整体缩，缩得够就**不截**', () => {
    const many = Array.from({ length: 12 }, (_, i) => mkNode(`n${i}`, { title: '标题', content: '正文内容' }));
    const p = planCard(many, { showFooter: true, withImage: noImg }, measureFake);
    expect(p.scale).toBeLessThan(1);
    expect(p.scale).toBeGreaterThanOrEqual(MIN_SCALE);
    expect(p.clipped).toBe(false);
  });

  it('实在放不下 ⇒ 缩到下限并标 clipped（预览要告诉用户）', () => {
    const many = Array.from({ length: 200 }, (_, i) => mkNode(`n${i}`, { title: '标题', content: '正文内容' }));
    const p = planCard(many, { showFooter: true, withImage: noImg }, measureFake);
    expect(p.scale).toBe(MIN_SCALE);
    expect(p.clipped).toBe(true);
  });

  it('落款开着 ⇒ 可用高度更小', () => {
    const nodes = [mkNode('a', { title: '标题' })];
    const withF = planCard(nodes, { showFooter: true, withImage: noImg }, measureFake);
    const noF = planCard(nodes, { showFooter: false, withImage: noImg }, measureFake);
    expect(withF.availH).toBe(noF.availH - 56);
  });

  it('块高 = 标题 + 正文 + 小字 的行高之和', () => {
    const n = mkNode('a', { title: '标题', content: '正文', type: 'reflect', time: '2026-11-02' });
    const p = planCard([n], { showFooter: true, withImage: noImg }, measureFake);
    const expectH = TITLE_LH + 12 + BODY_LH + 10 + 24;
    expect(p.blocks[0]!.h).toBe(expectH);
  });

  it('块与块之间留 GAP', () => {
    const nodes = [mkNode('a'), mkNode('b')];
    const p = planCard(nodes, { showFooter: true, withImage: noImg }, measureFake);
    expect(p.totalH).toBe(p.blocks[0]!.h + p.blocks[1]!.h + GAP);
  });
});

/* ============================================================
 * ★ 硬约束：卡片上的每一个字都是用户自己写的
 * ============================================================ */

describe('卡片上不许有软件生成的字', () => {
  it('每一行标题/正文都是用户原文的片段', () => {
    const nodes = [
      mkNode('a', { title: '今天把那个功能做完了', content: '卡在最后一步，改了三遍。' }),
      mkNode('b', { title: '明天要问清楚需求', content: '顺便把设计稿发出去' }),
    ];
    const p = planCard(nodes, { showFooter: true, withImage: noImg }, measureFake);
    for (const b of p.blocks) {
      const src = nodes.find((n) => n.id === b.nodeId)!;
      for (const l of b.titleLines) expect(src.title).toContain(l);
      for (const l of b.bodyLines) expect(src.content).toContain(l);
    }
  });

  it('小字只有类型和时间（事实），没有评价', () => {
    const n = mkNode('a', { type: 'reflect', time: '2026-11-02' });
    expect(metaLine(n)).toBe('反思 · 2026-11-02');
    // 没有时间就只有类型
    expect(metaLine(mkNode('b', { type: 'work' }))).toBe('作品');
  });

  it('小字里不出现"总结/亮点/关键词"这类词', () => {
    const nodes = [
      mkNode('a', { type: 'goal', title: 'x' }),
      mkNode('b', { type: 'work', time: '2026-11-03' }),
      mkNode('c', { type: 'emotion' }),
    ];
    for (const n of nodes) {
      expect(metaLine(n)).not.toMatch(/总结|亮点|关键词|值得|优秀|建议/);
    }
  });

  it('正文行和小字行分开：正文是原文片段，小字是「类型 · 时间」', () => {
    const nodes = [
      mkNode('a', { title: '今天把功能做完了', content: '卡在最后一步', type: 'reflect', time: '2026-11-02' }),
    ];
    const p = planCard(nodes, { showFooter: true, withImage: noImg }, measureFake);
    // 正文行：全是原文片段
    expect(cardLines(p)).toEqual(['今天把功能做完了', '卡在最后一步']);
    // 小字行：类型 · 时间
    expect(cardMetaLines(p)).toEqual(['反思 · 2026-11-02']);
  });

  it('小字行里也不许出现生成的文字', () => {
    const nodes = [mkNode('a', { type: 'idea', title: 'x', time: '2026-11-02' })];
    const p = planCard(nodes, { showFooter: true, withImage: noImg }, measureFake);
    for (const m of cardMetaLines(p)) {
      expect(m).toMatch(/^(目标|事件|情绪|想法|人物|资源|行动|反思|地点|作品)( · .+)?$/);
    }
  });
});
