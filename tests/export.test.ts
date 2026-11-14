import { describe, expect, it } from 'vitest';
import { fromBundle, toBundle, toJsonCanvas, toMarkdown } from '../src/persist/export';
import { buildSampleLibrary } from '../src/data/seed';
import type { Library } from '../src/model/types';

const lib = (): Library => {
  const s = buildSampleLibrary();
  return {
    ...s,
    themes: s.themes.map((t) => ({ ...t, spaceId: 'default' })),
    stages: s.stages.map((st) => ({ ...st, spaceId: 'default' })),
    nodes: s.nodes.map((n) => ({ ...n, spaceId: 'default' })),
    edges: s.edges.map((e) => ({ ...e, spaceId: 'default' })),
  };
};

describe('JSON 往返', () => {
  it('导出 → 导入 → 再导出完全等价（M1 DoD）', () => {
    const a = toBundle(lib());
    const restored = fromBundle(JSON.parse(JSON.stringify(a)));
    const b = toBundle(restored);
    // 键顺序无语义，fromBundle 会按固定顺序重建，所以比较规范化后的 JSON
    // undefined 的键会在 JSON 往返后消失，比较时两边都要忽略它们
    const canon = (v: unknown): string => {
      if (v === undefined) return 'undefined';
      if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
      if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
      const o = v as Record<string, unknown>;
      return '{' + Object.keys(o).sort()
        .filter((k) => o[k] !== undefined)
        .map((k) => JSON.stringify(k) + ':' + canon(o[k])).join(',') + '}';
    };
    const strip = (x: ReturnType<typeof toBundle>) => canon({ ...x, meta: { ...x.meta, exportedAt: '' } });
    expect(strip(b)).toBe(strip(a));
  });

  it('往返后实体数量与关键字段完全一致', () => {
    const src = lib();
    const out = fromBundle(JSON.parse(JSON.stringify(toBundle(src))));
    expect(out.nodes).toHaveLength(src.nodes.length);
    expect(out.edges).toHaveLength(src.edges.length);
    expect(out.themes).toHaveLength(src.themes.length);
    expect(out.stages).toHaveLength(src.stages.length);
    const byId = new Map(out.nodes.map((n) => [n.id, n]));
    for (const n of src.nodes) {
      const o = byId.get(n.id)!;
      expect(o.title).toBe(n.title);
      expect(o.type).toBe(n.type);
      expect(o.status).toBe(n.status);
      expect(o.themeIds).toEqual(n.themeIds);
      expect(o.stageIds).toEqual(n.stageIds);
      expect(o.x).toBe(n.x);
    }
  });

  it('拒绝非法文件而不是崩掉', () => {
    expect(() => fromBundle(null)).toThrow();
    expect(() => fromBundle({ foo: 1 })).toThrow();
    expect(() => fromBundle({ library: { nodes: 'no' } })).toThrow();
  });

  it('缺 edges/themes/stages/versions 的旧文件也能读', () => {
    const minimal = { library: { nodes: lib().nodes } };
    const out = fromBundle(minimal);
    expect(out.nodes.length).toBeGreaterThan(0);
    expect(out.edges).toEqual([]);
    expect(out.themes).toEqual([]);
    expect(out.stages).toEqual([]);
    expect(out.versions).toEqual([]);
  });
});

describe('Markdown 导出', () => {
  const md = toMarkdown(lib());

  it('主题是标题，关系单独成段，演变带原因', () => {
    expect(md).toContain('# 人生画布导出');
    expect(md).toMatch(/^## 身心健康/m);
    expect(md).toMatch(/^## 2026 过渡期/m);
    expect(md).toMatch(/^### 目标：/m);
    expect(md).toContain('#### 关系');
    expect(md).toContain('**取代**');
    expect(md).toContain('#### 演变');
  });

  it('取代链的演进原因写进了文件', () => {
    expect(md).toContain('想清楚「不是环境问题，是节奏问题」之后重设');
  });

  it('里程碑版本带星号标记', () => {
    expect(md).toContain('★');
  });

  it('限定单个主题时只导出该主题的节点', () => {
    const target = lib().themes.find((t) => t.name === '身心健康')!.id;
    const one = toMarkdown(lib(), target);
    expect(one).toContain('## 身心健康');
    expect(one).not.toContain('## 事业（职业）');
    expect(one).not.toContain('## 2026 过渡期');
  });

  it('限定单个阶段时只导出该阶段的节点', () => {
    const target = lib().stages.find((s) => s.name === '2026 过渡期')!.id;
    const one = toMarkdown(lib(), target);
    expect(one).toContain('## 2026 过渡期');
    expect(one).not.toContain('## 2023–2025 星河');
    expect(one).not.toContain('## 身心健康');
  });

  it('焦点 ID 不存在时回退到导出全部，而不是静默输出空文件', () => {
    const one = toMarkdown(lib(), 'a-does-not-exist');
    expect(one).toContain('## 2026 过渡期');
    expect(one).toContain('## 身心健康');
  });
});

describe('JSON Canvas 导出（迁移出口）', () => {
  const oc = toJsonCanvas(lib()) as { nodes: { id: string; type: string; x: number }[]; edges: { fromNode: string; toNode: string; label: string }[] };

  it('结构符合 Obsidian JSON Canvas', () => {
    expect(oc.nodes.length).toBeGreaterThan(0);
    for (const n of oc.nodes) {
      expect(typeof n.id).toBe('string');
      expect(typeof n.x).toBe('number');
      expect(['text', 'file', 'link', 'group']).toContain(n.type);
    }
  });

  it('边带中文标签', () => {
    expect(oc.edges.length).toBeGreaterThan(0);
    expect(oc.edges[0]!.label.length).toBeGreaterThan(0);
  });

  it('边的两端都能在 nodes 里找到', () => {
    const ids = new Set(oc.nodes.map((n) => n.id));
    for (const e of oc.edges) {
      expect(ids.has(e.fromNode), `缺 fromNode ${e.fromNode}`).toBe(true);
      expect(ids.has(e.toNode), `缺 toNode ${e.toNode}`).toBe(true);
    }
  });
});

describe('封面图导出', () => {
  it('imageData 走 data: 行（自包含）', () => {
    const l = lib();
    const target = l.nodes[0]!;
    target.imageData = 'data:image/jpeg;base64,/9j/abc';
    target.imageW = 800; target.imageH = 600;
    const md = toMarkdown(l);
    expect(md).toContain('![](data:image/jpeg;base64,/9j/abc)');
  });

  it('imageUrl 走普通 URL 行（不持久）', () => {
    const l = lib();
    const target = l.nodes[0]!;
    target.imageUrl = 'https://example.com/cover.jpg';
    const md = toMarkdown(l);
    expect(md).toContain('![](https://example.com/cover.jpg)');
    // 不该有 data: 行
    expect(md).not.toMatch(/!\[\]\(data:/);
  });

  it('imageData 优先于 imageUrl', () => {
    const l = lib();
    const target = l.nodes[0]!;
    target.imageData = 'data:image/png;base64,xyz';
    target.imageUrl = 'https://example.com/cover.jpg';
    const md = toMarkdown(l);
    expect(md).toContain('![](data:image/png;base64,xyz)');
    expect(md).not.toContain('https://example.com/cover.jpg');
  });

  it('无图时 markdown 里没有 ![]( 行', () => {
    const l = lib();
    const md = toMarkdown(l);
    expect(md).not.toMatch(/!\[\]\(/);
  });
});

describe('链接导出', () => {
  it('linkUrl 走 🔗 行；label 优先于 url 当显示文本', () => {
    const l = lib();
    const target = l.nodes[0]!;
    target.linkUrl = 'https://example.com/doc';
    target.linkLabel = '官方文档';
    const md = toMarkdown(l);
    expect(md).toContain('🔗 [官方文档](https://example.com/doc)');
  });

  it('linkLabel 为空时，链接文本就是 url 本身', () => {
    const l = lib();
    const target = l.nodes[0]!;
    target.linkUrl = 'https://example.com/x';
    const md = toMarkdown(l);
    expect(md).toContain('🔗 [https://example.com/x](https://example.com/x)');
  });

  it('无 linkUrl 时不写 🔗 行', () => {
    const l = lib();
    const md = toMarkdown(l);
    expect(md).not.toMatch(/🔗/);
  });
});

describe('done 状态导出', () => {
  it('done=true 的节点标题在 markdown 里用 ~~ 删除线包裹', () => {
    const l = lib();
    const a = l.nodes[0];
    if (!a) throw new Error('seed empty');
    const done = { ...a, done: true };
    const lDone: Library = { ...l, nodes: [done, ...l.nodes.slice(1)] };
    const md = toMarkdown(lDone);
    expect(md).toMatch(new RegExp(`~~${a.title.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}~~`));
  });

  it('done=false 的节点标题不带删除线', () => {
    const l = lib();
    const a = l.nodes[0];
    if (!a) throw new Error('seed empty');
    const notDone = { ...a, done: false };
    const lNot: Library = { ...l, nodes: [notDone, ...l.nodes.slice(1)] };
    const md = toMarkdown(lNot);
    expect(md).not.toMatch(new RegExp(`~~${a.title.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}~~`));
  });
});
