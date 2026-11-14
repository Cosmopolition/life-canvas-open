/**
 * 仓储层：内存 Library ↔ IndexedDB。
 * 写入按 store 的脏集合增量执行，不做全库重写（10k 节点下全量 JSON.stringify 不可接受）。
 */
import type {
  ID, Library, LifeEdge, LifeNode, LifeStage, LifeTheme, Milestone, Version,
} from '../model/types';
import { bumpRevision } from '../model/selectors';
import { Store } from '../model/store';
import { db, type Row, META_SETTINGS } from './db';
import { decryptJSON, encryptJSON } from './crypto';

type TableName = 'nodes' | 'edges' | 'themes' | 'stages' | 'milestones' | 'versions';

/** 旧 LifeArea 的松散结构（迁移时用）。不属于 model 层。 */
interface LegacyArea extends Record<string, unknown> {
  id: ID;
  spaceId: ID;
  name: string;
  type: string;
  parentId: ID | null;
  color: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
}

export class Repository {
  private key: CryptoKey | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private store: Store;

  constructor(store: Store) { this.store = store; }

  setKey(k: CryptoKey | null): void { this.key = k; }

  private toRow<T extends { id: string; spaceId: string; updatedAt: number; type?: string }>(obj: T): Promise<Row> {
    return encryptJSON(this.key, obj).then((payload) => ({
      id: obj.id, spaceId: obj.spaceId, updatedAt: obj.updatedAt,
      type: (obj as { type?: string }).type, payload,
    }));
  }

  private async readAll(): Promise<Library> {
    const [ns, es, ts, ss, vs, ms, cs] = await Promise.all([
      db.nodes.toArray(), db.edges.toArray(),
      db.themes.toArray(), db.stages.toArray(),
      db.versions.toArray(), db.milestones.toArray(),
      db.customStatuses.toArray(),
    ]);
    const open = <T>(rows: readonly Row[]): Promise<T[]> =>
      Promise.all(rows.map((r) => decryptJSON<T>(this.key, r.payload)));
    const [nodes, edges, themes, stages, versions, milestones] = await Promise.all([
      open<LifeNode>(ns), open<LifeEdge>(es),
      open<LifeTheme>(ts), open<LifeStage>(ss),
      open<Version>(vs), open<Milestone>(ms),
    ]);
    return {
      nodes: nodes.filter(Boolean), edges: edges.filter(Boolean),
      themes: themes.filter(Boolean), stages: stages.filter(Boolean),
      versions: versions.filter(Boolean),
      milestones: milestones.filter(Boolean),
      customStatuses: cs,
    };
  }

  async load(): Promise<Library> { return this.readAll(); }

  /** 订阅 store，debounce 后落盘脏数据 */
  bind(): () => void {
    return this.store.subscribe(() => this.schedule());
  }

  schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush(); }, 300);
  }

  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const dirty = this.store.takeDirty();
    if (!dirty.size) return;
    const lib = this.store.lib;

    const byTable: Record<TableName, Set<string>> = {
      nodes: new Set(), edges: new Set(),
      themes: new Set(), stages: new Set(),
      milestones: new Set(), versions: new Set(),
    };
    let bulk: TableName | null = null;
    let customDirty = false;

    for (const key of dirty) {
      const [kind, id] = key.split(':') as [string, string];
      if (kind === 'meta') { bulk = null; continue; }
      if (kind === 'status') { customDirty = true; continue; }
      if (kind === 'nodes' || kind === 'edges' || kind === 'versions') { bulk = kind; continue; }
      if (kind === 'node' || kind === 'edge' || kind === 'theme' || kind === 'stage' || kind === 'version' || kind === 'milestone') {
        // 'theme' → 'themes'；'stage' → 'stages'；'milestone' → 'milestones'
        const t = (kind === 'theme' ? 'themes' : kind === 'stage' ? 'stages' : kind === 'milestone' ? 'milestones' : kind + 's') as TableName;
        byTable[t].add(id);
      }
    }

    try {
      if (bulk === 'nodes') await this.rewrite('nodes', lib.nodes);
      else if (bulk === 'edges') await this.rewrite('edges', lib.edges);
      else if (bulk === 'versions') await this.rewrite('versions', lib.versions);

      await Promise.all([
        this.sync('nodes', byTable.nodes, lib.nodes),
        this.sync('edges', byTable.edges, lib.edges),
        this.sync('themes', byTable.themes, lib.themes),
        this.sync('stages', byTable.stages, lib.stages),
        this.sync('milestones', byTable.milestones, lib.milestones),
        this.sync('versions', byTable.versions, lib.versions),
      ]);
      if (customDirty) await db.customStatuses.bulkPut(lib.customStatuses);
    } catch (err) {
      console.error('[repo] 落盘失败', err);
    }
  }

  /**
   * 加密并行。
   * WebCrypto 的 AES-GCM 跑在线程池上，但逐条 `await` 会把主线程的微任务队列
   * 堵死 —— 1 万点 + 1.6 万边共 2.6 万次串行 await 时，页面连 rAF 都跑不起来。
   * 分批 Promise.all 既让加密真正并行，也避免一次堆爆内存。
   */
  private static readonly BATCH = 500;

  private async toRows(items: readonly unknown[]): Promise<Row[]> {
    const out: Row[] = [];
    for (let i = 0; i < items.length; i += Repository.BATCH) {
      out.push(...(await Promise.all(items.slice(i, i + Repository.BATCH).map((o) => this.toRow(o as never)))));
    }
    return out;
  }

  private async sync(table: TableName, ids: Set<string>, all: readonly { id: string }[]): Promise<void> {
    if (!ids.size) return;
    const t = db.table(table);
    const alive = new Set(all.map((x) => x.id));
    const gone = [...ids].filter((id) => !alive.has(id));
    if (gone.length) await t.bulkDelete(gone);
    const dirty = all.filter((o) => ids.has(o.id));
    if (dirty.length) await t.bulkPut(await this.toRows(dirty));
  }

  private async rewrite(table: TableName, all: readonly unknown[]): Promise<void> {
    await db.table(table).clear();
    if (all.length) await db.table(table).bulkPut(await this.toRows(all));
  }

  /** 整库替换（导入 / 改密码重写） */
  async replaceAll(lib: Library): Promise<void> {
    await Promise.all(['nodes', 'edges', 'themes', 'stages', 'milestones', 'versions'].map((t) => db.table(t).clear()));
    await this.rewrite('nodes', lib.nodes);
    await this.rewrite('edges', lib.edges);
    await this.rewrite('themes', lib.themes);
    await this.rewrite('stages', lib.stages);
    await this.rewrite('milestones', lib.milestones);
    await this.rewrite('versions', lib.versions);
    await db.customStatuses.bulkPut(lib.customStatuses);
  }

  async clear(): Promise<void> {
    await Promise.all([
      db.nodes.clear(), db.edges.clear(),
      db.themes.clear(), db.stages.clear(),
      db.milestones.clear(),
      db.versions.clear(), db.customStatuses.clear(),
    ]);
  }

  /* ---------------- schema 迁移 ---------------- */

  /** 是否有 v2 → v3 的待迁数据 */
  async hasPendingMigration(): Promise<boolean> {
    const row = await db.meta.get('pendingSchemaMigration');
    return !!row;
  }

  /**
   * 把旧 areas 表里的 LifeArea 拆到 themes / stages，并改写 node.areaIds / edge.fromKind,toKind。
   * 设计原因：v2 升级函数拿不到 key，加密数据无法在升级里解。
   * 流程：
   *   1. 读 + 解密所有 areas
   *   2. 按 type 分类：root/theme → Theme；stage/transition/year/project → Stage；role → 丢弃
   *   3. 跨类型 parentId 置 null；用名字解析 start/end
   *   4. 写 themes / stages
   *   5. 遍历 node 行：areaIds 拆到 themeIds / stageIds
   *   6. 遍历 edge 行：fromKind/toKind === 'area' 改写
   *   7. timelineLanes 过滤为只剩 theme id
   *   8. 清 areas 表、删 flag
   * 失败：保留 flag，下次启动重试
   */
  async runSchemaMigration(): Promise<void> {
    if (!this.key) {
      console.warn('[migration] 加密开启但 key 尚未加载，跳过');
      return;
    }
    if (!(await this.hasPendingMigration())) return;

    // 1. 读所有旧 area 行（areas 表在 v3 schema 里已删，但 v2 残留数据仍可读）
    // db.table() 走原 IndexedDB store，不依赖类属性，v3 升级后仍可用
    const areaRows = await db.table('areas').toArray();
    if (!areaRows.length) {
      // 表里没东西了，但 flag 还在 —— 清掉就行
      await db.meta.delete('pendingSchemaMigration');
      return;
    }

    // 2. 解密 + 分类（用本地 LegacyArea 类型，不污染 model）
    const rawAreas: LegacyArea[] = [];
    for (const r of areaRows) {
      const a = await decryptJSON<LegacyArea>(this.key, r.payload);
      if (a) rawAreas.push(a);
    }

    const themes: LifeTheme[] = [];
    const stages: LifeStage[] = [];
    /** old areaId → 新实体 { kind, newId }（kind='drop' 表示该 area 被丢弃） */
    const idRemap = new Map<ID, { kind: 'theme' | 'stage' | 'drop'; newId: ID }>();

    const isThemeKind = (t: string) => t === 'root' || t === 'theme';
    const isStageKind = (t: string) => t === 'stage' || t === 'transition' || t === 'year' || t === 'project';

    for (const a of rawAreas) {
      if (isThemeKind(a.type)) {
        const t: LifeTheme = {
          id: a.id, kind: 'theme', spaceId: a.spaceId, name: a.name,
          parentId: a.parentId, color: a.color, description: a.description,
          createdAt: a.createdAt, updatedAt: a.updatedAt,
        };
        themes.push(t);
        idRemap.set(a.id, { kind: 'theme', newId: a.id });
      } else if (isStageKind(a.type)) {
        const { start, end } = parseStageDatesFromName(a.name) ?? {};
        const s: LifeStage = {
          id: a.id, kind: 'stage', spaceId: a.spaceId, name: a.name,
          color: a.color, start, end, description: a.description,
          createdAt: a.createdAt, updatedAt: a.updatedAt,
        };
        stages.push(s);
        idRemap.set(a.id, { kind: 'stage', newId: a.id });
      } else {
        // 含 'role' 和未来未知 type
        idRemap.set(a.id, { kind: 'drop', newId: '' });
      }
    }

    // 3. 跨类型 parentId 修复
    const typeOf = (id: ID): string | undefined => rawAreas.find((x) => x.id === id)?.type;
    for (const t of themes) {
      if (t.parentId && !isThemeKind(typeOf(t.parentId) ?? '')) t.parentId = null;
    }
    // 阶段本身就是平级（LifeStage 没有 parentId 字段），旧值忽略
    for (const a of rawAreas) {
      if (idRemap.get(a.id)?.kind !== 'drop') {
        // area.parentId 若指向不同新 kind，也置空
        if (a.parentId && idRemap.get(a.parentId)?.kind === 'drop') {
          const t = themes.find((x) => x.id === a.id);
          if (t) t.parentId = null;
        }
      }
    }

    // 4. 写新表
    if (themes.length) await this.rewrite('themes', themes);
    if (stages.length) await this.rewrite('stages', stages);

    // 5. 改 nodes.areaIds → themeIds / stageIds
    // 旧数据：LifeNode 当时有 areaIds 字段；现在 LifeNode 没有这个字段 —— 用结构断言读
    const nodeRows = await db.nodes.toArray();
    for (const row of nodeRows) {
      const n = await decryptJSON<LifeNode & { areaIds?: ID[] }>(this.key, row.payload);
      if (!n) continue;
      const oldAreaIds: ID[] = n.areaIds ?? [];
      const themeIds: ID[] = n.themeIds ?? [];
      const stageIds: ID[] = n.stageIds ?? [];
      const newThemeIds = [...themeIds];
      const newStageIds = [...stageIds];
      for (const aid of oldAreaIds) {
        const m = idRemap.get(aid);
        if (!m || m.kind === 'drop') continue;
        if (m.kind === 'theme' && !newThemeIds.includes(m.newId)) newThemeIds.push(m.newId);
        else if (m.kind === 'stage' && !newStageIds.includes(m.newId)) newStageIds.push(m.newId);
      }
      const newN: LifeNode = { ...n, themeIds: newThemeIds, stageIds: newStageIds };
      const payload = await encryptJSON(this.key, newN);
      await db.nodes.put({ ...row, payload, updatedAt: newN.updatedAt });
    }

    // 6. 改 edges.fromKind/toKind = 'area'
    const edgeRows = await db.edges.toArray();
    for (const row of edgeRows) {
      const e = await decryptJSON<LifeEdge>(this.key, row.payload);
      if (!e) continue;
      let dirty = false;
      if (e.fromKind === 'area') {
        const m = idRemap.get(e.fromId);
        e.fromKind = m?.kind === 'theme' ? 'theme' : m?.kind === 'stage' ? 'stage' : 'node';
        dirty = true;
      }
      if (e.toKind === 'area') {
        const m = idRemap.get(e.toId);
        e.toKind = m?.kind === 'theme' ? 'theme' : m?.kind === 'stage' ? 'stage' : 'node';
        dirty = true;
      }
      if (dirty) {
        const payload = await encryptJSON(this.key, e);
        await db.edges.put({ ...row, payload, updatedAt: e.updatedAt });
      }
    }

    // 7. timelineLanes：只留映射到 theme 的 id
    const settingsRow = await db.meta.get(META_SETTINGS);
    if (settingsRow && typeof settingsRow.value === 'object' && settingsRow.value) {
      const v = settingsRow.value as { timelineLanes?: unknown };
      if (Array.isArray(v.timelineLanes)) {
        const old = v.timelineLanes as ID[];
        v.timelineLanes = old.filter((id) => idRemap.get(id)?.kind === 'theme');
        await db.meta.put(settingsRow);
      }
    }

    // 8. 清 areas 表 + 删 flag
    await db.table('areas').clear();
    await db.meta.delete('pendingSchemaMigration');

    // 9. 让上层派生缓存失效（store 还没加载，所以这次 flush 会顺带写 lib）
    bumpRevision();
  }
}

/**
 * 旧 area 名字带年份时尝试解析 start/end。
 * - "2023-2025 星河" / "2023–2025 星河" → start=2023-01, end=2025-12
 * - "2026 过渡期" → start=2026-01, end=2026-12
 * - 解析不到 → null（用户自己起名时不带年份，留空让 UI 提示）
 */
function parseStageDatesFromName(name: string): { start: string; end: string } | null {
  const m = /(\d{4})\s*[-–]\s*(\d{4})/.exec(name);
  if (m) {
    return { start: `${m[1]}-01`, end: `${m[2]}-12` };
  }
  const y = /(\d{4})/.exec(name);
  if (y) return { start: `${y[1]}-01`, end: `${y[1]}-12` };
  return null;
}
