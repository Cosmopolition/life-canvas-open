/**
 * 详情画布：goal + action 节点的全屏 zoom-in 视图。
 *
 * 设计要点：
 * - 全屏替换 #vCanvas（与现有 view 切换机制一致：[hidden]）
 * - **只读** —— 任何写操作都通过 onEdit 走 inspector
 * - 横向 milestone 时间线（SVG，自带 dark/light 调色）
 * - 关联节点按入边/出边分组卡片，点击 → onLinkedPick（App 决定 push / pick）
 * - 栈式导航：栈深 > 1 时显示面包屑
 */
import {
  EDGE_TYPE_COLOR, edgeTypeLabel, NODE_TYPE_COLOR, nodeTypeLabel,
  STATUS_COLOR, statusLabel, tagLabel,
} from '../model/types';
import type { LifeEdge, LifeNode, Library, Milestone } from '../model/types';
import {
  adjacencyOf, byId, milestoneDisplay, milestonesOf, parentGoalsOf, todayKey,
  MILESTONE_COLOR, milestoneLabel,
} from '../model/selectors';
import { el, svgEl } from '../ui/dom';
import { monthLabel, t } from '../i18n';

export interface DetailHost {
  lib: Library;
  /** 栈顶 node id */
  nodeId: string;
  /** 栈深度（>= 1） */
  stackDepth: number;
  /** 栈序列（用于面包屑） */
  stackBreadcrumb: ReadonlyArray<{ nodeId: string; title: string }>;
  theme: 'dark' | 'light';
  /** 关联节点点击（App 决定 push detail 还是 pop + pick 回画布） */
  onLinkedPick: (id: string) => void;
  /** ✎ 编辑按钮 → 退出栈 + 选中 + 切回画布 */
  onEdit: (id: string) => void;
  /** ← 返回（栈非空 pop；栈空 = no-op） */
  onBack: () => void;
  /** 面包屑跳到第 N 层 */
  onJumpTo: (level: number) => void;
  /**
   * 勾选 / 取消勾选里程碑。详情画布里唯一的写操作。
   *
   * 为什么单开这一个口子：勾里程碑就是这个页面的核心动作（"看看推到哪了，
   * 顺手勾掉刚完成的"），一个不能打勾的清单只是只读报告。而 setMilestoneDone
   * 本身是轻量写 —— 不入版本历史、不弹原因框，跟 action 的 done 同路子。
   * 其余一切（标题 / 正文 / 日期 / 增删里程碑）仍然只读，走 ✎ → 检视面板。
   */
  onToggleMilestone: (milestoneId: string, done: boolean) => void;
  /** 编辑一条关系（改类型 / 改备注） */
  onEditEdge: (edgeId: string) => void;
  /** 删除一条关系（确认由 app 层负责） */
  onRemoveEdge: (edgeId: string) => void;
  /**
   * 「回原文」—— 这个节点是从别的节点复制来的，跳回源头。
   * app 层负责切空间 + 聚焦。
   */
  onGoToSource: (sourceId: string) => void;
  /**
   * 查源节点。
   *
   * ⚠️ 必须由 app 层给：host.lib 是**当前空间**的视图（周画布里只有周空间的东西），
   *   而原件在主空间 —— 拿 host.lib 查会永远查不到，"回原文"就成了死按钮。
   *   id 全局唯一，所以全库查一次就够。
   */
  resolveSource: (id: string) => LifeNode | undefined;
}

export function renderDetail(root: HTMLElement, host: DetailHost): void {
  root.innerHTML = '';
  const n = byId(host.lib.nodes, host.nodeId);
  if (!n) {
    root.append(el('div', { class: 'detail-empty' },
      t('error.nodeDeletedReturning')));
    return;
  }

  const main = el('div', { class: 'detail-main' });
  // 先入文档再填内容：时间线的布局宽度取决于容器实际宽度，
  // main 还挂在树上的时候量不到（detached 元素 clientWidth 恒为 0）。
  root.append(main);
  main.append(buildBar(host, n));
  main.append(buildTitleRow(n));
  const stRow = buildStatusRow(n);
  if (stRow) main.append(stRow);
  const srcRow = buildSourceRow(host, n);
  if (srcRow) main.append(srcRow);
  const cover = buildCover(n);
  if (cover) main.append(cover);
  main.append(buildTimeline(host, n, timelineAvail(main)));
  const rel = buildRelationCards(host, n);
  if (rel) main.append(rel);
}

/* ============================================================
 * 封面图
 * ============================================================ */

/**
 * 封面图：这个点贴的图，在详情页摆一张**能看全**的大图。
 *
 * ⚠️ 为什么详情页要单独给图一个位置：
 *    画布上的图是"缩略图"（精细路径 120px / 概览路径一个角标）——
 *    它们回答的是"这个点有图吗"，不是"这张图长什么样"。
 *    详情页是唯一能把整张图摊开的地方：贴了张作品截图，
 *    想看清到底是哪张，进来就该看见，而不是再去画布上放大。
 *
 * ⚠️ imageData（贴进来的）和 imageUrl（外链）的区别要说清楚：
 *    外链换设备就没了 —— 少了这句提示，用户会以为它跟贴进来的一样可靠。
 */
function buildCover(n: LifeNode): HTMLElement | null {
  const src = n.imageData ?? n.imageUrl;
  if (!src) return null;
  const box = el('div', { class: 'detail-cover' });
  const img = el('img', { class: 'detail-cover-img', src, alt: n.title });
  img.loading = 'eager';
  box.append(img);
  box.append(el('div', { class: 'detail-cover-cap' },
    n.imageData
      ? t('image.sizeEncrypted', { w: n.imageW ?? '?', h: n.imageH ?? '?' })
      : t('image.externalUrlHint')));
  return box;
}

/**
 * 时间线可用宽度 = .detail-main 内容宽 − .detail-tl 的内边距(16×2)与边框(1×2)。
 * 量不到时（极端窄）退回一个保守值，别让布局宽度算出 0。
 */
function timelineAvail(main: HTMLElement): number {
  const w = main.clientWidth - 34;
  return w > 240 ? w : 240;
}

/* ============================================================
 * 顶部 sticky bar：← 返回 / 面包屑 / ✎
 * ============================================================ */
function buildBar(host: DetailHost, n: LifeNode): HTMLElement {
  const bar = el('div', { class: 'detail-bar' });
  const back = el('button', { class: 'detail-back', title: t('action.backOneLevel') }, t('action.back'));
  back.onclick = () => host.onBack();
  bar.append(back);

  bar.append(buildCrumb(host));

  const edit = el('button', { class: 'detail-edit', title: t('detail.leaveDetail') }, t('action.edit'));
  edit.onclick = () => host.onEdit(n.id);
  bar.append(edit);
  return bar;
}

function buildCrumb(host: DetailHost): HTMLElement {
  const crumb = el('div', { class: 'detail-crumb' });
  if (host.stackDepth <= 1) {
    crumb.append(el('span', {}, nodeTypeLabel(byId(host.lib.nodes, host.nodeId)?.type ?? 'idea')));
    return crumb;
  }
  for (let i = 0; i < host.stackBreadcrumb.length; i++) {
    if (i > 0) crumb.append(el('span', { class: 'sep' }, '›'));
    const item = host.stackBreadcrumb[i]!;
    const isHere = i === host.stackDepth - 1;
    const span = el('span', { class: isHere ? 'here' : 'a' }, item.title);
    if (!isHere) {
      span.style.cursor = 'pointer';
      span.onclick = () => host.onJumpTo(i);
    }
    crumb.append(span);
  }
  return crumb;
}

/* ============================================================
 * 标题行
 * ============================================================ */
function buildTitleRow(n: LifeNode): HTMLElement {
  const row = el('div', { class: 'detail-title-row' });
  const typeChip = el('span', { class: 'detail-chip' });
  const sw = el('span', { class: 'sw' });
  sw.style.background = NODE_TYPE_COLOR[n.type];
  typeChip.append(sw, document.createTextNode(nodeTypeLabel(n.type)));
  row.append(typeChip);

  if (n.tags?.length) {
    for (const tg of n.tags.slice(0, 3)) {
      const tag = el('span', { class: 'detail-chip' }, `#${tagLabel(tg)}`);
      row.append(tag);
    }
  }
  row.append(el('h1', { class: 'detail-title' }, n.title));

  // id 单独一行作为元数据，跟标题分开 —— 上一版贴在标题末尾会显得拥挤
  const meta: string[] = [];
  if (n.time) meta.push(t('field.timeLabel', { time: n.time }));
  meta.push(`id ${n.id.slice(0, 8)}…`);
  row.append(el('div', { class: 'detail-sub' }, meta.join(' · ')));
  return row;
}

/* ============================================================
 * 状态行（只读）
 * ============================================================ */
function buildStatusRow(n: LifeNode): HTMLElement | null {
  if (n.type === 'goal' && n.status) {
    const row = el('div', { class: 'detail-st-row' });
    const c = STATUS_COLOR[n.status] ?? '';
    const chip = el('span', { class: 'detail-st on' }, statusLabel(n.status));
    if (c) {
      chip.style.background = c;
      chip.style.borderColor = c;
    }
    row.append(chip);
    return row;
  }
  if (n.type === 'action') {
    const row = el('div', { class: 'detail-st-row' });
    const chip = el('span', { class: 'detail-st on' }, n.done ? t('status.completed') : t('status.inProgress'));
    if (n.done) {
      chip.style.background = 'var(--ok)';
      chip.style.borderColor = 'var(--ok)';
    }
    row.append(chip);
    return row;
  }
  return null;
}

/* ============================================================
 * 来源行：「回原文」
 *
 * 这个节点是从别的节点复制来的（周画布里引入的原数据）。
 * 给一个跳回源头的入口 —— 副本改坏了还能回去看原件。
 * ============================================================ */
function buildSourceRow(host: DetailHost, n: LifeNode): HTMLElement | null {
  if (!n.sourceId) return null;
  // 源节点被删了 ⇒ 这一行不显示（副本本身照常用）
  const src = host.resolveSource(n.sourceId);
  if (!src) return null;
  const row = el('div', { class: 'detail-src' });
  row.append(el('span', { class: 'lb' }, t('week.source')));
  const btn = el('button', { class: 'detail-src-go' }, `${src.title} ↗`);
  btn.onclick = () => host.onGoToSource(src.id);
  row.append(btn);
  return row;
}

/* ============================================================
 * 横向 milestone 时间线（SVG）
 * ============================================================ */
interface TimelineLayout {
  width: number;
  /** viewBox 内的 lo / hi 端点（毫秒），月份刻度循环直接用 */
  lo: number;
  hi: number;
  xOf: (dStr: string) => number;
  ms: Milestone[];
  today: string;
}

const LANE_H = 56;          // SVG 总高（只画轴 + 圆点 + "今天"线，文字交给 HTML 浮层）
const AXIS_Y = 28;          // 时间轴线 y 坐标
const DOT_Y = 28;           // 圆心 y 坐标
const DOT_R = 5;
const SIDE_PAD = 110;       // 两侧固定留白：标题文字约 90px + 余量
const DOT_SPACING_MIN = 100;// 圆点之间最小像素距离，低于此值会拉宽 viewBox
const MIN_WIDTH = 360;      // 布局下限：再窄标题就放不下了，只能等比压扁
const MAX_WIDTH = 1400;     // 封顶：避免 1 年跨度把卡片撑爆

function timelineLayout(lib: Library, goalId: string, today: string, avail: number): TimelineLayout | null {
  const ms = milestonesOf(lib, goalId);
  if (!ms.length) return null;

  // 关键修复：milestone 的"实际跨度"只算 [最早, 最晚]，
  // padding / today 不算进 spacing。圆点间距 = (实际跨度) / (N-1)，
  // 然后整体再加两侧 SIDE_PAD 留白给标题文字。
  const targetDates = ms.map((m) => parseDay(m.targetDate)).sort((a, b) => a - b);
  const lo = targetDates[0]!;
  const hi = targetDates[targetDates.length - 1]!;
  const n = targetDates.length;
  // 需要的最小区间：每个圆点至少 DOT_SPACING_MIN 像素
  const requiredInner = (n - 1) * DOT_SPACING_MIN;

  // 宽度以容器实际宽度 avail 为上限。之前是固定算到 1400 再塞进 920 的容器，
  // SVG 按 viewBox 等比压缩，DOT_SPACING_MIN 100 实际只剩 66px ——
  // 圆点重新挤成一团，正是详情画布最初难看的那三个截图的问题。
  const want = requiredInner + SIDE_PAD * 2;
  const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.min(want, avail)));
  const innerWidth = width - SIDE_PAD * 2;

  // xOf：圆点在内区间 [SIDE_PAD, width - SIDE_PAD] 上均匀分布
  const innerLeft = SIDE_PAD;
  const innerRight = width - SIDE_PAD;
  const xOf = (dStr: string): number => {
    const t = parseDay(dStr);
    if (n === 1) return (innerLeft + innerRight) / 2;
    return innerLeft + (t - lo) / (hi - lo) * innerWidth;
  };
  return { width, lo, hi, xOf, ms, today };
}

function parseDay(dStr: string): number {
  // 'YYYY-MM-DD' 12:00 本地时间，避免夏令时穿越导致 ±1 天偏移
  return new Date(dStr + 'T12:00:00').getTime();
}

function buildTimeline(host: DetailHost, n: LifeNode, avail: number): HTMLElement {
  const sec = el('div', { class: 'detail-tl' });
  sec.append(el('div', { class: 'detail-tl-title' },
    n.type === 'goal' ? t('milestone.timeline') : t('week.parentGoalPreview')));

  let goalId: string | null = null;
  let isActionPreview = false;
  if (n.type === 'goal') goalId = n.id;
  else if (n.type === 'action') {
    const parents = parentGoalsOf(host.lib, n.id);
    if (parents.length) {
      goalId = parents[0]!.id;
      isActionPreview = true;
    }
  }

  if (!goalId) {
    sec.append(el('div', { class: 'detail-tl-empty' },
      n.type === 'goal'
        ? t('onboard.hintSoftPlan2')
        : t('softPlan.notAttachedToGoal')));
    return sec;
  }

  if (isActionPreview) {
    const goal = byId(host.lib.nodes, goalId);
    sec.append(el('div', { class: 'detail-tl-empty', style: 'margin-bottom:8px;color:var(--dim)' },
      t('milestone.parentGoalReadOnly', { title: goal?.title ?? '?' })));
  }

  const layout = timelineLayout(host.lib, goalId, todayKey(), avail);
  if (!layout) {
    sec.append(el('div', { class: 'detail-tl-empty' }, t('milestone.noneForGoal')));
    return sec;
  }

  // action 详情里看到的是父目标的里程碑 —— 保持只读，跟上方"只读"注脚一致。
  // 真正想勾的话，点父目标标题进它的详情。
  sec.append(buildTimelineFrame(host, layout, !isActionPreview));
  return sec;
}

/**
 * 时间线整体框：
 * - SVG 画轴 + 圆点 + "今天"线（紧凑 56px）
 * - 下方堆一个 milestone 列表（按 targetDate 升序），每条全宽 → 不再互踩
 */
function buildTimelineFrame(host: DetailHost, layout: TimelineLayout, canToggle: boolean): HTMLElement {
  const frame = el('div', { class: 'detail-tl-frame' });
  frame.style.setProperty('--tl-width', `${layout.width}px`);
  frame.append(buildTimelineSvg(layout));

  const list = el('div', { class: 'detail-tl-list' });
  for (const m of [...layout.ms].sort((a, b) => a.targetDate.localeCompare(b.targetDate))) {
    list.append(buildTimelineRow(host, m, layout.today, canToggle));
  }
  frame.append(list);
  return frame;
}

function buildTimelineRow(host: DetailHost, m: Milestone, today: string, canToggle: boolean): HTMLElement {
  const disp = milestoneDisplay(m, today);
  const done = !!m.completedAt;
  const row = el('div', { class: 'tl-row' + (done ? ' is-done' : '') });

  // 圆点 = 勾选框。canToggle（goal 自己的详情）时可点；action 里预览父目标时只读。
  const swatch = el(canToggle ? 'button' : 'span', { class: 'tl-row-dot' + (canToggle ? ' is-btn' : '') });
  swatch.style.background = MILESTONE_COLOR[disp];
  if (canToggle) {
    swatch.title = done ? t('action.uncheck') : t('action.markAsCompleted');
    swatch.setAttribute('aria-pressed', done ? 'true' : 'false');
    swatch.setAttribute('aria-label', t('version.actionTitle', {
      action: done ? t('action.uncheck') : t('action.markCompleted'),
      title: m.title,
    }));
    (swatch as HTMLButtonElement).type = 'button';
    swatch.onclick = () => host.onToggleMilestone(m.id, !done);
  } else {
    swatch.title = t('week.readOnlyPreview');
  }
  row.append(swatch);

  const title = el('span', { class: 'tl-row-t' }, m.title);
  row.append(title);

  const tag = el('span', { class: 'tl-row-st' }, milestoneLabel(disp));
  tag.style.color = MILESTONE_COLOR[disp];
  tag.style.borderColor = MILESTONE_COLOR[disp];
  row.append(tag);

  const date = el('span', { class: 'tl-row-d' },
    m.completedAt ? t('version.dateDoneTime', { date: m.targetDate, time: m.completedAt }) : m.targetDate);
  row.append(date);
  return row;
}

function buildTimelineSvg(layout: TimelineLayout): SVGElement {
  const { width, lo, hi, xOf, ms, today } = layout;
  // 只画：月份刻度 + 主轴线 + "今天"竖虚线 + 每个 milestone 圆点
  // 标题 / 状态 / targetDate 全部交给 HTML 浮层（.tl-item）—— SVG 文字不换行、相邻会互踩
  const svg = svgEl('svg', {
    class: 'detail-tl-svg',
    viewBox: `0 0 ${width} ${LANE_H}`,
    width: '100%',
    height: LANE_H,
  });

  // 1. 月份刻度
  const cur = new Date(new Date(lo).getFullYear(), new Date(lo).getMonth(), 1);
  const hiDate = new Date(hi);
  while (cur <= hiDate) {
    const dk = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-01`;
    const tx = xOf(dk);
    if (tx >= -20 && tx <= width + 20) {
      const tick = svgEl('line', {
        x1: tx, x2: tx, y1: AXIS_Y - 4, y2: AXIS_Y + 4,
        class: 'tl-axis-tick',
      });
      tick.setAttribute('stroke', 'var(--line-soft)');
      tick.setAttribute('stroke-width', '1');
      svg.append(tick);
      const label = svgEl('text', { x: tx, y: AXIS_Y - 8, class: 'tl-month', 'text-anchor': 'middle' });
      label.setAttribute('fill', 'var(--faint)');
      label.setAttribute('font-size', '10');
      label.setAttribute('font-family', 'var(--ui-font)');
      label.textContent = monthLabel(cur.getMonth());
      svg.append(label);
    }
    cur.setMonth(cur.getMonth() + 1);
  }

  // 2. 主时间轴线
  const axis = svgEl('line', { x1: 0, x2: width, y1: AXIS_Y, y2: AXIS_Y, class: 'tl-axis' });
  axis.setAttribute('stroke', 'var(--line)');
  axis.setAttribute('stroke-width', '1');
  svg.append(axis);

  // 3. "今天"竖虚线
  const todayX = xOf(today);
  if (todayX >= 0 && todayX <= width) {
    const td = svgEl('line', { x1: todayX, x2: todayX, y1: DOT_Y - 4, y2: LANE_H - 2, class: 'tl-today' });
    td.setAttribute('stroke', 'var(--accent)');
    td.setAttribute('stroke-width', '1');
    td.setAttribute('stroke-dasharray', '3 3');
    svg.append(td);
    const tdLbl = svgEl('text', { x: todayX, y: LANE_H - 4, 'text-anchor': 'middle' });
    tdLbl.setAttribute('fill', 'var(--accent)');
    tdLbl.setAttribute('font-size', '9.5');
    tdLbl.setAttribute('font-family', 'var(--ui-font)');
    tdLbl.textContent = t('today.dateHeading', { date: today });
    svg.append(tdLbl);
  }

  // 4. 每个 milestone 圆点（无文字）
  for (const m of ms) {
    const disp = milestoneDisplay(m, today);
    const dot = svgEl('circle', { cx: xOf(m.targetDate), cy: DOT_Y, r: DOT_R, class: 'tl-dot' });
    dot.setAttribute('fill', MILESTONE_COLOR[disp]);
    // title 元素用作 hover tooltip
    const titleEl = svgEl('title');
    titleEl.textContent = m.title + '\n' +
      t('milestone.stateGoalDate', { state: milestoneLabel(disp), date: m.targetDate }) +
      (m.completedAt ? t('milestone.doneAtTime', { time: m.completedAt }) : '');
    dot.append(titleEl);
    svg.append(dot);
  }

  return svg;
}

/* ============================================================
 * 关联节点（按入边/出边分组）
 * ============================================================ */
function buildRelationCards(host: DetailHost, n: LifeNode): HTMLElement | null {
  const adj = adjacencyOf(host.lib, n.id);
  const groups = [
    { title: t('detail.outgoing'), edges: adj.out },
    { title: t('detail.incoming'), edges: adj.in },
  ];
  const any = groups.some((g) => g.edges.length > 0);
  if (!any) return null;

  const sec = el('div', { class: 'detail-rel' });
  sec.append(el('div', { class: 'detail-rel-hd' }, t('detail.relatedNodes')));

  for (const g of groups) {
    if (!g.edges.length) continue;
    const grp = el('div', { class: 'detail-rel-grp' });
    grp.append(el('div', { class: 'detail-rel-grp-t' }, g.title));
    for (const edge of g.edges) grp.append(buildRelCard(host, edge, n));
    sec.append(grp);
  }
  return sec;
}

function buildRelCard(host: DetailHost, edge: LifeEdge, n: LifeNode): HTMLElement {
  const otherId = edge.fromId === n.id ? edge.toId : edge.fromId;
  const node = byId(host.lib.nodes, otherId);
  const theme = byId(host.lib.themes, otherId);
  const stage = byId(host.lib.stages, otherId);
  const target = node ?? theme ?? stage;
  const isNode = !!node;

  const card = el('div', { class: 'detail-rel-i' });

  // 类型徽标可点（点一下就能改这条线的类型）
  const tag = el('button', { class: 'detail-rel-tag', title: t('detail.changeRelationType') }, edgeTypeLabel(edge.type));
  tag.style.color = EDGE_TYPE_COLOR[edge.type];
  tag.style.borderColor = EDGE_TYPE_COLOR[edge.type];
  tag.onclick = (ev) => { ev.stopPropagation(); host.onEditEdge(edge.id); };
  card.append(tag);

  const relBox = el('div', { class: 'detail-rel-t' });
  if (!target) {
    relBox.append(el('b', {}, '?'));
    relBox.append(el('span', {}, t('toast.deleted')));
  } else {
    const label = 'title' in target ? target.title : target.name;
    relBox.append(el('b', {}, label));
    if (isNode) {
      const nt = (node as LifeNode).type;
      relBox.append(el('span', {}, nodeTypeLabel(nt) + (node?.time ? ` · ${node.time}` : '')));
    } else if (theme) {
      relBox.append(el('span', {}, t('field.theme')));
    } else if (stage) {
      const dateStr = stage.start || stage.end ? `${stage.start ?? '…'} → ${stage.end ?? '…'}` : t('common.noDates');
      relBox.append(el('span', {}, t('field.stageWithRange', { range: dateStr })));
    }
  }
  card.append(relBox);

  // 编辑 / 删除（常驻可见 —— 隐藏的按钮等于没有）
  const edit = el('button', { class: 'rel-act', title: t('action.editThisRelation') }, '✎');
  edit.onclick = (ev) => { ev.stopPropagation(); host.onEditEdge(edge.id); };
  const del = el('button', { class: 'rel-del', title: t('action.deleteThisRelation') }, '×');
  del.onclick = (ev) => { ev.stopPropagation(); host.onRemoveEdge(edge.id); };
  card.append(edit, del);

  if (target) card.onclick = () => host.onLinkedPick(otherId);
  return card;
}
