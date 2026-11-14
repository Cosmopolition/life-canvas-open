/**
 * 内存图谱 + 订阅。三个视图共享同一份状态（AD-09）。
 * 所有修改经过这里，保证版本快照不被绕过。
 */
import { bumpRevision, todayKey } from './selectors';
import { MAIN_SPACE } from './space';
import { t } from '../i18n';
import {
  emptyLibrary, uid, MIN_NODE_H, MIN_NODE_W, type EdgeType, type EntityKind, type GoalStatus, type ID,
  type Library, type LifeEdge, type LifeNode, type LifeStage, type LifeTheme, type Milestone, type NodeType, type Version,
} from './types';

export type ChangeKind = 'graph' | 'selection' | 'meta';
export type Listener = (kind: ChangeKind) => void;

/** 版本快照包含的字段 —— 刻意不含 x/y/w/h，位置调整不产生版本（§8.1） */
const SNAPSHOT_FIELDS = ['title', 'content', 'status', 'time', 'tags', 'type'] as const;
type SnapshotField = (typeof SNAPSHOT_FIELDS)[number];

function snapshotOf(n: LifeNode): Record<SnapshotField, unknown> {
  return {
    title: n.title, content: n.content, status: n.status ?? null,
    time: n.time ?? null, tags: [...n.tags], type: n.type,
  };
}

export interface EditOpts {
  /** 内容变更时必填。UI 负责收集 */
  reason?: string;
  /** 手动标记的里程碑版本 */
  milestone?: string;
}

export class Store {
  lib: Library = emptyLibrary();
  /**
   * 当前空间。'default' = 主画布；'week:2026-11-02' = 那一周的复盘画布。
   *
   * ★ 这是「当前在哪个空间」的**唯一事实源** —— app 层读它，写的也认它。
   *   （store 是单例，两处各存一份必然会不同步。）
   */
  currentSpaceId: string = MAIN_SPACE;
  private listeners = new Set<Listener>();
  private pending = new Map<ID, ReturnType<typeof setTimeout>>();
  /** 已产生快照的基线，用于抑制无变化版本 */
  private baseline = new Map<ID, string>();
  /** 脏实体集合（'node:<id>' 等），持久层据此做增量写而非全库重写 */
  readonly dirty = new Set<string>();
  private mark(key: string): void { this.dirty.add(key); }

  /** 取出并清空脏集合 */
  takeDirty(): Set<string> { const d = new Set(this.dirty); this.dirty.clear(); return d; }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(kind: ChangeKind = 'graph'): void {
    if (kind === 'graph') bumpRevision();
    for (const fn of this.listeners) fn(kind);
  }

  replaceLibrary(lib: Library): void {
    this.lib = lib;
    this.baseline.clear();
    for (const n of lib.nodes) this.baseline.set(n.id, JSON.stringify(snapshotOf(n)));
    bumpRevision();
    this.emit('graph');
  }

  /* ---------------- 点 ---------------- */

  addNode(p: Partial<LifeNode> & { type: NodeType }): LifeNode {
    const now = Date.now();
    const n: LifeNode = {
      id: p.id ?? uid('n-'), kind: 'node', spaceId: p.spaceId ?? this.currentSpaceId,
      type: p.type, title: p.title ?? t('common.untitled'), content: p.content ?? '',
      status: p.status, time: p.time, tags: p.tags ?? [],
      themeIds: p.themeIds ?? [],
      stageIds: p.stageIds ?? [],
      x: p.x ?? 0, y: p.y ?? 0, w: p.w ?? 240, h: p.h ?? 84,
      createdAt: now, updatedAt: now,
    };
    // 可选字段一并带上。
    // ★ 为什么这里要显式列出来：周画布「引入本周原数据」是**复制**，
    //   副本必须跟原件长得一样 —— 图、外链、链接、完成状态都要跟着走。
    //   addNode 只认 Partial<LifeNode>，不显式拷贝的话这些字段会被悄悄丢掉
    //   （类型允许、运行时不写，是最难查的一种坑）。
    if (p.done !== undefined) n.done = p.done;
    if (p.imageData !== undefined) n.imageData = p.imageData;
    if (p.imageW !== undefined) n.imageW = p.imageW;
    if (p.imageH !== undefined) n.imageH = p.imageH;
    if (p.imageUrl !== undefined) n.imageUrl = p.imageUrl;
    if (p.linkUrl !== undefined) n.linkUrl = p.linkUrl;
    if (p.linkLabel !== undefined) n.linkLabel = p.linkLabel;
    if (p.sourceId !== undefined) n.sourceId = p.sourceId;
    this.lib.nodes.push(n);
    this.baseline.set(n.id, JSON.stringify(snapshotOf(n)));
    this.mark('node:' + n.id); this.mark('meta');
    this.emit();
    return n;
  }

  /** 只改几何，不产生版本 */
  moveNode(id: string, x: number, y: number, resize?: { w: number; h: number }): void {
    const n = this.lib.nodes.find((v) => v.id === id);
    if (!n) return;
    n.x = x; n.y = y;
    if (resize) {
      // 夹一下：拖到 0 就成了一条线，节点会没法点
      n.w = Math.max(MIN_NODE_W, Math.round(resize.w));
      n.h = Math.max(MIN_NODE_H, Math.round(resize.h));
    }
    n.updatedAt = Date.now();
    this.mark('node:' + n.id);
    this.emit();
  }

  updateNode(id: string, patch: Partial<LifeNode>, opts: EditOpts = {}): void {
    const n = this.lib.nodes.find((v) => v.id === id);
    if (!n) return;
    const before = JSON.stringify(snapshotOf(n));
    Object.assign(n, patch);
    n.updatedAt = Date.now();
    const after = JSON.stringify(snapshotOf(n));
    if (before !== after) this.queueVersion(n, opts);
    this.mark('node:' + n.id);
    this.emit();
  }

  /** 批量字段编辑（改类型 + 改状态一起）走同一入口 */
  setGoalStatus(id: string, status: GoalStatus, reason: string): void {
    this.updateNode(id, { status }, { reason });
  }

  removeNode(id: string): void {
    const removedMs = this.lib.milestones.filter((m) => m.parentId === id);
    this.lib.nodes = this.lib.nodes.filter((n) => n.id !== id);
    this.lib.edges = this.lib.edges.filter((e) => e.fromId !== id && e.toId !== id);
    this.lib.versions = this.lib.versions.filter((v) => v.nodeId !== id);
    this.lib.milestones = this.lib.milestones.filter((m) => m.parentId !== id);
    this.baseline.delete(id);
    this.mark('node:' + id); this.mark('edge'); this.mark('versions'); this.mark('meta');
    for (const r of removedMs) this.mark('milestone:' + r.id);
    this.emit();
  }

  /* ---------------- 线 ---------------- */

  addEdge(p: { fromId: string; fromKind: EntityKind; toId: string; toKind: EntityKind; type: EdgeType; note?: string }): LifeEdge {
    const a = this.lib.nodes.find((n) => n.id === p.fromId);
    const b = this.lib.nodes.find((n) => n.id === p.toId);
    // 跨空间连线不允许：一条边的两端必须属于同一个空间。
    // 正常情况下 UI 选不到别的空间的点（连线目标只亮当前空间的），
    // 这条是兜底 —— 脏数据、脚本调用都不能绕过它。
    if (a && b && a.spaceId !== b.spaceId) {
      throw new Error(t('error.cannotConnectAcrossSpaces'));
    }
    // 主题 / 阶段是全局的，没有 spaceId ⇒ 取点那一端的空间
    const spaceId = a?.spaceId ?? b?.spaceId ?? this.currentSpaceId;
    const now = Date.now();
    const e: LifeEdge = {
      id: uid('e-'), kind: 'edge', spaceId,
      fromId: p.fromId, fromKind: p.fromKind, toId: p.toId, toKind: p.toKind,
      type: p.type, note: p.note, createdAt: now, updatedAt: now,
    };
    this.lib.edges.push(e);
    this.mark('edge:' + e.id); this.mark('edges');
    this.emit();
    return e;
  }

  updateEdge(id: string, patch: Partial<LifeEdge>): void {
    const e = this.lib.edges.find((v) => v.id === id);
    if (!e) return;
    Object.assign(e, patch);
    e.updatedAt = Date.now();
    this.mark('edge:' + e.id);
    this.emit();
  }

  removeEdge(id: string): void {
    this.lib.edges = this.lib.edges.filter((e) => e.id !== id);
    this.mark('edge:' + id); this.mark('edges');
    this.emit();
  }

  /* ---------------- 主题 / 阶段（新 API） ---------------- */

  addTheme(p: Partial<LifeTheme> & { name: string }): LifeTheme {
    const now = Date.now();
    const t: LifeTheme = {
      id: p.id ?? uid('t-'), kind: 'theme', spaceId: p.spaceId ?? 'default', name: p.name,
      parentId: p.parentId ?? null,
      color: p.color ?? '#7f9bd4', description: p.description,
      createdAt: now, updatedAt: now,
    };
    this.lib.themes.push(t);
    this.mark('theme:' + t.id);
    this.emit();
    return t;
  }

  updateTheme(id: string, patch: Partial<LifeTheme>): void {
    const t = this.lib.themes.find((v) => v.id === id);
    if (!t) return;
    Object.assign(t, patch);
    t.updatedAt = Date.now();
    this.mark('theme:' + t.id);
    this.emit();
  }

  removeTheme(id: string): void {
    this.lib.themes = this.lib.themes.filter((t) => t.id !== id);
    for (const n of this.lib.nodes) n.themeIds = n.themeIds.filter((x) => x !== id);
    this.lib.edges = this.lib.edges.filter((e) => e.fromId !== id && e.toId !== id);
    this.mark('theme:' + id); this.mark('edges'); this.mark('nodes'); this.mark('versions');
    this.emit();
  }

  addStage(p: Partial<LifeStage> & { name: string }): LifeStage {
    const now = Date.now();
    const s: LifeStage = {
      id: p.id ?? uid('s-'), kind: 'stage', spaceId: p.spaceId ?? 'default', name: p.name,
      color: p.color ?? '#7f9bd4',
      start: p.start, end: p.end,
      description: p.description,
      createdAt: now, updatedAt: now,
    };
    this.lib.stages.push(s);
    this.mark('stage:' + s.id);
    this.emit();
    return s;
  }

  updateStage(id: string, patch: Partial<LifeStage>): void {
    const s = this.lib.stages.find((v) => v.id === id);
    if (!s) return;
    Object.assign(s, patch);
    s.updatedAt = Date.now();
    this.mark('stage:' + s.id);
    this.emit();
  }

  removeStage(id: string): void {
    this.lib.stages = this.lib.stages.filter((s) => s.id !== id);
    for (const n of this.lib.nodes) n.stageIds = n.stageIds.filter((x) => x !== id);
    this.lib.edges = this.lib.edges.filter((e) => e.fromId !== id && e.toId !== id);
    this.mark('stage:' + id); this.mark('edges'); this.mark('nodes'); this.mark('versions');
    this.emit();
  }

  /* ---------------- 里程碑（goal 的时间点位检查清单） ---------------- */
  // 不入版本历史 —— 与 action.done 同档：勾掉是状态，不是"内容修改"。
  // 衍生状态（pending / overdue / completed-early ...）由 selectors.milestoneDisplay 现算，不入库。

  addMilestone(
    parentId: ID,
    partial: Partial<Pick<Milestone, 'title' | 'targetDate'>>,
  ): Milestone {
    const parent = this.lib.nodes.find((n) => n.id === parentId);
    if (!parent || parent.type !== 'goal') throw new Error(t('error.milestoneNeedsGoal'));
    const sib = this.lib.milestones.filter((m) => m.parentId === parentId);
    const maxOrder = sib.length ? Math.max(...sib.map((m) => m.order)) : -1;
    const now = Date.now();
    const m: Milestone = {
      id: uid('ml-'), kind: 'milestone', spaceId: parent.spaceId,
      parentId,
      title: partial.title?.trim() || t('common.untitled'),
      targetDate: partial.targetDate || todayKey(),
      order: maxOrder + 1,
      createdAt: now, updatedAt: now,
    };
    this.lib.milestones.push(m);
    this.mark('milestone:' + m.id);
    this.emit();
    return m;
  }

  updateMilestone(
    id: ID,
    patch: Partial<Pick<Milestone, 'title' | 'targetDate' | 'order'>>,
  ): void {
    const m = this.lib.milestones.find((x) => x.id === id);
    if (!m) return;
    if (patch.title !== undefined) {
      const t = patch.title.trim();
      if (!t) return;
      m.title = t;
    }
    if (patch.targetDate !== undefined) m.targetDate = patch.targetDate;
    if (patch.order !== undefined) m.order = patch.order;
    m.updatedAt = Date.now();
    this.mark('milestone:' + id);
    this.emit();
  }

  /** 显式设定完成态（true / false）+ today 作 completedAt。
   *  与 onToggleDone(id, done) 同形 —— 状态由调用方决定，避免双重真值 */
  setMilestoneDone(id: ID, done: boolean, today: string): void {
    const m = this.lib.milestones.find((x) => x.id === id);
    if (!m) return;
    if (done && !m.completedAt) m.completedAt = today;
    else if (!done && m.completedAt) delete m.completedAt;
    else return; // 没变化就不标记脏
    m.updatedAt = Date.now();
    this.mark('milestone:' + id);
    this.emit();
  }

  removeMilestone(id: ID): void {
    this.lib.milestones = this.lib.milestones.filter((m) => m.id !== id);
    this.mark('milestone:' + id);
    this.emit();
  }

  /* ---------------- 版本历史 ---------------- */

  private queueVersion(n: LifeNode, opts: EditOpts): void {
    this.baseline.set(n.id, JSON.stringify(snapshotOf(n)));
    const prev = this.pending.get(n.id);
    if (prev) clearTimeout(prev);
    this.pending.set(n.id, setTimeout(() => {
      this.pending.delete(n.id);
      this.commitVersion(n.id, opts);
    }, 600));
  }

  /** 强制立刻落版本（例如离开编辑框时） */
  flushVersion(id: string, opts: EditOpts = {}): void {
    const t = this.pending.get(id);
    if (t) { clearTimeout(t); this.pending.delete(id); }
    this.commitVersion(id, opts);
  }

  private commitVersion(nodeId: string, opts: EditOpts): void {
    const n = this.lib.nodes.find((v) => v.id === nodeId);
    if (!n) return;
    const snap = snapshotOf(n);
    const json = JSON.stringify(snap);
    const vs = this.lib.versions.filter((v) => v.nodeId === nodeId);
    const last = vs[vs.length - 1];
    // 与最新版本完全一致 → 丢弃
    if (last && last.snapshot === json && !opts.milestone) return;
    const changed: string[] = [];
    const prevSnap = last ? (JSON.parse(last.snapshot) as Record<string, unknown>) : {};
    for (const f of SNAPSHOT_FIELDS) {
      if (JSON.stringify(prevSnap[f]) !== JSON.stringify(snap[f])) changed.push(f);
    }
    const v: Version = {
      id: uid('v-'), nodeId, snapshot: json,
      title: opts.milestone, reason: opts.reason || t('version.noReasonGiven'),
      changedAt: Date.now(), changedFields: changed,
    };
    this.lib.versions.push(v);
    this.mark('version:' + v.id); this.mark('versions');
    this.emit();
  }

  /** 只读字段单独手动记一个里程碑（不改内容） */
  markMilestone(nodeId: string, title: string, reason: string): void {
    const n = this.lib.nodes.find((v) => v.id === nodeId);
    if (!n) return;
    const v: Version = {
      id: uid('v-'), nodeId, snapshot: JSON.stringify(snapshotOf(n)),
      title, reason, changedAt: Date.now(), changedFields: [],
    };
    this.lib.versions.push(v);
    this.mark('version:' + v.id); this.mark('versions');
    this.emit();
  }

  versionsOf(nodeId: string): Version[] {
    return this.lib.versions.filter((v) => v.nodeId === nodeId)
      .sort((a, b) => a.changedAt - b.changedAt);
  }

  restoreVersion(nodeId: string, versionId: string, reason: string): void {
    const v = this.lib.versions.find((x) => x.id === versionId);
    const n = this.lib.nodes.find((x) => x.id === nodeId);
    if (!v || !n) return;
    const snap = JSON.parse(v.snapshot) as Partial<LifeNode>;
    // 恢复本身也产生一条新版本，历史不丢
    this.updateNode(nodeId, {
      title: snap.title ?? n.title, content: snap.content ?? '',
      status: snap.status, time: snap.time, tags: snap.tags ?? [], type: snap.type ?? n.type,
    }, { reason });
    this.flushVersion(nodeId, { reason: t('version.restoredToTitle', { title: v.title ?? v.reason }) });
  }
}

export const store = new Store();
