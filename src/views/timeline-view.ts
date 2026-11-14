/**
 * 时间轴视图（视图二，AD-10：属于 P0）。
 * 同一份图谱的第二种投影：按发生时间排开，取代关系单独连出来。
 */
import { NODE_TYPE_COLOR, nodeTypeLabel, STATUS_COLOR, statusLabel, type Library, type LifeNode } from '../model/types';
import { monthOf, themeChain } from '../model/selectors';
import { el, esc, svgEl } from '../ui/dom';
import { t } from '../i18n';

const T0 = Date.parse('2023-01-01');
const T1 = Date.parse('2027-06-01');
const L = 150, W = 1180, TOP = 108, RH = 152, GAP = 210;
const TL_MAX = 400;

export interface TimelineHost {
  lib: Library;
  theme: 'dark' | 'light';
  onPick(id: string): void;
}

/** 时间轴 SVG 调色板：SVG 不读 CSS 变量，按主题各自维护 */
const TL_PAL = {
  dark: {
    tickLine:'#2a2f3a', yearLabel:'#626a79', laneLabel:'#949cab',
    laneLine:'#262b35', accent:'#e0a458', noteBg:'#16181d',
    title:'#dfe2e8', subFallback:'#5b6270',
  },
  light: {
    tickLine:'#d6cfc0', yearLabel:'#8c8576', laneLabel:'#5b554c',
    laneLine:'#e6e1d5', accent:'#b8722e', noteBg:'#ffffff',
    title:'#2a2622', subFallback:'#8c8576',
  },
} as const;

export function renderTimeline(root: HTMLElement, host: TimelineHost): void {
  const lib = host.lib;
  const tl = TL_PAL[host.theme];
  const lanes = pickLanes(lib);
  let items = lib.nodes.filter((n) => monthOf(n.time) && lanes.some((l) => n.themeIds.includes(l)));
  // 上限：SVG 建 1 万个 group 会卡死。时间轴回答的是"目标怎么变的"，
  // 超量时优先保留目标与取代链相关点，其余按时间倒序补足。
  let truncated = 0;
  if (items.length > TL_MAX) {
    const must = items.filter((n) => n.type === 'goal' || lib.edges.some(
      (e) => e.type === 'replace' && (e.fromId === n.id || e.toId === n.id)));
    const rest = items.filter((n) => !must.includes(n)).sort((a, b) => (b.time ?? '').localeCompare(a.time ?? ''));
    truncated = items.length - TL_MAX;
    items = [...must, ...rest].slice(0, TL_MAX);
  }

  const x = (t: string): number => {
    const d = Date.parse((monthOf(t) ?? t) + '-01');
    return L + ((d - T0) / (T1 - T0)) * W;
  };

  // 一跳之外不做布局猜测：同泳道内按时间分列，列间距不足就换行
  const pos = new Map<string, [number, number]>();
  const laneMeta: { lane: string; top: number; rows: number }[] = [];
  lanes.forEach((lane, i) => {
    const top = TOP + i * RH;
    const cols: number[] = [];
    const inLane = items.filter((n) => n.themeIds.includes(lane))
      .sort((a, b) => (a.time ?? '').localeCompare(b.time ?? ''));
    for (const n of inLane) {
      const px = x(n.time ?? '');
      let c = 0;
      while (cols[c] !== undefined && (cols[c] as number) + GAP > px) c++;
      cols[c] = px;
      pos.set(n.id, [px, top + 30 + c * 52]);
    }
    laneMeta.push({ lane, top, rows: Math.max(1, cols.length) });
  });

  const H = TOP + lanes.length * RH + 20;
  const root$ = svgEl('svg', { viewBox: `0 0 ${L + W + 40} ${H}`, width: '100%', style: 'display:block' });

  // 时间刻度
  for (let y = 2023; y <= 2027; y++) {
    const px = L + ((Date.parse(`${y}-01-01`) - T0) / (T1 - T0)) * W;
    root$.append(svgEl('line', { x1: px, y1: TOP - 24, x2: px, y2: H - 26, stroke: tl.tickLine, 'stroke-width': 1 }));
    const yearEl = svgEl('text', { x: px + 6, y: TOP - 30, fill: tl.yearLabel, 'font-size': 11, opacity: .85 });
    yearEl.textContent = String(y);
    root$.append(yearEl);
  }

  // 泳道
  for (const m of laneMeta) {
    const name = lib.themes.find((a) => a.id === m.lane);
    const laneEl = svgEl('text', { x: 0, y: m.top + 4, fill: tl.laneLabel, 'font-size': 11.5, 'font-weight': 600 });
    laneEl.textContent = name?.name ?? m.lane;
    root$.append(laneEl);
    root$.append(svgEl('line', { x1: L, y1: m.top + 14, x2: L + W, y2: m.top + 14, stroke: tl.laneLine, 'stroke-width': 1 }));
  }

  // 取代链（画在点下面）
  for (const e of lib.edges) {
    if (e.type !== 'replace') continue;
    const a = pos.get(e.fromId); const b = pos.get(e.toId);
    if (!a || !b) continue;
    const lift = Math.abs(a[1] - b[1]) > 60 ? 96 : 52;
    const mx = a[0] + (b[0] - a[0]) * 0.5;
    const my = Math.min(a[1], b[1]) - lift;
    root$.append(svgEl('path', {
      d: `M${a[0]},${a[1]} C${mx},${a[1] - lift} ${mx},${b[1] - lift} ${b[0]},${b[1]}`,
      fill: 'none', stroke: tl.accent, 'stroke-width': 2, opacity: .9,
    }));
    const bx = Math.max(L, mx - noteW(e.note) / 2);
    root$.append(svgEl('rect', {
      x: bx, y: my - 11, width: noteW(e.note), height: 19, rx: 5,
      fill: tl.noteBg, stroke: tl.accent, 'stroke-opacity': .55,
    }));
    const nt = svgEl('text', { x: bx + noteW(e.note) / 2, y: my + 3, fill: tl.accent, 'font-size': 10.5, 'text-anchor': 'middle' });
    nt.textContent = e.note ?? '';
    root$.append(nt);
  }

  // 点
  for (const n of items) {
    const p = pos.get(n.id);
    if (!p) continue;
    root$.append(mkItem(n, p[0], p[1], host));
  }

  root.innerHTML = '';
  root.append(chainCard(lib));
  root.append(root$);
  if (truncated > 0) {
    root.append(el('p', { style: 'margin-top:12px;font-size:12px;color:var(--faint)' },
      t('timeline.truncated', { max: TL_MAX, n: truncated })));
  }
}

const noteW = (s?: string): number => (s?.length ?? 0) * 11.2 + 14;

function mkItem(n: LifeNode, x: number, y: number, host: TimelineHost): SVGGElement {
  const tl = TL_PAL[host.theme];
  const g = svgEl('g', { style: 'cursor:pointer' }) as SVGGElement;
  const c = NODE_TYPE_COLOR[n.type];
  const isGoal = n.type === 'goal';
  g.append(svgEl('circle', { cx: x, cy: y, r: isGoal ? 6 : 4, fill: c, opacity: isGoal ? 1 : .7 }));
  if (isGoal) g.append(svgEl('circle', { cx: x, cy: y, r: 11, fill: 'none', stroke: c, 'stroke-opacity': .32 }));

  const title = svgEl('text', { x: x + 15, y: y - 1, fill: tl.title, 'font-size': 11 });
  title.textContent = n.title.length > 13 ? n.title.slice(0, 13) + '…' : n.title;
  g.append(title);

  const sub = svgEl('text', { x: x + 15, y: y + 11, fill: (n.status ? STATUS_COLOR[n.status] : tl.subFallback) ?? tl.subFallback, 'font-size': 10.5 });
  sub.textContent = `${n.status ? statusLabel(n.status) : nodeTypeLabel(n.type)} · ${n.time}`;
  g.append(sub);

  g.addEventListener('click', () => host.onPick(n.id));
  return g;
}

function pickLanes(lib: Library): string[] {
  // 选有时间的点所归属的"最上层"主题（无 root 间接层），最多 4 条泳道
  const withTime = lib.nodes.filter((n) => n.time);
  const seen = new Map<string, number>();
  for (const n of withTime) {
    for (const a of n.themeIds) {
      const chain = themeChain(lib, a);
      // 主题链无 root 间接层，最上层就是 chain[0]
      const top = chain[0]?.id;
      if (top) seen.set(top, (seen.get(top) ?? 0) + 1);
    }
  }
  return [...seen.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4).map(([id]) => id);
}

function chainCard(lib: Library): HTMLElement {
  const card = document.createElement('div');
  card.className = 'chain';
  // 找最长的一条取代链
  let best: LifeNode[] = [];
  
  for (const n of lib.nodes) {
    if (n.type !== 'goal') continue;
    const chain = chainOf(lib, n.id);
    if (chain.length > best.length) best = chain;
  }
  if (best.length < 2) {
    card.innerHTML = `<div class="hint">${esc(t('empty.noReplacementChain'))}</div>`;
    return card;
  }
  // 按时间正序：取代链要从最早那个讲起，否则读起来是倒的
  best = [...best].sort((a, b) => (a.time ?? '').localeCompare(b.time ?? ''));
  for (const [i, n] of best.entries()) {
    const d = document.createElement('div');
    d.className = 'chain-i';
    d.innerHTML =
      `<div class="chain-d">${n.time ?? '—'} · ${esc(n.status == null ? t('common.noStatus') : statusLabel(n.status))}</div>` +
      `<div class="chain-t">${esc(n.title)}</div>` +
      `<div class="chain-r">${esc(lastReason(lib, n.id))}</div>` +
      (i < best.length - 1 ? '<span class="chain-a">→</span>' : '');
    card.append(d);
  }
  return card;
}

function lastReason(lib: Library, nodeId: string): string {
  const vs = lib.versions.filter((v) => v.nodeId === nodeId).sort((a, b) => a.changedAt - b.changedAt);
  return vs[vs.length - 1]?.reason ?? t('version.noReasonRecorded');
}

function chainOf(lib: Library, startId: string): LifeNode[] {
  const prev = new Map<string, string>();
  for (const e of lib.edges) if (e.type === 'replace') prev.set(e.fromId, e.toId);
  const out: LifeNode[] = [];
  const seen = new Set<string>();
  let cur = lib.nodes.find((n) => n.id === startId);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id); out.push(cur);
    const nx = prev.get(cur.id);
    cur = nx ? lib.nodes.find((n) => n.id === nx) : undefined;
  }
  return out.reverse();
}
