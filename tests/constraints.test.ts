import { describe, expect, it } from 'vitest';
import { canConnect, EDGE_CONSTRAINTS, EDGE_TYPES, GOAL_STATUS, NODE_TYPES } from '../src/model/types';

const node = (type: (typeof NODE_TYPES)[number]) => ({ kind: 'node', type } as const);
const theme = { kind: 'theme' } as const;
const stage = { kind: 'stage' } as const;
const area = { kind: 'area' } as const; // 迁移期残留，约束里不开放

describe('关系约束 canConnect', () => {
  it('取代只能从目标出发 —— 这是产品最硬的一条约束', () => {
    expect(canConnect('replace', node('goal'), 'node')).toBe(true);
    for (const t of NODE_TYPES.filter((t) => t !== 'goal')) {
      expect(canConnect('replace', node(t), 'node'), `${t} 不该能作为取代的起点`).toBe(false);
    }
  });

  it('取代不能指向主题 / 阶段 / 面', () => {
    expect(canConnect('replace', node('goal'), 'theme')).toBe(false);
    expect(canConnect('replace', node('goal'), 'stage')).toBe(false);
    expect(canConnect('replace', node('goal'), 'area')).toBe(false);
  });

  it('「属于」不能通过手工连线建立 —— 归属走 themeIds / stageIds', () => {
    expect(canConnect('belong', node('goal'), 'theme')).toBe(false);
    expect(canConnect('belong', node('goal'), 'stage')).toBe(false);
    expect(canConnect('belong', node('goal'), 'node')).toBe(false);
  });

  it('只有参考和冲突允许指向主题 / 阶段', () => {
    for (const t of ['support', 'block', 'cause', 'inspire', 'sequence'] as const) {
      for (const k of ['theme', 'stage'] as const) {
        expect(canConnect(t, node('idea'), k as 'theme' | 'stage'),
          `${t} idea→${k} 不该能成立`).toBe(false);
      }
    }
    // 参考 / 冲突：node↔theme、node↔stage、theme↔stage 都可
    expect(canConnect('reference', node('idea'), 'node')).toBe(true);
    expect(canConnect('reference', node('idea'), 'theme')).toBe(true);
    expect(canConnect('reference', node('idea'), 'stage')).toBe(true);
    expect(canConnect('reference', theme, 'theme')).toBe(true);
    expect(canConnect('reference', stage, 'node')).toBe(true);
    expect(canConnect('conflict', theme, 'stage')).toBe(true);
  });

  it('迁移期残留的 area 不能作为任何关系的起点 / 终点', () => {
    for (const t of ['support', 'block', 'cause', 'inspire', 'sequence', 'replace', 'reference', 'conflict'] as const) {
      expect(canConnect(t, area, 'node'), `area→${t}→node 不该能成立`).toBe(false);
      expect(canConnect(t, node('idea'), 'area'), `${t} idea→area 不该能成立`).toBe(false);
    }
  });

  it('主题 / 阶段不能作为除参考/冲突外的起点', () => {
    for (const k of [theme, stage] as const) {
      for (const t of ['support', 'block', 'cause', 'inspire', 'sequence', 'replace'] as const) {
        expect(canConnect(t, k, 'node'), `${k.kind}→${t} 不该能成立`).toBe(false);
      }
    }
  });

  it('每种线类型都有约束定义（除 belong 外）', () => {
    for (const t of EDGE_TYPES) {
      if (t === 'belong') continue;
      expect(EDGE_CONSTRAINTS[t], `${t} 缺约束定义`).toBeDefined();
      expect(EDGE_CONSTRAINTS[t].from.length).toBeGreaterThan(0);
      expect(EDGE_CONSTRAINTS[t].to.length).toBeGreaterThan(0);
    }
  });

  it('对称关系标记正确', () => {
    expect(EDGE_CONSTRAINTS.conflict.symmetric).toBe(true);
    expect(EDGE_CONSTRAINTS.sequence.symmetric).toBe(true);
    expect(EDGE_CONSTRAINTS.cause.symmetric).toBe(false);
  });
});

describe('枚举完整性', () => {
  it('10 种点类型、9 种线类型（含 belong）、8 种目标状态', () => {
    expect(NODE_TYPES).toHaveLength(10);
    expect(EDGE_TYPES).toHaveLength(9);
    expect(GOAL_STATUS).toHaveLength(8);
  });

  it('点类型没有重复', () => {
    expect(new Set(NODE_TYPES).size).toBe(NODE_TYPES.length);
  });
});
