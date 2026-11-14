/**
 * 导出。JSON 是完整保真的主格式；Markdown 是"给人看"的一层；
 * JSON Canvas 作为迁移出口（Obsidian 可直接打开）。
 */
import {
  edgeTypeLabel, nodeTypeLabel, statusLabel, STATUS_COLOR, tagLabel,
  type EdgeType, type Library, type LifeNode, type LifeStage, type LifeTheme,
} from '../model/types';
import { byId, inStage, nodesInTheme } from '../model/selectors';
import { emit } from '../platform/shell';
import { fmtDateTime, t } from '../i18n';

export const EXPORT_VERSION = '1.1.0';

export interface ExportBundle {
  meta: {
    app: '人生画布';
    schema: number;
    version: string;
    exportedAt: string;
    counts: { nodes: number; edges: number; themes: number; stages: number; milestones: number; versions: number };
  };
  library: Library;
}

export function toBundle(lib: Library): ExportBundle {
  return {
    meta: {
      app: '人生画布', schema: 1, version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      counts: {
        nodes: lib.nodes.length, edges: lib.edges.length,
        themes: lib.themes.length, stages: lib.stages.length,
        versions: lib.versions.length,
        milestones: lib.milestones.length,
      },
    },
    library: lib,
  };
}

export function fromBundle(raw: unknown): Library {
  const b = raw as Partial<ExportBundle>;
  if (!b?.library || !Array.isArray(b.library.nodes)) throw new Error(t('error.invalidExportFile'));
  return {
    nodes: b.library.nodes, edges: b.library.edges ?? [],
    themes: b.library.themes ?? [], stages: b.library.stages ?? [],
    versions: b.library.versions ?? [],
    milestones: b.library.milestones ?? [],
    customStatuses: b.library.customStatuses ?? [],
  };
}

/* ---------------- Markdown ---------------- */

/**
 * 把 lib 转成给人看的 Markdown。
 * 排版：主题为一级分区（h2），阶段为另一组一级分区，节点在分区内为 h3。
 * focusId：传一个 id，导出限定到该主题或该阶段；id 找不到时回退导出全部。
 */
export function toMarkdown(lib: Library, focusId: string | null = null): string {
  const L: string[] = [];

  // 解析 focus：先看是不是 theme，再看是不是 stage；都没有则视为全显
  const focusTheme: LifeTheme | null = focusId ? byId(lib.themes, focusId) ?? null : null;
  const focusStage: LifeStage | null = focusId ? byId(lib.stages, focusId) ?? null : null;
  // 指定的 id 找不到（比如导入的数据 ID 变了）→ focusTheme / focusStage 都为 null，
  // 下面的判断自然走"导出全部"分支。这里不需要额外代码 —— 注释说明意图。

  L.push(`# ${t('export.fileTitle')}`);
  L.push(`> ${fmtDateTime(new Date())} · ${t('common.nodeRelationCount', { n: lib.nodes.length, m: lib.edges.length })}`);
  L.push('');

  // 主题区段（焦点是阶段时跳过）
  if (!focusStage) {
    const themes = focusTheme ? [focusTheme] : topThemes(lib);
    for (const theme of themes) writeThemeSection(lib, theme, 2, L);
  }

  // 阶段区段（焦点是主题时跳过）
  if (!focusTheme) {
    const stages = focusStage ? [focusStage] : lib.stages;
    for (const stage of stages) writeStageSection(lib, stage, 2, L);
  }

  return L.join('\n');
}

function topThemes(lib: Library): LifeTheme[] {
  const hasParent = new Set(lib.themes.map((th) => th.parentId).filter(Boolean) as string[]);
  return lib.themes.filter((th) => !hasParent.has(th.id));
}

function writeThemeSection(lib: Library, theme: LifeTheme, depth: number, L: string[]): void {
  L.push(`${'#'.repeat(depth)} ${theme.name}`);
  L.push('');
  if (theme.description) { L.push(theme.description, ''); }

  const nodes = nodesInTheme(lib, theme.id, false)
    .sort((a, b) => (b.time ?? '').localeCompare(a.time ?? ''));
  for (const n of nodes) writeNode(lib, n, depth + 1, L);

  // 递归子主题
  for (const child of lib.themes.filter((th) => th.parentId === theme.id)) {
    L.push('');
    writeThemeSection(lib, child, depth + 1, L);
  }
}

function writeStageSection(lib: Library, stage: LifeStage, depth: number, L: string[]): void {
  const date = stage.start || stage.end ? ` (${stage.start ?? '…'} → ${stage.end ?? '…'})` : '';
  L.push(`${'#'.repeat(depth)} ${stage.name}${date}`);
  L.push('');
  if (stage.description) { L.push(stage.description, ''); }

  // 阶段成员：显式 stageIds ∪ 时基命中（与渲染层 inStage 谓词一致）
  const nodes = lib.nodes
    .filter((n) => inStage(lib, n, stage.id))
    .sort((a, b) => (b.time ?? '').localeCompare(a.time ?? ''));
  for (const n of nodes) writeNode(lib, n, depth + 1, L);
}

function writeNode(lib: Library, n: LifeNode, depth: number, L: string[]): void {
  const status = n.status ? ` · **${statusLabel(n.status)}**` : '';
  const time = n.time ? ` \`${n.time}\`` : '';
  const tags = n.tags.length ? ` ${n.tags.map((tag) => `#${tagLabel(tag)}`).join(' ')}` : '';
  // 已完成（done）用 ~~ 包裹标题，保留语义的删线视觉提示
  const title = n.done ? `~~${n.title}~~` : n.title;
  L.push(`${'#'.repeat(depth)} ${t('node.typeTitle', { type: nodeTypeLabel(n.type), title })}${status}${time}${tags}`);
  L.push('');
  // 封面图：dataURL 内嵌（自包含）；URL 用普通引用（不持久但轻）
  if (n.imageData) L.push(`![](${n.imageData})`, '');
  else if (n.imageUrl) L.push(`![](${n.imageUrl})`, '');
  // 链接：任意 URL（label 可空时空着让 markdown 自动取 url 当文本）
  if (n.linkUrl) {
    const text = n.linkLabel || n.linkUrl;
    L.push(`🔗 [${text}](${n.linkUrl})`, '');
  }
  if (n.content) { L.push(n.content, ''); }

  const rel = lib.edges.filter((e) => e.fromId === n.id || e.toId === n.id);
  if (rel.length) {
    L.push(`${'#'.repeat(depth + 1)} ${t('detail.relations')}`);
    L.push('');
    for (const e of rel) {
      const otherId = e.fromId === n.id ? e.toId : e.fromId;
      const other = byId(lib.nodes, otherId) ?? byId(lib.themes, otherId) ?? byId(lib.stages, otherId);
      const otherName = other
        ? ('title' in other ? other.title : other.name)
        : t('common.deletedAlt');
      const dir = e.fromId === n.id ? '→' : '←';
      const note = e.note ? ` —— ${e.note}` : '';
      const color = e.type === 'replace' ? ' **' : '';
      const close = e.type === 'replace' ? '**' : '';
      L.push(`- ${dir} ${color}${edgeTypeLabel(e.type as EdgeType)}${close} ${otherName}${note}`);
    }
    L.push('');
  }

  const vs = lib.versions.filter((v) => v.nodeId === n.id).sort((a, b) => a.changedAt - b.changedAt);
  if (vs.length > 1) {
    L.push(`${'#'.repeat(depth + 1)} ${t('version.evolution')}`, '');
    for (const v of vs) {
      const day = new Date(v.changedAt).toISOString().slice(0, 10);
      const star = v.title ? '★ ' : '';
      L.push(`- ${star}\`${day}\` ${v.reason}${v.title ? t('common.parenthesizedTitle', { title: v.title }) : ''}`);
    }
    L.push('');
  }
}

/* ---------------- JSON Canvas（迁移出口） ---------------- */

/**
 * 投影到 Obsidian JSON Canvas 格式。
 * focusId：限定到该主题（递归含子主题）的节点；找不到则全量。
 * 主题和阶段作为 group 节点入图，节点按原坐标铺。
 */
export function toJsonCanvas(lib: Library, focusId: string | null = null): unknown {
  const focusTheme: LifeTheme | null = focusId ? byId(lib.themes, focusId) ?? null : null;
  const focusStage: LifeStage | null = focusId ? byId(lib.stages, focusId) ?? null : null;

  // 节点：按主题过滤（递归含子主题）
  const nodes = focusTheme
    ? nodesInTheme(lib, focusTheme.id, true)
    : focusStage
      ? lib.nodes.filter((n) => inStage(lib, n, focusStage.id))
      : lib.nodes;
  const ids = new Set(nodes.map((n) => n.id));

  // 主题/阶段作为 group 节点
  const groupThemes = focusTheme ? [focusTheme] : lib.themes;
  const groupStages = focusStage ? [focusStage] : lib.stages;

  const out = {
    nodes: [
      ...groupThemes.map((th) => ({
        id: th.id, type: 'group', text: `# ${th.name}`,
        x: 0, y: 0, width: 260, height: 80,
        color: th.color === '#e0a458' ? '1' : '6',
      })),
      ...groupStages.map((s) => ({
        id: s.id, type: 'group', text: `# ${s.name}`,
        x: 0, y: 0, width: 260, height: 80, color: '5',
      })),
      ...nodes.map((n) => ({
        id: n.id, type: 'text',
        text: jsonCanvasText(n),
        x: n.x, y: n.y, width: n.w, height: n.h, color: '1',
      })),
    ],
    edges: lib.edges
      .filter((e) => ids.has(e.fromId) || ids.has(e.toId))
      .map((e) => ({
        id: e.id, fromNode: e.fromId, fromSide: 'right', toNode: e.toId, toSide: 'left',
        label: edgeTypeLabel(e.type as EdgeType) + (e.note ? ` · ${e.note}` : ''),
      })),
  };
  return out;
}

/**
 * JSON Canvas 节点正文：类型 · 标题 + 状态 / 时间 / 正文。
 *
 * ⚠️ 结构是**数据契约**（Obsidian 按行读），只有「类型：」「状态：」「时间：」
 *   这些显示名走 t()；type 字段、字段名、换行位置都不动。
 */
function jsonCanvasText(n: LifeNode): string {
  const lines: string[] = [t('node.typeTitle', { type: nodeTypeLabel(n.type), title: n.title })];
  if (n.status) lines.push(t('field.statusValue', { s: statusLabel(n.status) }));
  if (n.time) lines.push(t('field.timeValue', { time: n.time }));
  if (n.content) { lines.push(''); lines.push(n.content); }
  return lines.join('\n');
}

/* ---------------- 落盘 ---------------- */

export function download(filename: string, data: string | Blob, mime = 'application/json'): void {
  const blob = data instanceof Blob ? data : new Blob([data], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  // 原生弹的保存面板**不知道建议文件名**（runOpenPanelWith 不带这个信息），
  // 所以先把名字报给原生，它存下来填进 NSSavePanel。
  // 浏览器里 emit 是空操作，不影响。
  emit('downloadName', { name: filename });
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const stamp = (): string => new Date().toISOString().slice(0, 10);

export const statusSwatch = (s?: string): string => (s && STATUS_COLOR[s]) || '#626a79';
