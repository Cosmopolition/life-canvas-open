/**
 * 今日视图相关：todayNodes selector + 端到端的 saveDiary/addSoft 流程。
 * 见 plan: 零增字段，reflect 节点 time=YYYY-MM-DD，content 用 ### 意图/### 复盘 分块。
 */
import { describe, expect, it } from 'vitest';
import { todayNodes } from '../src/model/selectors';
import { Store } from '../src/model/store';
import type { LifeNode } from '../src/model/types';
import { emptyLibrary } from '../src/model/types';

const TODAY = '2026-10-12';
const YESTERDAY = '2026-10-11';
const TOMORROW = '2026-10-13';

const mkNode = (id: string, over: Partial<LifeNode> = {}): LifeNode =>
  ({
    id, kind: 'node', spaceId: 's', type: 'idea', title: id, content: '',
    tags: [], themeIds: [], stageIds: [], x: 0, y: 0, w: 200, h: 80,
    createdAt: 0, updatedAt: 0, ...over,
  });

/** 今日视图用的内容解析：从 reflect.content 拆 intent/review */
function parseDiary(content: string): { intent: string; review: string } {
  const m = content.match(/### 意图\n([\s\S]*?)(?:\n\n### 复盘\n([\s\S]*))?$/);
  if (!m) return { intent: content, review: '' };
  return { intent: (m[1] ?? '').trim(), review: (m[2] ?? '').trim() };
}

describe('todayNodes', () => {
  it('空 lib 返回空', () => {
    const lib = emptyLibrary();
    expect(todayNodes(lib, TODAY)).toEqual({ diary: undefined, soft: [] });
  });

  it('跨日的节点一律不命中', () => {
    const lib = emptyLibrary();
    lib.nodes.push(
      mkNode('a', { type: 'action', time: YESTERDAY, title: '昨天' }),
      mkNode('b', { type: 'action', time: TOMORROW, title: '明天' }),
      mkNode('c', { type: 'reflect', time: YESTERDAY, title: '昨天日记' }),
      mkNode('d', { type: 'reflect', time: '2026-10', title: '无日期' }),
    );
    expect(todayNodes(lib, TODAY)).toEqual({ diary: undefined, soft: [] });
  });

  it('同日的多个 action 全部进入 soft', () => {
    const lib = emptyLibrary();
    lib.nodes.push(
      mkNode('a1', { type: 'action', time: TODAY, title: '投简历' }),
      mkNode('a2', { type: 'action', time: `${TODAY}T08:00`, title: '回邮件' }),
      mkNode('a3', { type: 'action', time: YESTERDAY, title: '昨天的不算' }),
    );
    const r = todayNodes(lib, TODAY);
    expect(r.soft).toHaveLength(2);
    expect(r.soft.map((n) => n.id).sort()).toEqual(['a1', 'a2']);
  });

  it('reflect 节点只取第一条作为 diary', () => {
    const lib = emptyLibrary();
    lib.nodes.push(
      mkNode('r1', { type: 'reflect', time: TODAY, title: '第一条' }),
      mkNode('r2', { type: 'reflect', time: TODAY, title: '第二条' }),
    );
    const r = todayNodes(lib, TODAY);
    expect(r.diary?.id).toBe('r1');
    expect(r.soft).toHaveLength(0);
  });

  it('event / idea / goal 等其他类型不进入 today', () => {
    const lib = emptyLibrary();
    lib.nodes.push(
      mkNode('e', { type: 'event', time: TODAY, title: '今天的事件' }),
      mkNode('i', { type: 'idea', time: TODAY, title: '今天的想法' }),
      mkNode('g', { type: 'goal', time: TODAY, title: '今天的目标' }),
    );
    expect(todayNodes(lib, TODAY)).toEqual({ diary: undefined, soft: [] });
  });
});

describe('saveDiary 流程（直接对 store 操作）', () => {
  it('首次保存：addNode 创建 reflect，content 含意图/复盘两个块', () => {
    const st = new Store();
    const t = todayNodes(st.lib, TODAY);
    expect(t.diary).toBeUndefined();
    const id = 'n-day-1';
    st.addNode({
      id, type: 'reflect', title: '10月12日', time: TODAY,
      content: `### 意图\n写完融合设计稿\n\n### 复盘\n(晚上写)`,
      tags: ['日记'],
      x: 0, y: 0, w: 280, h: 128,
    });
    const t2 = todayNodes(st.lib, TODAY);
    expect(t2.diary?.id).toBe(id);
    expect(t2.diary?.content).toContain('### 意图');
    expect(t2.diary?.content).toContain('### 复盘');
  });

  it('二次保存：updateNode 改 content，触发版本历史', () => {
    const st = new Store();
    const n0 = st.addNode({ type: 'reflect', title: '10/12', time: TODAY, content: '### 意图\n早' });
    st.flushVersion(n0.id, { reason: '今日视图保存' });

    st.updateNode(n0.id, { content: '### 意图\n早\n\n### 复盘\n晚' }, { reason: '今日视图保存' });
    st.flushVersion(n0.id, { reason: '今日视图保存' });

    const n = st.lib.nodes.find((x) => x.id === n0.id);
    expect(n?.content).toContain('### 复盘');
    // 两条历史：第一次创建 baseline + 一次内容更新
    const hist = st.versionsOf(n0.id);
    expect(hist.length).toBeGreaterThanOrEqual(2);
  });
});

describe('addSoft 流程', () => {
  it('addNode 创建一个 time=今天 的 action', () => {
    const st = new Store();
    st.addNode({ type: 'action', title: '投 1 家公司', time: TODAY, content: '不要用数量逃避判断' });
    const t = todayNodes(st.lib, TODAY);
    expect(t.soft).toHaveLength(1);
    expect(t.soft[0]?.title).toBe('投 1 家公司');
    expect(t.soft[0]?.type).toBe('action');
    expect(t.soft[0]?.time).toBe(TODAY);
  });
});

describe('内容解析（早/晚两段）', () => {
  it('从 content 拆出 intent 和 review', () => {
    const r = parseDiary('### 意图\n- 写完设计稿\n- 回邮件\n\n### 复盘\n- 设计稿交了\n- 邮件回了');
    expect(r.intent).toBe('- 写完设计稿\n- 回邮件');
    expect(r.review).toBe('- 设计稿交了\n- 邮件回了');
  });

  it('只有意图没有复盘也能解析', () => {
    const r = parseDiary('### 意图\n- 写完设计稿');
    expect(r.intent).toBe('- 写完设计稿');
    expect(r.review).toBe('');
  });

  it('没有标记的旧 reflect content 全部当 intent', () => {
    const r = parseDiary('今天想：早点睡');
    expect(r.intent).toBe('今天想：早点睡');
    expect(r.review).toBe('');
  });
});

describe('软安排编辑/删除（直接对 store 操作）', () => {
  it('updateNode + flushVersion 改 title 后在 today 仍能查到', () => {
    const st = new Store();
    const n0 = st.addNode({ type: 'action', title: '旧标题', time: TODAY, content: '' });
    st.flushVersion(n0.id, { reason: '创建' });

    st.updateNode(n0.id, { title: '新标题' }, { reason: '今日视图编辑软安排' });
    st.flushVersion(n0.id, { reason: '今日视图编辑软安排' });
    const n = st.lib.nodes.find((x) => x.id === n0.id);
    expect(n?.title).toBe('新标题');
    // 编辑后版本历史追加一条
    const hist = st.versionsOf(n0.id);
    expect(hist.length).toBeGreaterThanOrEqual(2);
    expect(hist[hist.length - 1]?.reason).toBe('今日视图编辑软安排');
  });

  it('removeNode 把软安排从 today 列表里彻底清掉', () => {
    const st = new Store();
    const n0 = st.addNode({ type: 'action', title: '要被删的', time: TODAY, content: '' });
    expect(todayNodes(st.lib, TODAY).soft).toHaveLength(1);
    st.removeNode(n0.id);
    expect(todayNodes(st.lib, TODAY).soft).toHaveLength(0);
  });

  it('删除跨日的软安排不影响今天', () => {
    const st = new Store();
    const a = st.addNode({ type: 'action', title: '今天的', time: TODAY, content: '' });
    st.addNode({ type: 'action', title: '昨天的', time: YESTERDAY, content: '' });
    expect(todayNodes(st.lib, TODAY).soft).toHaveLength(1);
    st.removeNode(a.id);
    expect(todayNodes(st.lib, TODAY).soft).toHaveLength(0);
  });
});

describe('action 节点的 done 状态（持久化）', () => {
  it('updateNode 写入 done 后节点带该字段', () => {
    const st = new Store();
    const n = st.addNode({ type: 'action', title: '投简历', time: TODAY, content: '' });
    st.updateNode(n.id, { done: true });
    expect(st.lib.nodes.find((x) => x.id === n.id)?.done).toBe(true);
  });

  it('改 done 字段不进版本历史（轻量状态，不是"内容修改"）', async () => {
    const st = new Store();
    const n = st.addNode({ type: 'action', title: '投简历', time: TODAY, content: '' });
    st.updateNode(n.id, { done: true });
    await new Promise((r) => setTimeout(r, 700));
    expect(st.versionsOf(n.id)).toHaveLength(0);
  });

  it('todayNodes 在 done=true 时仍能查到（已完成也是今天的行动）', () => {
    const st = new Store();
    const n = st.addNode({ type: 'action', title: '投简历', time: TODAY, content: '' });
    st.updateNode(n.id, { done: true });
    const r = todayNodes(st.lib, TODAY);
    expect(r.soft).toHaveLength(1);
    expect(r.soft[0]?.done).toBe(true);
  });

  it('完成后改 title 仍走版本历史（标题是内容）', async () => {
    const st = new Store();
    const n = st.addNode({ type: 'action', title: 'a', time: TODAY, content: '' });
    st.updateNode(n.id, { done: true });
    st.updateNode(n.id, { title: 'b' }, { reason: '完成确认' });
    await new Promise((r) => setTimeout(r, 700));
    expect(st.versionsOf(n.id).length).toBeGreaterThan(0);
  });
});
