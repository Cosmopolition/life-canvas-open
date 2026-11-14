import { describe, expect, it } from 'vitest';
import { BigramIndex, grams, normalize, snippet, tokenize } from '../src/search/indexer';
import { charWidth, measure, wrapByWidth } from '../src/canvas/text-layout';

describe('中文分词（bigram）', () => {
  it('归一化去掉标点空格并转半角', () => {
    expect(normalize('  换工作！！ ')).toBe('换工作');
    expect(normalize('ＡＢＣ')).toBe('abc');
  });

  it('grams 是相邻二字组', () => {
    expect(grams('换工作')).toEqual(['换工', '工作']);
  });

  it('tokenize 同时产出单字与 bigram —— 单字查询才命中最得中', () => {
    expect(tokenize('钱')).toEqual(['钱']);
    expect(tokenize('换工')).toEqual(['换', '换工', '工']);
  });

  it('空串不产生 token', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('   ')).toEqual([]);
  });
});

describe('BigramIndex', () => {
  const docs = [
    { id: 'a', title: '我可能不是想换工作', content: '是想换一个自己的定义', spaceId: 'default', tags: ['转折'], reasons: ['想清楚了'] },
    { id: 'b', title: '去一家节奏更快的公司证明自己', content: '想换个环境，逼自己加速', spaceId: 'default', tags: ['职业'], reasons: ['头衔路线走不通'] },
    { id: 'c', title: '存款', content: '4.2 个月生活费', spaceId: 'default', tags: [], reasons: [] },
  ];
  const build = () => { const ix = new BigramIndex(); docs.forEach((d) => ix.add(d)); return ix; };

  it('中文短语能命中', () => {
    const ids = build().search('换工作').map((h) => h.id);
    expect(ids).toContain('a');
    expect(ids).not.toContain('c');
  });

  it('命中内容而不只是标题', () => {
    expect(build().search('生活费').map((h) => h.id)).toContain('c');
  });

  it('命中标签', () => {
    expect(build().search('转折').map((h) => h.id)).toContain('a');
  });

  it('命中版本原因 —— 对应场景 F「以后搜得到」', () => {
    expect(build().search('头衔').map((h) => h.id)).toContain('b');
  });

  it('多词是 AND，不是 OR', () => {
    const ids = build().search('换工作 生活费').map((h) => h.id);
    expect(ids).toHaveLength(0);
  });

  it('标题命中权重高于正文', () => {
    const ix = new BigramIndex();
    ix.add({ id: 'title-hit', title: '里程碑', content: '', spaceId: 'default', tags: [], reasons: [] });
    ix.add({ id: 'body-hit', title: 'zzz', content: '里程碑在这里', spaceId: 'default', tags: [], reasons: [] });
    const r = ix.search('里程碑');
    expect(r[0]!.id).toBe('title-hit');
    expect(r[0]!.field).toBe('title');
  });

  it('单字也能搜到', () => {
    expect(build().search('存').map((h) => h.id)).toContain('c');
  });

  it('更新文档后旧内容不再命中', () => {
    const ix = build();
    expect(ix.search('生活费').map((h) => h.id)).toContain('c');
    ix.add({ id: 'c', title: '存款', content: '换了别的说法', spaceId: 'default', tags: [], reasons: [] });
    expect(ix.search('生活费')).toHaveLength(0);
    expect(ix.search('别的说法').map((h) => h.id)).toContain('c');
  });

  it('remove 之后不再命中，size 同步', () => {
    const ix = build();
    expect(ix.size).toBe(3);
    ix.remove('c');
    expect(ix.size).toBe(2);
    expect(ix.search('生活费')).toHaveLength(0);
  });

  it('clear 清空全部 —— 锁定时必须不留明文', () => {
    const ix = build();
    ix.clear();
    expect(ix.size).toBe(0);
    expect(ix.search('换工作')).toHaveLength(0);
  });

  it('空查询与未收录词返回空', () => {
    const ix = build();
    expect(ix.search('')).toHaveLength(0);
    expect(ix.search('量子力学')).toHaveLength(0);
  });

  it('尊重 limit', () => {
    const ix = new BigramIndex();
    for (let i = 0; i < 500; i++) ix.add({ id: `n${i}`, title: `共同的词${i}`, content: '', spaceId: 'default', tags: [], reasons: [] });
    expect(ix.search('共同的词', 20)).toHaveLength(20);
  });
});

describe('片段提取', () => {
  it('围绕命中位置截取并加省略号', () => {
    const text = '前面很长的一段铺垫内容'.repeat(6) + '关键词在这里出现' + '后面还有很多内容'.repeat(6);
    const s = snippet(text, '关键词', 30);
    expect(s.length).toBeLessThanOrEqual(34);
    expect(s).toContain('关键');
  });

  it('空文本返回空串', () => {
    expect(snippet('', 'x')).toBe('');
  });
});

describe('文本排版', () => {
  it('中文按 1em、ASCII 更窄', () => {
    expect(charWidth('中', 14)).toBe(14);
    expect(charWidth('a', 14)).toBeLessThan(14);
    expect(charWidth('中', 14)).toBeGreaterThan(charWidth('a', 14));
  });

  it('measure 随宽度线性增长', () => {
    expect(measure('中中中', 12)).toBe(36);
    expect(measure('', 12)).toBe(0);
  });

  it('按像素宽度折行而不是按字数', () => {
    const lines = wrapByWidth('这是一个很长的中文标题需要折行', 14, 70, 2);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.length).toBeLessThanOrEqual(2);
    for (const l of lines) expect(measure(l, 14)).toBeLessThanOrEqual(70 + 14);
  });

  it('超长文本被截断加省略号，不丢行数上限', () => {
    const lines = wrapByWidth('一'.repeat(200), 14, 70, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1]!.endsWith('…')).toBe(true);
  });

  it('空文本也能返回一行，不崩', () => {
    expect(wrapByWidth('', 14, 100, 2)).toEqual(['']);
  });

  it('一行放得下时只返回一行', () => {
    expect(wrapByWidth('短', 14, 200, 2)).toEqual(['短']);
  });
});