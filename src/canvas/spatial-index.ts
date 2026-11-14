/**
 * 空间索引（§6.2）。网格：命中检测与框选。四叉树：视口裁剪。两者都惰性重建。
 */
import type { Rect } from './viewport';
import { rectsIntersect } from './viewport';

export interface SpatialItem extends Rect { id: string }

const CELL = 256;

/**
 * 网格索引：命中检测与框选。
 *
 * 试过"懒构建 + 线性扫描兜底"，实测反而更慢 —— 线性扫描每帧重跑，
 * 而网格一次建好之后查询只是几个 Map 查找。保持 eager build。
 */
export class GridIndex {
  private cells = new Map<string, SpatialItem[]>();
  private items = new Map<string, SpatialItem>();

  private keys(r: Rect): string[] {
    const x0 = Math.floor(r.x / CELL), y0 = Math.floor(r.y / CELL);
    const x1 = Math.floor((r.x + r.w) / CELL), y1 = Math.floor((r.y + r.h) / CELL);
    const out: string[] = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push(`${x},${y}`);
    return out;
  }

  /**
   * 新增 / 移动都**立刻**更新网格。
   *
   * ⚠️ 为什么不能"先记下 dirty、晚点再重建"：
   *    重建只发生在 setAll（全量替换）的时候，而拖动一个点走的是 insert。
   *    于是**刚拖过的点，网格里还是它旧位置的框**：
   *      · 点它选不中（命中测试打在旧框上）
   *      · 拖远了甚至会**从画布上消失**（视口裁剪按旧位置算，新位置出界了）
   *    症状是"刚拖完就点不动它了"，过一会儿又好了 ——
   *    因为上层有个 150ms 防抖的 render 会顺手 setAll 一次。
   */
  insert(item: SpatialItem): void {
    const old = this.items.get(item.id);
    if (old) this.detach(old);
    this.items.set(item.id, item);
    for (const k of this.keys(item)) {
      let arr = this.cells.get(k);
      if (!arr) { arr = []; this.cells.set(k, arr); }
      arr.push(item);
    }
  }

  /** 从网格里摘掉某个框（它可能在好几个格子里） */
  private detach(item: SpatialItem): void {
    for (const k of this.keys(item)) {
      const arr = this.cells.get(k);
      if (!arr) continue;
      const i = arr.findIndex((x) => x.id === item.id);
      if (i >= 0) arr.splice(i, 1);
      if (!arr.length) this.cells.delete(k);
    }
  }

  remove(id: string): void {
    const old = this.items.get(id);
    if (old) this.detach(old);
    this.items.delete(id);
  }

  clear(): void { this.cells.clear(); this.items.clear(); }

  /**
   * 这个 id 在索引里吗（自测用）。
   *
   * ⚠️ **不要**用 query 一个巨大的矩形来查 ——
   *    keys() 会按格子逐个展开，矩形一大就是几十亿个 key，主线程直接卡死。
   */
  has(id: string): boolean { return this.items.has(id); }

  /** 全量替换并立即建好网格 */
  setAll(items: SpatialItem[]): void {
    this.cells.clear();
    this.items.clear();
    for (const i of items) this.items.set(i.id, i);
    this.rebuild();
  }

  get size(): number { return this.items.size; }
  warmUp(): void { this.rebuild(); }

  /** 全量重建网格（O(n)）。只在整库替换时用 —— 移动走 insert。 */
  rebuild(): void {
    this.cells.clear();
    for (const item of this.items.values()) {
      for (const k of this.keys(item)) {
        let arr = this.cells.get(k);
        if (!arr) { arr = []; this.cells.set(k, arr); }
        arr.push(item);
      }
    }
  }

  query(r: Rect): SpatialItem[] {
    const seen = new Set<string>();
    const out: SpatialItem[] = [];
    for (const k of this.keys(r)) {
      const arr = this.cells.get(k);
      if (!arr) continue;
      for (const it of arr) {
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        if (it.x < r.x + r.w && it.x + it.w > r.x && it.y < r.y + r.h && it.y + it.h > r.y) out.push(it);
      }
    }
    return out;
  }

  /** 点命中：同一格内最上层的一个 */
  hitTest(x: number, y: number): SpatialItem | null {
    const arr = this.cells.get(`${Math.floor(x / CELL)},${Math.floor(y / CELL)}`);
    if (!arr) return null;
    let best: SpatialItem | null = null;
    for (const it of arr) {
      if (x >= it.x && x <= it.x + it.w && y >= it.y && y <= it.y + it.h) {
        if (!best || it.y < best.y || (it.y === best.y && it.x > best.x)) best = it;
      }
    }
    return best;
  }
}

/* ---------------- 四叉树 ---------------- */

interface QItem extends Rect { id: string }

export class Quadtree {
  private root: QNode;
  private depth = 0;
  constructor(private bounds: Rect) { this.root = new QNode(bounds, 0); }
  insert(item: QItem): void { this.root.insert(item, this.bounds, this.depth); }
  clear(): void { this.root = new QNode(this.bounds, 0); }
  query(r: Rect, out: QItem[] = []): QItem[] { this.root.query(r, out); return out; }
  get size(): number { return this.root.count; }
}

const MAX_ITEMS = 12;

class QNode {
  count = 0;
  private items: QItem[] = [];
  private kids: QNode[] | null = null;

  constructor(readonly bounds: Rect, readonly level: number) {}

  private subdivide(): void {
    const { x, y, w, h } = this.bounds;
    const hw = w / 2, hh = h / 2;
    this.kids = [
      new QNode({ x, y, w: hw, h: hh }, this.level + 1),
      new QNode({ x: x + hw, y, w: hw, h: hh }, this.level + 1),
      new QNode({ x, y: y + hh, w: hw, h: hh }, this.level + 1),
      new QNode({ x: x + hw, y: y + hh, w: hw, h: hh }, this.level + 1),
    ];
  }

  private fits(r: Rect): boolean {
    return r.x >= this.bounds.x && r.y >= this.bounds.y &&
      r.x + r.w <= this.bounds.x + this.bounds.w &&
      r.y + r.h <= this.bounds.y + this.bounds.h;
  }

  insert(item: QItem, rootBounds: Rect, maxDepth: number): void {
    this.count++;
    if (this.kids) {
      for (const k of this.kids) if (this.fits(item) && k.level <= maxDepth) { k.insert(item, rootBounds, maxDepth); return; }
      this.items.push(item);
      return;
    }
    this.items.push(item);
    if (this.items.length > MAX_ITEMS && this.level < maxDepth && this.bounds.w > 64) {
      this.subdivide();
      const keep: QItem[] = [];
      for (const it of this.items) {
        let placed = false;
        for (const k of this.kids!) if (this.fits(it) && k.level <= maxDepth) { k.insert(it, rootBounds, maxDepth); placed = true; break; }
        if (!placed) keep.push(it);
      }
      this.items = keep;
    }
  }

  query(r: Rect, out: QItem[] = []): QItem[] {
    if (!rectsIntersect(this.bounds, r)) return out;
    for (const it of this.items) if (rectsIntersect(it, r)) out.push(it);
    for (const k of this.kids!) k.query(r, out);
    return out;
  }
}
