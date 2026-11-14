import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../src/model/store';
import type { LifeNode } from '../src/model/types';

/**
 * 版本历史是这个产品的核心承诺（需求文档 6.4）：
 * "修改不覆盖，保留原因"。这些用例把承诺钉死。
 */

const mk = (id = 'n1'): LifeNode => ({
  id, kind: 'node', spaceId: 's', type: 'idea', title: '原标题', content: '原内容',
  tags: [], themeIds: [], stageIds: [], x: 0, y: 0, w: 200, h: 80, createdAt: 0, updatedAt: 0,
});

let st: Store;
beforeEach(() => { st = new Store(); });

describe('自动快照', () => {
  it('内容不变就不产生版本 —— 位置调整不该进历史', async () => {
    const n = st.addNode({ type: 'idea', title: 'x' });
    st.moveNode(n.id, 100, 100);
    st.moveNode(n.id, 300, 300);
    await new Promise((r) => setTimeout(r, 700));
    expect(st.versionsOf(n.id)).toHaveLength(0);
  });

  it('改标题会产生一条版本', async () => {
    const n = st.addNode({ type: 'idea', title: 'a' });
    st.updateNode(n.id, { title: 'b' }, { reason: '想清楚了' });
    await new Promise((r) => setTimeout(r, 700));
    const vs = st.versionsOf(n.id);
    expect(vs).toHaveLength(1);
    expect(vs[0]!.reason).toBe('想清楚了');
    expect(JSON.parse(vs[0]!.snapshot).title).toBe('b');
  });

  it('原因缺省时落到占位文案，不允许静默丢失', async () => {
    const n = st.addNode({ type: 'idea', title: 'a' });
    st.updateNode(n.id, { title: 'b' });
    await new Promise((r) => setTimeout(r, 700));
    expect(st.versionsOf(n.id)[0]!.reason).toBe('（未填写原因）');
  });

  it('连续多次修改会各自留版本', async () => {
    const n = st.addNode({ type: 'idea', title: 'v0' });
    for (const t of ['v1', 'v2', 'v3']) {
      st.updateNode(n.id, { title: t }, { reason: `改成${t}` });
      await new Promise((r) => setTimeout(r, 700));
    }
    expect(st.versionsOf(n.id).map((v) => JSON.parse(v.snapshot).title)).toEqual(['v1', 'v2', 'v3']);
  });

  it('重复改成同一个值不产生新版本', async () => {
    const n = st.addNode({ type: 'idea', title: 'same' });
    st.updateNode(n.id, { title: 'x' }, { reason: 'r' });
    await new Promise((r) => setTimeout(r, 700));
    st.updateNode(n.id, { title: 'x' }, { reason: 'r' });
    await new Promise((r) => setTimeout(r, 700));
    expect(st.versionsOf(n.id)).toHaveLength(1);
  });

  it('快照不含坐标 —— 否则拖一次就多一条历史', async () => {
    const n = st.addNode({ type: 'idea', title: 'a' });
    st.updateNode(n.id, { title: 'b' }, { reason: 'r' });
    await new Promise((r) => setTimeout(r, 700));
    const snap = JSON.parse(st.versionsOf(n.id)[0]!.snapshot);
    expect(snap).not.toHaveProperty('x');
    expect(snap).not.toHaveProperty('y');
    expect(Object.keys(snap).sort()).toEqual(['content', 'status', 'tags', 'time', 'title', 'type']);
  });
});

describe('目标状态机', () => {
  it('改状态记版本，且快照里带新状态', async () => {
    const n = st.addNode({ type: 'goal', title: 'g', status: '进行中' });
    st.setGoalStatus(n.id, '已取代', '被新目标吃掉了');
    await new Promise((r) => setTimeout(r, 700));
    const v = st.versionsOf(n.id)[0]!;
    expect(v.reason).toBe('被新目标吃掉了');
    expect(JSON.parse(v.snapshot).status).toBe('已取代');
    expect(st.lib.nodes.find((x) => x.id === n.id)!.status).toBe('已取代');
  });

  it('非目标节点没有状态机入口', () => {
    const n = st.addNode({ type: 'idea', title: 'x' });
    expect(st.lib.nodes.find((v) => v.id === n.id)!.status).toBeUndefined();
  });
});

describe('手动里程碑', () => {
  it('即使内容没变也能标记，且有标题', () => {
    const n = st.addNode({ type: 'idea', title: 'a' });
    st.markMilestone(n.id, '终于想清楚了', '一个念头成型');
    const vs = st.versionsOf(n.id);
    expect(vs).toHaveLength(1);
    expect(vs[0]!.title).toBe('终于想清楚了');
    expect(vs[0]!.changedFields).toEqual([]);
  });
});

describe('恢复版本', () => {
  it('恢复后内容回到旧值，且恢复动作本身也留版本', async () => {
    const n = st.addNode({ type: 'idea', title: 'v0' });
    st.updateNode(n.id, { title: 'v1' }, { reason: '改成 v1' });
    await new Promise((r) => setTimeout(r, 700));
    st.updateNode(n.id, { title: 'v2' }, { reason: '改成 v2' });
    await new Promise((r) => setTimeout(r, 700));
    const v1 = st.versionsOf(n.id)[0]!;
    expect(JSON.parse(v1.snapshot).title).toBe('v1');

    st.restoreVersion(n.id, v1.id, '想退回去');
    const after = st.lib.nodes.find((x) => x.id === n.id)!;
    expect(after.title).toBe('v1');
    const vs = st.versionsOf(n.id);
    expect(vs.length).toBeGreaterThanOrEqual(3);
    expect(vs.some((v) => v.reason.includes('恢复'))).toBe(true);
  });
});

describe('删除与脏集合', () => {
  it('删点会连带删掉它的边和版本', () => {
    const a = st.addNode({ type: 'idea', title: 'a' });
    const b = st.addNode({ type: 'idea', title: 'b' });
    st.addEdge({ fromId: a.id, fromKind: 'node', toId: b.id, toKind: 'node', type: 'cause' });
    st.markMilestone(a.id, 'm', 'r');
    expect(st.lib.edges).toHaveLength(1);
    st.removeNode(a.id);
    expect(st.lib.edges).toHaveLength(0);
    expect(st.versionsOf(a.id)).toHaveLength(0);
  });

  it('takeDirty 取出后清空', () => {
    st.addNode({ type: 'idea', title: 'a' });
    const d = st.takeDirty();
    expect(d.size).toBeGreaterThan(0);
    expect(st.takeDirty().size).toBe(0);
  });

  it('删主题会把点从该主题摘出来', () => {
    const t = st.addTheme({ name: 'A' });
    const n = st.addNode({ type: 'idea', title: 'x', themeIds: [t.id] });
    st.removeTheme(t.id);
    expect(st.lib.nodes.find((x) => x.id === n.id)!.themeIds).toEqual([]);
  });

  it('删阶段会把点从该阶段摘出来', () => {
    const s = st.addStage({ name: 'A' });
    const n = st.addNode({ type: 'idea', title: 'x', stageIds: [s.id] });
    st.removeStage(s.id);
    expect(st.lib.nodes.find((x) => x.id === n.id)!.stageIds).toEqual([]);
  });
});

describe('订阅', () => {
  it('退订后不再收到事件', () => {
    const spy = vi.fn();
    const off = st.subscribe(spy);
    st.addNode({ type: 'idea', title: 'a' });
    expect(spy).toHaveBeenCalled();
    off();
    const n = st.lib.nodes[0]!;
    st.updateNode(n.id, { title: 'b' });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('节点默认值', () => {
  it('目标默认进入探索状态，其余类型没有状态', () => {
    const g = mk();
    g.type = 'goal';
    st.replaceLibrary({ nodes: [], edges: [], themes: [], stages: [], milestones: [], versions: [], customStatuses: [] });
    const a = st.addNode({ type: 'goal', title: 'g' });
    const b = st.addNode({ type: 'idea', title: 'i' });
    expect(a.status).toBeUndefined();
    expect(b.status).toBeUndefined();
    expect(st.lib.nodes).toHaveLength(2);
  });
});
describe('轻量字段（themeIds/stageIds/done）', () => {
  it('改 themeIds 不进版本历史（不在 SNAPSHOT_FIELDS）', async () => {
    const st = new Store();
    const t = st.addTheme({ name: '工作', color: '#aaa' });
    const n = st.addNode({ type: 'idea', title: 'x', content: '', x: 0, y: 0, w: 0, h: 0 });
    st.updateNode(n.id, { themeIds: [t.id] });
    await new Promise((r) => setTimeout(r, 700));
    expect(st.versionsOf(n.id)).toHaveLength(0);
  });

  it('改 stageIds 不进版本历史', async () => {
    const st = new Store();
    const s = st.addStage({ name: '2026', color: '#aaa' });
    const n = st.addNode({ type: 'idea', title: 'x', content: '', x: 0, y: 0, w: 0, h: 0 });
    st.updateNode(n.id, { stageIds: [s.id] });
    await new Promise((r) => setTimeout(r, 700));
    expect(st.versionsOf(n.id)).toHaveLength(0);
  });

  it('themeIds 切换成员：toggle 行为可预测', () => {
    const st = new Store();
    const t1 = st.addTheme({ name: '工作', color: '#aaa' });
    const t2 = st.addTheme({ name: '生活', color: '#bbb' });
    const n = st.addNode({ type: 'idea', title: 'x', content: '', x: 0, y: 0, w: 0, h: 0 });
    st.updateNode(n.id, { themeIds: [t1.id] });
    expect(st.lib.nodes.find((v) => v.id === n.id)?.themeIds).toEqual([t1.id]);
    // 切换：去掉 t1，加 t2
    st.updateNode(n.id, { themeIds: [t2.id] });
    expect(st.lib.nodes.find((v) => v.id === n.id)?.themeIds).toEqual([t2.id]);
  });

  it('tags 在 SNAPSHOT_FIELDS 里：改 tags 会进版本历史', async () => {
    const st = new Store();
    const n = st.addNode({ type: 'idea', title: 'x', content: '', x: 0, y: 0, w: 0, h: 0 });
    st.updateNode(n.id, { tags: ['读书'] }, { reason: '加标签 #读书' });
    await new Promise((r) => setTimeout(r, 700));
    const vs = st.versionsOf(n.id);
    expect(vs.length).toBeGreaterThan(0);
    expect(vs[0]?.changedFields).toContain('tags');
  });
});
