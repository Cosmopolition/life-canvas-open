/**
 * Dexie schema。加密关闭与开启共用同一张表：
 * 明文列只有 id / spaceId / updatedAt / type（点类型），其余一律在 payload 里。
 * 这样两种模式只有一条读写代码路径，见 AD-04。
 */
import Dexie, { type Table } from 'dexie';
import type { CustomStatus } from '../model/types';
import type { CryptoConfig } from './crypto';

export interface Row {
  id: string;
  spaceId: string;
  updatedAt: number;
  /** 仅点记录有；用于不解密也能按类型筛选 */
  type?: string;
  payload: Uint8Array;
}

export interface MetaRow { key: string; value: unknown }

export class LifeDB extends Dexie {
  nodes!: Table<Row, string>;
  edges!: Table<Row, string>;
  themes!: Table<Row, string>;
  stages!: Table<Row, string>;
  milestones!: Table<Row, string>;
  versions!: Table<Row, string>;
  customStatuses!: Table<CustomStatus, string>;
  meta!: Table<MetaRow, string>;

  constructor() {
    super('life-canvas');
    // v1：原 schema
    this.version(1).stores({
      // fromId / toId 不建索引：加密开启时它们属于结构信息，不应明文可查
      nodes: 'id, spaceId, type, updatedAt, [spaceId+updatedAt]',
      edges: 'id, spaceId, updatedAt',
      areas: 'id, spaceId, parentId, updatedAt',
      versions: 'id, spaceId, updatedAt, [spaceId+updatedAt]',
      customStatuses: 'id, name',
      meta: 'key',
    });
    // v2：新增 themes / stages 表，areas 保留给数据迁移（应用层 unlock 后再迁）
    this.version(2).stores({
      nodes: 'id, spaceId, type, updatedAt, [spaceId+updatedAt]',
      edges: 'id, spaceId, updatedAt',
      areas: 'id, spaceId, parentId, updatedAt',
      themes: 'id, spaceId, parentId, updatedAt',
      stages: 'id, spaceId, updatedAt, start, end',
      versions: 'id, spaceId, updatedAt, [spaceId+updatedAt]',
      customStatuses: 'id, name',
      meta: 'key',
    }).upgrade(async (tx) => {
      // 加密数据不能在 upgrade 里解（没 key）；只立个 flag，让 app 层拿到 key 后再做
      await tx.table('meta').put({ key: 'pendingSchemaMigration', value: 2 });
    });
    // v3：areas 表已空（应用层迁移完会清），从这里删表
    this.version(3).stores({
      nodes: 'id, spaceId, type, updatedAt, [spaceId+updatedAt]',
      edges: 'id, spaceId, updatedAt',
      themes: 'id, spaceId, parentId, updatedAt',
      stages: 'id, spaceId, updatedAt, start, end',
      versions: 'id, spaceId, updatedAt, [spaceId+updatedAt]',
      customStatuses: 'id, name',
      meta: 'key',
    });
    // v4：新增 milestones 表（goal 节点的时间点位检查清单）
    // —— 纯新增表，无需升级回调；旧库的 milestones 表初始为空
    this.version(4).stores({
      nodes: 'id, spaceId, type, updatedAt, [spaceId+updatedAt]',
      edges: 'id, spaceId, updatedAt',
      themes: 'id, spaceId, parentId, updatedAt',
      stages: 'id, spaceId, updatedAt, start, end',
      milestones: 'id, spaceId, parentId, updatedAt',
      versions: 'id, spaceId, updatedAt, [spaceId+updatedAt]',
      customStatuses: 'id, name',
      meta: 'key',
    });
  }
}

export const db = new LifeDB();

export const META_CRYPTO = 'cryptoConfig';
export const META_SETTINGS = 'settings';
/** 设置结构版本标记。主题从 dark/light 变成 auto/dark/light 时用过。 */
export const META_SETTINGS_V2 = 'settingsSchemaV2';

export const loadCryptoConfig = async (): Promise<CryptoConfig> => {
  const row = await db.meta.get(META_CRYPTO);
  return (row?.value as CryptoConfig) ?? { enabled: false, salt: null, iterations: 600_000, verifier: null };
};

export const saveCryptoConfig = (cfg: CryptoConfig): Promise<string> =>
  db.meta.put({ key: META_CRYPTO, value: cfg });

export type Contrast = 'normal' | 'high';
export type Scale = 'md' | 'lg' | 'xl';
export type { Theme, ResolvedTheme } from './theme';
import { migrateTheme, resolveTheme, type ResolvedTheme, type Theme } from './theme';

export interface Settings {
  /** 关系上下文开关：搜索命中后是否带出一跳邻居（§7.3） */
  searchContext: boolean;
  /** 自动锁定分钟数 */
  lockMinutes: number;
  /** 时间轴视图的泳道（面）顺序 */
  timelineLanes: string[];
  /** 无障碍：高对比度 */
  contrast: Contrast;
  /** 无障碍：字体缩放 */
  scale: Scale;
  /** 主题：跟随系统 / 暗色 / 亮色 */
  theme: Theme;
  /** 左栏宽度（px）。0 = 收起。undefined = 用断点默认值 */
  leftW?: number;
  /** 右栏宽度（px）。0 = 收起。undefined = 用断点默认值 */
  rightW?: number;
}

export const defaultSettings = (): Settings => ({
  searchContext: true, lockMinutes: 15, timelineLanes: [],
  contrast: 'normal', scale: 'md', theme: 'auto',
});

/** 把无障碍设置落到 <html> 上 */
export function applyA11y(s: Pick<Settings, 'contrast' | 'scale'>): void {
  const el = document.documentElement;
  if (s.contrast === 'high') el.dataset.contrast = 'high'; else delete el.dataset.contrast;
  if (s.scale !== 'md') el.dataset.scale = s.scale; else delete el.dataset.scale;
}

/**
 * 解析后的实际主题。
 *
 * 渲染层（画布配色 / 时间轴 / 列表 / 今日 / 详情）一律读这个，
 * **不要**直接读 settings.theme —— 那是偏好，可能是 'auto'。
 */
let resolvedTheme: ResolvedTheme = 'dark';
export function effectiveTheme(): ResolvedTheme { return resolvedTheme; }

/**
 * 系统当前外观。
 * 原生外壳里由原生推过来（见 App.setTheme）；纯浏览器里退回
 * prefers-color-scheme —— 浏览器里也该跟着系统走，而不是永远深色。
 */
export function systemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/**
 * 把主题设置落到 <html data-theme> 上，并记下解析结果。
 * system 是"系统当前外观"，原生推过来的值优先于 media query。
 * 返回解析后的实际主题。
 */
export function applyTheme(
  s: Pick<Settings, 'theme'>,
  system: ResolvedTheme = systemTheme(),
): ResolvedTheme {
  const t = resolveTheme(s.theme, system);
  resolvedTheme = t;
  const el = document.documentElement;
  if (t === 'light') el.dataset.theme = 'light'; else delete el.dataset.theme;
  return t;
}

export const loadSettings = async (): Promise<Settings> => {
  const row = await db.meta.get(META_SETTINGS);
  const merged: Settings = { ...defaultSettings(), ...((row?.value as Partial<Settings>) ?? {}) };
  // 主题只迁一次（规则见 theme.ts 的 migrateTheme）：
  // 靠 meta 里的版本标记，否则用户在新设置里选的暗色
  // 会在下次启动又被迁回 auto —— 选了等于没选。
  const v2 = await db.meta.get(META_SETTINGS_V2);
  const migrated = migrateTheme(merged.theme, !!v2?.value);
  if (migrated !== merged.theme) {
    merged.theme = migrated;
    await db.meta.put({ key: META_SETTINGS_V2, value: true });
    await saveSettings(merged);
  }
  return merged;
};

export const saveSettings = (s: Settings): Promise<string> =>
  db.meta.put({ key: META_SETTINGS, value: s });
