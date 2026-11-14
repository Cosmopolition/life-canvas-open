import { describe, expect, it } from 'vitest';
import { Store } from '../src/model/store';
import {
  milestoneDisplay, milestonesOf,
} from '../src/model/selectors';
import type { LifeNode, Milestone } from '../src/model/types';

/**
 * 里程碑（goal 的时间点位检查清单）—— 入库、状态切换、级联清理、派生计算。
 * 持久化层 roundtrip 已经在 tests/ 别的文件里覆盖；这里只测 store + selectors。
 */

const mkGoal = (id: string, title = 'g'): LifeNode =>
  ({
    id, kind: 'node', spaceId: 's', type: 'goal', title, content: '',
    status: '进行中', tags: [], themeIds: [], stageIds: [],
    x: 0, y: 0, w: 240, h: 78,
    createdAt: 0, updatedAt: 0,
  });

describe('store: 里程碑', () => {
  it('addMilestone：只接受 type === "goal" 的父节点', () => {
    const st = new Store();
    const goal = mkGoal('g1');
    const nonGoal: LifeNode = { ...goal, id: 'idea-1', type: 'idea' };
    st.lib.nodes.push(goal, nonGoal);

    expect(() => st.addMilestone('g1', { title: '里程碑 1', targetDate: '2026-10-01' })).not.toThrow();
    expect(() => st.addMilestone('not-exist', { title: 'x', targetDate: '2026-10-01' })).toThrow();
    expect(() => st.addMilestone('idea-1', { title: 'x', targetDate: '2026-10-01' })).toThrow();
    expect(st.lib.milestones).toHaveLength(1);
    expect(st.lib.milestones[0]).toMatchObject({
      kind: 'milestone', parentId: 'g1', title: '里程碑 1',
      targetDate: '2026-10-01', order: 0,
    });
    expect(st.lib.milestones[0]!.completedAt).toBeUndefined();
  });

  it('addMilestone：order 自动递增；同一 goal 多次添加递增', () => {
    const st = new Store();
    st.lib.nodes.push(mkGoal('g1'));
    const a = st.addMilestone('g1', { title: 'a', targetDate: '2026-10-01' });
    const b = st.addMilestone('g1', { title: 'b', targetDate: '2026-10-02' });
    const c = st.addMilestone('g1', { title: 'c', targetDate: '2026-10-03' });
    expect([a.order, b.order, c.order]).toEqual([0, 1, 2]);
  });

  it('setMilestoneDone：true 写入 today；false 清空；同状态不重复标记', () => {
    const st = new Store();
    st.lib.nodes.push(mkGoal('g1'));
    const m = st.addMilestone('g1', { title: 'x', targetDate: '2026-10-01' });

    st.setMilestoneDone(m.id, true, '2026-10-02');
    expect(m.completedAt).toBe('2026-10-02');

    // 再设一次 true：相同 desired state，store 早退（不写 updatedAt 也不发 emit）
    const updatedAtBefore = m.updatedAt;
    st.setMilestoneDone(m.id, true, '2026-10-05');
    expect(m.completedAt).toBe('2026-10-02'); // 没变
    expect(m.updatedAt).toBe(updatedAtBefore);

    // 设 false：清空
    st.setMilestoneDone(m.id, false, '2026-10-06');
    expect(m.completedAt).toBeUndefined();
  });

  it('removeNode：级联清除该 goal 的所有 milestone（不会留僵尸数据）', () => {
    const st = new Store();
    st.lib.nodes.push(mkGoal('g1'), mkGoal('g2'));
    st.addMilestone('g1', { title: 'a', targetDate: '2026-10-01' });
    st.addMilestone('g1', { title: 'b', targetDate: '2026-10-02' });
    st.addMilestone('g2', { title: 'c', targetDate: '2026-10-03' });
    expect(st.lib.milestones).toHaveLength(3);

    st.removeNode('g1');
    expect(st.lib.milestones.map((m) => m.parentId)).toEqual(['g2']);
  });

  it('updateMilestone：title / targetDate / order 都能改；空 title 拒绝（避免空字符串脏数据）', () => {
    const st = new Store();
    st.lib.nodes.push(mkGoal('g1'));
    const m = st.addMilestone('g1', { title: 'orig', targetDate: '2026-10-01' });

    st.updateMilestone(m.id, { title: '改', targetDate: '2026-10-05' });
    expect(m.title).toBe('改');
    expect(m.targetDate).toBe('2026-10-05');

    st.updateMilestone(m.id, { title: '   ' }); // 全空格 / 空
    expect(m.title).toBe('改'); // 没变

    st.updateMilestone(m.id, { order: 99 });
    expect(m.order).toBe(99);
  });
});

describe('selectors: 里程碑', () => {
  const lib = {
    nodes: [], edges: [], themes: [], stages: [],
    milestones: [
      m('m1', 'g1', 2, '2026-10-01'),
      m('m2', 'g1', 0, '2026-10-02'),
      m('m3', 'g1', 1, '2026-09-28', '2026-09-29'), // 提前完成
      m('m4', 'g2', 0, '2026-10-03'),
    ] as Milestone[],
    versions: [], customStatuses: [],
  };

  it('milestonesOf：按 parentId 过滤并按 order 升序', () => {
    const got = milestonesOf(lib, 'g1').map((m) => m.id);
    expect(got).toEqual(['m2', 'm3', 'm1']); // order 0,1,2
    expect(milestonesOf(lib, 'g2').map((m) => m.id)).toEqual(['m4']);
    expect(milestonesOf(lib, 'no-such')).toEqual([]);
  });

  it('milestoneDisplay：5 个状态全覆盖', () => {
    expect(milestoneDisplay(m('x', 'g', 0, '2099-01-01'), '2026-10-01')).toBe('pending');
    expect(milestoneDisplay(m('x', 'g', 0, '2026-09-30'), '2026-10-01')).toBe('overdue');
    expect(milestoneDisplay(m('x', 'g', 0, '2026-10-01', '2026-10-01'), '2026-10-01')).toBe('completed');
    expect(milestoneDisplay(m('x', 'g', 0, '2026-10-05', '2026-10-01'), '2026-10-01')).toBe('completed-early');
    expect(milestoneDisplay(m('x', 'g', 0, '2026-10-01', '2026-10-05'), '2026-10-01')).toBe('completed-late');
  });
});

function m(id: string, parentId: string, order: number, targetDate: string, completedAt?: string): Milestone {
  return {
    id, kind: 'milestone', spaceId: 's', parentId,
    title: id, targetDate, completedAt, order,
    createdAt: 0, updatedAt: 0,
  };
}
