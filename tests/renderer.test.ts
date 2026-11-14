/**
 * Renderer 的纯逻辑测试：nodeSizeOf 在有图/无图时的高度计算。
 * Renderer 实例化需要 canvas（jsdom 不带），但 nodeSizeOf 是 static，直接调即可。
 */
import { describe, expect, it } from 'vitest';
import { Renderer } from '../src/canvas/renderer';
import type { LifeNode } from '../src/model/types';

const mk = (over: Partial<LifeNode> = {}): LifeNode => ({
  id: 'n', kind: 'node', spaceId: 's', type: 'idea', title: 'x', content: '',
  tags: [], themeIds: [], stageIds: [],
  x: 0, y: 0, w: 240, h: 78,
  createdAt: 0, updatedAt: 0, ...over,
});

describe('nodeSizeOf', () => {
  it('无图时按标题长度给 h', () => {
    const cache = new Map();
    expect(Renderer.nodeSizeOf(mk({ h: 0, title: 'a' }), cache).h).toBe(78);
    expect(Renderer.nodeSizeOf(mk({ h: 0, title: 'a'.repeat(11) }), cache).h).toBe(88);
    expect(Renderer.nodeSizeOf(mk({ h: 0, title: 'a'.repeat(17) }), cache).h).toBe(96);
  });

  it('有 imageData 时 h 至少 96', () => {
    const cache = new Map();
    expect(Renderer.nodeSizeOf(mk({ h: 0, title: 'a', imageData: 'data:img/..' }), cache).h).toBe(96);
    expect(Renderer.nodeSizeOf(mk({ h: 0, title: 'a'.repeat(20), imageData: 'd' }), cache).h).toBe(96);
  });

  it('有 imageUrl 时 h 至少 96（外链也算有图）', () => {
    const cache = new Map();
    expect(Renderer.nodeSizeOf(mk({ h: 0, title: 'a', imageUrl: 'https://x.com/y.jpg' }), cache).h).toBe(96);
  });

  it('显式 h 优先于启发式', () => {
    const cache = new Map();
    expect(Renderer.nodeSizeOf(mk({ h: 200, title: 'a' }), cache).h).toBe(200);
  });

  it('同节点连查两次命中缓存（key 含图片状态）', () => {
    const cache = new Map();
    const n = mk({ h: 0, title: 'a' });
    Renderer.nodeSizeOf(n, cache);
    expect(cache.has('n')).toBe(true);
    // 加图后 key 变 → 缓存失效
    n.imageData = 'data:img/..';
    const r = Renderer.nodeSizeOf(n, cache);
    expect(r.h).toBe(96);
  });
});
